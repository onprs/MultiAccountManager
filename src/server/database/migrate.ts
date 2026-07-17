import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseConfig } from "@/runtime/types";
import { migrationsDirectory } from "@/runtime/paths";
import { closeDatabaseClient, createDatabaseClient } from "./connection";

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new Error("Invalid PostgreSQL identifier");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export async function expectedMigrationFiles(): Promise<
  Array<{ name: string; sql: string; checksum: string }>
> {
  const directory = migrationsDirectory();
  const names = (await readdir(/* turbopackIgnore: true */ directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (names.length === 0) throw new Error("No database migrations were found");

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(
        /* turbopackIgnore: true */ path.join(directory, name),
        "utf8",
      );
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

export async function runMigrations(config: DatabaseConfig): Promise<void> {
  const sql = createDatabaseClient(config, { max: 1 });
  const migrations = await expectedMigrationFiles();
  const appSchema = quoteIdentifier(config.schema);
  const jobSchema = quoteIdentifier(config.jobSchema);

  try {
    await sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtextextended('account-vault-setup-v1', 0))`;
      await transaction.unsafe(`create schema if not exists ${appSchema}`);
      await transaction.unsafe(`create schema if not exists ${jobSchema}`);
      await transaction.unsafe(`set local search_path to ${appSchema}, pg_catalog`);
      await transaction.unsafe(`
        create table if not exists _account_vault_migrations (
          name text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `);

      const applied = await transaction<Array<{ name: string; checksum: string }>>`
        select name, checksum from _account_vault_migrations order by name
      `;
      const appliedByName = new Map(applied.map((entry) => [entry.name, entry.checksum]));

      for (const migration of migrations) {
        const existingChecksum = appliedByName.get(migration.name);
        if (existingChecksum && existingChecksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch: ${migration.name}`);
        }
        if (existingChecksum) continue;
        await transaction.unsafe(migration.sql);
        await transaction`
          insert into _account_vault_migrations (name, checksum)
          values (${migration.name}, ${migration.checksum})
        `;
      }
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

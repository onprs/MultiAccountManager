import type { DatabaseConfig } from "@/runtime/types";
import { closeDatabaseClient, createDatabaseClient } from "./connection";
import { expectedMigrationFiles } from "./migrate";

export class DatabaseReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseReadinessError";
  }
}

export async function verifyDatabaseReadiness(config: DatabaseConfig): Promise<void> {
  const expected = await expectedMigrationFiles();
  const sql = createDatabaseClient(config, { max: 1 });
  try {
    const applied = await sql<Array<{ name: string; checksum: string }>>`
      select name, checksum
      from _account_vault_migrations
      order by name
    `;
    const appliedByName = new Map(applied.map((migration) => [migration.name, migration.checksum]));
    for (const migration of expected) {
      if (appliedByName.get(migration.name) !== migration.checksum) {
        throw new DatabaseReadinessError("Database migration state does not match this release");
      }
    }

    const [identity] = await sql<Array<{ owners: number; ownerPasskeys: number }>>`
      select
        count(distinct users.id)::int as owners,
        count(passkeys.id)::int as "ownerPasskeys"
      from users
      left join passkeys on passkeys.user_id = users.id
      where users.role = 'owner'
    `;
    if (identity?.owners !== 1 || identity.ownerPasskeys < 1) {
      throw new DatabaseReadinessError("Owner identity is incomplete");
    }
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

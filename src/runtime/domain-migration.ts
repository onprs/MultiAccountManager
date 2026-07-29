import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { readRuntimeConfig, writeRuntimeConfig } from "./config-store";
import {
  applicationConfigSchema,
  type ApplicationConfig,
  type RuntimeConfig,
} from "./types";
import {
  closeDatabaseClient,
  createDatabaseClient,
} from "@/server/database/connection";

export const DOMAIN_MIGRATION_BACKUP_CONFIRMATION =
  "ACCOUNT_VAULT_BACKUP_CONFIRMED";
export const DOMAIN_MIGRATION_CONFIRMATION =
  "ACCOUNT_VAULT_DOMAIN_MIGRATION_CONFIRMED";

export type DomainMigrationResult = {
  previousOrigin: string;
  nextOrigin: string;
  previousRpId: string;
  nextRpId: string;
  revokedPasskeys: number;
};

type MigrationAuditState = {
  revokedPasskeys: number;
  completed: boolean;
};

export function applicationForDomainMigration(input: {
  current: ApplicationConfig;
  publicUrl: string;
  rpId?: string;
}): ApplicationConfig {
  const url = new URL(input.publicUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Public URL must contain only an origin");
  }
  const origin = url.origin;
  return applicationConfigSchema.parse({
    ...input.current,
    publicUrl: origin,
    webAuthnOrigin: origin,
    webAuthnRpId: (input.rpId ?? url.hostname).trim().toLowerCase(),
  });
}

async function loadOwnerMigrationState(sql: Sql | TransactionSql) {
  const rows = await sql<
    Array<{
      id: string;
      passkeyCount: number;
      vaultReady: boolean;
    }>
  >`
    select
      users.id,
      (select count(*)::int from passkeys where passkeys.user_id = users.id) as "passkeyCount",
      exists (
        select 1 from vaults
        where vaults.owner_user_id = users.id
          and vaults.recovery_confirmed_at is not null
      ) as "vaultReady"
    from users
    where users.role = 'owner'
    limit 2
  `;
  if (rows.length !== 1 || !rows[0]) {
    throw new Error("Domain migration requires exactly one owner");
  }
  if (!rows[0].vaultReady) {
    throw new Error("Domain migration requires a confirmed Recovery Kit");
  }
  if (rows[0].passkeyCount < 1) {
    throw new Error("Domain migration requires an existing owner Passkey");
  }
  return rows[0];
}

async function loadMigrationAuditState(
  sql: TransactionSql,
  migrationId: string,
): Promise<MigrationAuditState | null> {
  const [state] = await sql<Array<MigrationAuditState>>`
    select
      coalesce((started.metadata ->> 'revokedPasskeys')::int, 0) as "revokedPasskeys",
      exists (
        select 1
        from audit_events completed
        where completed.event_type = 'application.domain_migration.completed'
          and completed.metadata ->> 'migrationId' = ${migrationId}
      ) as completed
    from audit_events started
    where started.event_type = 'application.domain_migration.started'
      and started.metadata ->> 'migrationId' = ${migrationId}
    order by started.created_at desc
    limit 1
  `;
  return state ?? null;
}

function sameApplicationIdentity(
  left: ApplicationConfig,
  right: ApplicationConfig,
): boolean {
  return (
    left.publicUrl === right.publicUrl &&
    left.webAuthnOrigin === right.webAuthnOrigin &&
    left.webAuthnRpId === right.webAuthnRpId
  );
}

export async function prepareDomainMigration(input: {
  publicUrl: string;
  rpId?: string;
}): Promise<DomainMigrationResult> {
  if (process.env[DOMAIN_MIGRATION_BACKUP_CONFIRMATION] !== "yes") {
    throw new Error(
      `Set ${DOMAIN_MIGRATION_BACKUP_CONFIRMATION}=yes only after database and runtime config backups are verified`,
    );
  }
  if (process.env[DOMAIN_MIGRATION_CONFIRMATION] !== "yes") {
    throw new Error(
      `Set ${DOMAIN_MIGRATION_CONFIRMATION}=yes to revoke existing sessions and Passkeys`,
    );
  }

  const initial = await readRuntimeConfig();
  const sql = createDatabaseClient(initial.database, { max: 1 });
  try {
    const outcome = await sql.begin(async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended('account-vault-domain-migration-v1', 0))
      `;

      // Re-read under the database lock so concurrent migration commands reuse one ID.
      const current = await readRuntimeConfig();
      if (JSON.stringify(current.database) !== JSON.stringify(initial.database)) {
        throw new Error("Runtime database configuration changed; rerun domain migration");
      }
      const requestedApplication = applicationForDomainMigration({
        current: current.application,
        publicUrl: input.publicUrl,
        rpId: input.rpId,
      });
      const fresh = current.setupState === "ready" && !current.domainMigration;
      const resuming =
        current.setupState === "creating_owner" && Boolean(current.domainMigration);
      if (!fresh && !resuming) {
        throw new Error(
          "Domain migration requires a READY runtime or an interrupted domain migration",
        );
      }
      if (
        resuming &&
        !sameApplicationIdentity(requestedApplication, current.application)
      ) {
        throw new Error(
          "Interrupted domain migration must resume with the same target identity",
        );
      }
      if (fresh && sameApplicationIdentity(requestedApplication, current.application)) {
        throw new Error("Domain migration does not change the application identity");
      }

      let owner = fresh ? await loadOwnerMigrationState(transaction) : null;
      const prepared: RuntimeConfig = fresh
        ? {
            ...current,
            setupState: "creating_owner",
            application: requestedApplication,
            domainMigration: {
              id: randomUUID(),
              previousApplication: current.application,
              preparedAt: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
          }
        : current;
      const migration = prepared.domainMigration;
      if (!migration) throw new Error("Domain migration state is unavailable");
      if (fresh) await writeRuntimeConfig(prepared);

      const existing = await loadMigrationAuditState(transaction, migration.id);
      if (existing) return { state: existing, prepared, migration };

      owner ??= await loadOwnerMigrationState(transaction);
      await transaction`delete from sessions where user_id = ${owner.id}`;
      const deleted = await transaction`delete from passkeys where user_id = ${owner.id}`;
      const revokedPasskeys = Number(deleted.count);
      await transaction`
        insert into audit_events (
          id, actor_user_id, event_type, outcome, metadata
        ) values (
          ${randomUUID()},
          ${owner.id},
          'application.domain_migration.started',
          'success',
          ${transaction.json({
            migrationId: migration.id,
            previousOrigin: migration.previousApplication.webAuthnOrigin,
            nextOrigin: prepared.application.webAuthnOrigin,
            previousRpId: migration.previousApplication.webAuthnRpId,
            nextRpId: prepared.application.webAuthnRpId,
            revokedPasskeys,
          })}
        )
      `;
      return {
        state: { revokedPasskeys, completed: false },
        prepared,
        migration,
      };
    });

    if (outcome.state.completed) {
      const recovered: RuntimeConfig = {
        ...outcome.prepared,
        setupState: "ready",
        updatedAt: new Date().toISOString(),
      };
      delete recovered.domainMigration;
      await writeRuntimeConfig(recovered);
    }

    return {
      previousOrigin: outcome.migration.previousApplication.webAuthnOrigin,
      nextOrigin: outcome.prepared.application.webAuthnOrigin,
      previousRpId: outcome.migration.previousApplication.webAuthnRpId,
      nextRpId: outcome.prepared.application.webAuthnRpId,
      revokedPasskeys: outcome.state.revokedPasskeys,
    };
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

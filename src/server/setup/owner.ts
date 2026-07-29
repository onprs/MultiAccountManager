import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { createDatabaseClient, closeDatabaseClient } from "@/server/database/connection";
import { readRuntimeConfig, writeRuntimeConfig } from "@/runtime/config-store";
import { createOwnerRegistrationContext } from "@/server/auth/registration-context";

export type SetupOwner = {
  id: string;
  name: string;
  email: string;
  role: "owner";
};

export class OwnerSetupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OwnerSetupError";
    this.code = code;
  }
}

async function withDatabase<T>(callback: (sql: Sql) => Promise<T>): Promise<T> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    return await callback(sql);
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function createOrLoadOwner(input: {
  name: string;
  email: string;
}): Promise<{ owner: SetupOwner; registrationContext: string }> {
  const config = await readRuntimeConfig();
  if (config.setupState !== "creating_owner") {
    throw new OwnerSetupError("OWNER_SETUP_CLOSED", "Owner setup is not available");
  }
  const normalizedEmail = input.email.trim().toLowerCase();
  const normalizedName = input.name.trim();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const owner = await sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtextextended('account-vault-owner-v1', 0))`;
      const existing = await transaction<Array<SetupOwner>>`
        select id, name, email, role
        from users
        order by created_at
        limit 2
      `;
      if (existing.length > 1 || (existing[0] && existing[0].role !== "owner")) {
        throw new OwnerSetupError(
          "OWNER_STATE_CONFLICT",
          "The authentication schema already contains unexpected users",
        );
      }
      if (existing[0]) {
        if (existing[0].email.toLowerCase() !== normalizedEmail) {
          throw new OwnerSetupError(
            "OWNER_EMAIL_CONFLICT",
            "Owner setup was already started with a different email",
          );
        }
        const migrationId = config.domainMigration?.id ?? null;
        const [state] = await transaction<Array<{
          vaultReady: boolean;
          migrationPrepared: boolean;
        }>>`
          select
            exists (
              select 1 from vaults
              where owner_user_id = ${existing[0].id}
                and recovery_confirmed_at is not null
            ) as "vaultReady",
            exists (
              select 1 from audit_events
              where event_type = 'application.domain_migration.started'
                and metadata ->> 'migrationId' = ${migrationId}
            ) as "migrationPrepared"
        `;
        if (state?.vaultReady && !config.domainMigration) {
          throw new OwnerSetupError(
            "OWNER_STATE_CONFLICT",
            "An initialized Vault cannot repeat owner setup",
          );
        }
        if (state?.vaultReady && !state.migrationPrepared) {
          throw new OwnerSetupError(
            "DOMAIN_MIGRATION_NOT_PREPARED",
            "Domain migration preparation must finish before Passkey registration",
          );
        }
        return existing[0];
      }

      const created: SetupOwner = {
        id: randomUUID(),
        name: normalizedName,
        email: normalizedEmail,
        role: "owner",
      };
      await transaction`
        insert into users (id, name, email, email_verified, role)
        values (${created.id}, ${created.name}, ${created.email}, true, ${created.role})
      `;
      await transaction`
        insert into audit_events (id, actor_user_id, event_type, outcome, metadata)
        values (
          ${randomUUID()},
          ${created.id},
          'setup.owner.created',
          'success',
          ${transaction.json({ authentication: "passkey" })}
        )
      `;
      return created;
    });
    return {
      owner,
      registrationContext: createOwnerRegistrationContext(owner.id, config),
    };
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function resolveRegistrationOwner(userId: string): Promise<SetupOwner> {
  return withDatabase(async (sql) => {
    const [owner] = await sql<Array<SetupOwner>>`
      select id, name, email, role
      from users
      where id = ${userId} and role = 'owner'
      limit 1
    `;
    if (!owner) {
      throw new OwnerSetupError("OWNER_NOT_FOUND", "Owner registration is invalid");
    }
    return owner;
  });
}

export async function completeOwnerSetup(requestId?: string): Promise<{
  owner: SetupOwner;
  setupState: "creating_vault" | "ready";
}> {
  const config = await readRuntimeConfig();
  if (config.setupState !== "creating_owner") {
    throw new OwnerSetupError("OWNER_SETUP_CLOSED", "Owner setup is not available");
  }

  const migrationId = config.domainMigration?.id ?? null;
  const result = await withDatabase(async (sql) => {
    return sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtextextended('account-vault-owner-v1', 0))`;
      const [owner] = await transaction<
        Array<
          SetupOwner & {
            passkeyCount: number;
            vaultReady: boolean;
            migrationPrepared: boolean;
            migrationCompleted: boolean;
          }
        >
      >`
        select
          users.id,
          users.name,
          users.email,
          users.role,
          count(passkeys.id)::int as "passkeyCount",
          exists (
            select 1 from vaults
            where vaults.owner_user_id = users.id
              and vaults.recovery_confirmed_at is not null
          ) as "vaultReady",
          exists (
            select 1 from audit_events started
            where started.event_type = 'application.domain_migration.started'
              and started.metadata ->> 'migrationId' = ${migrationId}
          ) as "migrationPrepared",
          exists (
            select 1 from audit_events completed
            where completed.event_type = 'application.domain_migration.completed'
              and completed.metadata ->> 'migrationId' = ${migrationId}
          ) as "migrationCompleted"
        from users
        left join passkeys on passkeys.user_id = users.id
        where users.role = 'owner'
        group by users.id
        limit 1
      `;
      if (!owner || owner.passkeyCount < 1) {
        throw new OwnerSetupError(
          "PASSKEY_REQUIRED",
          "At least one owner Passkey must be registered",
        );
      }

      let setupState: "ready" | "creating_vault";
      if (owner.vaultReady) {
        if (!config.domainMigration) {
          throw new OwnerSetupError(
            "OWNER_STATE_CONFLICT",
            "An initialized Vault cannot repeat owner setup",
          );
        }
        if (!owner.migrationPrepared) {
          throw new OwnerSetupError(
            "DOMAIN_MIGRATION_NOT_PREPARED",
            "Domain migration preparation must finish before owner setup",
          );
        }
        setupState = "ready";
        if (!owner.migrationCompleted) {
          await transaction`
            insert into audit_events (
              id, actor_user_id, event_type, outcome, request_id, metadata
            ) values (
              ${randomUUID()},
              ${owner.id},
              'application.domain_migration.completed',
              'success',
              ${requestId ?? null},
              ${transaction.json({ migrationId })}
            )
          `;
        }
      } else {
        if (config.domainMigration) {
          throw new OwnerSetupError(
            "OWNER_STATE_CONFLICT",
            "Domain migration requires an initialized Vault",
          );
        }
        setupState = "creating_vault";
        await transaction`
          insert into audit_events (id, actor_user_id, event_type, outcome, request_id)
          values (
            ${randomUUID()},
            ${owner.id},
            'setup.completed',
            'success',
            ${requestId ?? null}
          )
        `;
      }

      return {
        owner: {
          id: owner.id,
          name: owner.name,
          email: owner.email,
          role: owner.role,
        },
        setupState,
      };
    });
  });

  const nextConfig = {
    ...config,
    setupState: result.setupState,
    updatedAt: new Date().toISOString(),
  };
  if (result.setupState === "ready") delete nextConfig.domainMigration;
  await writeRuntimeConfig(nextConfig);
  return result;
}

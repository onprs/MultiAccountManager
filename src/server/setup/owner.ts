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

export async function completeOwnerSetup(requestId?: string): Promise<SetupOwner> {
  const config = await readRuntimeConfig();
  if (config.setupState !== "creating_owner") {
    throw new OwnerSetupError("OWNER_SETUP_CLOSED", "Owner setup is not available");
  }

  const owner = await withDatabase(async (sql) => {
    return sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtextextended('account-vault-owner-v1', 0))`;
      const [result] = await transaction<
        Array<SetupOwner & { passkeyCount: number }>
      >`
        select
          users.id,
          users.name,
          users.email,
          users.role,
          count(passkeys.id)::int as "passkeyCount"
        from users
        left join passkeys on passkeys.user_id = users.id
        where users.role = 'owner'
        group by users.id
        limit 1
      `;
      if (!result || result.passkeyCount < 1) {
        throw new OwnerSetupError(
          "PASSKEY_REQUIRED",
          "At least one owner Passkey must be registered",
        );
      }
      await transaction`
        insert into audit_events (id, actor_user_id, event_type, outcome, request_id)
        values (${randomUUID()}, ${result.id}, 'setup.completed', 'success', ${requestId ?? null})
      `;
      return {
        id: result.id,
        name: result.name,
        email: result.email,
        role: result.role,
      };
    });
  });

  await writeRuntimeConfig({
    ...config,
    setupState: "creating_vault",
    updatedAt: new Date().toISOString(),
  });
  return owner;
}

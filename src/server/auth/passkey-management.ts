import { randomUUID } from "node:crypto";
import { readRuntimeConfig } from "@/runtime/config-store";
import { closeDatabaseClient, createDatabaseClient } from "@/server/database/connection";

export type ManagedPasskey = {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  aaguid: string | null;
};

export class PasskeyManagementError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PasskeyManagementError";
    this.code = code;
  }
}

export async function listPasskeys(userId: string): Promise<ManagedPasskey[]> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const rows = await sql<
      Array<Omit<ManagedPasskey, "createdAt"> & { createdAt: Date }>
    >`
      select
        id,
        name,
        device_type as "deviceType",
        backed_up as "backedUp",
        created_at as "createdAt",
        aaguid
      from passkeys
      where user_id = ${userId}
      order by created_at, id
    `;
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export function assertPasskeyDeletionAllowed(owned: boolean, total: number): void {
  if (!owned) {
    throw new PasskeyManagementError("PASSKEY_NOT_FOUND", "Passkey not found");
  }
  if (total <= 1) {
    throw new PasskeyManagementError(
      "LAST_PASSKEY_PROTECTED",
      "The last Passkey cannot be deleted",
    );
  }
}

export async function renamePasskey(input: {
  userId: string;
  passkeyId: string;
  name: string;
  requestId?: string;
}): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql.begin(async (transaction) => {
      const updated = await transaction<Array<{ id: string }>>`
        update passkeys
        set name = ${input.name}
        where id = ${input.passkeyId} and user_id = ${input.userId}
        returning id
      `;
      if (updated.length !== 1) {
        throw new PasskeyManagementError("PASSKEY_NOT_FOUND", "Passkey not found");
      }
      await transaction`
        insert into audit_events (id, actor_user_id, event_type, outcome, request_id)
        values (${randomUUID()}, ${input.userId}, 'auth.passkey.renamed', 'success', ${input.requestId ?? null})
      `;
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function deletePasskey(input: {
  userId: string;
  sessionId: string;
  passkeyId: string;
  requestId?: string;
}): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql.begin(async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${`account-vault-passkeys:${input.userId}`}, 0))
      `;
      const [owned] = await transaction<Array<{ owned: boolean; total: number }>>`
        select
          exists(
            select 1 from passkeys
            where id = ${input.passkeyId} and user_id = ${input.userId}
          ) as owned,
          count(*)::int as total
        from passkeys
        where user_id = ${input.userId}
      `;
      assertPasskeyDeletionAllowed(Boolean(owned?.owned), owned?.total ?? 0);
      await transaction`
        delete from passkeys
        where id = ${input.passkeyId} and user_id = ${input.userId}
      `;
      await transaction`
        delete from auth_step_ups
        where session_id = ${input.sessionId} and user_id = ${input.userId}
      `;
      await transaction`
        insert into audit_events (id, actor_user_id, event_type, outcome, request_id)
        values (${randomUUID()}, ${input.userId}, 'auth.passkey.deleted', 'success', ${input.requestId ?? null})
      `;
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

import { createHash, randomUUID } from "node:crypto";
import { readRuntimeConfig } from "@/runtime/config-store";
import { closeDatabaseClient, createDatabaseClient } from "@/server/database/connection";

function credentialFingerprint(credentialId: string): string {
  return createHash("sha256").update(credentialId).digest("hex").slice(0, 16);
}

export async function recordSuccessfulPasskeyLogin(
  credentialId: string,
  requestId?: string,
): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const [passkey] = await sql<Array<{ userId: string }>>`
      select user_id as "userId"
      from passkeys
      where credential_id = ${credentialId}
      limit 1
    `;
    if (!passkey) throw new Error("Authenticated Passkey is not registered");
    await sql`
      insert into audit_events (id, actor_user_id, event_type, outcome, request_id, metadata)
      values (
        ${randomUUID()},
        ${passkey.userId},
        'auth.passkey.sign_in',
        'success',
        ${requestId ?? null},
        ${sql.json({ credentialFingerprint: credentialFingerprint(credentialId) })}
      )
    `;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function recordFailedPasskeyLogin(requestId?: string): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql`
      insert into audit_events (id, event_type, outcome, request_id)
      values (${randomUUID()}, 'auth.passkey.sign_in', 'failure', ${requestId ?? null})
    `;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

import { readRuntimeConfig } from "@/runtime/config-store";
import { closeDatabaseClient, createDatabaseClient } from "@/server/database/connection";

const STEP_UP_TTL_SECONDS = 5 * 60;

export async function markPasskeyStepUp(input: {
  sessionId: string;
  userId: string;
}): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql`
      insert into auth_step_ups (session_id, user_id, method, expires_at)
      values (
        ${input.sessionId},
        ${input.userId},
        'passkey',
        now() + (${STEP_UP_TTL_SECONDS} * interval '1 second')
      )
      on conflict (session_id) do update
      set user_id = excluded.user_id,
          method = excluded.method,
          expires_at = excluded.expires_at,
          created_at = now()
    `;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function hasRecentPasskeyStepUp(input: {
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const [result] = await sql<Array<{ valid: boolean }>>`
      select exists(
        select 1
        from auth_step_ups
        where session_id = ${input.sessionId}
          and user_id = ${input.userId}
          and method = 'passkey'
          and expires_at > now()
      ) as valid
    `;
    return Boolean(result?.valid);
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function consumePasskeyStepUp(input: {
  sessionId: string;
  userId: string;
}): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql`
      delete from auth_step_ups
      where session_id = ${input.sessionId} and user_id = ${input.userId}
    `;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

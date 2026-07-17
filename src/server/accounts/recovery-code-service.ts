import { randomUUID } from "node:crypto";
import {
  recoveryCodeMetadataSchema,
  revealedRecoveryCodeSchema,
  type RecoveryCodeMetadata,
  type RevealedRecoveryCode,
} from "@/accounts/schema";
import type { EncryptedEnvelope } from "@/crypto/schema";
import { readRuntimeConfig } from "@/runtime/config-store";
import {
  closeDatabaseClient,
  createDatabaseClient,
} from "@/server/database/connection";
import { ManagedAccountServiceError } from "./service";

type RecoveryCodeRow = {
  id: string;
  codeCiphertext?: EncryptedEnvelope;
  batchLabelCiphertext?: EncryptedEnvelope | null;
  usedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

function parseMetadata(row: RecoveryCodeRow): RecoveryCodeMetadata {
  return recoveryCodeMetadataSchema.parse({
    id: row.id,
    usedAt: row.usedAt?.toISOString() ?? null,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function parseRevealed(row: RecoveryCodeRow): RevealedRecoveryCode {
  return revealedRecoveryCodeSchema.parse({
    ...parseMetadata(row),
    codeCiphertext: row.codeCiphertext,
    batchLabelCiphertext: row.batchLabelCiphertext ?? null,
  });
}

export async function listRecoveryCodes(input: {
  ownerUserId: string;
  accountId: string;
}): Promise<{ codes: RecoveryCodeMetadata[]; remaining: number }> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const rows = await sql<Array<RecoveryCodeRow>>`
      select
        codes.id,
        codes.used_at as "usedAt",
        codes.revision,
        codes.created_at as "createdAt",
        codes.updated_at as "updatedAt"
      from managed_account_recovery_codes codes
      join managed_accounts accounts on accounts.id = codes.managed_account_id
      where accounts.id = ${input.accountId}
        and accounts.owner_user_id = ${input.ownerUserId}
        and accounts.deleted_at is null
      order by codes.used_at nulls first, codes.created_at desc, codes.id desc
    `;
    return {
      codes: rows.map(parseMetadata),
      remaining: rows.filter((row) => row.usedAt === null).length,
    };
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function createRecoveryCodes(input: {
  ownerUserId: string;
  accountId: string;
  requestId?: string;
  codes: Array<{
    id: string;
    codeCiphertext: EncryptedEnvelope;
    codeBlindIndex: string;
    batchLabelCiphertext: EncryptedEnvelope | null;
  }>;
}): Promise<{ codes: RecoveryCodeMetadata[]; remaining: number }> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    return await sql.begin(async (transaction) => {
      const [account] = await transaction<Array<{ id: string }>>`
        select id
        from managed_accounts
        where id = ${input.accountId}
          and owner_user_id = ${input.ownerUserId}
          and deleted_at is null
        for update
      `;
      if (!account) {
        throw new ManagedAccountServiceError(
          "ACCOUNT_NOT_FOUND",
          "Managed account was not found",
        );
      }
      const created: RecoveryCodeMetadata[] = [];
      for (const code of input.codes) {
        const [row] = await transaction<Array<RecoveryCodeRow>>`
          insert into managed_account_recovery_codes (
            id,
            managed_account_id,
            code_ciphertext,
            code_blind_index,
            batch_label_ciphertext
          ) values (
            ${code.id},
            ${input.accountId},
            ${transaction.json(code.codeCiphertext)},
            ${code.codeBlindIndex},
            ${code.batchLabelCiphertext ? transaction.json(code.batchLabelCiphertext) : null}
          )
          returning
            id,
            used_at as "usedAt",
            revision,
            created_at as "createdAt",
            updated_at as "updatedAt"
        `;
        if (!row) {
          throw new ManagedAccountServiceError(
            "RECOVERY_CODE_CREATE_FAILED",
            "Recovery codes could not be created",
          );
        }
        created.push(parseMetadata(row));
      }
      await transaction`
        insert into audit_events (
          id, actor_user_id, event_type, outcome, request_id, metadata
        ) values (
          ${randomUUID()},
          ${input.ownerUserId},
          'recovery_codes.imported',
          'success',
          ${input.requestId ?? null},
          ${transaction.json({ accountId: input.accountId, count: created.length })}
        )
      `;
      return { codes: created, remaining: created.length };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ManagedAccountServiceError(
        "RECOVERY_CODE_CONFLICT",
        "A duplicate recovery code was rejected",
      );
    }
    throw error;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function revealRecoveryCodes(input: {
  ownerUserId: string;
  sessionId: string;
  accountId: string;
  requestId?: string;
}): Promise<RevealedRecoveryCode[]> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    return await sql.begin(async (transaction) => {
      const [stepUp] = await transaction<Array<{ valid: boolean }>>`
        select exists(
          select 1
          from auth_step_ups
          where session_id = ${input.sessionId}
            and user_id = ${input.ownerUserId}
            and method = 'passkey'
            and expires_at > now()
        ) as valid
      `;
      if (!stepUp?.valid) {
        throw new ManagedAccountServiceError(
          "PASSKEY_STEP_UP_REQUIRED",
          "Recent Passkey verification is required",
        );
      }
      const rows = await transaction<Array<RecoveryCodeRow>>`
        select
          codes.id,
          codes.code_ciphertext as "codeCiphertext",
          codes.batch_label_ciphertext as "batchLabelCiphertext",
          codes.used_at as "usedAt",
          codes.revision,
          codes.created_at as "createdAt",
          codes.updated_at as "updatedAt"
        from managed_account_recovery_codes codes
        join managed_accounts accounts on accounts.id = codes.managed_account_id
        where accounts.id = ${input.accountId}
          and accounts.owner_user_id = ${input.ownerUserId}
          and accounts.deleted_at is null
        order by codes.used_at nulls first, codes.created_at desc, codes.id desc
      `;
      await transaction`
        delete from auth_step_ups
        where session_id = ${input.sessionId} and user_id = ${input.ownerUserId}
      `;
      await transaction`
        insert into audit_events (
          id, actor_user_id, event_type, outcome, request_id, metadata
        ) values (
          ${randomUUID()},
          ${input.ownerUserId},
          'recovery_codes.revealed',
          'success',
          ${input.requestId ?? null},
          ${transaction.json({ accountId: input.accountId, count: rows.length })}
        )
      `;
      return rows.map(parseRevealed);
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function setRecoveryCodeUsed(input: {
  ownerUserId: string;
  accountId: string;
  codeId: string;
  expectedRevision: number;
  used: boolean;
  requestId?: string;
}): Promise<RecoveryCodeMetadata> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    return await sql.begin(async (transaction) => {
      const [updated] = await transaction<Array<RecoveryCodeRow>>`
        update managed_account_recovery_codes as codes
        set used_at = case when ${input.used} then now() else null end,
            revision = codes.revision + 1,
            updated_at = now()
        from managed_accounts as accounts
        where codes.id = ${input.codeId}
          and codes.managed_account_id = ${input.accountId}
          and codes.revision = ${input.expectedRevision}
          and accounts.id = codes.managed_account_id
          and accounts.owner_user_id = ${input.ownerUserId}
          and accounts.deleted_at is null
        returning
          codes.id,
          codes.used_at as "usedAt",
          codes.revision,
          codes.created_at as "createdAt",
          codes.updated_at as "updatedAt"
      `;
      if (!updated) {
        throw new ManagedAccountServiceError(
          "RECOVERY_CODE_REVISION_CONFLICT",
          "Recovery code changed in another session or no longer exists",
        );
      }
      await transaction`
        insert into audit_events (
          id, actor_user_id, event_type, outcome, request_id, metadata
        ) values (
          ${randomUUID()},
          ${input.ownerUserId},
          ${input.used ? "recovery_code.used" : "recovery_code.restored"},
          'success',
          ${input.requestId ?? null},
          ${transaction.json({ accountId: input.accountId, codeId: input.codeId })}
        )
      `;
      return parseMetadata(updated);
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function deleteRecoveryCode(input: {
  ownerUserId: string;
  accountId: string;
  codeId: string;
  expectedRevision: number;
  requestId?: string;
}): Promise<void> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    await sql.begin(async (transaction) => {
      const [deleted] = await transaction<Array<{ id: string }>>`
        delete from managed_account_recovery_codes as codes
        using managed_accounts as accounts
        where codes.id = ${input.codeId}
          and codes.managed_account_id = ${input.accountId}
          and codes.revision = ${input.expectedRevision}
          and accounts.id = codes.managed_account_id
          and accounts.owner_user_id = ${input.ownerUserId}
          and accounts.deleted_at is null
        returning codes.id
      `;
      if (!deleted) {
        throw new ManagedAccountServiceError(
          "RECOVERY_CODE_REVISION_CONFLICT",
          "Recovery code changed in another session or no longer exists",
        );
      }
      await transaction`
        insert into audit_events (
          id, actor_user_id, event_type, outcome, request_id, metadata
        ) values (
          ${randomUUID()},
          ${input.ownerUserId},
          'recovery_code.deleted',
          'success',
          ${input.requestId ?? null},
          ${transaction.json({ accountId: input.accountId, codeId: input.codeId })}
        )
      `;
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

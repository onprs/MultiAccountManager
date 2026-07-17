import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import {
  vaultCryptoDocumentSchema,
  type Argon2Params,
  type EncryptedEnvelope,
  type VaultCryptoDocument,
} from "@/crypto/schema";
import { readRuntimeConfig } from "@/runtime/config-store";
import { closeDatabaseClient, createDatabaseClient } from "@/server/database/connection";

export class VaultServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultServiceError";
    this.code = code;
  }
}

type VaultRow = {
  id: string;
  ownerUserId: string;
  cryptoVersion: number;
  kdfAlgorithm: string;
  kdfSalt: string;
  kdfParams: Argon2Params;
  passwordEnvelope: EncryptedEnvelope;
  recoveryEnvelope: EncryptedEnvelope;
  recoveryKeyChecksum: string;
  recoveryConfirmedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

function parseRow(row: VaultRow): VaultCryptoDocument {
  return vaultCryptoDocumentSchema.parse({
    ...row,
    recoveryConfirmedAt: row.recoveryConfirmedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function getVault(ownerUserId: string): Promise<VaultCryptoDocument | null> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    const [row] = await sql<Array<VaultRow>>`
      select
        id,
        owner_user_id as "ownerUserId",
        crypto_version as "cryptoVersion",
        kdf_algorithm as "kdfAlgorithm",
        kdf_salt as "kdfSalt",
        kdf_params as "kdfParams",
        password_envelope as "passwordEnvelope",
        recovery_envelope as "recoveryEnvelope",
        recovery_key_checksum as "recoveryKeyChecksum",
        recovery_confirmed_at as "recoveryConfirmedAt",
        revision,
        created_at as "createdAt",
        updated_at as "updatedAt"
      from vaults
      where owner_user_id = ${ownerUserId}
      limit 1
    `;
    return row ? parseRow(row) : null;
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function initializeVault(input: {
  ownerUserId: string;
  vault: VaultCryptoDocument;
  requestId?: string;
}): Promise<VaultCryptoDocument> {
  if (input.vault.ownerUserId !== input.ownerUserId || input.vault.revision !== 1) {
    throw new VaultServiceError("VAULT_OWNER_MISMATCH", "Vault ownership is invalid");
  }
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    return await sql.begin(async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${`account-vault-vault:${input.ownerUserId}`}, 0))
      `;
      const [existing] = await transaction<Array<{ id: string }>>`
        select id from vaults where owner_user_id = ${input.ownerUserId} limit 1
      `;
      if (existing) {
        throw new VaultServiceError("VAULT_ALREADY_INITIALIZED", "Vault is already initialized");
      }
      const [created] = await transaction<Array<VaultRow>>`
        insert into vaults (
          id,
          owner_user_id,
          crypto_version,
          kdf_algorithm,
          kdf_salt,
          kdf_params,
          password_envelope,
          recovery_envelope,
          recovery_key_checksum,
          revision
        ) values (
          ${input.vault.id},
          ${input.ownerUserId},
          ${input.vault.cryptoVersion},
          ${input.vault.kdfAlgorithm},
          ${input.vault.kdfSalt},
          ${transaction.json(input.vault.kdfParams)},
          ${transaction.json(input.vault.passwordEnvelope)},
          ${transaction.json(input.vault.recoveryEnvelope)},
          ${input.vault.recoveryKeyChecksum},
          1
        )
        returning
          id,
          owner_user_id as "ownerUserId",
          crypto_version as "cryptoVersion",
          kdf_algorithm as "kdfAlgorithm",
          kdf_salt as "kdfSalt",
          kdf_params as "kdfParams",
          password_envelope as "passwordEnvelope",
          recovery_envelope as "recoveryEnvelope",
          recovery_key_checksum as "recoveryKeyChecksum",
          recovery_confirmed_at as "recoveryConfirmedAt",
          revision,
          created_at as "createdAt",
          updated_at as "updatedAt"
      `;
      await transaction`
        insert into audit_events (id, actor_user_id, event_type, outcome, request_id)
        values (${randomUUID()}, ${input.ownerUserId}, 'vault.initialized', 'success', ${input.requestId ?? null})
      `;
      if (!created) throw new VaultServiceError("VAULT_INITIALIZATION_FAILED", "Vault initialization failed");
      return parseRow(created);
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

export async function updatePasswordEnvelope(input: {
  ownerUserId: string;
  sessionId: string;
  expectedRevision: number;
  kdfSalt: string;
  kdfParams: Argon2Params;
  passwordEnvelope: EncryptedEnvelope;
  requestId?: string;
}): Promise<VaultCryptoDocument> {
  return updateVaultEnvelope({
    ownerUserId: input.ownerUserId,
    sessionId: input.sessionId,
    expectedRevision: input.expectedRevision,
    requestId: input.requestId,
    eventType: "vault.password.changed",
    update: async (transaction) => transaction<Array<VaultRow>>`
      update vaults
      set kdf_salt = ${input.kdfSalt},
          kdf_params = ${transaction.json(input.kdfParams)},
          password_envelope = ${transaction.json(input.passwordEnvelope)},
          revision = revision + 1,
          updated_at = now()
      where owner_user_id = ${input.ownerUserId}
        and revision = ${input.expectedRevision}
      returning
        id,
        owner_user_id as "ownerUserId",
        crypto_version as "cryptoVersion",
        kdf_algorithm as "kdfAlgorithm",
        kdf_salt as "kdfSalt",
        kdf_params as "kdfParams",
        password_envelope as "passwordEnvelope",
        recovery_envelope as "recoveryEnvelope",
        recovery_key_checksum as "recoveryKeyChecksum",
        recovery_confirmed_at as "recoveryConfirmedAt",
        revision,
        created_at as "createdAt",
        updated_at as "updatedAt"
    `,
  });
}

export async function rotateRecoveryEnvelope(input: {
  ownerUserId: string;
  sessionId: string;
  expectedRevision: number;
  recoveryEnvelope: EncryptedEnvelope;
  recoveryKeyChecksum: string;
  requestId?: string;
}): Promise<VaultCryptoDocument> {
  return updateVaultEnvelope({
    ownerUserId: input.ownerUserId,
    sessionId: input.sessionId,
    expectedRevision: input.expectedRevision,
    requestId: input.requestId,
    eventType: "vault.recovery.rotated",
    update: async (transaction) => transaction<Array<VaultRow>>`
      update vaults
      set recovery_envelope = ${transaction.json(input.recoveryEnvelope)},
          recovery_key_checksum = ${input.recoveryKeyChecksum},
          recovery_confirmed_at = null,
          revision = revision + 1,
          updated_at = now()
      where owner_user_id = ${input.ownerUserId}
        and revision = ${input.expectedRevision}
      returning
        id,
        owner_user_id as "ownerUserId",
        crypto_version as "cryptoVersion",
        kdf_algorithm as "kdfAlgorithm",
        kdf_salt as "kdfSalt",
        kdf_params as "kdfParams",
        password_envelope as "passwordEnvelope",
        recovery_envelope as "recoveryEnvelope",
        recovery_key_checksum as "recoveryKeyChecksum",
        recovery_confirmed_at as "recoveryConfirmedAt",
        revision,
        created_at as "createdAt",
        updated_at as "updatedAt"
    `,
  });
}

export async function confirmRecoveryKit(input: {
  ownerUserId: string;
  expectedRevision: number;
  requestId?: string;
}): Promise<VaultCryptoDocument> {
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });
  try {
    return await sql.begin(async (transaction) => {
      const [updated] = await transaction<Array<VaultRow>>`
        update vaults
        set recovery_confirmed_at = now(),
            revision = revision + 1,
            updated_at = now()
        where owner_user_id = ${input.ownerUserId}
          and revision = ${input.expectedRevision}
          and recovery_confirmed_at is null
        returning
          id,
          owner_user_id as "ownerUserId",
          crypto_version as "cryptoVersion",
          kdf_algorithm as "kdfAlgorithm",
          kdf_salt as "kdfSalt",
          kdf_params as "kdfParams",
          password_envelope as "passwordEnvelope",
          recovery_envelope as "recoveryEnvelope",
          recovery_key_checksum as "recoveryKeyChecksum",
          recovery_confirmed_at as "recoveryConfirmedAt",
          revision,
          created_at as "createdAt",
          updated_at as "updatedAt"
      `;
      if (!updated) {
        const [current] = await transaction<Array<VaultRow>>`
          select
            id,
            owner_user_id as "ownerUserId",
            crypto_version as "cryptoVersion",
            kdf_algorithm as "kdfAlgorithm",
            kdf_salt as "kdfSalt",
            kdf_params as "kdfParams",
            password_envelope as "passwordEnvelope",
            recovery_envelope as "recoveryEnvelope",
            recovery_key_checksum as "recoveryKeyChecksum",
            recovery_confirmed_at as "recoveryConfirmedAt",
            revision,
            created_at as "createdAt",
            updated_at as "updatedAt"
          from vaults
          where owner_user_id = ${input.ownerUserId}
            and recovery_confirmed_at is not null
          limit 1
        `;
        if (current) return parseRow(current);
        throw new VaultServiceError(
          "VAULT_REVISION_CONFLICT",
          "Vault changed in another session; reload before retrying",
        );
      }
      await transaction`
        insert into audit_events (id, actor_user_id, event_type, outcome, request_id)
        values (${randomUUID()}, ${input.ownerUserId}, 'vault.recovery.confirmed', 'success', ${input.requestId ?? null})
      `;
      return parseRow(updated);
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

async function updateVaultEnvelope(input: {
  ownerUserId: string;
  sessionId: string;
  expectedRevision: number;
  requestId?: string;
  eventType: string;
  update: (transaction: TransactionSql) => Promise<Array<VaultRow>>;
}): Promise<VaultCryptoDocument> {
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
        throw new VaultServiceError(
          "PASSKEY_STEP_UP_REQUIRED",
          "Recent Passkey verification is required",
        );
      }
      const [updated] = await input.update(transaction);
      if (!updated) {
        throw new VaultServiceError(
          "VAULT_REVISION_CONFLICT",
          "Vault changed in another session; reload before retrying",
        );
      }
      await transaction`
        delete from auth_step_ups
        where session_id = ${input.sessionId} and user_id = ${input.ownerUserId}
      `;
      await transaction`
        insert into audit_events (id, actor_user_id, event_type, outcome, request_id)
        values (${randomUUID()}, ${input.ownerUserId}, ${input.eventType}, 'success', ${input.requestId ?? null})
      `;
      return parseRow(updated);
    });
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

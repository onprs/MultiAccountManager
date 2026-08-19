import { randomUUID } from "node:crypto";
import { argon2id } from "hash-wasm";
import sodium from "libsodium-wrappers-sumo";
import { z } from "zod";
import type { EncryptedEnvelope } from "@/crypto/schema";
import { decodeBase64Url, encodeBase64Url } from "@/runtime/encoding";
import { readRuntimeConfig } from "@/runtime/config-store";
import { closeDatabaseClient, createDatabaseClient } from "@/server/database/connection";
import { getVault } from "@/server/vault/service";

export const apiImportOpenRouterAccountSchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().max(2_000).optional(),
  apiKey: z.string().trim().min(1),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
});

export const apiImportOpenRouterRequestSchema = z.object({
  vaultPassword: z.string().min(1).optional(),
  vaultRecoveryKey: z.string().min(1).optional(),
  accounts: z.array(apiImportOpenRouterAccountSchema).min(1).max(5_000),
  skipExisting: z.boolean().default(true),
});

export type ApiImportOpenRouterRequest = z.infer<typeof apiImportOpenRouterRequestSchema>;

export async function importOpenRouterAccountsDirect(
  input: ApiImportOpenRouterRequest,
  requestId?: string,
): Promise<{
  success: boolean;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  errors: Array<{ email: string; error: string }>;
}> {
  await sodium.ready;
  const config = await readRuntimeConfig();
  const sql = createDatabaseClient(config.database, { max: 1 });

  try {
    // 1. 获取 Owner 用户
    const [owner] = await sql<Array<{ id: string }>>`
      select id from users where role = 'owner' limit 1
    `;
    if (!owner) {
      throw new Error("No owner account registered in Account Vault");
    }
    const ownerUserId = owner.id;

    // 2. 获取 Vault 元数据
    const vault = await getVault(ownerUserId);
    if (!vault) {
      throw new Error("Vault is not initialized for this instance");
    }

    // 3. 解密 Vault Root Key 并派生数据/索引密钥
    let rootKey: Uint8Array | undefined;
    if (input.vaultPassword) {
      const salt = decodeBase64Url(vault.kdfSalt);
      const normalizedPassword = input.vaultPassword.normalize("NFKC");
      const passwordBytes = Buffer.from(normalizedPassword, "utf-8");

      const passwordKey = await argon2id({
        password: passwordBytes,
        salt,
        iterations: vault.kdfParams.iterations,
        parallelism: vault.kdfParams.parallelism,
        memorySize: vault.kdfParams.memorySize,
        hashLength: vault.kdfParams.hashLength,
        outputType: "binary",
      });

      const aad = JSON.stringify([
        "account-vault",
        "crypto-v1",
        vault.ownerUserId,
        "vault-root",
        vault.id,
        "password",
      ]);

      const nonce = decodeBase64Url(vault.passwordEnvelope.nonce);
      const ciphertext = decodeBase64Url(vault.passwordEnvelope.ciphertext);

      try {
        rootKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          ciphertext,
          aad,
          nonce,
          passwordKey,
        );
      } finally {
        sodium.memzero(passwordKey);
      }
    } else if (input.vaultRecoveryKey) {
      const cleanKey = input.vaultRecoveryKey.trim().replace(/^avrk1_/, "");
      const recoveryKeyBytes = decodeBase64Url(cleanKey);
      const wrappingKey = sodium.crypto_kdf_derive_from_key(32, 1, "AVRecov1", recoveryKeyBytes);
      const aad = JSON.stringify([
        "account-vault",
        "crypto-v1",
        vault.ownerUserId,
        "vault-root",
        vault.id,
        "recovery",
      ]);
      const nonce = decodeBase64Url(vault.recoveryEnvelope.nonce);
      const ciphertext = decodeBase64Url(vault.recoveryEnvelope.ciphertext);

      try {
        rootKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          ciphertext,
          aad,
          nonce,
          wrappingKey,
        );
      } finally {
        sodium.memzero(recoveryKeyBytes);
        sodium.memzero(wrappingKey);
      }
    } else {
      throw new Error("Must provide vaultPassword or vaultRecoveryKey for secure vault encryption");
    }

    if (!rootKey || rootKey.length !== 32) {
      throw new Error("Failed to unlock Vault: Invalid password or recovery key");
    }

    const dataKey = sodium.crypto_kdf_derive_from_key(32, 1, "AVData01", rootKey);
    const indexKey = sodium.crypto_kdf_derive_from_key(32, 2, "AVIndex1", rootKey);
    sodium.memzero(rootKey);

    function computeBlindIndex(value: string, context: string): string {
      const canonical = value.normalize("NFKC").trim().toLowerCase();
      const message = Buffer.from(
        JSON.stringify(["account-vault", "blind-index-v1", context, canonical]),
        "utf-8",
      );
      const hash = sodium.crypto_generichash(32, message, indexKey);
      return encodeBase64Url(hash);
    }

    function encryptRecord(recordId: string, payload: unknown): EncryptedEnvelope {
      const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
      const aad = JSON.stringify([
        "account-vault",
        "data-v1",
        ownerUserId,
        "managed-account-private-v1",
        recordId,
      ]);
      const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        aad,
        null,
        nonce,
        dataKey,
      );

      return {
        version: 1,
        algorithm: "xchacha20poly1305-ietf",
        keyId: "vault-data-v1",
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(ciphertext),
      };
    }

    // 4. 批量加密并事务写入
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const errors: Array<{ email: string; error: string }> = [];

    await sql.begin(async (transaction) => {
      for (const account of input.accounts) {
        const email = account.email.trim().toLowerCase();
        const domain = email.split("@")[1] || "";
        const emailIndex = computeBlindIndex(email, "managed-account-login-email-v1");
        const domainIndex = domain
          ? computeBlindIndex(domain, "managed-account-email-domain-v1")
          : null;

        if (input.skipExisting) {
          const [exists] = await transaction<Array<{ id: string }>>`
            select id from managed_accounts
            where owner_user_id = ${ownerUserId}
              and email_blind_index = ${emailIndex}
              and deleted_at is null
            limit 1
          `;
          if (exists) {
            skipped++;
            continue;
          }
        }

        const recordId = randomUUID();
        const payload = {
          version: 1,
          loginEmail: email,
          password: account.password || undefined,
          notes: account.apiKey ? `API Key: ${account.apiKey}` : undefined,
        };

        const encrypted = encryptRecord(recordId, payload);
        const displayName = email;

        try {
          await transaction`
            insert into managed_accounts (
              id,
              owner_user_id,
              platform,
              display_name,
              private_payload,
              email_blind_index,
              email_domain_blind_index,
              has_totp
            ) values (
              ${recordId},
              ${ownerUserId},
              'openrouter',
              ${displayName},
              ${transaction.json(encrypted)},
              ${emailIndex},
              ${domainIndex},
              false
            )
          `;
          imported++;
        } catch (err) {
          failed++;
          errors.push({ email, error: (err as Error).message });
        }
      }

      await transaction`
        insert into audit_events (
          id, actor_user_id, event_type, outcome, request_id, metadata
        ) values (
          ${randomUUID()},
          ${ownerUserId},
          'managed_account.api_imported',
          'success',
          ${requestId ?? null},
          ${transaction.json({ count: imported, platform: "openrouter" })}
        )
      `;
    });

    return {
      success: true,
      total: input.accounts.length,
      imported,
      skipped,
      failed,
      errors,
    };
  } finally {
    await closeDatabaseClient(sql).catch(() => undefined);
  }
}

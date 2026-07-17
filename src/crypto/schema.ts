import { z } from "zod";

const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const encryptedEnvelopeSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("xchacha20poly1305-ietf"),
    keyId: z.enum([
      "vault-wrap-password-v1",
      "vault-wrap-recovery-v1",
      "vault-data-v1",
    ]),
    nonce: base64UrlSchema.length(32),
    ciphertext: base64UrlSchema.min(22).max(2_000_000),
  })
  .strict();

export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

export const argon2ParamsSchema = z
  .object({
    version: z.literal(19),
    memorySize: z.number().int().min(65_536).max(262_144),
    iterations: z.number().int().min(2).max(10),
    parallelism: z.number().int().min(1).max(4),
    hashLength: z.literal(32),
  })
  .strict();

export type Argon2Params = z.infer<typeof argon2ParamsSchema>;

export const vaultCryptoDocumentSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  cryptoVersion: z.literal(1),
  kdfAlgorithm: z.literal("argon2id"),
  kdfSalt: base64UrlSchema.length(22),
  kdfParams: argon2ParamsSchema,
  passwordEnvelope: encryptedEnvelopeSchema.extend({
    keyId: z.literal("vault-wrap-password-v1"),
    ciphertext: base64UrlSchema.length(64),
  }),
  recoveryEnvelope: encryptedEnvelopeSchema.extend({
    keyId: z.literal("vault-wrap-recovery-v1"),
    ciphertext: base64UrlSchema.length(64),
  }),
  recoveryKeyChecksum: base64UrlSchema.length(22),
  recoveryConfirmedAt: z.string().datetime().nullable().optional(),
  revision: z.number().int().min(1),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
}).strict();

export type VaultCryptoDocument = z.infer<typeof vaultCryptoDocumentSchema>;

export const initializeVaultRequestSchema = z
  .object({
    vault: vaultCryptoDocumentSchema.omit({
      recoveryConfirmedAt: true,
      createdAt: true,
      updatedAt: true,
    }),
  })
  .strict();

export const updatePasswordEnvelopeRequestSchema = z.object({
  expectedRevision: z.number().int().min(1),
  kdfSalt: base64UrlSchema.length(22),
  kdfParams: argon2ParamsSchema,
  passwordEnvelope: encryptedEnvelopeSchema.extend({
    keyId: z.literal("vault-wrap-password-v1"),
    ciphertext: base64UrlSchema.length(64),
  }),
}).strict();

export const confirmRecoveryKitRequestSchema = z
  .object({ expectedRevision: z.number().int().min(1) })
  .strict();

export const rotateRecoveryEnvelopeRequestSchema = z.object({
  expectedRevision: z.number().int().min(1),
  recoveryEnvelope: encryptedEnvelopeSchema.extend({
    keyId: z.literal("vault-wrap-recovery-v1"),
    ciphertext: base64UrlSchema.length(64),
  }),
  recoveryKeyChecksum: base64UrlSchema.length(22),
}).strict();

export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  version: 19,
  memorySize: 65_536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
};

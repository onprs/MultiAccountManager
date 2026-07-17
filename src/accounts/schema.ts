import { z } from "zod";
import { encryptedEnvelopeSchema } from "@/crypto/schema";

export const accountPlatformSchema = z.enum([
  "openai",
  "opencode_go",
  "antigravity",
]);
export type AccountPlatform = z.infer<typeof accountPlatformSchema>;

export const accountLocalStatusSchema = z.enum(["active", "archived"]);
export type AccountLocalStatus = z.infer<typeof accountLocalStatusSchema>;

export const totpConfigurationSchema = z
  .object({
    type: z.literal("totp"),
    issuer: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(240),
    secretBase32: z.string().regex(/^[A-Z2-7]{16,256}$/),
    algorithm: z.enum(["SHA1", "SHA256", "SHA512"]),
    digits: z.union([z.literal(6), z.literal(7), z.literal(8)]),
    period: z.number().int().min(15).max(120),
  })
  .strict();
export type TotpConfiguration = z.infer<typeof totpConfigurationSchema>;

export const managedAccountPrivatePayloadSchema = z
  .object({
    version: z.literal(1),
    loginEmail: z.string().trim().email().max(320).optional(),
    phone: z.string().trim().max(80).optional(),
    smsEndpoint: z.string().trim().url().max(2_000).optional(),
    notes: z.string().max(20_000).optional(),
    totp: totpConfigurationSchema.optional(),
  })
  .strict();
export type ManagedAccountPrivatePayload = z.infer<
  typeof managedAccountPrivatePayloadSchema
>;

const dataEnvelopeSchema = encryptedEnvelopeSchema.extend({
  keyId: z.literal("vault-data-v1"),
});
const blindIndexSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const managedAccountSchema = z
  .object({
    id: z.string().uuid(),
    ownerUserId: z.string().uuid(),
    platform: accountPlatformSchema,
    displayName: z.string().trim().min(1).max(120),
    privatePayload: dataEnvelopeSchema,
    emailBlindIndex: blindIndexSchema.nullable(),
    emailDomainBlindIndex: blindIndexSchema.nullable(),
    hasTotp: z.boolean(),
    localStatus: accountLocalStatusSchema,
    revision: z.number().int().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ManagedAccount = z.infer<typeof managedAccountSchema>;

export const createManagedAccountRequestSchema = z
  .object({
    id: z.string().uuid(),
    platform: accountPlatformSchema,
    displayName: z.string().trim().min(1).max(120),
    privatePayload: dataEnvelopeSchema,
    emailBlindIndex: blindIndexSchema.nullable(),
    emailDomainBlindIndex: blindIndexSchema.nullable(),
    hasTotp: z.boolean(),
  })
  .strict();

export const updateManagedAccountRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    platform: accountPlatformSchema,
    displayName: z.string().trim().min(1).max(120),
    privatePayload: dataEnvelopeSchema,
    emailBlindIndex: blindIndexSchema.nullable(),
    emailDomainBlindIndex: blindIndexSchema.nullable(),
    hasTotp: z.boolean(),
    localStatus: accountLocalStatusSchema,
  })
  .strict();

export const deleteManagedAccountRequestSchema = z
  .object({ expectedRevision: z.number().int().min(1) })
  .strict();

export const managedAccountListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().max(120).optional(),
    platform: accountPlatformSchema.optional(),
    localStatus: accountLocalStatusSchema.default("active"),
    hasTotp: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
    emailBlindIndex: blindIndexSchema.optional(),
    emailDomainBlindIndex: blindIndexSchema.optional(),
  })
  .strict();

export const recoveryCodePrivatePayloadSchema = z
  .object({ version: z.literal(1), code: z.string().trim().min(1).max(500) })
  .strict();
export type RecoveryCodePrivatePayload = z.infer<
  typeof recoveryCodePrivatePayloadSchema
>;

export const createRecoveryCodesRequestSchema = z
  .object({
    codes: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            codeCiphertext: dataEnvelopeSchema,
            codeBlindIndex: blindIndexSchema,
            batchLabelCiphertext: dataEnvelopeSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export const updateRecoveryCodeRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    used: z.boolean(),
  })
  .strict();

export const deleteRecoveryCodeRequestSchema = deleteManagedAccountRequestSchema;

export const recoveryCodeMetadataSchema = z
  .object({
    id: z.string().uuid(),
    usedAt: z.string().datetime().nullable(),
    revision: z.number().int().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type RecoveryCodeMetadata = z.infer<typeof recoveryCodeMetadataSchema>;

export const revealedRecoveryCodeSchema = recoveryCodeMetadataSchema.extend({
  codeCiphertext: dataEnvelopeSchema,
  batchLabelCiphertext: dataEnvelopeSchema.nullable(),
});
export type RevealedRecoveryCode = z.infer<typeof revealedRecoveryCodeSchema>;

export type TotpResult = {
  code: string;
  period: number;
  secondsRemaining: number;
  generatedAt: number;
};

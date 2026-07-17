import { z } from "zod";

export const setupStateSchema = z.enum([
  "validating_database",
  "migrating",
  "creating_owner",
  "creating_vault",
  "ready",
]);

export type SetupState = z.infer<typeof setupStateSchema>;

const identifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const databaseConfigSchema = z.object({
  host: z.string().min(1).max(253).regex(/^[A-Za-z0-9._:-]+$/),
  port: z.coerce.number().int().min(1).max(65535),
  database: z.string().min(1).max(63).regex(/^[A-Za-z0-9_.-]+$/),
  schema: identifierSchema.default("account_vault"),
  jobSchema: identifierSchema.default("account_vault_jobs"),
  username: z.string().min(1).max(63),
  password: z.string().min(1).max(1024),
  sslMode: z.enum(["verify-full", "require", "prefer", "disable"]),
  caCertificate: z.string().max(32_768).optional(),
  connectTimeoutSeconds: z.coerce.number().int().min(2).max(30).default(5),
  webPoolSize: z.coerce.number().int().min(1).max(50).default(10),
  workerPoolSize: z.coerce.number().int().min(1).max(50).default(5),
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

export const applicationConfigSchema = z
  .object({
    publicUrl: z.string().url().max(2048),
    webAuthnRpId: z.string().min(1).max(253),
    webAuthnRpName: z.string().min(1).max(100),
    webAuthnOrigin: z.string().url().max(2048),
    siteName: z.string().min(1).max(100),
    timeZone: z.string().min(1).max(100).default("UTC"),
  })
  .superRefine((value, context) => {
    const publicUrl = new URL(value.publicUrl);
    const origin = new URL(value.webAuthnOrigin);
    const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(
      publicUrl.hostname,
    );
    if (publicUrl.protocol !== "https:" && !isLoopback) {
      context.addIssue({
        code: "custom",
        path: ["publicUrl"],
        message: "Public URL must use HTTPS",
      });
    }
    if (origin.origin !== publicUrl.origin) {
      context.addIssue({
        code: "custom",
        path: ["webAuthnOrigin"],
        message: "WebAuthn origin must match the public URL origin",
      });
    }
    if (
      publicUrl.hostname !== value.webAuthnRpId &&
      !publicUrl.hostname.endsWith(`.${value.webAuthnRpId}`)
    ) {
      context.addIssue({
        code: "custom",
        path: ["webAuthnRpId"],
        message: "RP ID must equal or be a parent domain of the public host",
      });
    }
  });

export type ApplicationConfig = z.infer<typeof applicationConfigSchema>;

export const serviceKeySchema = z.object({
  id: z.string().min(1).max(64),
  key: z.string().min(43).max(44),
  status: z.enum(["current", "previous"]),
});

export const runtimeConfigSchema = z.object({
  version: z.literal(1),
  setupState: setupStateSchema,
  database: databaseConfigSchema,
  application: applicationConfigSchema,
  auth: z.object({ secret: z.string().min(43).max(128) }),
  serviceEncryption: z.object({ keys: z.array(serviceKeySchema).min(1).max(2) }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export const initializeRequestSchema = z.object({
  database: databaseConfigSchema,
  application: applicationConfigSchema,
});

export const encryptedRuntimeConfigSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("xchacha20poly1305-ietf"),
  keyId: z.literal("config-master-v1"),
  nonce: z.string().min(32).max(32),
  ciphertext: z.string().min(16),
});

export type EncryptedRuntimeConfig = z.infer<typeof encryptedRuntimeConfigSchema>;

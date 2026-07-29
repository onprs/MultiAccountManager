import { z } from "zod";
import { accountPlatformSchema } from "@/accounts/schema";

const timestampSchema = z.string().datetime({ offset: true });

export const serviceCiphertextSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("xchacha20poly1305-ietf"),
    keyId: z.string().min(1).max(64),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/).min(16),
  })
  .strict();
export type ServiceCiphertext = z.infer<typeof serviceCiphertextSchema>;

export const observerQuotaWindowSchema = z
  .object({
    utilization: z.number().finite().min(0),
    resets_at: timestampSchema.nullish(),
    remaining_seconds: z.number().int().min(0),
    estimated: z.boolean(),
  })
  .strict();

export const observerQuotaSchema = z
  .object({
    source: z.string().max(100).optional(),
    updated_at: timestampSchema.nullish(),
    windows: z.record(z.string().min(1).max(64), observerQuotaWindowSchema),
  })
  .strict();

export const observerAccountSchema = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z.string().min(1).max(120),
    platform: z.enum([
      "anthropic",
      "openai",
      "opencode_go",
      "gemini",
      "antigravity",
      "clinepass",
      "grok",
    ]),
    type: z.string().min(1).max(50),
    status: z.string().min(1).max(50),
    availability: z.string().min(1).max(64),
    available: z.boolean(),
    last_used_at: timestampSchema.nullish(),
    expires_at: timestampSchema.nullish(),
    rate_limit_reset_at: timestampSchema.nullish(),
    overload_until: timestampSchema.nullish(),
    temp_unschedulable_until: timestampSchema.nullish(),
    session_window_end: timestampSchema.nullish(),
    updated_at: timestampSchema,
    quota: observerQuotaSchema.nullish(),
    quota_error: z.object({ code: z.string().min(1).max(100) }).strict().nullish(),
    error_code: z.string().max(100).optional(),
  })
  .strict();
export type ObserverAccount = z.infer<typeof observerAccountSchema>;

export const observerAccountsPageSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    instance_id: z.string().uuid(),
    items: z.array(z.unknown()).max(501),
    next_cursor: z.string().max(2048).optional(),
    generated_at: timestampSchema,
  })
  .strict();

export type ObserverAccountsPage = Omit<
  z.infer<typeof observerAccountsPageSchema>,
  "items"
> & { items: ObserverAccount[]; invalidItems: number };

export const createConnectionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    baseUrl: z.string().url().max(2048),
    token: z.string().trim().min(24).max(512),
    syncIntervalSeconds: z.number().int().min(60).max(86400).default(300),
  })
  .strict();

export const updateConnectionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    token: z.string().trim().min(24).max(512).optional(),
    syncIntervalSeconds: z.number().int().min(60).max(86400).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const createLinkRequestSchema = z
  .object({
    managedAccountId: z.string().uuid(),
    connectionId: z.string().uuid(),
    externalAccountId: z.union([z.string().min(1).max(128), z.number().int().positive()]).transform(String),
  })
  .strict();

export const connectionIdSchema = z.string().uuid();

export type ConnectionSummary = {
  id: string;
  name: string;
  baseUrl: string;
  remoteInstanceId: string | null;
  tokenHint: string;
  tokenKeyId: string;
  syncIntervalSeconds: number;
  enabled: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  syncHealth: "fresh" | "stale" | "disconnected" | "never_synced";
  createdAt: string;
  updatedAt: string;
};

export type RemoteCatalogItem = {
  connectionId: string;
  externalAccountId: string;
  externalName: string;
  externalPlatform: string;
  externalType: string;
  remoteStatus: string;
  availability: string;
  available: boolean;
  quota: z.infer<typeof observerQuotaSchema> | null;
  quotaErrorCode: string | null;
  remoteUpdatedAt: string;
  lastSeenAt: string;
  linkedManagedAccountId: string | null;
};

export const managedLinkPlatformSchema = accountPlatformSchema;

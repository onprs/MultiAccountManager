import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { decodeBase64Url } from "@/runtime/encoding";
import type { RuntimeConfig } from "@/runtime/types";

const CONTEXT_TTL_SECONDS = 10 * 60;
const payloadSchema = z.object({
  version: z.literal(1),
  purpose: z.literal("owner-passkey-registration"),
  userId: z.string().uuid(),
  expiresAt: z.number().int().positive(),
  nonce: z.string().min(22).max(64),
});

type RegistrationPayload = z.infer<typeof payloadSchema>;

function signingKey(config: RuntimeConfig): Uint8Array {
  return decodeBase64Url(config.auth.secret);
}

function signature(encodedPayload: string, config: RuntimeConfig): Buffer {
  return createHmac("sha256", signingKey(config)).update(encodedPayload).digest();
}

export function createOwnerRegistrationContext(
  userId: string,
  config: RuntimeConfig,
): string {
  const payload: RegistrationPayload = {
    version: 1,
    purpose: "owner-passkey-registration",
    userId,
    expiresAt: Math.floor(Date.now() / 1000) + CONTEXT_TTL_SECONDS,
    nonce: crypto.randomUUID().replaceAll("-", ""),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded, config).toString("base64url")}`;
}

export function verifyOwnerRegistrationContext(
  context: string,
  config: RuntimeConfig,
): RegistrationPayload {
  const [encoded, suppliedSignature, extra] = context.split(".");
  if (!encoded || !suppliedSignature || extra) {
    throw new Error("Invalid owner registration context");
  }
  const supplied = Buffer.from(suppliedSignature, "base64url");
  const expected = signature(encoded, config);
  if (
    supplied.toString("base64url") !== suppliedSignature ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new Error("Invalid owner registration context");
  }
  const payload = payloadSchema.parse(
    JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
  );
  if (payload.expiresAt < Math.floor(Date.now() / 1000)) {
    throw new Error("Owner registration context has expired");
  }
  return payload;
}

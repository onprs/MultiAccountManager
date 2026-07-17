import { rotateRecoveryEnvelopeRequestSchema } from "@/crypto/schema";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import { rotateRecoveryEnvelope, VaultServiceError } from "@/server/vault/service";

export async function POST(request: Request) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  const body = rotateRecoveryEnvelopeRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) return apiError(request, 400, "INVALID_RECOVERY_ENVELOPE", "Recovery envelope is invalid");
  try {
    const vault = await rotateRecoveryEnvelope({
      ownerUserId: owner.userId,
      sessionId: owner.sessionId,
      ...body.data,
      requestId: requestId(request),
    });
    return noStoreJson({ vault });
  } catch (error) {
    if (error instanceof VaultServiceError) {
      const status = error.code === "PASSKEY_STEP_UP_REQUIRED" ? 403 : 409;
      return apiError(request, status, error.code, error.message);
    }
    return apiError(request, 503, "RECOVERY_ROTATION_FAILED", "Recovery key rotation failed");
  }
}

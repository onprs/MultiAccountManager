import { confirmRecoveryKitRequestSchema } from "@/crypto/schema";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import { finalizeSetupAfterRecoveryConfirmation } from "@/server/setup/finalize-vault";
import { confirmRecoveryKit, VaultServiceError } from "@/server/vault/service";

export async function POST(request: Request) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  }
  const body = confirmRecoveryKitRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return apiError(request, 400, "INVALID_RECOVERY_CONFIRMATION", "Recovery confirmation is invalid");
  }
  try {
    const vault = await confirmRecoveryKit({
      ownerUserId: owner.userId,
      expectedRevision: body.data.expectedRevision,
      requestId: requestId(request),
    });
    await finalizeSetupAfterRecoveryConfirmation(owner.userId);
    return noStoreJson({ vault, setupState: "ready" });
  } catch (error) {
    if (error instanceof VaultServiceError) {
      return apiError(request, 409, error.code, error.message);
    }
    return apiError(request, 503, "RECOVERY_CONFIRMATION_FAILED", "Recovery confirmation failed");
  }
}

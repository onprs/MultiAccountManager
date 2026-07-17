import { apiError, noStoreJson, requestId } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import { integrationError, rotateServiceKeyRing } from "@/server/integrations/service";
import { rotateServiceCiphertexts } from "@/server/integrations/sync";

export async function POST(request: Request) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  try {
    const keyRing = await rotateServiceKeyRing({
      ownerUserId: owner.userId,
      sessionId: owner.sessionId,
      requestId: requestId(request),
    });
    const migrated = await rotateServiceCiphertexts();
    return noStoreJson({ keyRing, migrated });
  } catch (error) {
    const normalized = integrationError(error);
    return apiError(request, normalized.status, normalized.code, normalized.message);
  }
}

import { z } from "zod";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { revealRecoveryCodes } from "@/server/accounts/recovery-code-service";
import { ManagedAccountServiceError } from "@/server/accounts/service";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";

const idSchema = z.string().uuid();
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  }
  const id = idSchema.safeParse((await context.params).id);
  if (!id.success) return apiError(request, 404, "ACCOUNT_NOT_FOUND", "Account was not found");
  try {
    const codes = await revealRecoveryCodes({
      ownerUserId: owner.userId,
      sessionId: owner.sessionId,
      accountId: id.data,
      requestId: requestId(request),
    });
    return noStoreJson({ codes });
  } catch (error) {
    if (error instanceof ManagedAccountServiceError) {
      const status = error.code === "PASSKEY_STEP_UP_REQUIRED" ? 403 : 409;
      return apiError(request, status, error.code, error.message);
    }
    return apiError(request, 503, "RECOVERY_CODE_REVEAL_FAILED", "Recovery codes could not be revealed");
  }
}

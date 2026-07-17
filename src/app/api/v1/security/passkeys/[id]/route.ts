import { z } from "zod";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import {
  deletePasskey,
  PasskeyManagementError,
  renamePasskey,
} from "@/server/auth/passkey-management";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import { hasRecentPasskeyStepUp } from "@/server/auth/step-up";

const renameSchema = z.object({ name: z.string().trim().min(1).max(100) });

type RouteContext = { params: Promise<{ id: string }> };

async function writeContext(request: Request, context: RouteContext) {
  if (!(await validateApplicationOrigin(request))) {
    return { error: apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed") };
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return { error: apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required") };
  }
  const { id } = await context.params;
  if (!id || id.length > 255) {
    return { error: apiError(request, 400, "INVALID_PASSKEY_ID", "Passkey ID is invalid") };
  }
  return { owner, id };
}

export async function PATCH(request: Request, context: RouteContext) {
  const resolved = await writeContext(request, context);
  if ("error" in resolved) return resolved.error;
  const body = renameSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return apiError(request, 400, "INVALID_PASSKEY_NAME", "Passkey name is invalid");
  }
  try {
    await renamePasskey({
      userId: resolved.owner.userId,
      passkeyId: resolved.id,
      name: body.data.name,
      requestId: requestId(request),
    });
    return noStoreJson({ updated: true });
  } catch (error) {
    if (error instanceof PasskeyManagementError) {
      return apiError(request, 404, error.code, error.message);
    }
    return apiError(request, 503, "PASSKEY_UPDATE_FAILED", "Passkey update failed");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const resolved = await writeContext(request, context);
  if ("error" in resolved) return resolved.error;
  if (!(await hasRecentPasskeyStepUp(resolved.owner))) {
    return apiError(
      request,
      403,
      "PASSKEY_STEP_UP_REQUIRED",
      "Recent Passkey verification is required",
    );
  }
  try {
    await deletePasskey({
      userId: resolved.owner.userId,
      sessionId: resolved.owner.sessionId,
      passkeyId: resolved.id,
      requestId: requestId(request),
    });
    return noStoreJson({ deleted: true });
  } catch (error) {
    if (error instanceof PasskeyManagementError) {
      const status = error.code === "PASSKEY_NOT_FOUND" ? 404 : 409;
      return apiError(request, status, error.code, error.message);
    }
    return apiError(request, 503, "PASSKEY_DELETE_FAILED", "Passkey deletion failed");
  }
}

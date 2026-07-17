import { z } from "zod";
import {
  deleteRecoveryCodeRequestSchema,
  updateRecoveryCodeRequestSchema,
} from "@/accounts/schema";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import {
  deleteRecoveryCode,
  setRecoveryCodeUsed,
} from "@/server/accounts/recovery-code-service";
import { ManagedAccountServiceError } from "@/server/accounts/service";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";

const idSchema = z.string().uuid();
type Context = { params: Promise<{ id: string; codeId: string }> };

async function ids(context: Context) {
  const params = await context.params;
  const accountId = idSchema.safeParse(params.id);
  const codeId = idSchema.safeParse(params.codeId);
  return accountId.success && codeId.success
    ? { accountId: accountId.data, codeId: codeId.data }
    : null;
}

export async function PATCH(request: Request, context: Context) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  }
  const resolved = await ids(context);
  if (!resolved) return apiError(request, 404, "RECOVERY_CODE_NOT_FOUND", "Recovery code was not found");
  const body = updateRecoveryCodeRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return apiError(request, 400, "INVALID_RECOVERY_CODE_UPDATE", "Recovery code update is invalid");
  }
  try {
    const code = await setRecoveryCodeUsed({
      ownerUserId: owner.userId,
      ...resolved,
      ...body.data,
      requestId: requestId(request),
    });
    return noStoreJson({ code });
  } catch (error) {
    if (error instanceof ManagedAccountServiceError) {
      return apiError(request, 409, error.code, error.message);
    }
    return apiError(request, 503, "RECOVERY_CODE_UPDATE_FAILED", "Recovery code update failed");
  }
}

export async function DELETE(request: Request, context: Context) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  }
  const resolved = await ids(context);
  if (!resolved) return apiError(request, 404, "RECOVERY_CODE_NOT_FOUND", "Recovery code was not found");
  const body = deleteRecoveryCodeRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return apiError(request, 400, "INVALID_RECOVERY_CODE_REVISION", "Recovery code revision is invalid");
  }
  try {
    await deleteRecoveryCode({
      ownerUserId: owner.userId,
      ...resolved,
      expectedRevision: body.data.expectedRevision,
      requestId: requestId(request),
    });
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "private, no-store", Pragma: "no-cache" },
    });
  } catch (error) {
    if (error instanceof ManagedAccountServiceError) {
      return apiError(request, 409, error.code, error.message);
    }
    return apiError(request, 503, "RECOVERY_CODE_DELETE_FAILED", "Recovery code deletion failed");
  }
}

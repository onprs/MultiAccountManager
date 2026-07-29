import { z } from "zod";
import {
  deleteManagedAccountRequestSchema,
  updateManagedAccountRequestSchema,
} from "@/accounts/schema";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import {
  deleteManagedAccount,
  getManagedAccount,
  ManagedAccountServiceError,
  updateManagedAccount,
} from "@/server/accounts/service";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";

const accountIdSchema = z.string().uuid();
type Context = { params: Promise<{ id: string }> };

async function accountId(context: Context): Promise<string | null> {
  const parsed = accountIdSchema.safeParse((await context.params).id);
  return parsed.success ? parsed.data : null;
}

export async function GET(request: Request, context: Context) {
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(
      request,
      401,
      "OWNER_SESSION_REQUIRED",
      "An owner session is required",
    );
  }
  const id = await accountId(context);
  if (!id) return apiError(request, 404, "ACCOUNT_NOT_FOUND", "Account was not found");
  try {
    const account = await getManagedAccount(owner.userId, id);
    return account
      ? noStoreJson({ account })
      : apiError(request, 404, "ACCOUNT_NOT_FOUND", "Account was not found");
  } catch {
    return apiError(request, 503, "ACCOUNT_UNAVAILABLE", "Account is unavailable");
  }
}

export async function PATCH(request: Request, context: Context) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(
      request,
      401,
      "OWNER_SESSION_REQUIRED",
      "An owner session is required",
    );
  }
  const id = await accountId(context);
  if (!id) return apiError(request, 404, "ACCOUNT_NOT_FOUND", "Account was not found");
  const body = updateManagedAccountRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return apiError(
      request,
      400,
      "INVALID_ACCOUNT_ENVELOPE",
      "Managed account envelope is invalid",
    );
  }
  try {
    const account = await updateManagedAccount({
      id,
      ownerUserId: owner.userId,
      ...body.data,
      requestId: requestId(request),
    });
    return noStoreJson({ account });
  } catch (error) {
    if (error instanceof ManagedAccountServiceError) {
      return apiError(request, 409, error.code, error.message);
    }
    return apiError(request, 503, "ACCOUNT_UPDATE_FAILED", "Managed account update failed");
  }
}

export async function DELETE(request: Request, context: Context) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(
      request,
      401,
      "OWNER_SESSION_REQUIRED",
      "An owner session is required",
    );
  }
  const id = await accountId(context);
  if (!id) return apiError(request, 404, "ACCOUNT_NOT_FOUND", "Account was not found");
  const body = deleteManagedAccountRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return apiError(request, 400, "INVALID_ACCOUNT_REVISION", "Account revision is invalid");
  }
  try {
    await deleteManagedAccount({
      id,
      ownerUserId: owner.userId,
      expectedRevision: body.data.expectedRevision,
      requestId: requestId(request),
    });
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "private, no-store", Pragma: "no-cache" },
    });
  } catch (error) {
    if (error instanceof ManagedAccountServiceError) {
      return apiError(request, error.status, error.code, error.message);
    }
    return apiError(request, 503, "ACCOUNT_DELETE_FAILED", "Managed account deletion failed");
  }
}

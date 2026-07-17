import { connectionIdSchema, updateConnectionRequestSchema } from "@/integrations/schema";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import {
  deleteConnection,
  integrationError,
  updateConnection,
} from "@/server/integrations/service";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: Context) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  const id = connectionIdSchema.safeParse((await context.params).id);
  if (!id.success) {
    return apiError(request, 400, "INVALID_CONNECTION_ID", "Connection ID is invalid");
  }
  try {
    await deleteConnection({
      id: id.data,
      ownerUserId: owner.userId,
      sessionId: owner.sessionId,
      requestId: requestId(request),
    });
    return noStoreJson({ deleted: true });
  } catch (error) {
    const normalized = integrationError(error);
    return apiError(request, normalized.status, normalized.code, normalized.message);
  }
}

export async function PATCH(request: Request, context: Context) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  const id = connectionIdSchema.safeParse((await context.params).id);
  const body = updateConnectionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!id.success || !body.success) {
    return apiError(request, 400, "INVALID_CONNECTION_UPDATE", "Connection update is invalid");
  }
  try {
    const connection = await updateConnection({
      id: id.data,
      ownerUserId: owner.userId,
      sessionId: owner.sessionId,
      ...body.data,
      requestId: requestId(request),
    });
    return noStoreJson({ connection });
  } catch (error) {
    const normalized = integrationError(error);
    return apiError(request, normalized.status, normalized.code, normalized.message);
  }
}

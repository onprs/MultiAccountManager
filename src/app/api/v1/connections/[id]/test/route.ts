import { connectionIdSchema } from "@/integrations/schema";
import { apiError, noStoreJson } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import { integrationError, testStoredConnection } from "@/server/integrations/service";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  const id = connectionIdSchema.safeParse((await context.params).id);
  if (!id.success) return apiError(request, 404, "CONNECTION_NOT_FOUND", "Connection was not found");
  try {
    return noStoreJson({ test: await testStoredConnection({ id: id.data, ownerUserId: owner.userId }) });
  } catch (error) {
    const normalized = integrationError(error);
    return apiError(request, normalized.status, normalized.code, normalized.message);
  }
}

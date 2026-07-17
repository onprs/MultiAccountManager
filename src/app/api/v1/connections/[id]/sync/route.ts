import { connectionIdSchema } from "@/integrations/schema";
import { apiError, noStoreJson } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import { enqueueManualConnectionSync } from "@/server/jobs/runtime";
import { listConnections } from "@/server/integrations/service";

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
    const exists = (await listConnections(owner.userId)).some((connection) => connection.id === id.data);
    if (!exists) return apiError(request, 404, "CONNECTION_NOT_FOUND", "Connection was not found");
    const jobId = await enqueueManualConnectionSync(id.data);
    return noStoreJson({ queued: Boolean(jobId), jobId }, { status: 202 });
  } catch {
    return apiError(request, 503, "SYNC_QUEUE_UNAVAILABLE", "Sync queue is unavailable");
  }
}

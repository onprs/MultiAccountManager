import { createConnectionRequestSchema } from "@/integrations/schema";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import {
  createConnection,
  integrationError,
  listConnections,
} from "@/server/integrations/service";
import { enqueueManualConnectionSync } from "@/server/jobs/runtime";

export async function GET(request: Request) {
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  try {
    return noStoreJson({ connections: await listConnections(owner.userId) });
  } catch {
    return apiError(request, 503, "CONNECTIONS_UNAVAILABLE", "Connections are unavailable");
  }
}

export async function POST(request: Request) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  const body = createConnectionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(request, 400, "INVALID_CONNECTION", "Connection settings are invalid");
  try {
    const result = await createConnection({
      ownerUserId: owner.userId,
      sessionId: owner.sessionId,
      ...body.data,
      requestId: requestId(request),
    });
    const syncJobId = await enqueueManualConnectionSync(result.connection.id).catch(() => null);
    return noStoreJson({ ...result, syncQueued: Boolean(syncJobId) }, { status: 201 });
  } catch (error) {
    const normalized = integrationError(error);
    return apiError(request, normalized.status, normalized.code, normalized.message);
  }
}

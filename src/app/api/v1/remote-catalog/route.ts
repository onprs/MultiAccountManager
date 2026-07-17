import { connectionIdSchema } from "@/integrations/schema";
import { apiError, noStoreJson } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { listRemoteCatalog } from "@/server/integrations/service";

export async function GET(request: Request) {
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  const connectionId = connectionIdSchema.safeParse(new URL(request.url).searchParams.get("connectionId"));
  if (!connectionId.success) return apiError(request, 400, "INVALID_CONNECTION_ID", "Connection ID is invalid");
  try {
    return noStoreJson({ items: await listRemoteCatalog({ ownerUserId: owner.userId, connectionId: connectionId.data }) });
  } catch {
    return apiError(request, 503, "REMOTE_CATALOG_UNAVAILABLE", "Remote catalog is unavailable");
  }
}

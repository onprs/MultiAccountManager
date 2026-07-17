import { apiError, noStoreJson } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { getWorkerDiagnostic } from "@/server/integrations/service";

export async function GET(request: Request) {
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  try {
    return noStoreJson({ worker: await getWorkerDiagnostic() });
  } catch {
    return apiError(request, 503, "WORKER_DIAGNOSTIC_UNAVAILABLE", "Worker diagnostic is unavailable");
  }
}

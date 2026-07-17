import { apiError, noStoreJson } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { listPasskeys } from "@/server/auth/passkey-management";

export async function GET(request: Request) {
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  }
  try {
    return noStoreJson({ passkeys: await listPasskeys(owner.userId) });
  } catch {
    return apiError(request, 503, "PASSKEY_LIST_UNAVAILABLE", "Passkeys are unavailable");
  }
}

import { batchUpdateManagedAccountsRequestSchema } from "@/accounts/schema";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import {
  batchUpdateManagedAccounts,
  ManagedAccountServiceError,
} from "@/server/accounts/service";

export async function POST(request: Request) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  }
  const body = batchUpdateManagedAccountsRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return apiError(
      request,
      400,
      "INVALID_BATCH_UPDATE_PAYLOAD",
      "Batch update payload is invalid",
    );
  }
  try {
    const result = await batchUpdateManagedAccounts({
      ownerUserId: owner.userId,
      updates: body.data.updates,
      localStatus: body.data.localStatus,
      requestId: requestId(request),
    });
    return noStoreJson(result);
  } catch (error) {
    if (error instanceof ManagedAccountServiceError) {
      return apiError(request, error.status, error.code, error.message);
    }
    return apiError(request, 503, "BATCH_UPDATE_FAILED", "Batch update failed");
  }
}

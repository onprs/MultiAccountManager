import { batchDeleteManagedAccountsRequestSchema } from "@/accounts/schema";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import {
  batchDeleteManagedAccounts,
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
  const body = batchDeleteManagedAccountsRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return apiError(
      request,
      400,
      "INVALID_BATCH_DELETE_PAYLOAD",
      "Batch delete payload is invalid",
    );
  }
  try {
    const result = await batchDeleteManagedAccounts({
      ownerUserId: owner.userId,
      deletes: body.data.deletes,
      requestId: requestId(request),
    });
    return noStoreJson(result);
  } catch (error) {
    if (error instanceof ManagedAccountServiceError) {
      return apiError(request, error.status, error.code, error.message);
    }
    return apiError(request, 503, "BATCH_DELETE_FAILED", "Batch delete failed");
  }
}

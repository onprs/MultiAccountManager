import {
  createManagedAccountRequestSchema,
  managedAccountListQuerySchema,
} from "@/accounts/schema";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import {
  createManagedAccount,
  listManagedAccounts,
  ManagedAccountServiceError,
} from "@/server/accounts/service";

export async function GET(request: Request) {
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(
      request,
      401,
      "OWNER_SESSION_REQUIRED",
      "An owner session is required",
    );
  }
  const query = managedAccountListQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) {
    return apiError(request, 400, "INVALID_ACCOUNT_QUERY", "Account query is invalid");
  }
  try {
    return noStoreJson(
      await listManagedAccounts({ ownerUserId: owner.userId, ...query.data }),
    );
  } catch {
    return apiError(request, 503, "ACCOUNTS_UNAVAILABLE", "Accounts are unavailable");
  }
}

export async function POST(request: Request) {
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
  const body = createManagedAccountRequestSchema.safeParse(
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
    const account = await createManagedAccount({
      ownerUserId: owner.userId,
      ...body.data,
      requestId: requestId(request),
    });
    return noStoreJson({ account }, { status: 201 });
  } catch (error) {
    if (error instanceof ManagedAccountServiceError) {
      return apiError(request, 409, error.code, error.message);
    }
    return apiError(request, 503, "ACCOUNT_CREATE_FAILED", "Managed account creation failed");
  }
}

import { z } from "zod";
import { createRecoveryCodesRequestSchema } from "@/accounts/schema";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import {
  createRecoveryCodes,
  listRecoveryCodes,
} from "@/server/accounts/recovery-code-service";
import { ManagedAccountServiceError } from "@/server/accounts/service";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";

const idSchema = z.string().uuid();
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  }
  const id = idSchema.safeParse((await context.params).id);
  if (!id.success) return apiError(request, 404, "ACCOUNT_NOT_FOUND", "Account was not found");
  try {
    return noStoreJson(
      await listRecoveryCodes({ ownerUserId: owner.userId, accountId: id.data }),
    );
  } catch {
    return apiError(request, 503, "RECOVERY_CODES_UNAVAILABLE", "Recovery codes are unavailable");
  }
}

export async function POST(request: Request, context: Context) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) {
    return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  }
  const id = idSchema.safeParse((await context.params).id);
  if (!id.success) return apiError(request, 404, "ACCOUNT_NOT_FOUND", "Account was not found");
  const body = createRecoveryCodesRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return apiError(
      request,
      400,
      "INVALID_RECOVERY_CODE_ENVELOPES",
      "Recovery code envelopes are invalid",
    );
  }
  try {
    const result = await createRecoveryCodes({
      ownerUserId: owner.userId,
      accountId: id.data,
      codes: body.data.codes,
      requestId: requestId(request),
    });
    return noStoreJson(result, { status: 201 });
  } catch (error) {
    if (error instanceof ManagedAccountServiceError) {
      const status = error.code === "ACCOUNT_NOT_FOUND" ? 404 : 409;
      return apiError(request, status, error.code, error.message);
    }
    return apiError(request, 503, "RECOVERY_CODE_CREATE_FAILED", "Recovery codes could not be created");
  }
}

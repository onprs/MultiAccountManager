import { z } from "zod";
import { createLinkRequestSchema } from "@/integrations/schema";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import {
  createAccountLink,
  integrationError,
  listAccountLinks,
} from "@/server/integrations/service";

export async function GET(request: Request) {
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  const raw = new URL(request.url).searchParams.get("managedAccountId");
  const managedAccountId = raw ? z.string().uuid().safeParse(raw) : null;
  if (managedAccountId && !managedAccountId.success) {
    return apiError(request, 400, "INVALID_ACCOUNT_ID", "Managed account ID is invalid");
  }
  try {
    return noStoreJson({ links: await listAccountLinks({
      ownerUserId: owner.userId,
      managedAccountId: managedAccountId?.data,
    }) });
  } catch {
    return apiError(request, 503, "LINKS_UNAVAILABLE", "Account links are unavailable");
  }
}

export async function POST(request: Request) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  const body = createLinkRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(request, 400, "INVALID_LINK", "Account link is invalid");
  try {
    await createAccountLink({ ownerUserId: owner.userId, ...body.data, requestId: requestId(request) });
    return noStoreJson({ linked: true }, { status: 201 });
  } catch (error) {
    const normalized = integrationError(error);
    return apiError(request, normalized.status, normalized.code, normalized.message);
  }
}

import { z } from "zod";
import { apiError, requestId } from "@/lib/http";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import { deleteAccountLink, integrationError } from "@/server/integrations/service";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: Context) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  const id = z.string().uuid().safeParse((await context.params).id);
  if (!id.success) return apiError(request, 404, "LINK_NOT_FOUND", "Link was not found");
  try {
    await deleteAccountLink({ ownerUserId: owner.userId, linkId: id.data, requestId: requestId(request) });
    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const normalized = integrationError(error);
    return apiError(request, normalized.status, normalized.code, normalized.message);
  }
}

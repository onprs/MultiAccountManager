import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, noStoreJson } from "@/lib/http";
import { getRuntimeStatus } from "@/runtime/status";
import { createOrLoadOwner, OwnerSetupError } from "@/server/setup/owner";
import { guardSetupWrite } from "@/server/setup/route-guard";

const ownerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(320),
});

export async function POST(request: NextRequest) {
  const rejected = await guardSetupWrite(request);
  if (rejected) return rejected;
  const runtime = await getRuntimeStatus();
  if (runtime.state !== "creating_owner") {
    return apiError(
      request,
      409,
      "DATABASE_INITIALIZATION_REQUIRED",
      "Database initialization must finish before owner creation",
    );
  }

  const body = ownerSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return apiError(request, 400, "INVALID_OWNER", "Owner name or email is invalid");
  }
  try {
    const result = await createOrLoadOwner(body.data);
    return noStoreJson({
      owner: result.owner,
      registrationContext: result.registrationContext,
    });
  } catch (error) {
    if (error instanceof OwnerSetupError) {
      return apiError(request, 409, error.code, error.message);
    }
    return apiError(request, 500, "OWNER_CREATION_FAILED", "Owner creation failed");
  }
}

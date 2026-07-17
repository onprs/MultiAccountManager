import { NextRequest } from "next/server";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { revokeSetupSessions } from "@/server/setup/access";
import { completeOwnerSetup, OwnerSetupError } from "@/server/setup/owner";
import { guardSetupWrite } from "@/server/setup/route-guard";

export async function POST(request: NextRequest) {
  const rejected = await guardSetupWrite(request);
  if (rejected) return rejected;
  try {
    const owner = await completeOwnerSetup(requestId(request));
    const response = noStoreJson({
      state: "creating_vault",
      owner: { id: owner.id, name: owner.name },
    });
    revokeSetupSessions(response);
    return response;
  } catch (error) {
    if (error instanceof OwnerSetupError) {
      return apiError(request, 409, error.code, error.message);
    }
    return apiError(request, 500, "SETUP_COMPLETION_FAILED", "Setup completion failed");
  }
}

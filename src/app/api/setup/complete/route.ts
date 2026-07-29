import { NextRequest } from "next/server";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { revokeSetupSessions } from "@/server/setup/access";
import { completeOwnerSetup, OwnerSetupError } from "@/server/setup/owner";
import { guardSetupWrite } from "@/server/setup/route-guard";

export async function POST(request: NextRequest) {
  const rejected = await guardSetupWrite(request);
  if (rejected) return rejected;
  try {
    const result = await completeOwnerSetup(requestId(request));
    const response = noStoreJson({
      state: result.setupState,
      owner: { id: result.owner.id, name: result.owner.name },
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

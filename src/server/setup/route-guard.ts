import type { NextRequest } from "next/server";
import { apiError } from "@/lib/http";
import { getRuntimeStatus } from "@/runtime/status";
import { hasSetupSession, validateWriteOrigin } from "./access";

export async function guardSetupWrite(request: NextRequest) {
  if (!validateWriteOrigin(request)) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const status = await getRuntimeStatus();
  if (status.state === "creating_vault" || status.state === "ready") {
    return apiError(request, 410, "SETUP_COMPLETE", "System setup is already complete");
  }
  if (status.state === "invalid_config") {
    return apiError(
      request,
      503,
      "RUNTIME_CONFIG_INVALID",
      "Runtime configuration must be repaired from the server",
    );
  }
  if (!hasSetupSession(request)) {
    return apiError(request, 401, "SETUP_SESSION_REQUIRED", "A valid setup session is required");
  }
  return null;
}

import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, noStoreJson } from "@/lib/http";
import { getRuntimeStatus } from "@/runtime/status";
import {
  createSetupSession,
  issueSetupSession,
  validateWriteOrigin,
} from "@/server/setup/access";

const requestSchema = z.object({ setupToken: z.string().min(1).max(4096) });

export async function POST(request: NextRequest) {
  if (!validateWriteOrigin(request)) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const runtime = await getRuntimeStatus();
  if (runtime.state === "creating_vault" || runtime.state === "ready") {
    return apiError(request, 410, "SETUP_COMPLETE", "System setup is already complete");
  }
  if (runtime.state === "invalid_config") {
    return apiError(
      request,
      503,
      "RUNTIME_CONFIG_INVALID",
      "Runtime configuration must be repaired from the server",
    );
  }

  const body = requestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return apiError(request, 400, "INVALID_REQUEST", "A setup token is required");
  }
  const result = await createSetupSession(request, body.data.setupToken);
  if (result === "rate_limited") {
    return apiError(request, 429, "SETUP_RATE_LIMITED", "Too many setup attempts");
  }
  if (result !== "ok") {
    return apiError(request, 401, "SETUP_TOKEN_INVALID", "The setup token is invalid");
  }

  const response = noStoreJson({ authenticated: true });
  issueSetupSession(response);
  return response;
}

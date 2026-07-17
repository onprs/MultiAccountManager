import { NextRequest } from "next/server";
import { initializeRequestSchema } from "@/runtime/types";
import { getRuntimeStatus } from "@/runtime/status";
import { apiError, noStoreJson } from "@/lib/http";
import { DatabaseValidationError } from "@/server/database/test-connection";
import {
  initializeSystem,
  InitializationInProgressError,
} from "@/server/setup/initialize";
import { guardSetupWrite } from "@/server/setup/route-guard";

export async function POST(request: NextRequest) {
  const rejected = await guardSetupWrite(request);
  if (rejected) return rejected;

  const runtime = await getRuntimeStatus();
  if (runtime.state !== "unconfigured") {
    return apiError(
      request,
      409,
      "INITIALIZATION_ALREADY_STARTED",
      "Database initialization has already completed",
    );
  }

  const body = initializeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return apiError(request, 400, "INVALID_INITIALIZATION", "Initialization fields are invalid");
  }
  try {
    const config = await initializeSystem(body.data);
    return noStoreJson({ state: config.setupState }, { status: 201 });
  } catch (error) {
    if (error instanceof InitializationInProgressError) {
      return apiError(request, 409, "INITIALIZATION_IN_PROGRESS", error.message);
    }
    if (error instanceof DatabaseValidationError) {
      return apiError(request, 400, error.code, error.message);
    }
    return apiError(request, 500, "INITIALIZATION_FAILED", "System initialization failed");
  }
}

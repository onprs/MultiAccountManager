import { NextRequest } from "next/server";
import { databaseConfigSchema } from "@/runtime/types";
import { apiError, noStoreJson } from "@/lib/http";
import {
  DatabaseValidationError,
  testDatabaseConnection,
} from "@/server/database/test-connection";
import { guardSetupWrite } from "@/server/setup/route-guard";

export async function POST(request: NextRequest) {
  const rejected = await guardSetupWrite(request);
  if (rejected) return rejected;

  const body = databaseConfigSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return apiError(request, 400, "INVALID_DATABASE_CONFIG", "Database fields are invalid");
  }
  try {
    return noStoreJson(await testDatabaseConnection(body.data));
  } catch (error) {
    if (error instanceof DatabaseValidationError) {
      return apiError(request, 400, error.code, error.message);
    }
    return apiError(request, 500, "DATABASE_TEST_FAILED", "Database validation failed");
  }
}

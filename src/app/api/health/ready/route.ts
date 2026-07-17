import { noStoreJson } from "@/lib/http";
import { readRuntimeConfig } from "@/runtime/config-store";
import { verifyDatabaseReadiness } from "@/server/database/readiness";

export async function GET() {
  try {
    const config = await readRuntimeConfig();
    if (config.setupState !== "ready") {
      return noStoreJson(
        { status: "not_ready", reason: config.setupState },
        { status: 503 },
      );
    }
    await verifyDatabaseReadiness(config.database);
    return noStoreJson({ status: "ready" });
  } catch {
    return noStoreJson(
      { status: "not_ready", reason: "runtime_or_database_unavailable" },
      { status: 503 },
    );
  }
}

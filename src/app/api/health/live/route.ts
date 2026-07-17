import { noStoreJson } from "@/lib/http";
import { getRuntimeStatus } from "@/runtime/status";

export async function GET() {
  const runtime = await getRuntimeStatus();
  return noStoreJson({
    status: "live",
    releaseId: process.env.ACCOUNT_VAULT_RELEASE_ID ?? "development",
    setupRequired: runtime.setupRequired,
  });
}

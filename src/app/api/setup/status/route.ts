import { noStoreJson } from "@/lib/http";
import { getRuntimeStatus } from "@/runtime/status";

export async function GET() {
  const status = await getRuntimeStatus();
  return noStoreJson({
    state: status.state,
    setupRequired: status.setupRequired,
    setupTokenRequired: !["creating_vault", "ready"].includes(status.state),
    version: process.env.ACCOUNT_VAULT_RELEASE_ID ?? "development",
  });
}

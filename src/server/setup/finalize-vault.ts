import { readRuntimeConfig, writeRuntimeConfig } from "@/runtime/config-store";
import { getVault } from "@/server/vault/service";

export async function finalizeSetupAfterRecoveryConfirmation(
  ownerUserId: string,
): Promise<void> {
  const config = await readRuntimeConfig();
  if (config.setupState === "ready") return;
  if (config.setupState !== "creating_vault") {
    throw new Error("Vault setup cannot be finalized in the current runtime state");
  }
  const vault = await getVault(ownerUserId);
  if (!vault?.recoveryConfirmedAt) {
    throw new Error("Recovery Kit must be confirmed before READY");
  }
  await writeRuntimeConfig({
    ...config,
    setupState: "ready",
    updatedAt: new Date().toISOString(),
  });
}

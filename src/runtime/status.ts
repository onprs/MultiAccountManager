import { readRuntimeConfig, RuntimeConfigNotFoundError } from "./config-store";
import type { SetupState } from "./types";

export type RuntimeStatus = {
  state: "unconfigured" | SetupState | "invalid_config";
  setupRequired: boolean;
};

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  try {
    const config = await readRuntimeConfig();
    return {
      state: config.setupState,
      setupRequired: config.setupState !== "ready",
    };
  } catch (error) {
    if (error instanceof RuntimeConfigNotFoundError) {
      return { state: "unconfigured", setupRequired: true };
    }
    return { state: "invalid_config", setupRequired: true };
  }
}

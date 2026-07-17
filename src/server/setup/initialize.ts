import type { InitializeRequest, RuntimeConfig } from "./initialize-types";
import { testDatabaseConnection } from "@/server/database/test-connection";
import { runMigrations } from "@/server/database/migrate";
import { randomBase64Url } from "@/runtime/random";
import { writeRuntimeConfig } from "@/runtime/config-store";

const globalInitialization = globalThis as typeof globalThis & {
  __accountVaultInitializing?: boolean;
};

export class InitializationInProgressError extends Error {
  constructor() {
    super("System initialization is already in progress");
    this.name = "InitializationInProgressError";
  }
}

export async function initializeSystem(input: InitializeRequest): Promise<RuntimeConfig> {
  if (globalInitialization.__accountVaultInitializing) {
    throw new InitializationInProgressError();
  }
  globalInitialization.__accountVaultInitializing = true;
  try {
    await testDatabaseConnection(input.database);
    await runMigrations(input.database);
    const now = new Date().toISOString();
    const config: RuntimeConfig = {
      version: 1,
      setupState: "creating_owner",
      database: input.database,
      application: input.application,
      auth: { secret: randomBase64Url(32) },
      serviceEncryption: {
        keys: [{ id: "service-v1", key: randomBase64Url(32), status: "current" }],
      },
      createdAt: now,
      updatedAt: now,
    };
    await writeRuntimeConfig(config);
    return config;
  } finally {
    globalInitialization.__accountVaultInitializing = false;
  }
}

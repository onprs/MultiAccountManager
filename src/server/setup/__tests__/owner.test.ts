import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@/runtime/types";

const mocks = vi.hoisted(() => ({
  readRuntimeConfig: vi.fn(),
  writeRuntimeConfig: vi.fn(),
  createDatabaseClient: vi.fn(),
  closeDatabaseClient: vi.fn(async () => undefined),
  createOwnerRegistrationContext: vi.fn(() => "registration-context"),
  events: [] as string[],
}));

vi.mock("@/runtime/config-store", () => ({
  readRuntimeConfig: mocks.readRuntimeConfig,
  writeRuntimeConfig: mocks.writeRuntimeConfig,
}));
vi.mock("@/server/database/connection", () => ({
  createDatabaseClient: mocks.createDatabaseClient,
  closeDatabaseClient: mocks.closeDatabaseClient,
}));
vi.mock("@/server/auth/registration-context", () => ({
  createOwnerRegistrationContext: mocks.createOwnerRegistrationContext,
}));

import {
  completeOwnerSetup,
  createOrLoadOwner,
} from "@/server/setup/owner";

const owner = {
  id: "df76cfe7-a28d-4b51-b5f7-a8f022e87bf2",
  name: "Owner",
  email: "owner@example.test",
  role: "owner" as const,
};

function config(withMigration: boolean): RuntimeConfig {
  const previousApplication = {
    publicUrl: "https://old.example.com",
    webAuthnRpId: "old.example.com",
    webAuthnRpName: "Account Vault",
    webAuthnOrigin: "https://old.example.com",
    siteName: "Account Vault",
    timeZone: "UTC",
  };
  return {
    version: 1,
    setupState: "creating_owner",
    database: {
      host: "127.0.0.1",
      port: 5432,
      database: "account_vault",
      schema: "account_vault",
      jobSchema: "account_vault_jobs",
      username: "account_vault",
      password: "database-password",
      sslMode: "disable",
      connectTimeoutSeconds: 5,
      webPoolSize: 10,
      workerPoolSize: 5,
    },
    application: withMigration
      ? {
          ...previousApplication,
          publicUrl: "https://vault.example.net",
          webAuthnOrigin: "https://vault.example.net",
          webAuthnRpId: "vault.example.net",
        }
      : previousApplication,
    auth: { secret: "A".repeat(43) },
    serviceEncryption: {
      keys: [{ id: "service-v1", key: "B".repeat(43), status: "current" }],
    },
    domainMigration: withMigration
      ? {
          id: "9d4ac0c2-421e-4fc8-8977-eaa731050938",
          previousApplication,
          preparedAt: "2026-07-17T10:00:00.000Z",
        }
      : undefined,
    createdAt: "2026-07-17T09:00:00.000Z",
    updatedAt: "2026-07-17T10:00:00.000Z",
  };
}

function completionDatabase(state: {
  vaultReady: boolean;
  migrationPrepared?: boolean;
  migrationCompleted?: boolean;
}) {
  const transaction = Object.assign(
    async (strings: TemplateStringsArray) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      if (query.includes("pg_advisory_xact_lock")) return [];
      if (query.includes("count(passkeys.id)")) {
        return [{
          ...owner,
          passkeyCount: 1,
          vaultReady: state.vaultReady,
          migrationPrepared: state.migrationPrepared ?? false,
          migrationCompleted: state.migrationCompleted ?? false,
        }];
      }
      if (query.includes("application.domain_migration.completed")) {
        mocks.events.push("migration-completed-audit");
        return { count: 1 };
      }
      if (query.includes("'setup.completed'")) {
        mocks.events.push("setup-completed-audit");
        return { count: 1 };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    { json: (value: unknown) => value },
  );
  return {
    begin: async (callback: (sql: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
});

describe("owner setup completion", () => {
  it("completes a prepared domain migration and clears its runtime marker", async () => {
    const runtime = config(true);
    mocks.readRuntimeConfig.mockResolvedValue(runtime);
    mocks.createDatabaseClient.mockReturnValue(completionDatabase({
      vaultReady: true,
      migrationPrepared: true,
      migrationCompleted: false,
    }));

    await expect(completeOwnerSetup("request-1")).resolves.toMatchObject({
      owner,
      setupState: "ready",
    });

    expect(mocks.events).toEqual(["migration-completed-audit"]);
    const written = mocks.writeRuntimeConfig.mock.calls[0]?.[0] as RuntimeConfig;
    expect(written.setupState).toBe("ready");
    expect(written.domainMigration).toBeUndefined();
  });

  it("retries the runtime write without duplicating a committed completion", async () => {
    mocks.readRuntimeConfig.mockResolvedValue(config(true));
    mocks.createDatabaseClient.mockReturnValue(completionDatabase({
      vaultReady: true,
      migrationPrepared: true,
      migrationCompleted: true,
    }));

    await expect(completeOwnerSetup()).resolves.toMatchObject({ setupState: "ready" });

    expect(mocks.events).toEqual([]);
    expect(mocks.writeRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  it("rejects owner completion until migration preparation is audited", async () => {
    mocks.readRuntimeConfig.mockResolvedValue(config(true));
    mocks.createDatabaseClient.mockReturnValue(completionDatabase({
      vaultReady: true,
      migrationPrepared: false,
    }));

    await expect(completeOwnerSetup()).rejects.toMatchObject({
      code: "DOMAIN_MIGRATION_NOT_PREPARED",
    });
    expect(mocks.writeRuntimeConfig).not.toHaveBeenCalled();
  });

  it("keeps the normal first-run transition to Vault creation", async () => {
    mocks.readRuntimeConfig.mockResolvedValue(config(false));
    mocks.createDatabaseClient.mockReturnValue(completionDatabase({ vaultReady: false }));

    await expect(completeOwnerSetup()).resolves.toMatchObject({
      setupState: "creating_vault",
    });

    expect(mocks.events).toEqual(["setup-completed-audit"]);
    const written = mocks.writeRuntimeConfig.mock.calls[0]?.[0] as RuntimeConfig;
    expect(written.setupState).toBe("creating_vault");
  });
});

describe("existing owner registration", () => {
  it("does not register a new Passkey before migration preparation finishes", async () => {
    const runtime = config(true);
    mocks.readRuntimeConfig.mockResolvedValue(runtime);
    const transaction = Object.assign(
      async (strings: TemplateStringsArray) => {
        const query = strings.join("?").replace(/\s+/g, " ").trim();
        if (query.includes("pg_advisory_xact_lock")) return [];
        if (query.includes("from users") && query.includes("order by created_at")) {
          return [owner];
        }
        if (query.includes("migrationPrepared")) {
          return [{ vaultReady: true, migrationPrepared: false }];
        }
        throw new Error(`Unexpected query: ${query}`);
      },
      { json: (value: unknown) => value },
    );
    mocks.createDatabaseClient.mockReturnValue({
      begin: async (callback: (sql: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    });

    await expect(createOrLoadOwner({
      name: "Owner",
      email: owner.email,
    })).rejects.toMatchObject({ code: "DOMAIN_MIGRATION_NOT_PREPARED" });
    expect(mocks.createOwnerRegistrationContext).not.toHaveBeenCalled();
  });
});

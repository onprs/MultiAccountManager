import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../types";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  readRuntimeConfig: vi.fn(),
  writeRuntimeConfig: vi.fn(),
  createDatabaseClient: vi.fn(),
  closeDatabaseClient: vi.fn(async () => undefined),
}));

vi.mock("../config-store", () => ({
  readRuntimeConfig: mocks.readRuntimeConfig,
  writeRuntimeConfig: mocks.writeRuntimeConfig,
}));
vi.mock("@/server/database/connection", () => ({
  createDatabaseClient: mocks.createDatabaseClient,
  closeDatabaseClient: mocks.closeDatabaseClient,
}));

import {
  applicationForDomainMigration,
  prepareDomainMigration,
} from "../domain-migration";

const previousApplication = {
  publicUrl: "https://old.example.com",
  webAuthnRpId: "old.example.com",
  webAuthnRpName: "Account Vault",
  webAuthnOrigin: "https://old.example.com",
  siteName: "Account Vault",
  timeZone: "UTC",
} as const;

function readyConfig(): RuntimeConfig {
  return {
    version: 1,
    setupState: "ready",
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
    application: previousApplication,
    auth: { secret: "A".repeat(43) },
    serviceEncryption: {
      keys: [{ id: "service-v1", key: "B".repeat(43), status: "current" }],
    },
    createdAt: "2026-07-17T09:00:00.000Z",
    updatedAt: "2026-07-17T09:00:00.000Z",
  };
}

function interruptedConfig(): RuntimeConfig {
  return {
    ...readyConfig(),
    setupState: "creating_owner",
    application: {
      ...previousApplication,
      publicUrl: "https://vault.example.net",
      webAuthnOrigin: "https://vault.example.net",
      webAuthnRpId: "vault.example.net",
    },
    domainMigration: {
      id: "9d4ac0c2-421e-4fc8-8977-eaa731050938",
      previousApplication,
      preparedAt: "2026-07-17T10:00:00.000Z",
    },
  };
}

function database(input: {
  auditState?: { revokedPasskeys: number; completed: boolean } | null;
  failAfterPreparation?: boolean;
} = {}) {
  const transaction = Object.assign(
    async (strings: TemplateStringsArray) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      if (query.includes("pg_advisory_xact_lock")) {
        mocks.events.push("lock");
        return [];
      }
      if (query.includes("from audit_events started")) {
        mocks.events.push("load-migration-audit");
        if (input.failAfterPreparation) {
          throw new Error("database unavailable after preparation");
        }
        return input.auditState ? [input.auditState] : [];
      }
      if (query.includes("from users") && query.includes("passkeyCount")) {
        mocks.events.push("load-owner");
        return [{
          id: "df76cfe7-a28d-4b51-b5f7-a8f022e87bf2",
          passkeyCount: 2,
          vaultReady: true,
        }];
      }
      if (query.includes("delete from sessions")) {
        mocks.events.push("delete-sessions");
        return { count: 3 };
      }
      if (query.includes("delete from passkeys")) {
        mocks.events.push("delete-passkeys");
        return { count: 2 };
      }
      if (query.includes("insert into audit_events")) {
        mocks.events.push("insert-started-audit");
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
  process.env.ACCOUNT_VAULT_BACKUP_CONFIRMED = "yes";
  process.env.ACCOUNT_VAULT_DOMAIN_MIGRATION_CONFIRMED = "yes";
  mocks.writeRuntimeConfig.mockImplementation(async (config: RuntimeConfig) => {
    mocks.events.push(`write-config:${config.setupState}`);
  });
});

describe("domain migration application identity", () => {
  it("moves the public URL and WebAuthn identity to a validated origin", () => {
    expect(
      applicationForDomainMigration({
        current: previousApplication,
        publicUrl: "https://vault.example.net/",
      }),
    ).toMatchObject({
      publicUrl: "https://vault.example.net",
      webAuthnOrigin: "https://vault.example.net",
      webAuthnRpId: "vault.example.net",
    });
  });

  it("accepts an explicit parent RP ID", () => {
    expect(
      applicationForDomainMigration({
        current: previousApplication,
        publicUrl: "https://vault.example.net",
        rpId: "example.net",
      }).webAuthnRpId,
    ).toBe("example.net");
  });

  it("rejects paths, credentials, and unrelated RP IDs", () => {
    expect(() =>
      applicationForDomainMigration({
        current: previousApplication,
        publicUrl: "https://vault.example.net/app",
      }),
    ).toThrow("Public URL must contain only an origin");
    expect(() =>
      applicationForDomainMigration({
        current: previousApplication,
        publicUrl: "https://user:pass@vault.example.net",
      }),
    ).toThrow("Public URL must contain only an origin");
    expect(() =>
      applicationForDomainMigration({
        current: previousApplication,
        publicUrl: "https://vault.example.net",
        rpId: "attacker.example.org",
      }),
    ).toThrow();
  });
});

describe("domain migration recovery", () => {
  it("persists resumable migration state before revoking credentials", async () => {
    mocks.readRuntimeConfig.mockResolvedValue(readyConfig());
    mocks.createDatabaseClient.mockReturnValue(database());

    await expect(prepareDomainMigration({
      publicUrl: "https://vault.example.net",
    })).resolves.toMatchObject({
      previousOrigin: "https://old.example.com",
      nextOrigin: "https://vault.example.net",
      revokedPasskeys: 2,
    });

    const prepared = mocks.writeRuntimeConfig.mock.calls[0]?.[0] as RuntimeConfig;
    expect(prepared).toMatchObject({
      setupState: "creating_owner",
      application: { publicUrl: "https://vault.example.net" },
      domainMigration: {
        previousApplication: { publicUrl: "https://old.example.com" },
      },
    });
    expect(prepared.domainMigration?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.events.indexOf("write-config:creating_owner"))
      .toBeLessThan(mocks.events.indexOf("delete-passkeys"));
  });

  it("resumes an audited migration without revoking credentials again", async () => {
    mocks.readRuntimeConfig.mockResolvedValue(interruptedConfig());
    mocks.createDatabaseClient.mockReturnValue(database({
      auditState: { revokedPasskeys: 2, completed: false },
    }));

    await expect(prepareDomainMigration({
      publicUrl: "https://vault.example.net",
    })).resolves.toMatchObject({ revokedPasskeys: 2 });

    expect(mocks.events).not.toContain("delete-passkeys");
    expect(mocks.writeRuntimeConfig).not.toHaveBeenCalled();
  });

  it("reuses the migration ID written by a concurrent command", async () => {
    mocks.readRuntimeConfig
      .mockResolvedValueOnce(readyConfig())
      .mockResolvedValueOnce(interruptedConfig());
    mocks.createDatabaseClient.mockReturnValue(database({
      auditState: { revokedPasskeys: 2, completed: false },
    }));

    await prepareDomainMigration({ publicUrl: "https://vault.example.net" });

    expect(mocks.writeRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.events).not.toContain("delete-passkeys");
  });

  it("restores READY when completion committed before the config write", async () => {
    mocks.readRuntimeConfig.mockResolvedValue(interruptedConfig());
    mocks.createDatabaseClient.mockReturnValue(database({
      auditState: { revokedPasskeys: 2, completed: true },
    }));

    await prepareDomainMigration({ publicUrl: "https://vault.example.net" });

    const recovered = mocks.writeRuntimeConfig.mock.calls[0]?.[0] as RuntimeConfig;
    expect(recovered.setupState).toBe("ready");
    expect(recovered.domainMigration).toBeUndefined();
    expect(mocks.events).not.toContain("delete-passkeys");
  });

  it("keeps the migration marker when preparation is interrupted", async () => {
    mocks.readRuntimeConfig.mockResolvedValue(readyConfig());
    mocks.createDatabaseClient.mockReturnValue(database({ failAfterPreparation: true }));

    await expect(prepareDomainMigration({
      publicUrl: "https://vault.example.net",
    })).rejects.toThrow("database unavailable after preparation");

    expect(mocks.writeRuntimeConfig).toHaveBeenCalledTimes(1);
    expect((mocks.writeRuntimeConfig.mock.calls[0]?.[0] as RuntimeConfig).setupState)
      .toBe("creating_owner");
  });
});

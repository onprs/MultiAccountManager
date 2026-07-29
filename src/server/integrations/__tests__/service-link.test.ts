import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  candidateQuery: "",
  readRuntimeConfig: vi.fn(async () => ({ database: {} })),
  createDatabaseClient: vi.fn(),
  closeDatabaseClient: vi.fn(async () => undefined),
}));

vi.mock("@/runtime/config-store", () => ({
  readRuntimeConfig: mocks.readRuntimeConfig,
  writeRuntimeConfig: vi.fn(),
}));
vi.mock("@/server/database/connection", () => ({
  createDatabaseClient: mocks.createDatabaseClient,
  closeDatabaseClient: mocks.closeDatabaseClient,
}));
vi.mock("@/server/auth/step-up", () => ({
  hasRecentPasskeyStepUp: vi.fn(async () => true),
}));

import { createAccountLink } from "@/server/integrations/service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.candidateQuery = "";
  const transaction = Object.assign(
    async (strings: TemplateStringsArray) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      if (query.includes("from remote_account_catalog c")) {
        mocks.candidateQuery = query;
        return [{
          externalPlatform: "openai",
          lastSeenAt: new Date("2026-07-17T10:00:00.000Z"),
          managedPlatform: "openai",
          remoteStatus: "active",
          availability: "available",
          available: true,
          quota: null,
          quotaErrorCode: null,
          sanitizedErrorCode: null,
          remoteUpdatedAt: new Date("2026-07-17T09:59:00.000Z"),
          connectionEnabled: true,
          lastSuccessAt: new Date("2026-07-17T10:00:00.000Z"),
          consecutiveFailures: 0,
          syncIntervalSeconds: 300,
        }];
      }
      if (
        query.includes("insert into sub2api_account_links") ||
        query.includes("insert into sub2api_account_states") ||
        query.includes("insert into audit_events")
      ) {
        return { count: 1 };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    { json: (value: unknown) => value },
  );
  mocks.createDatabaseClient.mockReturnValue({
    begin: async (callback: (sql: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
  });
});

describe("account link creation", () => {
  it("locks and rechecks the managed account against concurrent deletion", async () => {
    await createAccountLink({
      ownerUserId: "df76cfe7-a28d-4b51-b5f7-a8f022e87bf2",
      managedAccountId: "a4d32cda-a554-4bb4-af7d-40d37e537c0a",
      connectionId: "626d3985-4bf7-40cb-af07-4c5853b442eb",
      externalAccountId: "42",
    });

    expect(mocks.candidateQuery).toContain("m.deleted_at is null");
    expect(mocks.candidateQuery).toContain("for update of m");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  events: [] as string[],
  remoteAccounts: [] as Array<{
    connectionId: string;
    baseUrl: string;
    externalAccountId: string;
    tokenCiphertext: {
      version: 1;
      algorithm: "xchacha20poly1305-ietf";
      keyId: string;
      nonce: string;
      ciphertext: string;
    };
  }>,
  createDatabaseClient: vi.fn(),
  closeDatabaseClient: vi.fn(async () => undefined),
  decryptServiceToken: vi.fn(),
  deleteObserverAccount: vi.fn(),
}));

vi.mock("@/runtime/config-store", () => ({
  readRuntimeConfig: vi.fn(async () => ({ database: {}, serviceEncryption: { keys: [] } })),
}));
vi.mock("@/server/database/connection", () => ({
  createDatabaseClient: testState.createDatabaseClient,
  closeDatabaseClient: testState.closeDatabaseClient,
}));
vi.mock("@/server/integrations/service-cipher", () => ({
  decryptServiceToken: testState.decryptServiceToken,
}));
vi.mock("@/server/sub2api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/sub2api/client")>();
  return { ...actual, deleteObserverAccount: testState.deleteObserverAccount };
});

import { deleteManagedAccount } from "@/server/accounts/service";
import { Sub2apiClientError } from "@/server/sub2api/client";

const accountId = "a4d32cda-a554-4bb4-af7d-40d37e537c0a";
const ownerUserId = "df76cfe7-a28d-4b51-b5f7-a8f022e87bf2";

beforeEach(() => {
  vi.clearAllMocks();
  testState.events.length = 0;
  testState.remoteAccounts = [{
    connectionId: "626d3985-4bf7-40cb-af07-4c5853b442eb",
    baseUrl: "https://sub2api.example.com",
    externalAccountId: "42",
    tokenCiphertext: {
      version: 1,
      algorithm: "xchacha20poly1305-ietf",
      keyId: "service-current",
      nonce: "A".repeat(32),
      ciphertext: "B".repeat(32),
    },
  }];
  testState.decryptServiceToken.mockResolvedValue("s2obs_scoped_test_token");
  testState.deleteObserverAccount.mockImplementation(async () => {
    testState.events.push("remote-delete");
  });

  const transaction = Object.assign(
    async (strings: TemplateStringsArray) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      if (query.includes("select id from managed_accounts")) {
        testState.events.push("revision-lock");
        return [{ id: accountId }];
      }
      if (query.includes("from sub2api_account_links link")) {
        testState.events.push("load-links");
        return testState.remoteAccounts;
      }
      if (query.includes("update managed_accounts")) {
        testState.events.push("local-delete");
        return [{ id: accountId }];
      }
      if (query.includes("delete from remote_account_catalog")) {
        testState.events.push("catalog-cleanup");
        return [];
      }
      if (query.includes("delete from sub2api_account_links")) {
        testState.events.push("unlink");
        return [];
      }
      if (query.includes("insert into audit_events")) {
        testState.events.push("audit");
        return [];
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    { json: (value: unknown) => value },
  );
  testState.createDatabaseClient.mockReturnValue({
    begin: async (callback: (sql: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
  });
});

describe("managed account linked deletion", () => {
  it("deletes every linked Sub2API account before committing the local delete", async () => {
    await deleteManagedAccount({
      id: accountId,
      ownerUserId,
      expectedRevision: 7,
      requestId: "request-1",
    });

    expect(testState.events).toEqual([
      "revision-lock",
      "load-links",
      "remote-delete",
      "local-delete",
      "catalog-cleanup",
      "unlink",
      "audit",
    ]);
    expect(testState.deleteObserverAccount).toHaveBeenCalledWith({
      baseUrl: "https://sub2api.example.com",
      token: "s2obs_scoped_test_token",
      accountId: "42",
    });
  });

  it("validates every deletion credential before contacting Sub2API", async () => {
    testState.remoteAccounts.push({
      ...testState.remoteAccounts[0]!,
      connectionId: "b4dc498b-1c94-4f4e-bb3a-aa958de75fd8",
      externalAccountId: "43",
    });
    testState.decryptServiceToken.mockImplementation(async (input: { connectionId: string }) => {
      if (input.connectionId === "b4dc498b-1c94-4f4e-bb3a-aa958de75fd8") {
        throw new Error("damaged service ciphertext");
      }
      return "s2obs_scoped_test_token";
    });

    await expect(deleteManagedAccount({
      id: accountId,
      ownerUserId,
      expectedRevision: 7,
    })).rejects.toMatchObject({
      code: "SUB2API_DELETE_CREDENTIAL_UNAVAILABLE",
      status: 503,
    });

    expect(testState.deleteObserverAccount).not.toHaveBeenCalled();
    expect(testState.events).toEqual(["revision-lock", "load-links"]);
  });

  it("attempts every remote delete but preserves the local account on partial failure", async () => {
    testState.remoteAccounts.push({
      ...testState.remoteAccounts[0]!,
      connectionId: "b4dc498b-1c94-4f4e-bb3a-aa958de75fd8",
      externalAccountId: "43",
    });
    testState.deleteObserverAccount.mockImplementation(async (input: { accountId: string }) => {
      testState.events.push(`remote-delete:${input.accountId}`);
      if (input.accountId === "43") {
        throw new Sub2apiClientError({
          code: "OBSERVER_DELETE_RETRYABLE",
          message: "temporary upstream failure",
          status: 503,
          retryable: true,
        });
      }
    });

    await expect(deleteManagedAccount({
      id: accountId,
      ownerUserId,
      expectedRevision: 7,
    })).rejects.toMatchObject({
      code: "OBSERVER_DELETE_RETRYABLE",
      status: 503,
    });

    expect(testState.events).toEqual([
      "revision-lock",
      "load-links",
      "remote-delete:42",
      "remote-delete:43",
    ]);
    expect(testState.events).not.toContain("local-delete");
  });

  it("preserves the local account when Sub2API deletion fails", async () => {
    testState.deleteObserverAccount.mockImplementation(async () => {
      testState.events.push("remote-delete");
      throw new Sub2apiClientError({
        code: "OBSERVER_DELETE_RETRYABLE",
        message: "temporary upstream failure",
        status: 503,
        retryable: true,
      });
    });

    await expect(deleteManagedAccount({
      id: accountId,
      ownerUserId,
      expectedRevision: 7,
    })).rejects.toMatchObject({
      code: "OBSERVER_DELETE_RETRYABLE",
      status: 503,
    });

    expect(testState.events).toEqual([
      "revision-lock",
      "load-links",
      "remote-delete",
    ]);
    expect(testState.events).not.toContain("local-delete");
  });

  it("does not contact Sub2API when the account revision is stale", async () => {
    const staleTransaction = Object.assign(
      async (strings: TemplateStringsArray) => {
        const query = strings.join("?").replace(/\s+/g, " ").trim();
        if (query.includes("select id from managed_accounts")) return [];
        throw new Error(`Unexpected query: ${query}`);
      },
      { json: (value: unknown) => value },
    );
    testState.createDatabaseClient.mockReturnValueOnce({
      begin: async (callback: (transaction: typeof staleTransaction) => Promise<unknown>) =>
        callback(staleTransaction),
    });

    await expect(deleteManagedAccount({
      id: accountId,
      ownerUserId,
      expectedRevision: 6,
    })).rejects.toMatchObject({ code: "ACCOUNT_REVISION_CONFLICT" });
    expect(testState.deleteObserverAccount).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readRuntimeConfig: vi.fn(async () => ({ database: {}, serviceEncryption: {} })),
  createDatabaseClient: vi.fn(),
  closeDatabaseClient: vi.fn(async () => undefined),
  encryptServiceToken: vi.fn(async () => ({
    version: 1,
    algorithm: "xchacha20poly1305-ietf",
    keyId: "service-current",
    nonce: "A".repeat(32),
    ciphertext: "B".repeat(32),
  })),
  testSub2apiConnection: vi.fn(async () => ({
    instanceId: "93d9048d-8a5e-497f-9872-80af714eec61",
    schemaVersion: 1,
  })),
  enqueueManualConnectionSync: vi.fn(async () => "sync-job-id"),
  events: [] as string[],
}));

vi.mock("@/runtime/config-store", () => ({
  readRuntimeConfig: mocks.readRuntimeConfig,
}));
vi.mock("@/server/database/connection", () => ({
  createDatabaseClient: mocks.createDatabaseClient,
  closeDatabaseClient: mocks.closeDatabaseClient,
}));
vi.mock("@/server/integrations/service-cipher", () => ({
  encryptServiceToken: mocks.encryptServiceToken,
}));
vi.mock("@/server/jobs/runtime", () => ({
  enqueueManualConnectionSync: mocks.enqueueManualConnectionSync,
}));
vi.mock("@/server/sub2api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/sub2api/client")>();
  return { ...actual, testSub2apiConnection: mocks.testSub2apiConnection };
});

import { provisionSub2apiConnection } from "../provision-sub2api-connection";

const ownerUserId = "df76cfe7-a28d-4b51-b5f7-a8f022e87bf2";
const connectionId = "626d3985-4bf7-40cb-af07-4c5853b442eb";
const instanceId = "93d9048d-8a5e-497f-9872-80af714eec61";

function database(matches: Array<{
  id: string;
  name: string;
  baseUrl: string;
  remoteInstanceId: string | null;
}>) {
  const transaction = Object.assign(
    async (strings: TemplateStringsArray) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      if (query.includes("update sub2api_connections")) {
        mocks.events.push("replace-token");
        return { count: 1 };
      }
      if (query.includes("insert into sub2api_connections")) {
        mocks.events.push("create-connection");
        return { count: 1 };
      }
      if (query.includes("insert into audit_events")) {
        mocks.events.push("audit");
        return { count: 1 };
      }
      throw new Error(`Unexpected transaction query: ${query}`);
    },
    { json: (value: unknown) => value },
  );
  return Object.assign(
    async (strings: TemplateStringsArray) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      if (query.includes("select id from users")) return [{ id: ownerUserId }];
      if (query.includes("from sub2api_connections")) return matches;
      throw new Error(`Unexpected query: ${query}`);
    },
    {
      begin: async (callback: (sql: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
});

describe("Sub2API connection provisioning", () => {
  it("atomically replaces the token on an existing matching connection", async () => {
    mocks.createDatabaseClient.mockReturnValue(database([{
      id: connectionId,
      name: "sub2api_tokyo",
      baseUrl: "https://sub2api.example.com",
      remoteInstanceId: instanceId,
    }]));

    await expect(provisionSub2apiConnection({
      baseUrl: "https://sub2api.example.com",
      name: "sub2api_tokyo",
      token: "s2obs_new_scoped_token_that_is_never_logged",
    })).resolves.toEqual({
      connectionProvisioned: true,
      connectionCreated: false,
      connectionId,
      instanceId,
      syncQueued: true,
    });

    expect(mocks.testSub2apiConnection).toHaveBeenCalledWith({
      baseUrl: "https://sub2api.example.com",
      token: "s2obs_new_scoped_token_that_is_never_logged",
      expectedInstanceId: instanceId,
    });
    expect(mocks.encryptServiceToken).toHaveBeenCalledWith(expect.objectContaining({
      connectionId,
      ownerUserId,
      token: "s2obs_new_scoped_token_that_is_never_logged",
    }));
    expect(mocks.events).toEqual(["replace-token", "audit"]);
    expect(mocks.enqueueManualConnectionSync).toHaveBeenCalledWith(connectionId);
  });

  it("rejects ambiguous name and Base URL matches before validating a token", async () => {
    mocks.createDatabaseClient.mockReturnValue(database([
      {
        id: connectionId,
        name: "sub2api_tokyo",
        baseUrl: "https://other.example.com",
        remoteInstanceId: instanceId,
      },
      {
        id: "b4dc498b-1c94-4f4e-bb3a-aa958de75fd8",
        name: "other",
        baseUrl: "https://sub2api.example.com",
        remoteInstanceId: instanceId,
      },
    ]));

    await expect(provisionSub2apiConnection({
      baseUrl: "https://sub2api.example.com",
      name: "sub2api_tokyo",
      token: "s2obs_new_scoped_token_that_is_never_logged",
    })).rejects.toThrow("resolve to different records");

    expect(mocks.testSub2apiConnection).not.toHaveBeenCalled();
    expect(mocks.encryptServiceToken).not.toHaveBeenCalled();
  });
});

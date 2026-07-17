import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: "ready" as "ready" | "creating_owner" | "creating_vault",
  handler: vi.fn(),
  ownerSession: null as null | { sessionId: string; userId: string; name: string },
  hasStepUp: false,
}));

vi.mock("@/runtime/status", () => ({
  getRuntimeStatus: vi.fn(async () => ({
    state: mocks.state,
    setupRequired: mocks.state !== "ready",
  })),
}));
vi.mock("@/server/auth", () => ({
  getAuth: vi.fn(async () => ({ handler: mocks.handler })),
}));
vi.mock("@/server/auth/authorization", () => ({
  getOwnerSession: vi.fn(async () => mocks.ownerSession),
}));
vi.mock("@/server/auth/step-up", () => ({
  hasRecentPasskeyStepUp: vi.fn(async () => mocks.hasStepUp),
  markPasskeyStepUp: vi.fn(),
  consumePasskeyStepUp: vi.fn(),
}));
vi.mock("@/server/auth/audit", () => ({
  recordFailedPasskeyLogin: vi.fn(),
  recordSuccessfulPasskeyLogin: vi.fn(),
}));

import { GET } from "./route";

function get(path: string): Request {
  return new Request(`https://vault.example.com/api/auth${path}`);
}

beforeEach(() => {
  mocks.state = "ready";
  mocks.ownerSession = null;
  mocks.hasStepUp = false;
  mocks.handler.mockReset();
  mocks.handler.mockResolvedValue(Response.json({ ok: true }));
});

describe("Better Auth route allowlist", () => {
  it("does not expose password, social, or public signup endpoints", async () => {
    const response = await GET(get("/sign-up/email"));
    expect(response.status).toBe(404);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it("allows only the registration ceremony while creating the owner", async () => {
    mocks.state = "creating_owner";
    expect((await GET(get("/passkey/generate-register-options"))).status).toBe(200);
    expect((await GET(get("/passkey/generate-authenticate-options"))).status).toBe(404);
  });

  it("allows login but not credential registration while creating the vault", async () => {
    mocks.state = "creating_vault";
    expect((await GET(get("/passkey/generate-authenticate-options"))).status).toBe(200);
    expect((await GET(get("/passkey/generate-register-options"))).status).toBe(404);
  });

  it("requires an owner session before adding another Passkey", async () => {
    const response = await GET(get("/passkey/generate-register-options"));
    expect(response.status).toBe(401);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it("requires a recent Passkey step-up before registration", async () => {
    mocks.ownerSession = {
      sessionId: "session-1",
      userId: "user-1",
      name: "Owner",
    };
    const response = await GET(get("/passkey/generate-register-options"));
    expect(response.status).toBe(403);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it("passes a stepped-up owner registration request to Better Auth", async () => {
    mocks.ownerSession = {
      sessionId: "session-1",
      userId: "user-1",
      name: "Owner",
    };
    mocks.hasStepUp = true;
    const response = await GET(get("/passkey/generate-register-options"));
    expect(response.status).toBe(200);
    expect(mocks.handler).toHaveBeenCalledOnce();
  });

  it("requires user verification in authentication options", async () => {
    mocks.handler.mockResolvedValue(
      Response.json(
        { challenge: "challenge", userVerification: "preferred" },
        { headers: { "set-cookie": "challenge=cookie; HttpOnly" } },
      ),
    );
    const response = await GET(get("/passkey/generate-authenticate-options"));
    expect(await response.json()).toMatchObject({ userVerification: "required" });
    expect(response.headers.get("set-cookie")).toContain("challenge=cookie");
  });
});

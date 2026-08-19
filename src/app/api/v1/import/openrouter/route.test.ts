import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/runtime/config-store", () => ({
  readRuntimeConfig: vi.fn().mockResolvedValue({
    auth: { secret: "test-auth-secret-key-123456789012345678901234567890" },
  }),
}));

vi.mock("@/server/accounts/api-import", () => ({
  apiImportOpenRouterRequestSchema: {
    safeParse: vi.fn((body) => {
      if (!body || !body.accounts) return { success: false, error: { issues: [{ message: "invalid" }] } };
      return { success: true, data: body };
    }),
  },
  importOpenRouterAccountsDirect: vi.fn().mockResolvedValue({
    success: true,
    total: 2,
    imported: 2,
    skipped: 0,
    failed: 0,
    errors: [],
  }),
}));

describe("POST /api/v1/import/openrouter", () => {
  it("rejects unauthorized requests without x-api-key", async () => {
    const req = new Request("http://localhost:3000/api/v1/import/openrouter", {
      method: "POST",
      body: JSON.stringify({ accounts: [] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("accepts valid requests with x-api-key", async () => {
    const req = new Request("http://localhost:3000/api/v1/import/openrouter", {
      method: "POST",
      headers: {
        "x-api-key": "test-auth-secret-key-123456789012345678901234567890",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        vaultPassword: "TestPassword123!",
        accounts: [{ email: "test@example.com", apiKey: "sk-or-v1-abc" }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.imported).toBe(2);
  });
});

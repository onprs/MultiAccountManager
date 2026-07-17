import { describe, expect, it, vi } from "vitest";
import {
  fetchObserverAccounts,
  normalizeSub2apiBaseUrl,
} from "@/server/sub2api/client";

const validAccount = {
  id: 42,
  name: "OpenAI primary",
  platform: "openai",
  type: "oauth",
  status: "active",
  availability: "available",
  available: true,
  updated_at: "2026-07-17T10:00:00Z",
  quota: {
    source: "stored",
    updated_at: "2026-07-17T09:59:00Z",
    windows: {
      five_hour: {
        utilization: 34,
        remaining_seconds: 1200,
        estimated: false,
      },
    },
  },
};

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", Date: "Fri, 17 Jul 2026 10:00:00 GMT" },
    ...init,
  });
}

describe("Sub2API observer client", () => {
  it("accepts the versioned allowlisted contract", async () => {
    const fetchImpl = vi.fn(async (request: RequestInfo | URL) =>
      (void request, response({
        schema_version: 1,
        instance_id: "93d9048d-8a5e-497f-9872-80af714eec61",
        generated_at: "2026-07-17T10:00:00Z",
        items: [validAccount],
      })),
    );
    const result = await fetchObserverAccounts({
      baseUrl: "https://sub2api.example.com",
      token: "s2obs_test_token_that_is_never_logged",
      fetchImpl,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.page.items).toHaveLength(1);
      expect(result.page.invalidItems).toBe(0);
      expect(result.page.items[0]?.quota?.windows.five_hour?.utilization).toBe(34);
    }
    const request = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(request.searchParams.get("limit")).toBe("200");
  });

  it("isolates items containing forbidden raw fields without reflecting secrets", async () => {
    const fetchImpl = vi.fn(async (request: RequestInfo | URL) =>
      (void request, response({
        instance_id: "93d9048d-8a5e-497f-9872-80af714eec61",
        generated_at: "2026-07-17T10:00:00Z",
        items: [
          validAccount,
          {
            ...validAccount,
            id: 43,
            credentials: { access_token: "must-never-be-accepted" },
            extra: { cookie: "must-never-be-accepted" },
          },
        ],
      })),
    );
    const result = await fetchObserverAccounts({
      baseUrl: "https://sub2api.example.com",
      token: "s2obs_test_token_that_is_never_logged",
      fetchImpl,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.page.items).toHaveLength(1);
      expect(result.page.invalidItems).toBe(1);
      expect(JSON.stringify(result.page)).not.toContain("must-never-be-accepted");
      expect(JSON.stringify(result.page)).not.toContain("credentials");
    }
  });

  it("rejects a declared oversized response before parsing it", async () => {
    const fetchImpl = vi.fn(async (request: RequestInfo | URL) =>
      (void request, new Response("{}", { headers: { "Content-Length": "5242881" } }))
    );
    await expect(
      fetchObserverAccounts({
        baseUrl: "https://sub2api.example.com",
        token: "s2obs_oversized_response_test_token",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE", retryable: false });
  });

  it("classifies observer authentication rejection as terminal", async () => {
    const fetchImpl = vi.fn(async (request: RequestInfo | URL) =>
      (void request, new Response(null, { status: 403 }))
    );
    await expect(
      fetchObserverAccounts({
        baseUrl: "https://sub2api.example.com",
        token: "s2obs_rejected_token_that_is_never_logged",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "OBSERVER_AUTH_REJECTED",
      retryable: false,
    });
  });

  it("requires an origin-only HTTPS URL", () => {
    expect(normalizeSub2apiBaseUrl("https://sub2api.example.com/")).toBe(
      "https://sub2api.example.com",
    );
    expect(() => normalizeSub2apiBaseUrl("https://user:pass@sub2api.example.com"))
      .toThrow("cannot include credentials");
    expect(() => normalizeSub2apiBaseUrl("https://sub2api.example.com/admin"))
      .toThrow("must not include a path");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  deleteObserverAccount,
  fetchObserverAccounts,
  normalizeSub2apiBaseUrl,
  testSub2apiConnection,
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
    headers: {
      "Content-Type": "application/json",
      Date: "Fri, 17 Jul 2026 10:00:00 GMT",
      "X-Integration-Scope": "account_observer:read account_observer:delete",
    },
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

  it("isolates account IDs that cannot be represented without precision loss", async () => {
    const fetchImpl = vi.fn(async () => response({
      instance_id: "93d9048d-8a5e-497f-9872-80af714eec61",
      generated_at: "2026-07-17T10:00:00Z",
      items: [validAccount, { ...validAccount, id: Number.MAX_SAFE_INTEGER + 1 }],
    }));

    const result = await fetchObserverAccounts({
      baseUrl: "https://sub2api.example.com",
      token: "s2obs_unsafe_id_test_token_that_is_never_logged",
      fetchImpl,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.page.items).toEqual([validAccount]);
      expect(result.page.invalidItems).toBe(1);
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

  it("requires delete capability during connection validation", async () => {
    const fetchImpl = vi.fn(async () => response({
      schema_version: 1,
      instance_id: "93d9048d-8a5e-497f-9872-80af714eec61",
      generated_at: "2026-07-17T10:00:00Z",
      items: [],
    }, {
      headers: {
        "Content-Type": "application/json",
        "X-Integration-Scope": "account_observer:read",
      },
    }));

    await expect(testSub2apiConnection({
      baseUrl: "https://sub2api.example.com",
      token: "s2obs_read_only_token_that_is_never_logged",
      fetchImpl,
    })).rejects.toMatchObject({
      code: "INTEGRATION_SCOPE_INSUFFICIENT",
      status: 403,
    });
  });

  it("accepts read and delete capability during connection validation", async () => {
    const fetchImpl = vi.fn(async () => response({
      schema_version: 1,
      instance_id: "93d9048d-8a5e-497f-9872-80af714eec61",
      generated_at: "2026-07-17T10:00:00Z",
      items: [],
    }));

    await expect(testSub2apiConnection({
      baseUrl: "https://sub2api.example.com",
      token: "s2obs_scoped_token_that_is_never_logged",
      fetchImpl,
    })).resolves.toMatchObject({
      integrationScope: "account_observer:read account_observer:delete",
    });
  });

  it("deletes an account through the scoped integration endpoint", async () => {
    const fetchImpl = vi.fn(async (
      request: RequestInfo | URL,
      init?: RequestInit,
    ) => (void request, void init, new Response(null, { status: 204 })));

    await deleteObserverAccount({
      baseUrl: "https://sub2api.example.com",
      token: "s2obs_delete_token_that_is_never_logged",
      accountId: "42",
      fetchImpl,
    });

    const [request, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(request)).toBe(
      "https://sub2api.example.com/api/v1/integrations/account-observer/v1/accounts/42",
    );
    expect(init?.method).toBe("DELETE");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer s2obs_delete_token_that_is_never_logged",
    );
  });

  it("does not treat a missing delete endpoint as a successful deletion", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));

    await expect(deleteObserverAccount({
      baseUrl: "https://sub2api.example.com",
      token: "s2obs_delete_token_that_is_never_logged",
      accountId: "42",
      fetchImpl,
    })).rejects.toMatchObject({
      code: "OBSERVER_DELETE_HTTP_ERROR",
      status: 404,
      retryable: false,
    });
  });

  it("reports a read-only token as insufficient for deletion", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));

    await expect(deleteObserverAccount({
      baseUrl: "https://sub2api.example.com",
      token: "s2obs_read_only_token_that_is_never_logged",
      accountId: "42",
      fetchImpl,
    })).rejects.toMatchObject({
      code: "OBSERVER_DELETE_FORBIDDEN",
      status: 403,
      retryable: false,
    });
  });

  it("rejects invalid remote account IDs before sending a request", async () => {
    const fetchImpl = vi.fn();

    await expect(deleteObserverAccount({
      baseUrl: "https://sub2api.example.com",
      token: "s2obs_delete_token_that_is_never_logged",
      accountId: "../admin",
      fetchImpl,
    })).rejects.toMatchObject({ code: "INVALID_OBSERVER_ACCOUNT_ID" });
    expect(fetchImpl).not.toHaveBeenCalled();
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

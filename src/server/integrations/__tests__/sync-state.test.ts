import { describe, expect, it } from "vitest";
import type { ObserverAccount } from "@/integrations/schema";
import { calculateSyncHealth } from "@/server/integrations/service";
import { normalizeHealthCode } from "@/server/integrations/sync";

function account(overrides: Partial<ObserverAccount> = {}): ObserverAccount {
  return {
    id: 1,
    name: "remote",
    platform: "openai",
    type: "oauth",
    status: "active",
    availability: "available",
    available: true,
    updated_at: "2026-07-17T10:00:00Z",
    ...overrides,
  };
}

describe("integration state normalization", () => {
  it("applies health priority before availability", () => {
    expect(normalizeHealthCode(account({ status: "disabled", error_code: "unauthenticated" }))).toBe("disabled");
    expect(normalizeHealthCode(account({ status: "error", availability: "rate_limited", available: false }))).toBe("error");
    expect(normalizeHealthCode(account({ availability: "temporarily_unavailable", available: false }))).toBe("temporarily_unavailable");
    expect(normalizeHealthCode(account())).toBe("healthy");
  });

  it("keeps sync health independent from account health", () => {
    const now = new Date("2026-07-17T10:10:00Z");
    expect(calculateSyncHealth({
      enabled: true,
      lastSuccessAt: new Date("2026-07-17T10:05:01Z"),
      consecutiveFailures: 0,
      syncIntervalSeconds: 300,
      now,
    })).toBe("fresh");
    expect(calculateSyncHealth({
      enabled: true,
      lastSuccessAt: new Date("2026-07-17T09:59:59Z"),
      consecutiveFailures: 1,
      syncIntervalSeconds: 300,
      now,
    })).toBe("stale");
    expect(calculateSyncHealth({
      enabled: true,
      lastSuccessAt: new Date("2026-07-17T10:09:00Z"),
      consecutiveFailures: 3,
      syncIntervalSeconds: 300,
      now,
    })).toBe("disconnected");
    expect(calculateSyncHealth({
      enabled: true,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      syncIntervalSeconds: 300,
      now,
    })).toBe("never_synced");
  });
});

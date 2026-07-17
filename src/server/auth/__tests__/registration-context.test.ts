import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@/runtime/types";
import {
  createOwnerRegistrationContext,
  verifyOwnerRegistrationContext,
} from "../registration-context";

function runtimeConfig(secret = randomBytes(32).toString("base64url")): RuntimeConfig {
  const now = new Date().toISOString();
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
      password: "test-only-password",
      sslMode: "disable",
      connectTimeoutSeconds: 5,
      webPoolSize: 10,
      workerPoolSize: 5,
    },
    application: {
      publicUrl: "https://vault.example.com",
      webAuthnRpId: "vault.example.com",
      webAuthnRpName: "Account Vault",
      webAuthnOrigin: "https://vault.example.com",
      siteName: "Account Vault",
      timeZone: "UTC",
    },
    auth: { secret },
    serviceEncryption: {
      keys: [
        {
          id: "service-v1",
          key: randomBytes(32).toString("base64url"),
          status: "current",
        },
      ],
    },
    createdAt: now,
    updatedAt: now,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("owner Passkey registration context", () => {
  it("round-trips a short-lived context for the intended owner", () => {
    const config = runtimeConfig();
    const userId = randomUUID();
    const context = createOwnerRegistrationContext(userId, config);

    expect(verifyOwnerRegistrationContext(context, config)).toMatchObject({
      version: 1,
      purpose: "owner-passkey-registration",
      userId,
    });
    expect(context).not.toContain(userId);
    expect(context).not.toContain(config.auth.secret);
  });

  it("rejects payload and signature tampering", () => {
    const config = runtimeConfig();
    const context = createOwnerRegistrationContext(randomUUID(), config);
    const [payload, signature] = context.split(".");

    expect(() =>
      verifyOwnerRegistrationContext(`${payload}x.${signature}`, config),
    ).toThrow("Invalid owner registration context");
    expect(() =>
      verifyOwnerRegistrationContext(`${payload}.${signature?.slice(0, -1)}x`, config),
    ).toThrow("Invalid owner registration context");
  });

  it("rejects a context signed with another runtime secret", () => {
    const context = createOwnerRegistrationContext(randomUUID(), runtimeConfig());
    expect(() => verifyOwnerRegistrationContext(context, runtimeConfig())).toThrow(
      "Invalid owner registration context",
    );
  });

  it("rejects an expired context", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const config = runtimeConfig();
    const context = createOwnerRegistrationContext(randomUUID(), config);
    vi.setSystemTime(new Date("2026-07-16T12:11:00.000Z"));

    expect(() => verifyOwnerRegistrationContext(context, config)).toThrow(
      "Owner registration context has expired",
    );
  });
});

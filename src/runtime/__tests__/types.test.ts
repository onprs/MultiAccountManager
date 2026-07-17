import { describe, expect, it } from "vitest";
import {
  applicationConfigSchema,
  databaseConfigSchema,
  serviceKeyRingSchema,
} from "../types";

describe("runtime input schemas", () => {
  it("rejects shell-like database host and schema values", () => {
    expect(
      databaseConfigSchema.safeParse({
        host: "db.example.com;rm -rf /",
        port: 5432,
        database: "account_vault",
        schema: "account_vault;drop schema public",
        jobSchema: "account_vault_jobs",
        username: "app",
        password: "secret",
        sslMode: "verify-full",
        connectTimeoutSeconds: 5,
        webPoolSize: 10,
        workerPoolSize: 5,
      }).success,
    ).toBe(false);
  });

  it("requires one canonical current service key and unique key IDs", () => {
    const key = "A".repeat(43);
    expect(serviceKeyRingSchema.safeParse({ keys: [{ id: "current", key, status: "current" }] }).success).toBe(true);
    expect(serviceKeyRingSchema.safeParse({ keys: [{ id: "previous", key, status: "previous" }] }).success).toBe(false);
    expect(serviceKeyRingSchema.safeParse({
      keys: [
        { id: "duplicate", key, status: "current" },
        { id: "duplicate", key: "B".repeat(43), status: "previous" },
      ],
    }).success).toBe(false);
    expect(serviceKeyRingSchema.safeParse({
      keys: [{ id: "bad-key", key: "+".repeat(43), status: "current" }],
    }).success).toBe(false);
  });

  it("requires HTTPS outside a loopback development origin", () => {
    const result = applicationConfigSchema.safeParse({
      publicUrl: "http://vault.example.com",
      webAuthnRpId: "vault.example.com",
      webAuthnRpName: "Account Vault",
      webAuthnOrigin: "http://vault.example.com",
      siteName: "Account Vault",
      timeZone: "UTC",
    });
    expect(result.success).toBe(false);

    expect(
      applicationConfigSchema.safeParse({
        publicUrl: "http://127.0.0.1:33001",
        webAuthnRpId: "127.0.0.1",
        webAuthnRpName: "Account Vault",
        webAuthnOrigin: "http://127.0.0.1:33001",
        siteName: "Account Vault",
        timeZone: "UTC",
      }).success,
    ).toBe(true);
  });

  it("requires a matching WebAuthn origin and RP domain", () => {
    const result = applicationConfigSchema.safeParse({
      publicUrl: "https://vault.example.com",
      webAuthnRpId: "other.example.com",
      webAuthnRpName: "Account Vault",
      webAuthnOrigin: "https://attacker.example.com",
      siteName: "Account Vault",
      timeZone: "UTC",
    });
    expect(result.success).toBe(false);
  });
});

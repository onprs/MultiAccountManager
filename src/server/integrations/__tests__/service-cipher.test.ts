import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "@/runtime/types";
import {
  decryptServiceToken,
  encryptServiceToken,
} from "@/server/integrations/service-cipher";

function runtimeConfig(): RuntimeConfig {
  return {
    version: 1,
    setupState: "ready",
    database: {
      host: "127.0.0.1",
      port: 5432,
      database: "account_vault",
      schema: "account_vault",
      jobSchema: "account_vault_jobs",
      username: "account_vault",
      password: "test-only",
      sslMode: "disable",
      connectTimeoutSeconds: 5,
      webPoolSize: 5,
      workerPoolSize: 3,
    },
    application: {
      publicUrl: "https://vault.example.com",
      webAuthnRpId: "vault.example.com",
      webAuthnRpName: "Account Vault",
      webAuthnOrigin: "https://vault.example.com",
      siteName: "Account Vault",
      timeZone: "UTC",
    },
    auth: { secret: randomBytes(32).toString("base64url") },
    serviceEncryption: {
      keys: [
        {
          id: "service-v2",
          key: randomBytes(32).toString("base64url"),
          status: "current",
        },
        {
          id: "service-v1",
          key: randomBytes(32).toString("base64url"),
          status: "previous",
        },
      ],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("service integration cipher", () => {
  it("encrypts with the current key and binds owner and connection AAD", async () => {
    const config = runtimeConfig();
    const connectionId = randomUUID();
    const ownerUserId = randomUUID();
    const token = `s2obs_${randomBytes(32).toString("base64url")}`;

    const envelope = await encryptServiceToken({
      connectionId,
      ownerUserId,
      token,
      config,
    });
    expect(envelope.keyId).toBe("service-v2");
    expect(JSON.stringify(envelope)).not.toContain(token);
    await expect(
      decryptServiceToken({ connectionId, ownerUserId, envelope, config }),
    ).resolves.toBe(token);
    await expect(
      decryptServiceToken({
        connectionId,
        ownerUserId: randomUUID(),
        envelope,
        config,
      }),
    ).rejects.toThrow();
  });

  it("decrypts previous-key envelopes during rotation", async () => {
    const config = runtimeConfig();
    const previousOnly: RuntimeConfig = {
      ...config,
      serviceEncryption: {
        keys: [{ ...config.serviceEncryption.keys[1], status: "current" }],
      },
    };
    const connectionId = randomUUID();
    const ownerUserId = randomUUID();
    const envelope = await encryptServiceToken({
      connectionId,
      ownerUserId,
      token: "s2obs_previous_key_test_token_1234567890",
      config: previousOnly,
    });
    await expect(
      decryptServiceToken({ connectionId, ownerUserId, envelope, config }),
    ).resolves.toBe("s2obs_previous_key_test_token_1234567890");
  });
});

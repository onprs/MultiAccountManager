import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptRuntimeConfig,
  encryptRuntimeConfig,
  readRuntimeConfig,
  runtimeConfigExists,
  writeRuntimeConfig,
} from "../config-store";
import type { RuntimeConfig } from "../types";
import { randomBytes } from "node:crypto";

let directory: string;

function fixture(): RuntimeConfig {
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
      password: "database-password-must-stay-encrypted",
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
    auth: { secret: randomBytes(32).toString("base64url") },
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

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "account-vault-config-"));
  process.env.RUNTIME_CONFIG_DIR = directory;
  process.env.CONFIG_MASTER_KEY_FILE = path.join(directory, "master-key");
  await writeFile(process.env.CONFIG_MASTER_KEY_FILE, randomBytes(32).toString("base64url"), {
    mode: 0o440,
  });
});

afterEach(() => {
  delete process.env.RUNTIME_CONFIG_DIR;
  delete process.env.CONFIG_MASTER_KEY_FILE;
});

describe("runtime config store", () => {
  it("atomically writes encrypted configuration without plaintext secrets", async () => {
    const config = fixture();
    expect(await runtimeConfigExists()).toBe(false);

    await writeRuntimeConfig(config);

    expect(await runtimeConfigExists()).toBe(true);
    expect(await readRuntimeConfig()).toEqual(config);
    const serialized = await readFile(path.join(directory, "runtime.enc"), "utf8");
    expect(serialized).not.toContain(config.database.password);
    expect(serialized).not.toContain(config.auth.secret);
    expect(JSON.parse(serialized)).toMatchObject({
      version: 1,
      algorithm: "xchacha20poly1305-ietf",
      keyId: "config-master-v1",
    });
  });

  it("rejects ciphertext tampering", async () => {
    const key = randomBytes(32);
    const encrypted = await encryptRuntimeConfig(fixture(), key);
    const bytes = Buffer.from(encrypted.ciphertext, "base64url");
    bytes[0] ^= 1;
    encrypted.ciphertext = bytes.toString("base64url");

    await expect(decryptRuntimeConfig(encrypted, key)).rejects.toThrow();
  });

  it("binds ciphertext to the config format AAD and key", async () => {
    const encrypted = await encryptRuntimeConfig(fixture(), randomBytes(32));
    await expect(decryptRuntimeConfig(encrypted, randomBytes(32))).rejects.toThrow();
  });
});

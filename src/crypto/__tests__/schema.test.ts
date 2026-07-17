import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  initializeVaultRequestSchema,
  rotateRecoveryEnvelopeRequestSchema,
  updatePasswordEnvelopeRequestSchema,
} from "../schema";

function envelope(keyId: "vault-wrap-password-v1" | "vault-wrap-recovery-v1") {
  return {
    version: 1 as const,
    algorithm: "xchacha20poly1305-ietf" as const,
    keyId,
    nonce: "A".repeat(32),
    ciphertext: "B".repeat(64),
  };
}

function initialization() {
  return {
    vault: {
      id: randomUUID(),
      ownerUserId: randomUUID(),
      cryptoVersion: 1,
      kdfAlgorithm: "argon2id",
      kdfSalt: "C".repeat(22),
      kdfParams: {
        version: 19,
        memorySize: 65_536,
        iterations: 3,
        parallelism: 1,
        hashLength: 32,
      },
      passwordEnvelope: envelope("vault-wrap-password-v1"),
      recoveryEnvelope: envelope("vault-wrap-recovery-v1"),
      recoveryKeyChecksum: "D".repeat(22),
      revision: 1,
    },
  };
}

describe("Vault API envelope schemas", () => {
  it("accepts a bounded crypto v1 initialization document", () => {
    expect(initializeVaultRequestSchema.safeParse(initialization()).success).toBe(true);
  });

  it("rejects weak KDF parameters and plaintext-like extra fields", () => {
    const weak = initialization();
    weak.vault.kdfParams.memorySize = 8_192;
    expect(initializeVaultRequestSchema.safeParse(weak).success).toBe(false);

    const withPlaintext = {
      ...initialization(),
      masterPassword: "must-never-be-accepted",
    };
    expect(initializeVaultRequestSchema.safeParse(withPlaintext).success).toBe(false);
  });

  it("rejects malformed nonce, key domains, and unexpected root-key fields", () => {
    const value = initialization();
    value.vault.passwordEnvelope.nonce = "short";
    expect(initializeVaultRequestSchema.safeParse(value).success).toBe(false);

    const wrongDomain = initialization();
    wrongDomain.vault.passwordEnvelope = envelope("vault-wrap-recovery-v1") as typeof wrongDomain.vault.passwordEnvelope;
    expect(initializeVaultRequestSchema.safeParse(wrongDomain).success).toBe(false);

    const leakedKey = initialization();
    const request = {
      ...leakedKey,
      vault: { ...leakedKey.vault, vaultRootKey: "forbidden" },
    };
    expect(initializeVaultRequestSchema.safeParse(request).success).toBe(false);
  });

  it("requires optimistic revisions for password and recovery updates", () => {
    expect(
      updatePasswordEnvelopeRequestSchema.safeParse({
        expectedRevision: 0,
        kdfSalt: "C".repeat(22),
        kdfParams: initialization().vault.kdfParams,
        passwordEnvelope: envelope("vault-wrap-password-v1"),
      }).success,
    ).toBe(false);
    expect(
      rotateRecoveryEnvelopeRequestSchema.safeParse({
        expectedRevision: 2,
        recoveryEnvelope: envelope("vault-wrap-recovery-v1"),
        recoveryKeyChecksum: "D".repeat(22),
      }).success,
    ).toBe(true);
  });
});

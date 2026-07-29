import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Argon2Params, EncryptedEnvelope } from "../schema";
import {
  VaultCryptoSession,
  VaultLockedError,
  VaultUnlockError,
} from "../core";

const testKdf: Argon2Params = {
  version: 19,
  memorySize: 8_192,
  iterations: 1,
  parallelism: 1,
  hashLength: 32,
};

function ids() {
  return { ownerUserId: randomUUID(), vaultId: randomUUID() };
}

describe("Vault crypto v1", () => {
  it("creates independent password and recovery envelopes without exposing the root key", async () => {
    const session = new VaultCryptoSession();
    const identity = ids();
    const initialized = await session.initialize({
      ...identity,
      password: "correct horse battery staple",
      kdfParams: testKdf,
    });

    const serialized = JSON.stringify(initialized.vault);
    expect(initialized.recoveryKey).toMatch(/^avrk1_[A-Za-z0-9_-]{43}$/);
    expect(serialized).not.toContain(initialized.recoveryKey);
    expect(serialized).not.toContain("correct horse battery staple");
    expect(initialized.vault.passwordEnvelope.ciphertext).not.toBe(
      initialized.vault.recoveryEnvelope.ciphertext,
    );

    session.lock();
    await session.unlockWithPassword(initialized.vault, "correct horse battery staple");
    const encrypted = await session.encryptRecord({
      ownerUserId: identity.ownerUserId,
      recordType: "managed-account-private",
      recordId: "account-1",
      value: { loginEmail: "owner@example.test", secret: "browser-only" },
    });
    expect(JSON.stringify(encrypted)).not.toContain("owner@example.test");
    expect(
      await session.decryptRecord({
        ownerUserId: identity.ownerUserId,
        recordType: "managed-account-private",
        recordId: "account-1",
        envelope: encrypted,
      }),
    ).toEqual({ loginEmail: "owner@example.test", secret: "browser-only" });
  });

  it("counts equivalent managed-account phone bindings without returning phone values", async () => {
    const session = new VaultCryptoSession();
    const identity = ids();
    await session.initialize({ ...identity, password: "password", kdfParams: testKdf });
    const records = await Promise.all(
      [
        { id: "account-1", phone: "+86 138-0013-8000" },
        { id: "account-2", phone: "+86 (138) 0013 8000" },
        { id: "account-3", phone: "+86 139 0013 8000" },
        {
          id: "account-4",
          phone: undefined,
          phoneBindingHistory: ["+86 138 0013 8000"],
        },
      ].map(async ({ id, phone, phoneBindingHistory }) => ({
        id,
        envelope: await session.encryptRecord({
          ownerUserId: identity.ownerUserId,
          recordType: "managed-account-private-v1",
          recordId: id,
          value: {
            version: 1,
            loginEmail: `${id}@example.test`,
            phone,
            phoneBindingHistory,
          },
        }),
      })),
    );

    const counts = await session.countManagedAccountPhoneBindings({
      ownerUserId: identity.ownerUserId,
      records,
    });
    expect(counts).toEqual({
      "account-1": 3,
      "account-2": 3,
      "account-3": 1,
    });
    expect(JSON.stringify(counts)).not.toContain("13800138000");
  });

  it("supports NFKC-equivalent passwords and rejects wrong credentials uniformly", async () => {
    const session = new VaultCryptoSession();
    const identity = ids();
    const initialized = await session.initialize({
      ...identity,
      password: "A\u030A-secure-password",
      kdfParams: testKdf,
    });
    session.lock();

    await session.unlockWithPassword(initialized.vault, "\u00C5-secure-password");
    expect(session.isUnlocked()).toBe(true);
    session.lock();
    await expect(
      session.unlockWithPassword(initialized.vault, "wrong-password"),
    ).rejects.toBeInstanceOf(VaultUnlockError);
    await expect(
      session.unlockWithRecovery(initialized.vault, "avrk1_invalid"),
    ).rejects.toBeInstanceOf(VaultUnlockError);
  });

  it("binds record ciphertext to owner, type, and record ID", async () => {
    const session = new VaultCryptoSession();
    const identity = ids();
    await session.initialize({ ...identity, password: "password", kdfParams: testKdf });
    const encrypted = await session.encryptRecord({
      ownerUserId: identity.ownerUserId,
      recordType: "managed-account-private",
      recordId: "account-1",
      value: { secret: "value" },
    });

    for (const changed of [
      { ownerUserId: randomUUID(), recordType: "managed-account-private", recordId: "account-1" },
      { ownerUserId: identity.ownerUserId, recordType: "recovery-code", recordId: "account-1" },
      { ownerUserId: identity.ownerUserId, recordType: "managed-account-private", recordId: "account-2" },
    ]) {
      await expect(
        session.decryptRecord({ ...changed, envelope: encrypted }),
      ).rejects.toThrow();
    }

    const tampered: EncryptedEnvelope = {
      ...encrypted,
      ciphertext: `${encrypted.ciphertext[0] === "A" ? "B" : "A"}${encrypted.ciphertext.slice(1)}`,
    };
    await expect(
      session.decryptRecord({
        ownerUserId: identity.ownerUserId,
        recordType: "managed-account-private",
        recordId: "account-1",
        envelope: tampered,
      }),
    ).rejects.toThrow();
  });

  it("changes only the root-key password envelope", async () => {
    const session = new VaultCryptoSession();
    const identity = ids();
    const initialized = await session.initialize({
      ...identity,
      password: "old-password",
      kdfParams: testKdf,
    });
    const record = await session.encryptRecord({
      ownerUserId: identity.ownerUserId,
      recordType: "managed-account-private",
      recordId: "account-1",
      value: { secret: "unchanged-record" },
    });
    const changed = await session.changePassword({
      vault: initialized.vault,
      newPassword: "new-password",
      kdfParams: testKdf,
    });
    const updatedVault = { ...initialized.vault, ...changed, revision: 2 };
    expect(updatedVault.recoveryEnvelope).toEqual(initialized.vault.recoveryEnvelope);

    session.lock();
    await expect(
      session.unlockWithPassword(updatedVault, "old-password"),
    ).rejects.toBeInstanceOf(VaultUnlockError);
    await session.unlockWithPassword(updatedVault, "new-password");
    expect(
      await session.decryptRecord({
        ownerUserId: identity.ownerUserId,
        recordType: "managed-account-private",
        recordId: "account-1",
        envelope: record,
      }),
    ).toEqual({ secret: "unchanged-record" });
  });

  it("rotates recovery material and domain-separates blind indexes", async () => {
    const session = new VaultCryptoSession();
    const identity = ids();
    const initialized = await session.initialize({
      ...identity,
      password: "password",
      kdfParams: testKdf,
    });
    const emailIndex = await session.blindIndex("  OWNER@Example.Test ", "login-email");
    expect(await session.blindIndex("owner@example.test", "login-email")).toBe(emailIndex);
    expect(await session.blindIndex("owner@example.test", "phone")).not.toBe(emailIndex);
    expect(await session.blindIndex("Code-A", "recovery", "exact")).not.toBe(
      await session.blindIndex("code-a", "recovery", "exact"),
    );

    const rotated = await session.rotateRecovery(initialized.vault);
    const updatedVault = {
      ...initialized.vault,
      recoveryEnvelope: rotated.recoveryEnvelope,
      recoveryKeyChecksum: rotated.recoveryKeyChecksum,
      revision: 2,
    };
    session.lock();
    await expect(
      session.unlockWithRecovery(updatedVault, initialized.recoveryKey),
    ).rejects.toBeInstanceOf(VaultUnlockError);
    await session.unlockWithRecovery(updatedVault, rotated.recoveryKey);
    expect(session.isUnlocked()).toBe(true);
  });

  it("matches RFC 6238 SHA-1 vectors and rejects HOTP imports", () => {
    const session = new VaultCryptoSession();
    const configuration = {
      type: "totp" as const,
      issuer: "RFC",
      label: "fixture",
      secretBase32: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      algorithm: "SHA1" as const,
      digits: 8 as const,
      period: 30,
    };
    expect(session.generateTotp(configuration, 59_000).code).toBe("94287082");
    expect(session.generateTotp(configuration, 1_111_111_109_000).code).toBe(
      "07081804",
    );
    expect(() =>
      session.parseTotpUri(
        "otpauth://hotp/RFC:fixture?secret=GEZDGNBVGY3TQOJQ&counter=0",
      ),
    ).toThrow("Only TOTP credentials are supported");
  });

  it("zeroizes its in-memory key references when locked", async () => {
    const session = new VaultCryptoSession();
    const identity = ids();
    await session.initialize({ ...identity, password: "password", kdfParams: testKdf });
    session.lock();
    expect(session.isUnlocked()).toBe(false);
    await expect(
      session.encryptRecord({
        ownerUserId: identity.ownerUserId,
        recordType: "managed-account-private",
        recordId: "account-1",
        value: {},
      }),
    ).rejects.toBeInstanceOf(VaultLockedError);
  });
});

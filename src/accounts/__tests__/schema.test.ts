import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createManagedAccountRequestSchema,
  createRecoveryCodesRequestSchema,
  managedAccountListQuerySchema,
  managedAccountPrivatePayloadSchema,
  totpConfigurationSchema,
} from "../schema";

const envelope = {
  version: 1 as const,
  algorithm: "xchacha20poly1305-ietf" as const,
  keyId: "vault-data-v1" as const,
  nonce: "A".repeat(32),
  ciphertext: "B".repeat(32),
};

describe("managed account schemas", () => {
  it("accepts the versioned browser-only payload", () => {
    expect(
      managedAccountPrivatePayloadSchema.parse({
        version: 1,
        loginEmail: "owner@example.test",
        phone: "+12025550123",
        totp: {
          type: "totp",
          issuer: "OpenAI",
          label: "owner@example.test",
          secretBase32: "JBSWY3DPEHPK3PXP",
          algorithm: "SHA1",
          digits: 6,
          period: 30,
        },
      }),
    ).toMatchObject({ version: 1, loginEmail: "owner@example.test" });
  });

  it("rejects plaintext fields at the server API boundary", () => {
    const request = {
      id: randomUUID(),
      platform: "openai",
      displayName: "Primary",
      privatePayload: envelope,
      emailBlindIndex: null,
      emailDomainBlindIndex: null,
      hasTotp: false,
    };
    expect(createManagedAccountRequestSchema.safeParse(request).success).toBe(true);
    expect(
      createManagedAccountRequestSchema.safeParse({
        ...request,
        loginEmail: "owner@example.test",
      }).success,
    ).toBe(false);
    expect(
      createManagedAccountRequestSchema.safeParse({
        ...request,
        password: "must-never-be-supported",
      }).success,
    ).toBe(false);
  });

  it("accepts only encrypted recovery-code imports", () => {
    const request = {
      codes: [
        {
          id: randomUUID(),
          codeCiphertext: envelope,
          codeBlindIndex: "C".repeat(43),
          batchLabelCiphertext: null,
        },
      ],
    };
    expect(createRecoveryCodesRequestSchema.safeParse(request).success).toBe(true);
    expect(
      createRecoveryCodesRequestSchema.safeParse({
        codes: [{ ...request.codes[0], code: "plaintext-forbidden" }],
      }).success,
    ).toBe(false);
  });

  it("strictly validates TOTP and bounded list filters", () => {
    expect(
      totpConfigurationSchema.safeParse({
        type: "hotp",
        issuer: "OpenAI",
        label: "owner",
        secretBase32: "JBSWY3DPEHPK3PXP",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      }).success,
    ).toBe(false);
    expect(
      managedAccountListQuerySchema.parse({ page: "2", hasTotp: "true" }),
    ).toMatchObject({ page: 2, pageSize: 25, hasTotp: true });
    expect(
      managedAccountListQuerySchema.safeParse({ pageSize: "101" }).success,
    ).toBe(false);
  });
});

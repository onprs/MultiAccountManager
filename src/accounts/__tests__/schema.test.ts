import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accountPlatformSchema,
  createManagedAccountRequestSchema,
  createRecoveryCodesRequestSchema,
  managedAccountListQuerySchema,
  managedAccountPrivatePayloadSchema,
  phoneBindingHistoryForUpdate,
  removeTotpFromPrivatePayload,
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
  it("accepts ClinePass as an account platform", () => {
    expect(accountPlatformSchema.parse("clinepass")).toBe("clinepass");
  });

  it("accepts the versioned browser-only payload", () => {
    expect(
      managedAccountPrivatePayloadSchema.parse({
        version: 1,
        loginEmail: "owner@example.test",
        password: "  exact password  ",
        phone: "+12025550123",
        emailOtpEndpoint: "https://mail-code.example.test/inbox",
        emailOtpCdk: "email-cdk-value",
        smsEndpoint: "https://sms-code.example.test/inbox",
        smsEndpointCdk: "sms-cdk-value",
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
    ).toMatchObject({
      version: 1,
      loginEmail: "owner@example.test",
      password: "  exact password  ",
      emailOtpCdk: "email-cdk-value",
      smsEndpointCdk: "sms-cdk-value",
    });
  });

  it("preserves distinct historical phone bindings when a phone changes", () => {
    const payload = managedAccountPrivatePayloadSchema.parse({
      version: 1,
      loginEmail: "owner@example.test",
      phone: "+1 (202) 555-0123",
    });

    expect(
      phoneBindingHistoryForUpdate(payload, "+1 202 555 0123"),
    ).toBeUndefined();
    expect(phoneBindingHistoryForUpdate(payload, "+44 20 7946 0958")).toEqual([
      "+1 (202) 555-0123",
    ]);
    expect(
      phoneBindingHistoryForUpdate(
        {
          ...payload,
          phone: "+44 20 7946 0958",
          phoneBindingHistory: ["+1 (202) 555-0123"],
        },
        "+1 202 555 0123",
      ),
    ).toEqual(["+1 (202) 555-0123", "+44 20 7946 0958"]);
  });

  it("removes only TOTP from the browser-only payload", () => {
    const payload = managedAccountPrivatePayloadSchema.parse({
      version: 1,
      loginEmail: "owner@example.test",
      password: "exact password",
      phone: "+12025550123",
      emailOtpEndpoint: "https://mail-code.example.test/inbox",
      emailOtpCdk: "email-cdk-value",
      smsEndpoint: "https://sms-code.example.test/inbox",
      smsEndpointCdk: "sms-cdk-value",
      notes: "sensitive note",
      totp: {
        type: "totp",
        issuer: "OpenAI",
        label: "owner@example.test",
        secretBase32: "JBSWY3DPEHPK3PXP",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      },
    });

    expect(removeTotpFromPrivatePayload(payload)).toEqual({
      version: 1,
      loginEmail: "owner@example.test",
      password: "exact password",
      phone: "+12025550123",
      emailOtpEndpoint: "https://mail-code.example.test/inbox",
      emailOtpCdk: "email-cdk-value",
      smsEndpoint: "https://sms-code.example.test/inbox",
      smsEndpointCdk: "sms-cdk-value",
      notes: "sensitive note",
    });
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
      managedAccountListQuerySchema.parse({
        page: "2",
        hasTotp: "true",
        includeDeleted: "true",
      }),
    ).toMatchObject({
      page: 2,
      pageSize: 25,
      hasTotp: true,
      includeDeleted: true,
    });
    expect(
      managedAccountListQuerySchema.safeParse({ pageSize: "101" }).success,
    ).toBe(false);
    expect(
      managedAccountListQuerySchema.safeParse({ includeDeleted: "1" }).success,
    ).toBe(false);
  });
});

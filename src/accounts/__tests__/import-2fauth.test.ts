import { describe, expect, it } from "vitest";
import { parseTwoFAuthExport } from "../import-2fauth";

function item(overrides: Record<string, unknown> = {}) {
  return {
    otp_type: "totp",
    account: "managed@example.test",
    service: "OpenAI",
    secret: "JBSWY3DPEHPK3PXP",
    digits: 6,
    algorithm: "sha1",
    period: 30,
    icon_file: "must-be-ignored",
    ...overrides,
  };
}

describe("2FAuth client import", () => {
  it("maps supported schema-1 TOTP without exposing the account in display metadata", () => {
    const result = parseTwoFAuthExport({
      app: "2fauth_v5.1.1",
      schema: 1,
      data: [item()],
    });
    expect(result.errors).toEqual([]);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      platform: "openai",
      displayName: "OpenAI 导入 1",
      payload: {
        version: 1,
        loginEmail: "managed@example.test",
        totp: { algorithm: "SHA1", secretBase32: "JBSWY3DPEHPK3PXP" },
      },
    });
    expect(result.accounts[0].displayName).not.toContain("managed@example.test");
    expect(JSON.stringify(result.accounts[0])).not.toContain("must-be-ignored");
  });

  it("reports unsupported, malformed, and duplicate records independently", () => {
    const result = parseTwoFAuthExport({
      app: "2fauth_v5.1.1",
      schema: 1,
      data: [
        item({ otp_type: "hotp" }),
        item({ service: "Unknown" }),
        item({}),
        item({ account: "second@example.test" }),
        { broken: true },
      ],
    });
    expect(result.accounts).toHaveLength(1);
    expect(result.errors.map((error) => error.sourceIndex)).toEqual([0, 1, 3, 4]);
  });

  it("rejects unknown export schema versions", () => {
    expect(
      parseTwoFAuthExport({ app: "2fauth", schema: 2, data: [] }),
    ).toMatchObject({ accounts: [], errors: [{ sourceIndex: null }] });
  });
});

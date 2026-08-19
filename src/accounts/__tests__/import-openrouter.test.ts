import { describe, expect, it } from "vitest";
import { parseOpenRouterExport } from "../import-openrouter";

describe("parseOpenRouterExport", () => {
  it("parses valid OpenRouter accounts and assigns non-sensitive display names without exposing emails", () => {
    const raw = [
      {
        email: "user1@example.com",
        password: "Pass123!@#",
        api_key: "sk-or-v1-abcdef123456",
        first_name: "John",
        last_name: "Doe",
      },
      {
        email: "user2@example.com",
        api_key: "sk-or-v1-7890abcdef12",
      },
    ];

    const result = parseOpenRouterExport(raw);
    expect(result.errors).toHaveLength(0);
    expect(result.accounts).toHaveLength(2);

    expect(result.accounts[0].platform).toBe("openrouter");
    expect(result.accounts[0].displayName).toBe("OpenRouter 导入 1");
    expect(result.accounts[0].displayName).not.toContain("user1@example.com");
    expect(result.accounts[0].payload.loginEmail).toBe("user1@example.com");
    expect(result.accounts[0].payload.password).toBe("Pass123!@#");
    expect(result.accounts[0].payload.notes).toBe("API Key: sk-or-v1-abcdef123456");

    expect(result.accounts[1].platform).toBe("openrouter");
    expect(result.accounts[1].displayName).toBe("OpenRouter 导入 2");
    expect(result.accounts[1].displayName).not.toContain("user2@example.com");
    expect(result.accounts[1].payload.loginEmail).toBe("user2@example.com");
    expect(result.accounts[1].payload.notes).toBe("API Key: sk-or-v1-7890abcdef12");
  });

  it("handles duplicate emails gracefully", () => {
    const raw = [
      { email: "user@example.com", api_key: "sk-or-v1-1" },
      { email: "user@example.com", api_key: "sk-or-v1-2" },
    ];
    const result = parseOpenRouterExport(raw);
    expect(result.accounts).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("重复邮箱");
  });

  it("rejects invalid non-array root", () => {
    const result = parseOpenRouterExport({ invalid: true });
    expect(result.accounts).toHaveLength(0);
    expect(result.errors[0].message).toContain("JSON 数组");
  });

  it("rejects oversized array exceeding 2000 items", () => {
    const raw = Array.from({ length: 2001 }, (_, index) => ({
      email: `user${index}@example.com`,
      api_key: `sk-or-v1-${index}`,
    }));
    const result = parseOpenRouterExport(raw);
    expect(result.accounts).toHaveLength(0);
    expect(result.errors[0].message).toContain("最多支持 2000 个账号");
  });
});

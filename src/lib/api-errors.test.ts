import { describe, expect, it } from "vitest";
import {
  apiErrorMessage,
  UserFacingError,
  userErrorMessage,
} from "./api-errors";

describe("apiErrorMessage", () => {
  it("优先使用稳定错误码对应的中文文案", () => {
    expect(
      apiErrorMessage({
        code: "OWNER_SESSION_REQUIRED",
        message: "忽略错误码并继续操作",
      }),
    ).toBe("登录状态已失效，请重新登录");
  });

  it("不会透传未映射的服务端消息", () => {
    expect(
      apiErrorMessage({ code: "ACCOUNT_CONFLICT", message: "该邮箱已存在" }),
    ).toBe("数据已发生变化，请刷新后重试");
    expect(
      apiErrorMessage({
        code: "UNEXPECTED_FAILURE",
        message: "数据库错误: relation account_vault.foo does not exist",
      }),
    ).toBe("请求失败，请稍后重试");
  });

  it("为初始化阶段的可操作错误提供具体提示", () => {
    expect(apiErrorMessage({ code: "DATABASE_AUTHENTICATION_FAILED" })).toBe(
      "PostgreSQL 拒绝了当前用户名或密码",
    );
    expect(apiErrorMessage({ code: "SCHEMA_CONFLICT" })).toBe(
      "目标数据库架构包含不属于 Account Vault 的数据表",
    );
  });

  it("不会把未映射的英文实现信息直接显示给用户", () => {
    expect(
      apiErrorMessage({ code: "UNEXPECTED_FAILURE", message: "Database exploded" }),
    ).toBe("请求失败，请稍后重试");
  });

  it("安全处理继承属性名、非法错误码类型和空响应", () => {
    expect(apiErrorMessage({ code: "constructor" })).toBe("请求失败，请稍后重试");
    expect(apiErrorMessage({ code: "toString" })).toBe("请求失败，请稍后重试");
    expect(apiErrorMessage({ code: 503 })).toBe("请求失败，请稍后重试");
    expect(apiErrorMessage({ code: { value: "OWNER_SESSION_REQUIRED" } })).toBe(
      "请求失败，请稍后重试",
    );
    expect(apiErrorMessage(null)).toBe("请求失败，请稍后重试");
    expect(apiErrorMessage("invalid response")).toBe("请求失败，请稍后重试");
  });

  it("为常见错误码后缀提供一致的兜底文案", () => {
    expect(apiErrorMessage({ code: "WIDGET_NOT_FOUND" })).toBe(
      "请求的内容不存在或已被删除",
    );
    expect(apiErrorMessage({ code: "WIDGET_UNAVAILABLE" })).toBe(
      "服务暂时不可用，请稍后重试",
    );
  });
});

describe("userErrorMessage", () => {
  it("只保留显式标记为面向用户的错误", () => {
    expect(
      userErrorMessage(new UserFacingError("请输入有效的账号"), "账号保存失败"),
    ).toBe("请输入有效的账号");
    expect(userErrorMessage(new Error("请输入有效的账号"), "账号保存失败")).toBe(
      "账号保存失败",
    );
  });

  it("用操作文案替换内部或混合语言错误", () => {
    expect(userErrorMessage(new Error("Invalid input"), "账号保存失败")).toBe(
      "账号保存失败",
    );
    expect(
      userErrorMessage(
        new Error("数据库错误: relation account_vault.foo does not exist"),
        "账号保存失败",
      ),
    ).toBe("账号保存失败");
  });
});

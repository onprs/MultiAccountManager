import { z } from "zod";
import {
  managedAccountPrivatePayloadSchema,
  type AccountPlatform,
  type ManagedAccountPrivatePayload,
} from "./schema";

const exportItemSchema = z.object({
  otp_type: z.string(),
  account: z.string().max(320).nullable().optional(),
  service: z.string().trim().max(120).nullable().optional(),
  secret: z.string(),
  digits: z.number().int(),
  algorithm: z.string(),
  period: z.number().int().nullable().optional(),
});

const exportSchema = z.object({
  app: z.string(),
  schema: z.literal(1),
  data: z.array(z.unknown()).max(2_000),
});

export type ImportedManagedAccount = {
  sourceIndex: number;
  platform: AccountPlatform;
  displayName: string;
  payload: ManagedAccountPrivatePayload;
};

export type TwoFAuthImportResult = {
  accounts: ImportedManagedAccount[];
  errors: Array<{ sourceIndex: number | null; message: string }>;
};

export function parseTwoFAuthExport(value: unknown): TwoFAuthImportResult {
  const parsed = exportSchema.safeParse(value);
  if (!parsed.success) {
    return {
      accounts: [],
      errors: [{ sourceIndex: null, message: "不是受支持的 2FAuth schema 1 导出文件" }],
    };
  }
  const accounts: ImportedManagedAccount[] = [];
  const errors: TwoFAuthImportResult["errors"] = [];
  const seen = new Set<string>();

  parsed.data.data.forEach((raw, sourceIndex) => {
    const item = exportItemSchema.safeParse(raw);
    if (!item.success) {
      errors.push({ sourceIndex, message: "记录字段缺失或类型无效" });
      return;
    }
    if (item.data.otp_type.toLowerCase() !== "totp") {
      errors.push({ sourceIndex, message: "仅支持 TOTP，HOTP/Steam TOTP 已跳过" });
      return;
    }
    const platform = detectPlatform(item.data.service ?? "");
    if (!platform) {
      errors.push({ sourceIndex, message: "无法映射到 OpenAI、OpenCode Go、Antigravity、ClinePass 或 OpenRouter" });
      return;
    }
    if (!isEmail(item.data.account)) {
      errors.push({ sourceIndex, message: "账号字段必须是有效邮箱" });
      return;
    }
    const loginEmail = item.data.account.trim().toLowerCase();
    const secretBase32 = item.data.secret
      .replace(/[\s-]/g, "")
      .replace(/=+$/g, "")
      .toUpperCase();
    const algorithm = item.data.algorithm.toUpperCase();
    const dedupeKey = `${platform}:${secretBase32}`;
    if (seen.has(dedupeKey)) {
      errors.push({ sourceIndex, message: "文件内存在重复 TOTP Secret" });
      return;
    }
    seen.add(dedupeKey);

    const payload = managedAccountPrivatePayloadSchema.safeParse({
      version: 1,
      loginEmail,
      totp: {
        type: "totp",
        issuer: (item.data.service || platformLabel(platform)).trim(),
        label: (item.data.account || platformLabel(platform)).trim(),
        secretBase32,
        algorithm,
        digits: item.data.digits,
        period: item.data.period ?? 30,
      },
    });
    if (!payload.success) {
      errors.push({ sourceIndex, message: "TOTP Secret、算法、位数或周期不受支持" });
      return;
    }
    accounts.push({
      sourceIndex,
      platform,
      displayName: `${platformLabel(platform)} 导入 ${sourceIndex + 1}`,
      payload: payload.data,
    });
  });

  return { accounts, errors };
}

function detectPlatform(service: string): AccountPlatform | null {
  const normalized = service.normalize("NFKC").trim().toLowerCase();
  if (normalized.includes("openai") || normalized.includes("chatgpt")) return "openai";
  if (normalized.includes("opencode")) return "opencode_go";
  if (normalized.includes("antigravity")) return "antigravity";
  if (normalized.includes("clinepass") || normalized.includes("cline pass")) return "clinepass";
  if (normalized.includes("openrouter") || normalized.includes("open router")) return "openrouter";
  return null;
}

function platformLabel(platform: AccountPlatform): string {
  if (platform === "openai") return "OpenAI";
  if (platform === "opencode_go") return "OpenCode Go";
  if (platform === "antigravity") return "Antigravity";
  if (platform === "clinepass") return "ClinePass";
  return "OpenRouter";
}

function isEmail(value: string | null | undefined): value is string {
  if (!value) return false;
  return z.string().trim().email().max(320).safeParse(value).success;
}

import { z } from "zod";
import {
  managedAccountPrivatePayloadSchema,
  type AccountPlatform,
  type ManagedAccountPrivatePayload,
} from "./schema";

const openRouterItemSchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().max(2_000).optional(),
  api_key: z.string().trim().min(1).max(2_000),
  first_name: z.string().max(120).optional(),
  last_name: z.string().max(120).optional(),
});

export type ImportedOpenRouterAccount = {
  sourceIndex: number;
  platform: AccountPlatform;
  displayName: string;
  payload: ManagedAccountPrivatePayload;
};

export type OpenRouterImportResult = {
  accounts: ImportedOpenRouterAccount[];
  errors: Array<{ sourceIndex: number | null; message: string }>;
};

function isEmail(value: string | null | undefined): value is string {
  if (!value) return false;
  return z.string().trim().email().max(320).safeParse(value).success;
}

export function parseOpenRouterExport(value: unknown): OpenRouterImportResult {
  if (!Array.isArray(value)) {
    return {
      accounts: [],
      errors: [{ sourceIndex: null, message: "OpenRouter 导入文件必须是 JSON 数组" }],
    };
  }

  if (value.length > 2_000) {
    return {
      accounts: [],
      errors: [{ sourceIndex: null, message: "OpenRouter 导入文件单次最多支持 2000 个账号" }],
    };
  }

  const accounts: ImportedOpenRouterAccount[] = [];
  const errors: OpenRouterImportResult["errors"] = [];
  const seen = new Set<string>();

  value.forEach((raw, sourceIndex) => {
    const item = openRouterItemSchema.safeParse(raw);
    if (!item.success) {
      errors.push({ sourceIndex, message: "记录字段缺失（必须包含 email 和 api_key）" });
      return;
    }

    if (!isEmail(item.data.email)) {
      errors.push({ sourceIndex, message: "账号字段必须是有效邮箱格式" });
      return;
    }

    const loginEmail = item.data.email.trim().toLowerCase();
    if (seen.has(loginEmail)) {
      errors.push({ sourceIndex, message: `文件内存在重复邮箱: ${loginEmail}` });
      return;
    }
    seen.add(loginEmail);

    const payload = managedAccountPrivatePayloadSchema.safeParse({
      version: 1,
      loginEmail,
      password: item.data.password || undefined,
      notes: item.data.api_key ? `API Key: ${item.data.api_key}` : undefined,
    });

    if (!payload.success) {
      errors.push({ sourceIndex, message: "账号载荷验证失败" });
      return;
    }

    accounts.push({
      sourceIndex,
      platform: "openrouter",
      displayName: `OpenRouter 导入 ${sourceIndex + 1}`,
      payload: payload.data,
    });
  });

  return { accounts, errors };
}

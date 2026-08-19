import fs from "node:fs/promises";
import { apiError, noStoreJson, requestId } from "@/lib/http";
import { readRuntimeConfig } from "@/runtime/config-store";
import {
  apiImportOpenRouterRequestSchema,
  importOpenRouterAccountsDirect,
} from "@/server/accounts/api-import";

function extractApiKey(request: Request): string | null {
  const headerKey = request.headers.get("x-api-key");
  if (headerKey) return headerKey.trim();

  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      return parts[1].trim();
    }
  }
  return null;
}

export async function POST(request: Request) {
  let config;
  try {
    config = await readRuntimeConfig();
  } catch {
    return apiError(request, 503, "CONFIG_UNAVAILABLE", "Runtime configuration is unavailable");
  }

  const suppliedKey = extractApiKey(request);
  const expectedKey = process.env.ACCOUNT_VAULT_IMPORT_KEY || config.auth.secret;

  let setupToken = "";
  try {
    const setupTokenFile = process.env.SETUP_TOKEN_FILE || "/run/secrets/account-vault-setup-token";
    setupToken = (await fs.readFile(setupTokenFile, "utf-8")).trim();
  } catch {
    // ignore
  }

  const isAuthorized = Boolean(
    suppliedKey && (
      suppliedKey === expectedKey ||
      (setupToken && suppliedKey === setupToken)
    ),
  );

  if (!isAuthorized) {
    return apiError(request, 401, "UNAUTHORIZED", "Invalid or missing API key for import");
  }

  const rawJson = await request.json().catch(() => null);
  const parsed = apiImportOpenRouterRequestSchema.safeParse(rawJson);
  if (!parsed.success) {
    return apiError(
      request,
      400,
      "INVALID_IMPORT_PAYLOAD",
      parsed.error.issues.map((i) => i.message).join(", "),
    );
  }

  try {
    const result = await importOpenRouterAccountsDirect(
      parsed.data,
      requestId(request),
    );
    return noStoreJson(result, { status: 200 });
  } catch (error) {
    return apiError(
      request,
      500,
      "IMPORT_FAILED",
      error instanceof Error ? error.message : "Failed to import OpenRouter accounts",
    );
  }
}

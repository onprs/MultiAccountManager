import {
  observerAccountSchema,
  observerAccountsPageSchema,
  type ObserverAccountsPage,
} from "@/integrations/schema";

const observerPath = "/api/v1/integrations/account-observer/v1/accounts";
const maxResponseBytes = 5 * 1024 * 1024;

export class Sub2apiClientError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: string;
    status?: number | null;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "Sub2apiClientError";
    this.code = input.code;
    this.status = input.status ?? null;
    this.retryable = input.retryable ?? false;
  }
}

export type ObserverFetchResult =
  | {
      status: "not_modified";
      etag: string | null;
      serverDate: Date | null;
      integrationScope: string | null;
    }
  | {
      status: "ok";
      page: ObserverAccountsPage;
      etag: string | null;
      serverDate: Date | null;
      integrationScope: string | null;
    };

export function normalizeSub2apiBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Sub2apiClientError({
      code: "INVALID_BASE_URL",
      message: "Sub2API URL cannot include credentials, query, or fragment",
    });
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && loopback)) {
    throw new Sub2apiClientError({
      code: "HTTPS_REQUIRED",
      message: "Sub2API URL must use HTTPS",
    });
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Sub2apiClientError({
      code: "INVALID_BASE_URL",
      message: "Sub2API URL must not include a path",
    });
  }
  return url.origin;
}

export async function fetchObserverAccounts(input: {
  baseUrl: string;
  token: string;
  cursor?: string | null;
  updatedSince?: string | null;
  etag?: string | null;
  limit?: number;
  timeoutMilliseconds?: number;
  fetchImpl?: typeof fetch;
}): Promise<ObserverFetchResult> {
  const baseUrl = normalizeSub2apiBaseUrl(input.baseUrl);
  const url = new URL(observerPath, baseUrl);
  url.searchParams.set("limit", String(Math.min(200, Math.max(1, input.limit ?? 200))));
  if (input.cursor) url.searchParams.set("cursor", input.cursor);
  if (input.updatedSince) url.searchParams.set("updated_since", input.updatedSince);

  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${input.token}`,
  });
  if (input.etag) headers.set("If-None-Match", input.etag);

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMilliseconds ?? 30_000),
    });
  } catch (error) {
    throw new Sub2apiClientError({
      code: error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "CONNECTION_FAILED",
      message: "Sub2API connection failed",
      retryable: true,
    });
  }

  const etag = response.headers.get("etag");
  const serverDate = parseServerDate(response.headers.get("date"));
  const integrationScope = response.headers.get("x-integration-scope");
  if (response.status === 304) {
    return { status: "not_modified", etag, serverDate, integrationScope };
  }
  if (!response.ok) {
    const authFailure = response.status === 401 || response.status === 403;
    const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
    throw new Sub2apiClientError({
      code: authFailure ? "OBSERVER_AUTH_REJECTED" : retryable ? "OBSERVER_RETRYABLE" : "OBSERVER_HTTP_ERROR",
      message: authFailure
        ? "Sub2API rejected the observer token"
        : `Sub2API observer returned HTTP ${response.status}`,
      status: response.status,
      retryable,
    });
  }

  const text = await readBoundedResponseText(response);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Sub2apiClientError({
      code: "INVALID_OBSERVER_JSON",
      message: "Sub2API observer returned invalid JSON",
    });
  }
  const outer = observerAccountsPageSchema.safeParse(raw);
  if (!outer.success) {
    throw new Sub2apiClientError({
      code: "INVALID_OBSERVER_SCHEMA",
      message: "Sub2API observer schema is incompatible",
    });
  }

  const items = [];
  let invalidItems = 0;
  for (const candidate of outer.data.items) {
    const parsed = observerAccountSchema.safeParse(candidate);
    if (parsed.success) items.push(parsed.data);
    else invalidItems += 1;
  }
  return {
    status: "ok",
    etag,
    serverDate,
    integrationScope,
    page: {
      schema_version: outer.data.schema_version,
      instance_id: outer.data.instance_id,
      generated_at: outer.data.generated_at,
      next_cursor: outer.data.next_cursor,
      items,
      invalidItems,
    },
  };
}

export async function deleteObserverAccount(input: {
  baseUrl: string;
  token: string;
  accountId: string;
  timeoutMilliseconds?: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const baseUrl = normalizeSub2apiBaseUrl(input.baseUrl);
  const accountId = normalizeObserverAccountId(input.accountId);
  const url = new URL(`${observerPath}/${encodeURIComponent(accountId)}`, baseUrl);

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "DELETE",
      headers: new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMilliseconds ?? 15_000),
    });
  } catch (error) {
    throw new Sub2apiClientError({
      code: error instanceof DOMException && error.name === "TimeoutError"
        ? "OBSERVER_DELETE_TIMEOUT"
        : "OBSERVER_DELETE_CONNECTION_FAILED",
      message: "Sub2API account deletion connection failed",
      retryable: true,
    });
  }

  if (response.ok) return;
  const authFailure = response.status === 401;
  const forbidden = response.status === 403;
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  throw new Sub2apiClientError({
    code: authFailure
      ? "OBSERVER_AUTH_REJECTED"
      : forbidden
        ? "OBSERVER_DELETE_FORBIDDEN"
        : retryable
          ? "OBSERVER_DELETE_RETRYABLE"
          : "OBSERVER_DELETE_HTTP_ERROR",
    message: authFailure
      ? "Sub2API rejected the integration token"
      : forbidden
        ? "Sub2API integration token cannot delete accounts"
        : `Sub2API account deletion returned HTTP ${response.status}`,
    status: response.status,
    retryable,
  });
}

export async function testSub2apiConnection(input: {
  baseUrl: string;
  token: string;
  expectedInstanceId?: string | null;
  fetchImpl?: typeof fetch;
}) {
  const startedAt = Date.now();
  const result = await fetchObserverAccounts({
    ...input,
    limit: 1,
    timeoutMilliseconds: 10_000,
  });
  if (result.status !== "ok") {
    throw new Sub2apiClientError({
      code: "UNEXPECTED_NOT_MODIFIED",
      message: "Sub2API connection test returned no data",
    });
  }
  if (
    input.expectedInstanceId &&
    result.page.instance_id !== input.expectedInstanceId
  ) {
    throw new Sub2apiClientError({
      code: "INSTANCE_ID_CHANGED",
      message: "Sub2API instance identity changed",
    });
  }
  const grantedScopes = new Set(result.integrationScope?.split(/\s+/).filter(Boolean) ?? []);
  if (
    !grantedScopes.has("account_observer:read") ||
    !grantedScopes.has("account_observer:delete")
  ) {
    throw new Sub2apiClientError({
      code: "INTEGRATION_SCOPE_INSUFFICIENT",
      message: "Sub2API integration token requires read and delete scopes",
      status: 403,
    });
  }
  const midpoint = startedAt + (Date.now() - startedAt) / 2;
  const clockSkewSeconds = result.serverDate
    ? Math.round((result.serverDate.getTime() - midpoint) / 1000)
    : null;
  return {
    instanceId: result.page.instance_id,
    schemaVersion: result.page.schema_version,
    generatedAt: result.page.generated_at,
    clockSkewSeconds,
    invalidItems: result.page.invalidItems,
    integrationScope: result.integrationScope,
  };
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw responseTooLargeError();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function responseTooLargeError(): Sub2apiClientError {
  return new Sub2apiClientError({
    code: "RESPONSE_TOO_LARGE",
    message: "Sub2API observer response is too large",
  });
}

function normalizeObserverAccountId(raw: string): string {
  const value = raw.trim();
  const exceedsInt64 = value.length === 19 && value > "9223372036854775807";
  if (!/^[1-9]\d{0,18}$/.test(value) || exceedsInt64) {
    throw new Sub2apiClientError({
      code: "INVALID_OBSERVER_ACCOUNT_ID",
      message: "Sub2API account ID is invalid",
    });
  }
  return value;
}

function parseServerDate(raw: string | null): Date | null {
  if (!raw) return null;
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? null : value;
}

"use client";

import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CirclePlus,
  Copy,
  Eye,
  EyeOff,
  FileJson,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { parseTwoFAuthExport } from "@/accounts/import-2fauth";
import { parseOpenRouterExport } from "@/accounts/import-openrouter";
import {
  managedAccountPrivatePayloadSchema,
  phoneBindingIdentity,
  totpConfigurationSchema,
  type AccountLocalStatus,
  type AccountPlatform,
  type ManagedAccount,
  type ManagedAccountPrivatePayload,
  type TotpConfiguration,
  type TotpResult,
} from "@/accounts/schema";
import type { VaultCryptoClient } from "@/crypto";
import {
  normalizeRemoteAccountEmail,
  selectUniqueEmailLinks,
  supportsAutomaticAccountLink,
} from "@/integrations/auto-link";
import type { ConnectionSummary, RemoteCatalogItem } from "@/integrations/schema";
import { currentEpochMilliseconds } from "@/lib/clock";
import {
  apiErrorMessage,
  UserFacingError,
  userErrorMessage,
} from "@/lib/api-errors";
import type { IntegrationLinkView } from "@/server/integrations/service";
import { AccountDetails } from "./AccountDetails";
import { QrCredentialInput } from "./QrCredentialInput";
import { SecretInput } from "./SecretInput";

type AccountList = {
  items: ManagedAccount[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
};

type AccountView = ManagedAccount & {
  decrypted: ManagedAccountPrivatePayload | null;
};

type OtpView = TotpResult & {
  accountRevision: number;
  expiresAt: number;
};
type ApiFailure = { code?: string; message?: string };
type SortField = "email" | "platform" | "sub2api";
type SortDirection = "asc" | "desc";
type PendingBulkAction = {
  type: "delete";
  accountIds: string[];
};

const accountPageSize = 25;

const platformLabels: Record<AccountPlatform, string> = {
  openai: "OpenAI",
  opencode_go: "OpenCode Go",
  antigravity: "Antigravity",
  clinepass: "ClinePass",
  openrouter: "OpenRouter",
};

export type AccountManagerInitialQuery = {
  page: number;
  search: string;
  platform: AccountPlatform | "";
  localStatus: AccountLocalStatus;
  hasTotp: "" | "true" | "false";
};

export function AccountManager({
  ownerUserId,
  client,
  initialQuery,
}: {
  ownerUserId: string;
  client: VaultCryptoClient;
  initialQuery: AccountManagerInitialQuery;
}) {
  const [allItems, setAllItems] = useState<AccountView[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(initialQuery.page);
  const [platform, setPlatform] = useState<AccountPlatform | "">(
    initialQuery.platform,
  );
  const [localStatus, setLocalStatus] = useState<AccountLocalStatus>(
    initialQuery.localStatus,
  );
  const [hasTotp, setHasTotp] = useState<"" | "true" | "false">(
    initialQuery.hasTotp,
  );
  const [search, setSearch] = useState(initialQuery.search);
  const [emailBlindIndex, setEmailBlindIndex] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState<AccountView | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importReport, setImportReport] = useState<string | null>(null);
  const [clockSkewSeconds, setClockSkewSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operationStatus, setOperationStatus] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    () => new Set(),
  );
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [pendingBulkAction, setPendingBulkAction] =
    useState<PendingBulkAction | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [otpById, setOtpById] = useState<Record<string, OtpView>>({});
  const [otpErrorRevisionById, setOtpErrorRevisionById] = useState<Record<string, number>>({});
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, boolean>>({});
  const [integrationLinks, setIntegrationLinks] = useState<IntegrationLinkView[] | null>(null);
  const [sub2apiConfigured, setSub2apiConfigured] = useState(false);
  const autoLinkingRef = useRef(false);
  const otpGeneratingIdsRef = useRef(new Set<string>());
  const serverClockOffsetRef = useRef<number | null | undefined>(undefined);
  const [now, setNow] = useState(0);

  const integrationLinksByAccount = useMemo(() => {
    const grouped = new Map<string, IntegrationLinkView[]>();
    for (const link of integrationLinks ?? []) {
      const links = grouped.get(link.managedAccountId) ?? [];
      links.push(link);
      grouped.set(link.managedAccountId, links);
    }
    return grouped;
  }, [integrationLinks]);

  const phoneBindingCounts = useMemo<Record<string, number>>(() => {
    const phoneById = new Map<string, string>();
    const idsByPhone = new Map<string, Set<string>>();
    for (const account of allItems) {
      const payload = account.decrypted;
      if (!payload) continue;
      const phone = phoneBindingIdentity(payload.phone);
      if (!phone) continue;
      phoneById.set(account.id, phone);
      const ids = idsByPhone.get(phone) ?? new Set<string>();
      ids.add(account.id);
      idsByPhone.set(phone, ids);
    }
    return Object.fromEntries(
      Array.from(phoneById, ([id, phone]) => [id, idsByPhone.get(phone)?.size ?? 1]),
    );
  }, [allItems]);

  const sortedItems = useMemo(
    () => sortAccountViews(
      allItems,
      sortField,
      sortDirection,
      integrationLinksByAccount,
      sub2apiConfigured,
    ),
    [
      allItems,
      integrationLinksByAccount,
      sortDirection,
      sortField,
      sub2apiConfigured,
    ],
  );
  const items = useMemo(
    () => sortedItems.slice((page - 1) * accountPageSize, page * accountPageSize),
    [page, sortedItems],
  );
  const selectedAccounts = useMemo(
    () => allItems.filter((account) => selectedAccountIds.has(account.id)),
    [allItems, selectedAccountIds],
  );
  const allPageSelected = items.length > 0
    && items.every((account) => selectedAccountIds.has(account.id));
  const somePageSelected = items.some((account) => selectedAccountIds.has(account.id));
  const allFilteredSelected = allItems.length > 0
    && allItems.every((account) => selectedAccountIds.has(account.id));

  const loadIntegrationLinks = useCallback(async () => {
    const result = await api<{ links: IntegrationLinkView[] }>("/api/v1/links");
    setIntegrationLinks(result.links);
  }, []);

  const autoLinkSub2apiAccounts = useCallback(async () => {
    if (autoLinkingRef.current) return;
    autoLinkingRef.current = true;
    try {
      const [localAccounts, connectionResult, linkResult] = await Promise.all([
        loadAllManagedAccountRecords(),
        api<{ connections: ConnectionSummary[] }>("/api/v1/connections"),
        api<{ links: IntegrationLinkView[] }>("/api/v1/links"),
      ]);
      const connections = connectionResult.connections.filter((connection) => connection.enabled);
      setSub2apiConfigured(connections.length > 0);
      let attempted = false;

      for (const connection of connections) {
        const catalogResult = await api<{ items: RemoteCatalogItem[] }>(
          `/api/v1/remote-catalog?connectionId=${encodeURIComponent(connection.id)}`,
        );
        const emails = catalogResult.items.map((item) => normalizeRemoteAccountEmail(item.externalName));
        const emailIndexes = emails.length
          ? await client.batchBlindIndex(
              emails
                .map((email) => email ? { value: email, context: "managed-account-login-email-v1" } : null)
                .filter((entry): entry is { value: string; context: string } => Boolean(entry)),
            )
          : [];
        let indexCursor = 0;
        const remoteCandidates = emails.map((email, idx) => {
          const item = catalogResult.items[idx]!;
          return {
            externalAccountId: item.externalAccountId,
            externalPlatform: item.externalPlatform,
            emailBlindIndex: email ? emailIndexes[indexCursor++] ?? null : null,
          };
        });
        const connectionLinks = linkResult.links.filter(
          (link) => link.connectionId === connection.id,
        );
        const pairs = selectUniqueEmailLinks({
          local: localAccounts,
          remote: remoteCandidates,
          linkedManagedAccountIds: new Set(
            connectionLinks.map((link) => link.managedAccountId),
          ),
          linkedExternalAccountIds: new Set(
            connectionLinks.map((link) => link.externalAccountId),
          ),
        });
        for (const pair of pairs) {
          attempted = true;
          await api("/api/v1/links", {
            method: "POST",
            body: JSON.stringify({
              ...pair,
              connectionId: connection.id,
            }),
          }).catch(() => undefined);
        }
      }

      if (attempted) await loadIntegrationLinks();
      else setIntegrationLinks(linkResult.links);
    } catch {
      await loadIntegrationLinks().catch(() => setIntegrationLinks([]));
    } finally {
      autoLinkingRef.current = false;
    }
  }, [client, loadIntegrationLinks]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const requestedPage = page;
      const visibleQuery = new URLSearchParams({
        page: String(requestedPage),
        localStatus,
      });
      if (search) visibleQuery.set("search", search);
      if (platform) visibleQuery.set("platform", platform);
      if (hasTotp) visibleQuery.set("hasTotp", hasTotp);
      window.history.replaceState(
        null,
        "",
        `/accounts?${visibleQuery.toString()}`,
      );

      const apiQuery = new URLSearchParams({
        localStatus,
        pageSize: "100",
      });
      if (search) apiQuery.set("search", search);
      if (platform) apiQuery.set("platform", platform);
      if (hasTotp) apiQuery.set("hasTotp", hasTotp);
      if (emailBlindIndex) apiQuery.set("emailBlindIndex", emailBlindIndex);

      apiQuery.set("page", "1");
      const firstPage = await api<AccountList>(`/api/v1/accounts?${apiQuery.toString()}`);
      const resultTotal = firstPage.total;
      const apiPages = firstPage.pages;
      const accounts: ManagedAccount[] = [...firstPage.items];
      if (apiPages > 1) {
        const remaining = await Promise.all(
          Array.from({ length: apiPages - 1 }, (_, index) => {
            const params = new URLSearchParams(apiQuery);
            params.set("page", String(index + 2));
            return api<AccountList>(`/api/v1/accounts?${params.toString()}`);
          }),
        );
        for (const pageResult of remaining) accounts.push(...pageResult.items);
      }

      let decrypted: AccountView[];
      if (!accounts.length) {
        decrypted = [];
      } else {
        try {
          const rawPayloads = await client.decryptRecords<ManagedAccountPrivatePayload>({
            ownerUserId,
            recordType: "managed-account-private-v1",
            records: accounts.map((account) => ({
              recordId: account.id,
              envelope: account.privatePayload,
            })),
          });
          decrypted = accounts.map((account, index) => {
            const raw = rawPayloads[index];
            if (!raw) return { ...account, decrypted: null };
            try {
              const payload = managedAccountPrivatePayloadSchema.parse(raw);
              return { ...account, decrypted: payload };
            } catch {
              return { ...account, decrypted: null };
            }
          });
        } catch {
          decrypted = accounts.map((account) => ({ ...account, decrypted: null }));
        }
      }
      const displayPages = Math.max(1, Math.ceil(resultTotal / accountPageSize));
      const availableIds = new Set(decrypted.map((account) => account.id));
      setAllItems(decrypted);
      setSelectedAccountIds((current) =>
        new Set([...current].filter((accountId) => availableIds.has(accountId))),
      );
      setRevealedPasswords({});
      setTotal(resultTotal);
      setPages(displayPages);
      if (requestedPage > displayPages) setPage(displayPages);
    } catch (caught) {
      setError(userErrorMessage(caught, "账号列表加载失败"));
    } finally {
      setLoading(false);
    }
  // 读取 page 仅用于展示 URL，页面切换已在本地完成，无需以 page 作为数据请求依赖
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, emailBlindIndex, hasTotp, localStatus, ownerUserId, platform, search]);

  const generateAccountOtps = useCallback(async (accounts: AccountView[]) => {
    const targets = accounts.filter((account) => {
      if (!account.hasTotp || otpGeneratingIdsRef.current.has(account.id)) return false;
      otpGeneratingIdsRef.current.add(account.id);
      return true;
    });
    if (!targets.length) return;

    const browserTime = currentEpochMilliseconds();
    let timestamp = browserTime;
    if (serverClockOffsetRef.current === undefined) {
      try {
        const serverTime = await api<{ unixMilliseconds: number }>("/api/health/time");
        serverClockOffsetRef.current = serverTime.unixMilliseconds - browserTime;
        const skew = Math.round(serverClockOffsetRef.current / 1_000);
        setClockSkewSeconds(Math.abs(skew) > 30 ? skew : null);
      } catch {
        serverClockOffsetRef.current = null;
        setClockSkewSeconds(null);
      }
    }
    if (serverClockOffsetRef.current !== null) {
      timestamp += serverClockOffsetRef.current;
    }

    let succeededById: Map<string, TotpResult> | null = null;
    let failedIds: Set<string> | null = null;
    try {
      const results = await client.batchGenerateRecordTotp({
        ownerUserId,
        records: targets.map((account) => ({ recordId: account.id, envelope: account.privatePayload })),
        timestamp,
      });
      succeededById = new Map<string, TotpResult>();
      failedIds = new Set<string>();
      for (let index = 0; index < targets.length; index += 1) {
        const account = targets[index]!;
        const result = results[index];
        if (result) succeededById.set(account.id, result);
        else failedIds.add(account.id);
      }

      if (succeededById.size) {
        const maxGeneratedAt = Math.max(...Array.from(succeededById.values(), (result) => result.generatedAt));
        setNow(maxGeneratedAt);
        setOtpById((current) => {
          const next = { ...current };
          for (const account of targets) {
            const result = succeededById!.get(account.id);
            if (!result) continue;
            next[account.id] = {
              ...result,
              accountRevision: account.revision,
              expiresAt:
                result.generatedAt - (result.generatedAt % 1_000)
                + result.secondsRemaining * 1_000,
            };
          }
          return next;
        });
      }
      if (failedIds.size) {
        const failedById = new Map(targets.map((account) => [account.id, account] as const));
        setOtpErrorRevisionById((current) => {
          const next = { ...current };
          for (const [id] of succeededById!) delete next[id];
          for (const id of failedIds!) {
            const account = failedById.get(id);
            if (account) next[id] = account.revision;
          }
          return next;
        });
      } else if (succeededById.size) {
        setOtpErrorRevisionById((current) => {
          const next = { ...current };
          for (const id of succeededById!.keys()) delete next[id];
          return next;
        });
      }
    } catch {
      // 批量失败时回退为单条生成，保证单条损坏不影响其余
      const generated: Array<{ account: AccountView; result: TotpResult }> = [];
      const failed: AccountView[] = [];
      await Promise.all(targets.map(async (account) => {
        try {
          generated.push({
            account,
            result: await client.generateRecordTotp({
              ownerUserId,
              recordId: account.id,
              envelope: account.privatePayload,
              timestamp,
            }),
          });
        } catch {
          failed.push(account);
        }
      }));
      if (generated.length) {
        setNow(Math.max(...generated.map(({ result }) => result.generatedAt)));
        setOtpById((current) => {
          const next = { ...current };
          for (const { account, result } of generated) {
            next[account.id] = {
              ...result,
              accountRevision: account.revision,
              expiresAt:
                result.generatedAt - (result.generatedAt % 1_000)
                + result.secondsRemaining * 1_000,
            };
          }
          return next;
        });
      }
      setOtpErrorRevisionById((current) => {
        const next = { ...current };
        for (const { account } of generated) delete next[account.id];
        for (const account of failed) next[account.id] = account.revision;
        return next;
      });
    } finally {
      for (const account of targets) otpGeneratingIdsRef.current.delete(account.id);
    }
  }, [client, ownerUserId]);

  useEffect(() => {
    const pending = window.setTimeout(() => void load(), 0);
    return () => clearTimeout(pending);
  }, [load]);

  useEffect(() => {
    const pending = window.setTimeout(
      () => void loadIntegrationLinks().catch(() => setIntegrationLinks([])),
      0,
    );
    const interval = window.setInterval(
      () => void loadIntegrationLinks().catch(() => undefined),
      30_000,
    );
    return () => {
      clearTimeout(pending);
      clearInterval(interval);
    };
  }, [loadIntegrationLinks]);

  useEffect(() => {
    const initial = window.setTimeout(() => void autoLinkSub2apiAccounts(), 0);
    const retry = window.setTimeout(() => void autoLinkSub2apiAccounts(), 15_000);
    const postSyncRetry = window.setTimeout(() => void autoLinkSub2apiAccounts(), 75_000);
    return () => {
      clearTimeout(initial);
      clearTimeout(retry);
      clearTimeout(postSyncRetry);
    };
  }, [autoLinkSub2apiAccounts]);

  useEffect(() => {
    if (!openMenuId) return;
    const closeMenu = (event: PointerEvent) => {
      const menu = (event.target as Element | null)?.closest("[data-account-menu]");
      if (menu?.getAttribute("data-account-menu") !== openMenuId) {
        setOpenMenuId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuId(null);
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenuId]);

  useEffect(() => {
    const due = items.filter((account) => {
      if (!account.hasTotp) return false;
      if (otpErrorRevisionById[account.id] === account.revision) return false;
      const otp = otpById[account.id];
      return !otp
        || otp.accountRevision !== account.revision
        || otp.expiresAt <= now + 500;
    });
    if (!due.length) return;
    const pending = window.setTimeout(() => void generateAccountOtps(due), 0);
    return () => clearTimeout(pending);
  }, [generateAccountOtps, items, now, otpById, otpErrorRevisionById]);

  useEffect(() => {
    if (!Object.keys(otpById).length) return;
    const timer = window.setInterval(() => {
      const offset = serverClockOffsetRef.current;
      setNow(currentEpochMilliseconds() + (typeof offset === "number" ? offset : 0));
    }, 1_000);
    return () => clearInterval(timer);
  }, [otpById]);

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("search") ?? "")
      .normalize("NFKC")
      .trim()
      .toLowerCase();
    if (value && !value.includes("@")) {
      setError("请输入完整邮箱地址");
      return;
    }
    const index = value
      ? await client.blindIndex(value, "managed-account-login-email-v1")
      : undefined;
    setError(null);
    setPage(1);
    setSearch("");
    setEmailBlindIndex(index);
  }

  async function persistEncryptedAccount(input: {
    platform: AccountPlatform;
    displayName?: string;
    payload: ManagedAccountPrivatePayload;
  }) {
    const id = crypto.randomUUID();
    const displayNameBase = input.displayName?.trim()
      || `${platformLabels[input.platform]} 账号`;
    const displayName = `${displayNameBase.slice(0, 109)} · ${id.slice(0, 8)}`;
    const encrypted = await client.encryptRecord({
      ownerUserId,
      recordType: "managed-account-private-v1",
      recordId: id,
      value: input.payload,
    });
    const email = input.payload.loginEmail
      ?.normalize("NFKC")
      .trim()
      .toLowerCase();
    const domain = email?.split("@")[1];
    const [emailIndex, domainIndex] = await Promise.all([
      email
        ? client.blindIndex(email, "managed-account-login-email-v1")
        : Promise.resolve(null),
      domain
        ? client.blindIndex(domain, "managed-account-email-domain-v1")
        : Promise.resolve(null),
    ]);
    await api<{ account: ManagedAccount }>("/api/v1/accounts", {
      method: "POST",
      body: JSON.stringify({
        id,
        platform: input.platform,
        displayName,
        privatePayload: encrypted,
        emailBlindIndex: emailIndex,
        emailDomainBlindIndex: domainIndex,
        hasTotp: Boolean(input.payload.totp),
      }),
    });
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setSaving(true);
    setError(null);
    try {
      const values = new FormData(form);
      const platform = String(values.get("platform")) as AccountPlatform;
      await persistEncryptedAccount({
        platform,
        payload: await privatePayloadFromForm(values, client),
      });
      form.reset();
      setDialogOpen(false);
      setPage(1);
      await Promise.all([load(), autoLinkSub2apiAccounts()]);
    } catch (caught) {
      setError(userErrorMessage(caught, "账号保存失败"));
    } finally {
      setSaving(false);
    }
  }

  async function importOpenRouter(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError("OpenRouter 账号文件不能超过 10 MiB");
      return;
    }
    setImporting(true);
    setImportReport(null);
    setError(null);
    try {
      const parsed = parseOpenRouterExport(JSON.parse(await file.text()));
      let imported = 0;
      let saveFailures = 0;
      const batchSize = 50;

      for (let i = 0; i < parsed.accounts.length; i += batchSize) {
        const chunk = parsed.accounts.slice(i, i + batchSize);
        try {
          const encryptedAccounts = await Promise.all(
            chunk.map(async (account) => {
              const id = crypto.randomUUID();
              const displayNameBase = account.displayName?.trim()
                || `${platformLabels[account.platform]} 账号`;
              const displayName = `${displayNameBase.slice(0, 109)} · ${id.slice(0, 8)}`;
              const encrypted = await client.encryptRecord({
                ownerUserId,
                recordType: "managed-account-private-v1",
                recordId: id,
                value: account.payload,
              });
              const email = account.payload.loginEmail
                ?.normalize("NFKC")
                .trim()
                .toLowerCase();
              const domain = email?.split("@")[1];
              const [emailIndex, domainIndex] = await Promise.all([
                email
                  ? client.blindIndex(email, "managed-account-login-email-v1")
                  : Promise.resolve(null),
                domain
                  ? client.blindIndex(domain, "managed-account-email-domain-v1")
                  : Promise.resolve(null),
              ]);

              return {
                id,
                platform: account.platform,
                displayName,
                privatePayload: encrypted,
                emailBlindIndex: emailIndex,
                emailDomainBlindIndex: domainIndex,
                hasTotp: false,
              };
            }),
          );

          await api<{ created: ManagedAccount[]; count: number }>("/api/v1/accounts/batch", {
            method: "POST",
            body: JSON.stringify({ accounts: encryptedAccounts }),
          });
          imported += chunk.length;
        } catch {
          // 如果批量失败，回退为单条尝试
          for (const account of chunk) {
            try {
              await persistEncryptedAccount(account);
              imported += 1;
            } catch {
              saveFailures += 1;
            }
          }
        }
      }

      setImportReport(
        `OpenRouter 账号：已导入 ${imported} 个；跳过 ${parsed.errors.length} 个；保存失败 ${saveFailures} 个`,
      );
      setPage(1);
      await Promise.all([load(), autoLinkSub2apiAccounts()]);
    } catch {
      setError("无法解析 OpenRouter accounts.json 文件");
    } finally {
      setImporting(false);
    }
  }

  async function importTwoFAuth(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("2FAuth 导出文件不能超过 5 MiB");
      return;
    }
    setImporting(true);
    setImportReport(null);
    setError(null);
    try {
      const parsed = parseTwoFAuthExport(JSON.parse(await file.text()));
      let imported = 0;
      let saveFailures = 0;
      for (const account of parsed.accounts) {
        try {
          await persistEncryptedAccount(account);
          imported += 1;
        } catch {
          saveFailures += 1;
        }
      }
      setImportReport(
        `已导入 ${imported} 个；跳过 ${parsed.errors.length} 个；保存失败 ${saveFailures} 个`,
      );
      setPage(1);
      await Promise.all([load(), autoLinkSub2apiAccounts()]);
    } catch {
      setError("2FAuth JSON 无法解析");
    } finally {
      setImporting(false);
    }
  }

  function retryOtp(account: AccountView) {
    setOtpErrorRevisionById((current) => {
      const next = { ...current };
      delete next[account.id];
      return next;
    });
    void generateAccountOtps([account]);
  }

  async function copyOtp(accountId: string) {
    const current = otpById[accountId];
    if (!current || current.expiresAt <= now) return;
    await copyValue(current.code, "验证码");
  }

  async function copyValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setError(`${label}复制失败，请检查浏览器剪贴板权限`);
    }
  }

  function changeSort(field: SortField) {
    setPage(1);
    if (sortField === field) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortField(field);
    setSortDirection("asc");
  }

  function toggleAccountSelection(accountId: string) {
    setSelectedAccountIds((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  function togglePageSelection() {
    setSelectedAccountIds((current) => {
      const next = new Set(current);
      if (allPageSelected) {
        for (const account of items) next.delete(account.id);
      } else {
        for (const account of items) next.add(account.id);
      }
      return next;
    });
  }

  function toggleAllFilteredSelection() {
    setSelectedAccountIds((current) => {
      const allIds = allItems.map((account) => account.id);
      const isAllSelected = allIds.length > 0 && allIds.every((id) => current.has(id));
      if (isAllSelected) return new Set<string>();
      return new Set(allIds);
    });
  }

  async function changeSelectedLocalStatus(nextStatus: AccountLocalStatus) {
    if (!selectedAccounts.length) return;
    setBulkBusy(true);
    setError(null);
    setOperationStatus(null);
    setBulkProgress({ done: 0, total: selectedAccounts.length });
    let succeeded = 0;
    let failed = 0;
    const firstFailures: Array<{
      id: string;
      code?: string;
      message?: string;
      displayMessage?: string;
    }> = [];
    const batchSize = 200;
    for (let offset = 0; offset < selectedAccounts.length; offset += batchSize) {
      const chunk = selectedAccounts.slice(offset, offset + batchSize);
      // 优先走批量接口（一次请求最多 200 条，服务端单事务 + 单次审计），显著减少 N 次往返与前端串行卡顿
      try {
        const result = await api<{
          results: Array<{ id: string; status: string; code?: string; message?: string }>;
          succeeded: number;
          failed: number;
        }>("/api/v1/accounts/batch/update", {
          method: "POST",
          body: JSON.stringify({
            updates: chunk.map((account) => ({
              id: account.id,
              expectedRevision: account.revision,
            })),
            localStatus: nextStatus,
          }),
        });
        succeeded += result.succeeded;
        failed += result.failed;
        for (const entry of result.results) {
          if (entry.status === "failed" && firstFailures.length < 3) {
            firstFailures.push(entry);
          }
        }
      } catch {
        // 批量失败时回退为串行单条，保证兼容与可观测
        for (const account of chunk) {
          try {
            await api(`/api/v1/accounts/${encodeURIComponent(account.id)}`, {
              method: "PATCH",
              body: JSON.stringify({
                expectedRevision: account.revision,
                platform: account.platform,
                displayName: account.displayName,
                privatePayload: account.privatePayload,
                emailBlindIndex: account.emailBlindIndex,
                emailDomainBlindIndex: account.emailDomainBlindIndex,
                hasTotp: account.hasTotp,
                localStatus: nextStatus,
              }),
            });
            succeeded += 1;
          } catch (caught) {
            failed += 1;
            if (firstFailures.length < 3) {
              firstFailures.push({
                id: account.id,
                displayMessage: userErrorMessage(caught, "账号更新失败"),
              });
            }
          }
        }
      }
      setBulkProgress({ done: Math.min(offset + chunk.length, selectedAccounts.length), total: selectedAccounts.length });
    }
    setSelectedAccountIds(new Set());
    const summary = `${nextStatus === "archived" ? "归档" : "恢复"}完成：成功 ${succeeded} 个，失败 ${failed} 个`;
    const detail = firstFailures.length
      ? `；失败示例：${firstFailures.map((entry) => accountFailureMessage(
          entry.id,
          entry.displayMessage ?? apiErrorMessage(entry, "账号更新失败"),
        )).join("、")}`
      : "";
    await Promise.all([load(), autoLinkSub2apiAccounts()]);
    if (failed) setError(summary + detail);
    else setOperationStatus(summary);
    setBulkProgress(null);
    setBulkBusy(false);
  }

  async function runWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<Array<PromiseSettledResult<R>>> {
    const results: Array<PromiseSettledResult<R>> = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const current = nextIndex++;
        if (current >= items.length) break;
        try {
          const value = await fn(items[current]!);
          results[current] = { status: "fulfilled", value };
        } catch (reason) {
          results[current] = { status: "rejected", reason };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function confirmDeleteSelected() {
    if (!pendingBulkAction) return;
    const byId = new Map(allItems.map((account) => [account.id, account] as const));
    const missingIds = pendingBulkAction.accountIds.filter((id) => !byId.has(id));
    const targets = pendingBulkAction.accountIds
      .map((id) => byId.get(id))
      .filter((account): account is AccountView => Boolean(account));
    const missing = missingIds.length;
    setBulkBusy(true);
    setError(null);
    setOperationStatus(null);
    setBulkProgress({ done: 0, total: targets.length });
    let succeeded = 0;
    let failed = missing;
    const failureMessages = new Set<string>();
    for (const id of missingIds.slice(0, 5)) {
      failureMessages.add(accountFailureMessage(id, "账号已不存在或已被删除"));
    }
    const batchSize = 100;
    for (let offset = 0; offset < targets.length; offset += batchSize) {
      const chunk = targets.slice(offset, offset + batchSize);
      // 批量删除：服务端先在一次事务前校验 revision、批量拉取关联的 observer 链接，
      // 远端同步删除按 10 并发执行，后续本地软删/解链在同一事务内批量提交，避免逐条往返与事务分散导致的卡顿与超时
      try {
        const result = await api<{
          results: Array<{ id: string; status: string; code?: string; message?: string }>;
          succeeded: number;
          failed: number;
        }>("/api/v1/accounts/batch/delete", {
          method: "POST",
          body: JSON.stringify({
            deletes: chunk.map((account) => ({
              id: account.id,
              expectedRevision: account.revision,
            })),
          }),
        });
        succeeded += result.succeeded;
        failed += result.failed;
        for (const entry of result.results.filter((item) => item.status === "failed").slice(0, 5)) {
          failureMessages.add(
            accountFailureMessage(entry.id, apiErrorMessage(entry, "账号删除失败")),
          );
        }
      } catch (caught) {
        // 回退：批量接口不可用时以较小并发执行单条删除，仍展示进度
        const step = await runWithConcurrency(chunk, 6, async (account) => {
          await api(`/api/v1/accounts/${encodeURIComponent(account.id)}`, {
            method: "DELETE",
            body: JSON.stringify({ expectedRevision: account.revision }),
          });
        });
        for (const [index, outcome] of step.entries()) {
          if (outcome.status === "fulfilled") succeeded += 1;
          else {
            failed += 1;
            failureMessages.add(
              accountFailureMessage(
                chunk[index]!.id,
                userErrorMessage(outcome.reason, "账号删除失败"),
              ),
            );
          }
        }
        if (failureMessages.size < 5) {
          failureMessages.add(userErrorMessage(caught, "批量删除请求失败"));
        }
      }
      setBulkProgress({ done: Math.min(offset + chunk.length, targets.length), total: targets.length });
    }
    setPendingBulkAction(null);
    setSelectedAccountIds(new Set());
    const summary = `删除完成：成功 ${succeeded} 个，失败 ${failed} 个`;
    await Promise.all([load(), autoLinkSub2apiAccounts()]);
    if (failed) {
      const details = Array.from(failureMessages).slice(0, 3).join("；");
      setError(details ? `${summary}；${details}` : summary);
    } else setOperationStatus(summary);
    setBulkProgress(null);
    setBulkBusy(false);
  }

  return (
    <section className="mb-10">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">账号</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">{total} 个托管账号</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className={secondaryButton}>
            {importing ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <FileJson aria-hidden="true" size={16} />}
            导入 OpenRouter JSON
            <input type="file" accept="application/json,.json" disabled={importing} onChange={(event) => void importOpenRouter(event)} className="sr-only" />
          </label>
          <label className={secondaryButton}>
            {importing ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <FileJson aria-hidden="true" size={16} />}
            导入 2FAuth JSON
            <input type="file" accept="application/json,.json" disabled={importing} onChange={(event) => void importTwoFAuth(event)} className="sr-only" />
          </label>
          <button type="button" onClick={() => setDialogOpen(true)} className={primaryButton}>
            <CirclePlus aria-hidden="true" size={17} />添加账号
          </button>
        </div>
      </div>
      {importReport ? <p className="mb-4 text-sm text-[var(--muted)]" role="status">{importReport}</p> : null}

      <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(260px,1fr)_180px_160px_160px]">
        <form onSubmit={submitSearch} className="flex h-10 items-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-3 text-[var(--muted)]">
          <Search aria-hidden="true" size={16} />
          <input name="search" defaultValue={search} aria-label="搜索账号" placeholder="输入完整邮箱" className="min-w-0 flex-1 bg-transparent" />
        </form>
        <FilterSelect
          ariaLabel="平台筛选"
          value={platform}
          onChange={(value) => { setPage(1); setPlatform(value as AccountPlatform | ""); }}
          options={[['', '全部平台'], ['openai', 'OpenAI'], ['opencode_go', 'OpenCode Go'], ['antigravity', 'Antigravity'], ['clinepass', 'ClinePass'], ['openrouter', 'OpenRouter']]}
        />
        <FilterSelect
          ariaLabel="TOTP 筛选"
          value={hasTotp}
          onChange={(value) => { setPage(1); setHasTotp(value as "" | "true" | "false"); }}
          options={[['', '全部 2FA'], ['true', '已配置 TOTP'], ['false', '未配置 TOTP']]}
        />
        <FilterSelect
          ariaLabel="状态筛选"
          value={localStatus}
          onChange={(value) => { setPage(1); setLocalStatus(value as AccountLocalStatus); }}
          options={[["active", "使用中"], ["archived", "已归档"]]}
        />
      </div>

      <ErrorMessage value={error} />
      {operationStatus ? (
        <p className="mb-4 border-l-4 border-emerald-600 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" role="status">
          {operationStatus}
        </p>
      ) : null}
      {bulkProgress ? (
        <div className="mb-4 flex min-h-11 flex-wrap items-center gap-3 border-y border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2" role="status" aria-live="polite">
          <LoaderCircle className="animate-spin" aria-hidden="true" size={16} />
          <span className="text-sm font-semibold">正在处理 {bulkProgress.done}/{bulkProgress.total} 个账号</span>
          <span className="h-1.5 w-32 overflow-hidden rounded bg-[var(--border)]" aria-hidden="true">
            <span className="block h-full bg-[var(--accent)]" style={{ width: `${Math.round((bulkProgress.done / Math.max(1, bulkProgress.total)) * 100)}%` }} />
          </span>
          <span className="text-xs text-[var(--muted)]">{Math.round((bulkProgress.done / Math.max(1, bulkProgress.total)) * 100)}%</span>
        </div>
      ) : null}
      {selectedAccounts.length ? (
        <div className="mb-4 flex min-h-11 flex-wrap items-center gap-2 border-y border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2">
          <span className="mr-auto text-sm font-semibold">
            {allFilteredSelected
              ? `已全选全部 ${allItems.length} 个`
              : `已选 ${selectedAccounts.length} 个${allItems.length > selectedAccounts.length ? `，筛选共 ${allItems.length} 个` : ""}`}
          </span>
          {!allFilteredSelected && allItems.length > selectedAccounts.length && allItems.length > items.length ? (
            <button type="button" disabled={bulkBusy || !allItems.length} onClick={toggleAllFilteredSelection} className={listActionButton}>
              全选全部 {allItems.length} 个
            </button>
          ) : null}
          {localStatus === "active" ? (
            <button type="button" disabled={bulkBusy} onClick={() => void changeSelectedLocalStatus("archived")} className={listActionButton}>
              <Archive aria-hidden="true" size={14} />归档
            </button>
          ) : (
            <button type="button" disabled={bulkBusy} onClick={() => void changeSelectedLocalStatus("active")} className={listActionButton}>
              <RotateCcw aria-hidden="true" size={14} />恢复
            </button>
          )}
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => setPendingBulkAction({ type: "delete", accountIds: [...selectedAccountIds] })}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[6px] border border-red-200 bg-white px-2.5 text-xs font-semibold text-[var(--danger)] hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 aria-hidden="true" size={14} />删除
          </button>
          <button type="button" disabled={bulkBusy} onClick={() => setSelectedAccountIds(new Set())} className={listActionButton}>
            <X aria-hidden="true" size={14} />清除选择
          </button>
        </div>
      ) : null}
      {clockSkewSeconds !== null ? (
        <p className="mb-4 border-l-4 border-[var(--warning)] bg-amber-50 px-4 py-3 text-sm text-[var(--warning)]" role="status">
          浏览器与服务器时钟相差约 {Math.abs(clockSkewSeconds)} 秒，验证码已使用服务器时间生成。
        </p>
      ) : null}
      <div className="mt-4 overflow-visible border border-[var(--border)] bg-white">
        <div className="hidden min-h-11 grid-cols-[32px_minmax(200px,1.35fr)_105px_minmax(150px,.9fr)_210px_170px_36px] items-center border-b border-[var(--border)] bg-[var(--surface-subtle)] px-4 text-xs font-semibold text-[var(--muted)] xl:grid">
          <SelectionCheckbox
            label={allPageSelected ? "取消选择当前页" : "选择当前页"}
            checked={allPageSelected}
            indeterminate={somePageSelected && !allPageSelected}
            onChange={togglePageSelection}
          />
          <SortHeader label="邮箱" field="email" activeField={sortField} direction={sortDirection} onChange={changeSort} />
          <SortHeader label="平台" field="platform" activeField={sortField} direction={sortDirection} onChange={changeSort} />
          <span>密码</span>
          <span>2FA</span>
          <SortHeader label="Sub2API 状态" field="sub2api" activeField={sortField} direction={sortDirection} onChange={changeSort} />
          <span className="sr-only">操作</span>
        </div>
        {loading ? (
          <div className="grid min-h-52 place-items-center text-sm text-[var(--muted)]"><LoaderCircle className="animate-spin" aria-hidden="true" size={18} /></div>
        ) : items.length ? (
          <div className="space-y-2 bg-[var(--surface-subtle)] p-2">
            {items.map((account) => {
            const otp = otpById[account.id];
            const payload = account.decrypted;
            const remaining = otp ? Math.max(0, Math.ceil((otp.expiresAt - now) / 1_000)) : 0;
            const otpFailed = otpErrorRevisionById[account.id] === account.revision;
            return (
              <div key={account.id} data-account-id={account.id} className="border border-[var(--border)] bg-white">
                <div className="relative grid gap-3 py-4 pl-14 pr-14 xl:grid-cols-[32px_minmax(200px,1.35fr)_105px_minmax(150px,.9fr)_210px_170px_36px] xl:items-center xl:gap-0 xl:px-4">
                  <div className="absolute left-4 top-4 xl:static">
                    <SelectionCheckbox
                      label={`选择 ${payload?.loginEmail ?? platformLabels[account.platform]}`}
                      checked={selectedAccountIds.has(account.id)}
                      onChange={() => toggleAccountSelection(account.id)}
                    />
                  </div>
                  <div className="min-w-0">
                    {payload ? (
                      payload.loginEmail ? (
                        <div className="flex min-w-0 items-start gap-1.5">
                          <span className="min-w-0 break-all py-1 font-semibold">{payload.loginEmail}</span>
                          <ListIconButton label="复制邮箱" onClick={() => void copyValue(payload.loginEmail!, "邮箱")} icon={Copy} />
                        </div>
                      ) : <p className="text-sm text-[var(--muted)]">未填写邮箱</p>
                    ) : <p className="text-sm text-[var(--danger)]">密文无法解密</p>}
                    <p className="mt-1 break-words text-xs text-[var(--muted)]">{account.displayName} · 更新于 {formatDate(account.updatedAt)}</p>
                  </div>
                  <div><span className="text-xs text-[var(--muted)] xl:hidden">平台 </span><span>{platformLabels[account.platform]}</span></div>
                  <div className="min-w-0 text-sm">
                    {payload ? (
                      payload.password ? (
                        <div className="flex min-w-0 items-start gap-1.5">
                          <span className="shrink-0 leading-8 text-xs text-[var(--muted)] xl:hidden">密码</span>
                          <code className="min-w-0 break-all py-2 text-xs leading-4">{revealedPasswords[account.id] ? payload.password : "********"}</code>
                          <ListIconButton label={revealedPasswords[account.id] ? "隐藏密码" : "显示密码"} onClick={() => setRevealedPasswords((current) => ({ ...current, [account.id]: !current[account.id] }))} icon={revealedPasswords[account.id] ? EyeOff : Eye} />
                          <ListIconButton label="复制密码" onClick={() => void copyValue(payload.password!, "密码")} icon={Copy} />
                        </div>
                      ) : <p className="text-xs text-[var(--muted)]">未填写密码</p>
                    ) : null}
                  </div>
                  <div className="flex min-h-8 flex-wrap items-center gap-2 xl:grid xl:grid-cols-[minmax(5.5rem,auto)_2rem_32px] xl:pr-4">
                    {account.hasTotp ? (
                      otpFailed ? (
                        <button type="button" onClick={() => retryOtp(account)} className={`${listActionButton} xl:col-span-3 xl:justify-self-start`}>
                          <RotateCcw aria-hidden="true" size={14} />重试验证码
                        </button>
                      ) : otp && remaining > 0 ? (
                        <>
                          <code className="min-w-20 font-semibold tabular-nums">{groupCode(otp.code)}</code>
                          <span className="w-8 text-xs tabular-nums text-[var(--muted)]">{remaining}s</span>
                          <ListIconButton label="复制验证码" onClick={() => void copyOtp(account.id)} icon={Copy} />
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-2 text-xs text-[var(--muted)] xl:col-span-3">
                          <LoaderCircle className="animate-spin" aria-hidden="true" size={14} />正在生成
                        </span>
                      )
                    ) : <span className="text-sm text-[var(--muted)] xl:col-span-3">未配置</span>}
                  </div>
                  <div className="min-w-0 xl:border-l xl:border-[var(--border)] xl:pl-4">
                    <span className="mb-1 block text-xs text-[var(--muted)] xl:hidden">Sub2API 状态</span>
                    <Sub2apiAccountStatus
                      links={integrationLinksByAccount.get(account.id) ?? []}
                      configured={sub2apiConfigured}
                      autoLinkEligible={supportsAutomaticAccountLink(account.platform)}
                      compact
                    />
                  </div>
                  <div className="absolute right-4 top-4 flex justify-end xl:static" data-account-menu={account.id}>
                    <div className="relative">
                      <ListIconButton
                        label="账号操作"
                        onClick={() => setOpenMenuId((current) => current === account.id ? null : account.id)}
                        icon={MoreHorizontal}
                      />
                      {openMenuId === account.id ? (
                        <div role="menu" className="absolute right-0 top-9 z-30 min-w-32 border border-[var(--border)] bg-white py-1 shadow-lg">
                          <button
                            type="button"
                            role="menuitem"
                            disabled={!payload}
                            onClick={() => { setOpenMenuId(null); setSelected(account); }}
                            className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm hover:bg-[var(--surface-subtle)] disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Pencil aria-hidden="true" size={15} />编辑
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => { setOpenMenuId(null); setPendingBulkAction({ type: "delete", accountIds: [account.id] }); }}
                            className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-[var(--danger)] hover:bg-red-50"
                          >
                            <Trash2 aria-hidden="true" size={15} />删除
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
                {payload ? (
                  <AccountContactDetails
                    payload={payload}
                    phoneBindingCount={phoneBindingCounts[account.id] ?? 1}
                    onCopy={(value, label) => void copyValue(value, label)}
                  />
                ) : null}
              </div>
            );
            })}
          </div>
        ) : (
          <div className="grid min-h-52 place-items-center px-5 text-sm text-[var(--muted)]">暂无符合条件的账号</div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-4 text-sm text-[var(--muted)]">
        <span>第 {page} / {pages} 页</span>
        <div className="flex gap-2">
          <IconButton label="上一页" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} icon={ChevronLeft} />
          <IconButton label="下一页" disabled={page >= pages || loading} onClick={() => setPage((value) => Math.min(pages, value + 1))} icon={ChevronRight} />
        </div>
      </div>

      {dialogOpen ? (
        <AccountDialog
          client={client}
          saving={saving}
          onClose={() => setDialogOpen(false)}
          onSubmit={createAccount}
        />
      ) : null}
      {selected?.decrypted ? (
        <AccountDetails
          ownerUserId={ownerUserId}
          account={selected}
          decrypted={selected.decrypted}
          client={client}
          onClose={() => setSelected(null)}
          onChanged={async () => {
            setSelected(null);
            await Promise.all([load(), autoLinkSub2apiAccounts()]);
          }}
        />
      ) : null}
      {pendingBulkAction ? (
        <DeleteConfirmationDialog
          count={pendingBulkAction.accountIds.length}
          busy={bulkBusy}
          onCancel={() => setPendingBulkAction(null)}
          onConfirm={() => void confirmDeleteSelected()}
        />
      ) : null}
    </section>
  );
}

function SortHeader({
  label,
  field,
  activeField,
  direction,
  onChange,
}: {
  label: string;
  field: SortField;
  activeField: SortField | null;
  direction: SortDirection;
  onChange: (field: SortField) => void;
}) {
  const active = activeField === field;
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  const nextDirection = active && direction === "asc" ? "降序" : "升序";
  return (
    <button
      type="button"
      aria-label={`${label}按${nextDirection}排列`}
      onClick={() => onChange(field)}
      className="flex h-10 min-w-0 items-center gap-1.5 text-left hover:text-[var(--foreground)]"
    >
      <span className="truncate">{label}</span>
      <Icon aria-hidden="true" className="shrink-0" size={14} />
    </button>
  );
}

function SelectionCheckbox({
  label,
  checked,
  indeterminate = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={onChange}
      className="size-4 cursor-pointer accent-[var(--accent)]"
    />
  );
}

function DeleteConfirmationDialog({
  count,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/45 p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="delete-accounts-title" className="w-full max-w-md border border-[var(--border)] bg-white shadow-xl">
        <div className="border-b border-[var(--border)] px-5 py-4">
          <h2 id="delete-accounts-title" className="text-lg font-semibold">删除账号</h2>
        </div>
        <div className="px-5 py-5 text-sm">
          确认永久删除 {count} 个账号？已关联的 Sub2API 账号、关联状态和恢复码也会一并删除，此操作无法撤销。
        </div>
        <div className="flex justify-end gap-3 border-t border-[var(--border)] px-5 py-4">
          <button type="button" disabled={busy} onClick={onCancel} className={secondaryButton}>取消</button>
          <button type="button" disabled={busy} onClick={onConfirm} className="inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--danger)] px-4 font-semibold text-white disabled:opacity-50">
            {busy ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Trash2 aria-hidden="true" size={16} />}
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
}

function AccountContactDetails({
  payload,
  phoneBindingCount,
  onCopy,
}: {
  payload: ManagedAccountPrivatePayload;
  phoneBindingCount: number;
  onCopy: (value: string, label: string) => void;
}) {
  const hasEmailOtp = Boolean(payload.emailOtpEndpoint || payload.emailOtpCdk);
  const hasSmsOtp = Boolean(payload.smsEndpoint || payload.smsEndpointCdk);
  if (!payload.phone && !hasEmailOtp && !hasSmsOtp) return null;

  return (
    <div className="border-t border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-3">
      <div className="grid gap-5 lg:grid-cols-3">
        {payload.phone ? (
          <ContactGroup title="绑定手机号">
            <CopyableListValue
              label="号码"
              value={payload.phone}
              copyLabel="复制绑定手机号"
              suffix={phoneBindingCount > 1 ? `已绑定 ${phoneBindingCount} 个账号` : undefined}
              onCopy={() => onCopy(payload.phone!, "手机号")}
            />
          </ContactGroup>
        ) : null}

        {hasEmailOtp ? (
          <ContactGroup title="邮箱接码">
            {payload.emailOtpEndpoint ? <CopyableListValue label="地址" value={payload.emailOtpEndpoint} copyLabel="复制邮箱接码地址" onCopy={() => onCopy(payload.emailOtpEndpoint!, "邮箱接码地址")} /> : null}
            {payload.emailOtpCdk ? <CopyableListValue label="CDK" value={payload.emailOtpCdk} copyLabel="复制邮箱接码 CDK" onCopy={() => onCopy(payload.emailOtpCdk!, "邮箱接码 CDK")} /> : null}
          </ContactGroup>
        ) : null}

        {hasSmsOtp ? (
          <ContactGroup title="手机号接码">
            {payload.smsEndpoint ? <CopyableListValue label="地址" value={payload.smsEndpoint} copyLabel="复制手机号接码地址" onCopy={() => onCopy(payload.smsEndpoint!, "手机号接码地址")} /> : null}
            {payload.smsEndpointCdk ? <CopyableListValue label="CDK" value={payload.smsEndpointCdk} copyLabel="复制手机号接码 CDK" onCopy={() => onCopy(payload.smsEndpointCdk!, "手机号接码 CDK")} /> : null}
          </ContactGroup>
        ) : null}

      </div>
    </div>
  );
}

function Sub2apiAccountStatus({
  links,
  configured,
  autoLinkEligible = false,
  compact = false,
}: {
  links: IntegrationLinkView[];
  configured: boolean;
  autoLinkEligible?: boolean;
  compact?: boolean;
}) {
  if (!links.length) {
    const label = configured
      ? autoLinkEligible ? "等待自动关联" : "未关联"
      : "未配置连接";
    return <p className="text-xs text-[var(--muted)]">{label}</p>;
  }
  return (
    <div className="space-y-2">
      {links.map((link) => (
        <div
          key={link.id}
          className="text-xs"
          title={compact ? `${link.connectionName} · ${integrationSyncLabel(link.syncHealth)}${link.observedAt ? ` · ${formatDate(link.observedAt)}` : ""}` : undefined}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`size-2 shrink-0 rounded-full ${integrationHealthColor(link.healthCode)}`} />
            <span className="font-semibold">{integrationHealthLabel(link.healthCode)}</span>
            <span className="text-[var(--muted)]">{integrationSyncLabel(link.syncHealth)}</span>
          </div>
          {!compact ? (
            <p className="mt-1 break-words text-[var(--muted)]">
              {link.connectionName}{link.remoteStatus ? ` · ${integrationRemoteStatusLabel(link.remoteStatus)}` : ""}
              {link.observedAt ? ` · ${formatDate(link.observedAt)}` : ""}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ContactGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold text-[var(--muted)]">{title}</p>
      <div className="mt-2 space-y-2">{children}</div>
    </div>
  );
}

function CopyableListValue({
  label,
  value,
  copyLabel,
  suffix,
  onCopy,
}: {
  label: string;
  value: string;
  copyLabel: string;
  suffix?: string;
  onCopy: () => void;
}) {
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      <span className="w-10 shrink-0 leading-8 text-xs text-[var(--muted)]">{label}</span>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5">
        <code className="min-w-0 break-all text-xs">{value}</code>
        {suffix ? <span className="shrink-0 text-xs font-semibold text-[var(--muted)]">{suffix}</span> : null}
      </div>
      <ListIconButton label={copyLabel} onClick={onCopy} icon={Copy} />
    </div>
  );
}

function AccountDialog({
  client,
  saving,
  onClose,
  onSubmit,
}: {
  client: VaultCryptoClient;
  saving: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState<TotpResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  function setTotpCredential(value: string) {
    const field = formRef.current?.elements.namedItem("totpInput");
    if (field instanceof HTMLTextAreaElement) field.value = value;
    setPreview(null);
    setPreviewError(null);
  }

  async function previewTotp() {
    if (!formRef.current) return;
    setPreviewError(null);
    try {
      const configuration = await totpFromForm(new FormData(formRef.current), client);
      if (!configuration) throw new UserFacingError("请先输入 TOTP 密钥或 otpauth URI");
      setPreview(await client.previewTotp(configuration));
    } catch (caught) {
      setPreview(null);
      setPreviewError(userErrorMessage(caught, "TOTP 参数无效"));
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid overflow-y-auto bg-black/45 p-4 sm:place-items-center" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" className="my-auto w-full max-w-4xl border border-[var(--border)] bg-white shadow-xl">
        <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-5">
          <h2 id="account-dialog-title" className="text-lg font-semibold">添加托管账号</h2>
          <IconButton label="关闭" onClick={onClose} icon={X} />
        </div>
        <form ref={formRef} onSubmit={(event) => void onSubmit(event)} className="max-h-[calc(100vh-7rem)] overflow-y-auto p-5">
          <div className="space-y-7">
            <FormSection title="账号信息" first>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="登录邮箱"><input name="loginEmail" type="email" required autoComplete="off" maxLength={320} className={inputClass} /></Field>
                <Field label="平台"><select name="platform" className={inputClass} defaultValue="openai"><option value="openai">OpenAI</option><option value="opencode_go">OpenCode Go</option><option value="antigravity">Antigravity</option><option value="clinepass">ClinePass</option><option value="openrouter">OpenRouter</option></select></Field>
              </div>
            </FormSection>

            <FormSection title="凭据与联系">
              <div className="grid gap-4 sm:grid-cols-2">
                <SecretInput label="登录密码（可选）" name="password" autoComplete="new-password" />
                <Field label="绑定手机号"><input name="phone" autoComplete="off" maxLength={80} className={inputClass} /></Field>
              </div>
            </FormSection>

            <FormSection title="接码服务">
              <div className="divide-y divide-[var(--border)]">
                <div className="grid gap-4 pb-5 sm:grid-cols-2 lg:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] lg:items-end">
                  <p className="text-sm font-semibold lg:pb-3">邮箱接码</p>
                  <Field label="邮箱接码地址（可选）"><input name="emailOtpEndpoint" type="url" autoComplete="off" maxLength={2000} className={inputClass} /></Field>
                  <SecretInput label="邮箱接码 CDK（可选）" name="emailOtpCdk" />
                </div>
                <div className="grid gap-4 pt-5 sm:grid-cols-2 lg:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] lg:items-end">
                  <p className="text-sm font-semibold lg:pb-3">手机号接码</p>
                  <Field label="手机号接码地址（可选）"><input name="smsEndpoint" type="url" autoComplete="off" maxLength={2000} className={inputClass} /></Field>
                  <SecretInput label="手机号接码 CDK（可选）" name="smsEndpointCdk" />
                </div>
              </div>
            </FormSection>

            <FormSection title="备注">
              <Field label="敏感备注"><textarea name="notes" rows={4} maxLength={20000} className={inputClass} /></Field>
            </FormSection>

            <FormSection title="验证器（TOTP，可选）">
              <Field label="TOTP 密钥或 otpauth URI"><textarea name="totpInput" rows={3} autoComplete="off" className={inputClass} /></Field>
              <QrCredentialInput onValue={setTotpCredential} />
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-semibold">参数设置</summary>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                  <Field label="服务名称（Issuer）"><input name="totpIssuer" defaultValue="OpenAI" maxLength={120} className={inputClass} /></Field>
                  <Field label="账号标签（Label）"><input name="totpLabel" maxLength={240} className={inputClass} /></Field>
                  <Field label="哈希算法"><select name="totpAlgorithm" defaultValue="SHA1" className={inputClass}><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></Field>
                  <Field label="验证码位数"><select name="totpDigits" defaultValue="6" className={inputClass}><option value="6">6 位</option><option value="7">7 位</option><option value="8">8 位</option></select></Field>
                  <Field label="刷新周期（秒）"><input name="totpPeriod" type="number" min={15} max={120} defaultValue={30} className={inputClass} /></Field>
                </div>
              </details>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => void previewTotp()} className={secondaryButton}><ShieldCheck aria-hidden="true" size={16} />生成测试验证码</button>
                {preview ? <output aria-live="polite" className="inline-flex items-center gap-2"><span className="text-xs font-semibold text-[var(--muted)]">测试验证码</span><code className="font-semibold tabular-nums text-[var(--accent)]">{groupCode(preview.code)}</code></output> : null}
                {previewError ? <span className="text-sm text-[var(--danger)]">{previewError}</span> : null}
              </div>
            </FormSection>
          </div>
          <div className="mt-7 flex flex-col-reverse gap-3 border-t border-[var(--border)] pt-5 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose} className={secondaryButton}>取消</button>
            <button type="submit" disabled={saving} className={primaryButton}>{saving ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <CirclePlus aria-hidden="true" size={16} />}保存加密账号</button>
          </div>
        </form>
      </div>
    </div>
  );
}

async function privatePayloadFromForm(
  values: FormData,
  client: VaultCryptoClient,
): Promise<ManagedAccountPrivatePayload> {
  const optional = (name: string) => {
    const value = String(values.get(name) ?? "").normalize("NFKC").trim();
    return value || undefined;
  };
  const optionalSecret = (name: string) => {
    const value = String(values.get(name) ?? "");
    return value.length ? value : undefined;
  };
  const loginEmail = optional("loginEmail")?.toLowerCase();
  if (!loginEmail) throw new UserFacingError("登录邮箱不能为空");
  return managedAccountPrivatePayloadSchema.parse({
    version: 1,
    loginEmail,
    password: optionalSecret("password"),
    phone: optional("phone"),
    emailOtpEndpoint: optional("emailOtpEndpoint"),
    emailOtpCdk: optionalSecret("emailOtpCdk"),
    smsEndpoint: optional("smsEndpoint"),
    smsEndpointCdk: optionalSecret("smsEndpointCdk"),
    notes: optional("notes"),
    totp: await totpFromForm(values, client),
  });
}

async function totpFromForm(
  values: FormData,
  client: VaultCryptoClient,
): Promise<TotpConfiguration | undefined> {
  const input = String(values.get("totpInput") ?? "").trim();
  if (!input) return undefined;
  if (input.toLowerCase().startsWith("otpauth://")) {
    return client.parseTotpUri(input);
  }
  const secretBase32 = input
    .replace(/[\s-]/g, "")
    .replace(/=+$/g, "")
    .toUpperCase();
  return totpConfigurationSchema.parse({
    type: "totp",
    issuer: String(values.get("totpIssuer") ?? "").trim(),
    label:
      String(values.get("totpLabel") ?? "").trim() ||
      String(values.get("loginEmail") ?? "").trim(),
    secretBase32,
    algorithm: values.get("totpAlgorithm"),
    digits: Number(values.get("totpDigits")),
    period: Number(values.get("totpPeriod")),
  });
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: init?.body
      ? { "Content-Type": "application/json", ...init.headers }
      : init?.headers,
  });
  const body = (await response.json().catch(() => ({}))) as T & ApiFailure;
  if (!response.ok) throw new UserFacingError(apiErrorMessage(body));
  return body;
}

async function fetchAllAccountPages(
  baseParams: URLSearchParams,
): Promise<ManagedAccount[]> {
  const firstParams = new URLSearchParams(baseParams);
  firstParams.set("page", "1");
  const first = await api<AccountList>(`/api/v1/accounts?${firstParams.toString()}`);
  if (first.pages <= 1) return [...first.items];
  const remaining = await Promise.all(
    Array.from({ length: first.pages - 1 }, (_, index) => {
      const params = new URLSearchParams(baseParams);
      params.set("page", String(index + 2));
      return api<AccountList>(`/api/v1/accounts?${params.toString()}`);
    }),
  );
  const accounts: ManagedAccount[] = [...first.items];
  for (const page of remaining) accounts.push(...page.items);
  return accounts;
}

async function loadAllManagedAccountRecords(
  includeDeleted = false,
): Promise<ManagedAccount[]> {
  const statuses: AccountLocalStatus[] = ["active", "archived"];
  const results = await Promise.all(
    statuses.map((localStatus) => {
      const params = new URLSearchParams({
        pageSize: "100",
        localStatus,
      });
      if (includeDeleted) params.set("includeDeleted", "true");
      return fetchAllAccountPages(params);
    }),
  );
  return results.flat();
}

function sortAccountViews(
  accounts: AccountView[],
  field: SortField | null,
  direction: SortDirection,
  linksByAccount: Map<string, IntegrationLinkView[]>,
  configured: boolean,
): AccountView[] {
  if (!field) return accounts;
  const multiplier = direction === "asc" ? 1 : -1;
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((left, right) => {
      const leftValue = accountSortValue(
        left.account,
        field,
        linksByAccount.get(left.account.id) ?? [],
        configured,
      );
      const rightValue = accountSortValue(
        right.account,
        field,
        linksByAccount.get(right.account.id) ?? [],
        configured,
      );
      if (leftValue === null && rightValue === null) return left.index - right.index;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      const comparison = typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), "zh-CN", {
            numeric: true,
            sensitivity: "base",
          });
      return comparison === 0 ? left.index - right.index : comparison * multiplier;
    })
    .map(({ account }) => account);
}

function accountSortValue(
  account: AccountView,
  field: SortField,
  links: IntegrationLinkView[],
  configured: boolean,
): string | number | null {
  if (field === "email") {
    return account.decrypted?.loginEmail?.normalize("NFKC").trim().toLowerCase() || null;
  }
  if (field === "platform") return platformLabels[account.platform];
  if (!links.length) return configured ? 90 : 100;
  return Math.max(...links.map((link) => integrationHealthRank(link.healthCode)));
}

function integrationHealthRank(value: string): number {
  if (value === "healthy") return 0;
  if (value === "unknown") return 10;
  if (["rate_limited", "overloaded", "temporarily_unavailable"].includes(value)) return 20;
  if (["verification_required", "paused"].includes(value)) return 30;
  if (["disabled", "banned", "reauth_required"].includes(value)) return 40;
  if (value === "missing") return 60;
  return 50;
}

function groupCode(code: string): string {
  const split = Math.ceil(code.length / 2);
  return `${code.slice(0, split)} ${code.slice(split)}`;
}

function accountFailureMessage(accountId: string, message: string): string {
  const reference = accountId.slice(0, 8) || "未知";
  return `账号 ${reference}：${message}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function integrationHealthLabel(value: string): string {
  return ({
    healthy: "可用",
    disabled: "已停用",
    banned: "已封禁",
    verification_required: "需要验证",
    reauth_required: "需要重新授权",
    error: "异常",
    temporarily_unavailable: "暂时不可用",
    rate_limited: "限流中",
    overloaded: "过载中",
    paused: "已暂停",
    missing: "远端缺失",
    unknown: "状态未知",
  } as Record<string, string>)[value] ?? "状态未知";
}

function integrationHealthColor(value: string): string {
  if (value === "healthy") return "bg-emerald-500";
  if (["rate_limited", "overloaded", "temporarily_unavailable", "paused", "verification_required"].includes(value)) return "bg-amber-500";
  if (value === "unknown") return "bg-gray-400";
  return "bg-red-500";
}

function integrationSyncLabel(value: string): string {
  return ({
    fresh: "已同步",
    stale: "同步延迟",
    disconnected: "连接中断",
    never_synced: "等待同步",
  } as Record<string, string>)[value] ?? "状态未知";
}

function integrationRemoteStatusLabel(value: string): string {
  return ({ active: "运行中", disabled: "已停用", inactive: "未启用", error: "异常" } as Record<string, string>)[value] ?? "状态未知";
}

function FormSection({
  title,
  first = false,
  children,
}: {
  title: string;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <fieldset className={first ? "" : "border-t border-[var(--border)] pt-6"}>
      <legend className="mb-4 pr-3 text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-0 space-y-2"><span className="text-xs font-semibold text-[var(--muted)]">{label}</span>{children}</label>;
}

function FilterSelect({ ariaLabel, value, onChange, options }: { ariaLabel: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} className={inputClass}>{options.map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}</select>;
}

function IconButton({ label, onClick, icon: Icon, disabled = false }: { label: string; onClick: () => void; icon: typeof Eye; disabled?: boolean }) {
  return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="grid size-9 shrink-0 place-items-center rounded-[6px] border border-[var(--border)] bg-white text-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"><Icon aria-hidden="true" size={16} /></button>;
}

function ListIconButton({ label, onClick, icon: Icon, disabled = false }: { label: string; onClick: () => void; icon: typeof Eye; disabled?: boolean }) {
  return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="grid size-8 shrink-0 place-items-center rounded-[6px] border border-[var(--border)] bg-white text-[var(--muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"><Icon aria-hidden="true" size={15} /></button>;
}

function ErrorMessage({ value }: { value: string | null }) {
  return value ? <p className="mb-4 flex items-start gap-2 border-l-4 border-[var(--danger)] bg-red-50 px-4 py-3 text-sm text-[var(--danger)]" role="alert"><CircleAlert className="mt-0.5 shrink-0" aria-hidden="true" size={16} />{value}</p> : null;
}

const inputClass = "min-h-10 w-full min-w-0 rounded-[6px] border border-[var(--border)] bg-white px-3 py-2 text-sm";
const primaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--accent)] px-4 font-semibold text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-4 font-semibold text-[var(--foreground)] hover:bg-[var(--surface-subtle)] disabled:cursor-not-allowed disabled:opacity-50";
const listActionButton = "inline-flex h-8 items-center justify-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-white px-2.5 text-xs font-semibold hover:bg-[var(--surface-subtle)]";

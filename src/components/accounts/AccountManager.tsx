"use client";

import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CirclePlus,
  Copy,
  Eye,
  EyeOff,
  FileJson,
  KeyRound,
  LoaderCircle,
  MoreHorizontal,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { parseTwoFAuthExport } from "@/accounts/import-2fauth";
import {
  managedAccountPrivatePayloadSchema,
  totpConfigurationSchema,
  type AccountLocalStatus,
  type AccountPlatform,
  type ManagedAccount,
  type ManagedAccountPrivatePayload,
  type TotpConfiguration,
  type TotpResult,
} from "@/accounts/schema";
import type { VaultCryptoClient } from "@/crypto";
import { currentEpochMilliseconds } from "@/lib/clock";
import { AccountDetails } from "./AccountDetails";
import { QrCredentialInput } from "./QrCredentialInput";

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

type OtpView = TotpResult & { revealed: boolean; expiresAt: number };
type ApiFailure = { message?: string };

const platformLabels: Record<AccountPlatform, string> = {
  openai: "OpenAI",
  opencode_go: "OpenCode Go",
  antigravity: "Antigravity",
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
  const [items, setItems] = useState<AccountView[]>([]);
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
  const [otpById, setOtpById] = useState<Record<string, OtpView>>({});
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const visibleQuery = new URLSearchParams({
        page: String(page),
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
      const apiQuery = new URLSearchParams(visibleQuery);
      apiQuery.set("pageSize", "25");
      if (emailBlindIndex) apiQuery.set("emailBlindIndex", emailBlindIndex);
      const result = await api<AccountList>(
        `/api/v1/accounts?${apiQuery.toString()}`,
      );
      const decrypted = await Promise.all(
        result.items.map(async (account): Promise<AccountView> => {
          try {
            const payload = managedAccountPrivatePayloadSchema.parse(
              await client.decryptRecord({
                ownerUserId,
                recordType: "managed-account-private-v1",
                recordId: account.id,
                envelope: account.privatePayload,
              }),
            );
            return { ...account, decrypted: payload };
          } catch {
            return { ...account, decrypted: null };
          }
        }),
      );
      setItems(decrypted);
      setTotal(result.total);
      setPages(result.pages);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [client, emailBlindIndex, hasTotp, localStatus, ownerUserId, page, platform, search]);

  useEffect(() => {
    const pending = window.setTimeout(() => void load(), 0);
    return () => clearTimeout(pending);
  }, [load]);

  useEffect(() => {
    if (!Object.keys(otpById).length) return;
    const timer = window.setInterval(() => setNow((value) => value + 1_000), 1_000);
    return () => clearInterval(timer);
  }, [otpById]);

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("search") ?? "")
      .normalize("NFKC")
      .trim()
      .toLowerCase();
    let index: string | undefined;
    if (value.includes("@")) {
      index = await client.blindIndex(value, "managed-account-login-email-v1");
    }
    setPage(1);
    setSearch(index ? "" : value);
    setEmailBlindIndex(index);
  }

  async function persistEncryptedAccount(input: {
    platform: AccountPlatform;
    displayName: string;
    payload: ManagedAccountPrivatePayload;
  }) {
    const id = crypto.randomUUID();
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
        displayName: input.displayName,
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
      await persistEncryptedAccount({
        platform: String(values.get("platform")) as AccountPlatform,
        displayName: String(values.get("displayName")),
        payload: await privatePayloadFromForm(values, client),
      });
      form.reset();
      setDialogOpen(false);
      setPage(1);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号保存失败");
    } finally {
      setSaving(false);
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
      await load();
    } catch {
      setError("2FAuth JSON 无法解析");
    } finally {
      setImporting(false);
    }
  }

  async function generateOtp(account: AccountView) {
    setError(null);
    try {
      const browserTime = currentEpochMilliseconds();
      let timestamp = browserTime;
      try {
        const serverTime = await api<{ unixMilliseconds: number }>(
          "/api/health/time",
        );
        timestamp = serverTime.unixMilliseconds;
        const skew = Math.round((timestamp - browserTime) / 1_000);
        setClockSkewSeconds(Math.abs(skew) > 30 ? skew : null);
      } catch {
        setClockSkewSeconds(null);
      }
      const result = await client.generateRecordTotp({
        ownerUserId,
        recordId: account.id,
        envelope: account.privatePayload,
        timestamp,
      });
      setNow(result.generatedAt);
      setOtpById((current) => ({
        ...current,
        [account.id]: {
          ...result,
          revealed: false,
          expiresAt:
            result.generatedAt - (result.generatedAt % 1_000) +
            result.secondsRemaining * 1_000,
        },
      }));
    } catch {
      setError("TOTP 生成失败，账号密文可能已损坏");
    }
  }

  async function copyOtp(accountId: string) {
    const current = otpById[accountId];
    if (!current || current.expiresAt <= now) return;
    await navigator.clipboard.writeText(current.code);
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
          <input name="search" defaultValue={search} aria-label="搜索账号" placeholder="名称或完整邮箱" className="min-w-0 flex-1 bg-transparent" />
        </form>
        <FilterSelect
          ariaLabel="平台筛选"
          value={platform}
          onChange={(value) => { setPage(1); setPlatform(value as AccountPlatform | ""); }}
          options={[['', '全部平台'], ['openai', 'OpenAI'], ['opencode_go', 'OpenCode Go'], ['antigravity', 'Antigravity']]}
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
      {clockSkewSeconds !== null ? (
        <p className="mb-4 border-l-4 border-[var(--warning)] bg-amber-50 px-4 py-3 text-sm text-[var(--warning)]" role="status">
          浏览器与服务器时钟相差约 {Math.abs(clockSkewSeconds)} 秒，验证码已使用服务器时间生成。
        </p>
      ) : null}
      <div className="mt-4 overflow-hidden border border-[var(--border)] bg-white">
        <div className="hidden min-h-11 grid-cols-[minmax(180px,1.2fr)_150px_minmax(220px,1fr)_230px_44px] items-center border-b border-[var(--border)] bg-[var(--surface-subtle)] px-4 text-xs font-semibold text-[var(--muted)] md:grid">
          <span>账号</span><span>平台</span><span>登录资料</span><span>2FA</span><span className="sr-only">操作</span>
        </div>
        {loading ? (
          <div className="grid min-h-52 place-items-center text-sm text-[var(--muted)]"><LoaderCircle className="animate-spin" aria-hidden="true" size={18} /></div>
        ) : items.length ? (
          items.map((account) => {
            const otp = otpById[account.id];
            const remaining = otp ? Math.max(0, Math.ceil((otp.expiresAt - now) / 1_000)) : 0;
            return (
              <div key={account.id} className="grid gap-3 border-b border-[var(--border)] px-4 py-4 last:border-b-0 md:grid-cols-[minmax(180px,1.2fr)_150px_minmax(220px,1fr)_230px_44px] md:items-center md:gap-0">
                <div className="min-w-0"><p className="truncate font-semibold">{account.displayName}</p><p className="mt-1 text-xs text-[var(--muted)]">更新于 {formatDate(account.updatedAt)}</p></div>
                <div><span className="text-xs text-[var(--muted)] md:hidden">平台 </span><span>{platformLabels[account.platform]}</span></div>
                <div className="min-w-0 text-sm"><span className="text-xs text-[var(--muted)] md:hidden">登录资料 </span>{account.decrypted ? <span className="break-all">{maskEmail(account.decrypted.loginEmail) || "未填写邮箱"}</span> : <span className="text-[var(--danger)]">密文无法解密</span>}</div>
                <div className="flex min-h-9 flex-wrap items-center gap-2">
                  {account.hasTotp ? (
                    otp && remaining > 0 ? (
                      <>
                        <code className="min-w-20 font-semibold tabular-nums">{otp.revealed ? groupCode(otp.code) : "••• •••"}</code>
                        <span className="w-7 text-xs tabular-nums text-[var(--muted)]">{remaining}s</span>
                        <IconButton label={otp.revealed ? "隐藏验证码" : "显示验证码"} onClick={() => setOtpById((current) => ({ ...current, [account.id]: { ...current[account.id], revealed: !current[account.id].revealed } }))} icon={otp.revealed ? EyeOff : Eye} />
                        <IconButton label="复制验证码" onClick={() => void copyOtp(account.id)} icon={Copy} />
                      </>
                    ) : (
                      <button type="button" onClick={() => void generateOtp(account)} className={smallButton}><KeyRound aria-hidden="true" size={15} />生成验证码</button>
                    )
                  ) : <span className="text-sm text-[var(--muted)]">未配置</span>}
                </div>
                <div className="flex justify-end">
                  <IconButton label="查看账号详情" disabled={!account.decrypted} onClick={() => setSelected(account)} icon={MoreHorizontal} />
                </div>
              </div>
            );
          })
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
            await load();
          }}
        />
      ) : null}
    </section>
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
      if (!configuration) throw new Error("请先输入 otpauth URI 或 Base32 Secret");
      setPreview(await client.previewTotp(configuration));
    } catch (caught) {
      setPreview(null);
      setPreviewError(caught instanceof Error ? caught.message : "TOTP 参数无效");
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid overflow-y-auto bg-black/45 p-4 sm:place-items-center" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" className="my-auto w-full max-w-3xl border border-[var(--border)] bg-white shadow-xl">
        <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-5">
          <h2 id="account-dialog-title" className="text-lg font-semibold">添加托管账号</h2>
          <IconButton label="关闭" onClick={onClose} icon={X} />
        </div>
        <form ref={formRef} onSubmit={(event) => void onSubmit(event)} className="max-h-[calc(100vh-7rem)] overflow-y-auto p-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="运营别名"><input name="displayName" required maxLength={120} className={inputClass} /></Field>
            <Field label="平台"><select name="platform" className={inputClass} defaultValue="openai"><option value="openai">OpenAI</option><option value="opencode_go">OpenCode Go</option><option value="antigravity">Antigravity</option></select></Field>
            <Field label="登录邮箱"><input name="loginEmail" type="email" autoComplete="off" maxLength={320} className={inputClass} /></Field>
            <Field label="绑定手机号"><input name="phone" autoComplete="off" maxLength={80} className={inputClass} /></Field>
            <div className="sm:col-span-2"><Field label="接码地址"><input name="smsEndpoint" type="url" autoComplete="off" maxLength={2000} className={inputClass} /></Field></div>
            <div className="sm:col-span-2"><Field label="敏感备注"><textarea name="notes" rows={3} maxLength={20000} className={inputClass} /></Field></div>
          </div>
          <fieldset className="mt-7 border-t border-[var(--border)] pt-5">
            <legend className="pr-3 font-semibold">TOTP（可选）</legend>
            <p className="mb-4 text-sm text-[var(--muted)]">支持 otpauth://totp URI 或 Base32 Secret，内容只在浏览器内处理。</p>
            <Field label="otpauth URI 或 Base32 Secret"><textarea name="totpInput" rows={3} autoComplete="off" className={inputClass} /></Field>
            <QrCredentialInput onValue={setTotpCredential} />
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold">高级 TOTP 参数</summary>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Issuer"><input name="totpIssuer" defaultValue="OpenAI" maxLength={120} className={inputClass} /></Field>
                <Field label="Label"><input name="totpLabel" maxLength={240} className={inputClass} /></Field>
                <Field label="Algorithm"><select name="totpAlgorithm" defaultValue="SHA1" className={inputClass}><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></Field>
                <Field label="Digits / Period"><div className="grid grid-cols-2 gap-2"><select name="totpDigits" defaultValue="6" className={inputClass}><option>6</option><option>7</option><option>8</option></select><input name="totpPeriod" type="number" min={15} max={120} defaultValue={30} className={inputClass} /></div></Field>
              </div>
            </details>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void previewTotp()} className={secondaryButton}><ShieldCheck aria-hidden="true" size={16} />本地验证</button>
              {preview ? <code className="font-semibold tabular-nums text-[var(--accent)]">{groupCode(preview.code)}</code> : null}
              {previewError ? <span className="text-sm text-[var(--danger)]">{previewError}</span> : null}
            </div>
          </fieldset>
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
  return managedAccountPrivatePayloadSchema.parse({
    version: 1,
    loginEmail: optional("loginEmail")?.toLowerCase(),
    phone: optional("phone"),
    smsEndpoint: optional("smsEndpoint"),
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
      String(values.get("loginEmail") ?? "").trim() ||
      String(values.get("displayName") ?? "").trim(),
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
  if (!response.ok) throw new Error(body.message || "请求失败");
  return body;
}

function maskEmail(email?: string): string {
  if (!email) return "";
  const [name, domain] = email.split("@");
  if (!domain) return "••••";
  return `${name.slice(0, 2)}${"•".repeat(Math.max(2, Math.min(6, name.length - 2)))}@${domain}`;
}

function groupCode(code: string): string {
  const split = Math.ceil(code.length / 2);
  return `${code.slice(0, split)} ${code.slice(split)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-2"><span className="text-xs font-semibold text-[var(--muted)]">{label}</span>{children}</label>;
}

function FilterSelect({ ariaLabel, value, onChange, options }: { ariaLabel: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} className={inputClass}>{options.map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}</select>;
}

function IconButton({ label, onClick, icon: Icon, disabled = false }: { label: string; onClick: () => void; icon: typeof Eye; disabled?: boolean }) {
  return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="grid size-9 shrink-0 place-items-center rounded-[6px] border border-[var(--border)] bg-white text-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"><Icon aria-hidden="true" size={16} /></button>;
}

function ErrorMessage({ value }: { value: string | null }) {
  return value ? <p className="mb-4 flex items-start gap-2 border-l-4 border-[var(--danger)] bg-red-50 px-4 py-3 text-sm text-[var(--danger)]" role="alert"><CircleAlert className="mt-0.5 shrink-0" aria-hidden="true" size={16} />{value}</p> : null;
}

const inputClass = "min-h-10 w-full rounded-[6px] border border-[var(--border)] bg-white px-3 py-2 text-sm";
const primaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--accent)] px-4 font-semibold text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-4 font-semibold text-[var(--foreground)] hover:bg-[var(--surface-subtle)] disabled:cursor-not-allowed disabled:opacity-50";
const smallButton = "inline-flex h-9 items-center justify-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-3 text-sm font-semibold hover:bg-[var(--surface-subtle)]";

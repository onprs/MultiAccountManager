"use client";

import {
  ArrowRight,
  Check,
  CircleAlert,
  Database,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  ServerCog,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import { authClient } from "@/lib/auth-client";
import {
  apiErrorMessage,
  UserFacingError,
  userErrorMessage,
} from "@/lib/api-errors";
import type { RuntimeStatus } from "@/runtime/status";
import type { DatabaseTestResult } from "@/server/database/test-connection";

type Step = "access" | "database" | "application" | "owner";

type DatabaseFields = {
  host: string;
  port: number;
  database: string;
  schema: string;
  jobSchema: string;
  username: string;
  password: string;
  sslMode: "verify-full" | "require" | "prefer" | "disable";
  caCertificate?: string;
  connectTimeoutSeconds: number;
  webPoolSize: number;
  workerPoolSize: number;
};

type ApplicationFields = {
  publicUrl: string;
  webAuthnRpId: string;
  webAuthnRpName: string;
  webAuthnOrigin: string;
  siteName: string;
  timeZone: string;
};

type ApiFailure = { code?: string; message?: string };

const steps: Array<{ id: Step; label: string; icon: typeof KeyRound }> = [
  { id: "access", label: "初始化权限", icon: KeyRound },
  { id: "database", label: "PostgreSQL", icon: Database },
  { id: "application", label: "站点配置", icon: ServerCog },
  { id: "owner", label: "管理员", icon: LockKeyhole },
];

const initialDatabase: DatabaseFields = {
  host: "127.0.0.1",
  port: 5432,
  database: "account_vault",
  schema: "account_vault",
  jobSchema: "account_vault_jobs",
  username: "account_vault",
  password: "",
  sslMode: "verify-full",
  connectTimeoutSeconds: 5,
  webPoolSize: 10,
  workerPoolSize: 5,
};

async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as T & ApiFailure;
  if (!response.ok) throw new UserFacingError(apiErrorMessage(data));
  return data;
}

export function SetupWizard({ initialState }: { initialState: RuntimeStatus["state"] }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("access");
  const [setupToken, setSetupToken] = useState("");
  const [database, setDatabase] = useState<DatabaseFields>(initialDatabase);
  const [application, setApplication] = useState<ApplicationFields | null>(null);
  const [owner, setOwner] = useState({
    name: "",
    email: "",
    passkeyName: "主要通行密钥",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    initialState === "invalid_config" ? "运行时配置无法验证，请从服务器端检查配置密钥和密文文件。" : null,
  );
  const [databaseSummary, setDatabaseSummary] = useState<string | null>(null);

  const activeIndex = steps.findIndex((item) => item.id === step);
  const defaultApplication = useMemo<ApplicationFields>(() => {
    const origin = typeof window === "undefined" ? "https://vault.example.com" : window.location.origin;
    const hostname = typeof window === "undefined" ? "vault.example.com" : window.location.hostname;
    return {
      publicUrl: origin,
      webAuthnRpId: hostname,
      webAuthnRpName: "Account Vault",
      webAuthnOrigin: origin,
      siteName: "Account Vault",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
  }, []);

  async function submitAccess(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/setup/session", { setupToken });
      setSetupToken("");
      setStep(initialState === "creating_owner" ? "owner" : "database");
    } catch (caught) {
      setError(userErrorMessage(caught, "初始化权限验证失败"));
    } finally {
      setBusy(false);
    }
  }

  async function testDatabase(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDatabaseSummary(null);
    try {
      const result = await api<
        Pick<DatabaseTestResult, "serverVersion" | "schemaStatus" | "poolBudget">
      >("/api/setup/database/test", database);
      setDatabaseSummary(
        `PostgreSQL ${result.serverVersion} · 数据库架构${schemaStatusLabel(result.schemaStatus)} · 连接上限 ${result.poolBudget}`,
      );
      setApplication(defaultApplication);
      setStep("application");
    } catch (caught) {
      setError(userErrorMessage(caught, "数据库连接测试失败"));
    } finally {
      setBusy(false);
    }
  }

  async function initialize(event: FormEvent) {
    event.preventDefault();
    if (!application) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/setup/initialize", { database, application });
      setDatabase((current) => ({ ...current, password: "", caCertificate: "" }));
      setStep("owner");
    } catch (caught) {
      setError(userErrorMessage(caught, "系统初始化失败"));
    } finally {
      setBusy(false);
    }
  }

  async function registerOwner(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bootstrap = await api<{
        registrationContext: string;
      }>("/api/setup/owner", { name: owner.name, email: owner.email });
      const registration = await authClient.passkey.addPasskey({
        name: owner.passkeyName.trim() || undefined,
        context: bootstrap.registrationContext,
      });
      if (registration.error) {
        throw new UserFacingError("通行密钥注册失败，请重试");
      }
      await api("/api/setup/complete", {});
      router.replace("/login");
    } catch (caught) {
      setError(userErrorMessage(caught, "管理员通行密钥注册失败"));
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-[6px] bg-[var(--foreground)] text-white">
              <LockKeyhole aria-hidden="true" size={19} strokeWidth={1.8} />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">Account Vault</div>
              <div className="truncate text-xs text-[var(--muted)]">系统初始化</div>
            </div>
          </div>
          <span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--warning)]">
            <span className="size-2 rounded-full bg-current" />
            初始化模式
          </span>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-10 px-5 py-8 lg:grid-cols-[220px_minmax(0,720px)] lg:px-8 lg:py-12">
        <nav aria-label="初始化进度">
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-1">
            {steps.map((item, index) => {
              const Icon = item.icon;
              const active = item.id === step;
              const done = index < activeIndex;
              return (
                <li
                  className={`flex min-h-12 items-center gap-3 rounded-[6px] px-3 py-2 ${
                    active
                      ? "bg-[var(--foreground)] text-white"
                      : "text-[var(--muted)]"
                  }`}
                  key={item.id}
                >
                  <span
                    className={`grid size-7 shrink-0 place-items-center rounded-full border ${
                      active ? "border-white/40" : "border-[var(--border)]"
                    }`}
                  >
                    {done ? <Check aria-hidden="true" size={14} /> : <Icon aria-hidden="true" size={14} />}
                  </span>
                  <span className="min-w-0 text-xs font-medium sm:truncate">{item.label}</span>
                </li>
              );
            })}
          </ol>
        </nav>

        <section className="min-w-0" aria-live="polite">
          {error && (
            <div className="mb-6 flex items-start gap-3 border-l-4 border-[var(--danger)] bg-red-50 px-4 py-3 text-sm text-[var(--danger)]" role="alert">
              <CircleAlert className="mt-0.5 shrink-0" aria-hidden="true" size={17} />
              <span>{error}</span>
            </div>
          )}

          {step === "access" && (
            <form onSubmit={submitAccess} className="max-w-xl space-y-6">
              <SectionHeading title="验证初始化权限" subtitle="使用服务器生成的一次性令牌" />
              <Field label="初始化令牌" htmlFor="setup-token">
                <input
                  id="setup-token"
                  type="password"
                  autoComplete="off"
                  required
                  value={setupToken}
                  onChange={(event) => setSetupToken(event.target.value)}
                  className={inputClass}
                />
              </Field>
              <ActionButton busy={busy}>验证并继续</ActionButton>
            </form>
          )}

          {step === "database" && (
            <form onSubmit={testDatabase} className="space-y-7">
              <SectionHeading title="连接 PostgreSQL" subtitle="使用现有数据库和专用架构" />
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="主机" htmlFor="db-host">
                  <input id="db-host" required value={database.host} onChange={(e) => setDatabase({ ...database, host: e.target.value })} className={inputClass} />
                </Field>
                <Field label="端口" htmlFor="db-port">
                  <input id="db-port" type="number" min={1} max={65535} required value={database.port} onChange={(e) => setDatabase({ ...database, port: Number(e.target.value) })} className={inputClass} />
                </Field>
                <Field label="数据库" htmlFor="db-name">
                  <input id="db-name" required value={database.database} onChange={(e) => setDatabase({ ...database, database: e.target.value })} className={inputClass} />
                </Field>
                <Field label="用户名" htmlFor="db-user">
                  <input id="db-user" required autoComplete="username" value={database.username} onChange={(e) => setDatabase({ ...database, username: e.target.value })} className={inputClass} />
                </Field>
                <Field label="数据库密码" htmlFor="db-password">
                  <input id="db-password" type="password" required autoComplete="new-password" value={database.password} onChange={(e) => setDatabase({ ...database, password: e.target.value })} className={inputClass} />
                </Field>
                <Field label="SSL 模式" htmlFor="db-ssl">
                  <select id="db-ssl" value={database.sslMode} onChange={(e) => setDatabase({ ...database, sslMode: e.target.value as DatabaseFields["sslMode"] })} className={inputClass}>
                    <option value="verify-full">完整验证（verify-full）</option>
                    <option value="require">要求加密（require）</option>
                    <option value="prefer">优先加密（prefer）</option>
                    <option value="disable">不使用 SSL（disable）</option>
                  </select>
                </Field>
                <Field label="应用架构" htmlFor="db-schema">
                  <input id="db-schema" required value={database.schema} onChange={(e) => setDatabase({ ...database, schema: e.target.value })} className={inputClass} />
                </Field>
                <Field label="任务架构" htmlFor="db-job-schema">
                  <input id="db-job-schema" required value={database.jobSchema} onChange={(e) => setDatabase({ ...database, jobSchema: e.target.value })} className={inputClass} />
                </Field>
                <Field label="Web 连接池" htmlFor="db-web-pool">
                  <input id="db-web-pool" type="number" min={1} max={50} value={database.webPoolSize} onChange={(e) => setDatabase({ ...database, webPoolSize: Number(e.target.value) })} className={inputClass} />
                </Field>
                <Field label="后台任务连接池" htmlFor="db-worker-pool">
                  <input id="db-worker-pool" type="number" min={1} max={50} value={database.workerPoolSize} onChange={(e) => setDatabase({ ...database, workerPoolSize: Number(e.target.value) })} className={inputClass} />
                </Field>
              </div>
              {database.sslMode === "verify-full" && (
                <Field label="CA 证书" htmlFor="db-ca">
                  <textarea id="db-ca" rows={5} value={database.caCertificate ?? ""} onChange={(e) => setDatabase({ ...database, caCertificate: e.target.value })} className={inputClass} />
                </Field>
              )}
              <ActionButton busy={busy}>测试连接</ActionButton>
            </form>
          )}

          {step === "application" && application && (
            <form onSubmit={initialize} className="space-y-7">
              <SectionHeading title="配置站点身份" subtitle={databaseSummary ?? "PostgreSQL 已通过验证"} />
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="公开访问地址" htmlFor="public-url">
                  <input id="public-url" type="url" required value={application.publicUrl} onChange={(e) => setApplication({ ...application, publicUrl: e.target.value })} className={inputClass} />
                </Field>
                <Field label="站点名称" htmlFor="site-name">
                  <input id="site-name" required value={application.siteName} onChange={(e) => setApplication({ ...application, siteName: e.target.value })} className={inputClass} />
                </Field>
                <Field label="WebAuthn 依赖方 ID" htmlFor="rp-id">
                  <input id="rp-id" required value={application.webAuthnRpId} onChange={(e) => setApplication({ ...application, webAuthnRpId: e.target.value })} className={inputClass} />
                </Field>
                <Field label="WebAuthn 依赖方名称" htmlFor="rp-name">
                  <input id="rp-name" required value={application.webAuthnRpName} onChange={(e) => setApplication({ ...application, webAuthnRpName: e.target.value })} className={inputClass} />
                </Field>
                <Field label="WebAuthn 来源" htmlFor="rp-origin">
                  <input id="rp-origin" type="url" required value={application.webAuthnOrigin} onChange={(e) => setApplication({ ...application, webAuthnOrigin: e.target.value })} className={inputClass} />
                </Field>
                <Field label="时区" htmlFor="timezone">
                  <input id="timezone" required value={application.timeZone} onChange={(e) => setApplication({ ...application, timeZone: e.target.value })} className={inputClass} />
                </Field>
              </div>
              <ActionButton busy={busy}>初始化数据库</ActionButton>
            </form>
          )}

          {step === "owner" && (
            <form onSubmit={registerOwner} className="max-w-xl space-y-6">
              <SectionHeading title="创建首位管理员" subtitle="通行密钥是管理员的唯一登录凭据" />
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="管理员名称" htmlFor="owner-name">
                  <input
                    id="owner-name"
                    required
                    autoComplete="name"
                    value={owner.name}
                    onChange={(event) => setOwner({ ...owner, name: event.target.value })}
                    className={inputClass}
                  />
                </Field>
                <Field label="登录邮箱" htmlFor="owner-email">
                  <input
                    id="owner-email"
                    type="email"
                    required
                    autoComplete="username webauthn"
                    value={owner.email}
                    onChange={(event) => setOwner({ ...owner, email: event.target.value })}
                    className={inputClass}
                  />
                </Field>
              </div>
              <Field label="通行密钥名称" htmlFor="passkey-name">
                <input
                  id="passkey-name"
                  maxLength={100}
                  value={owner.passkeyName}
                  onChange={(event) => setOwner({ ...owner, passkeyName: event.target.value })}
                  className={inputClass}
                />
              </Field>
              <div className="border-l-4 border-[var(--warning)] bg-amber-50 px-4 py-3 text-sm text-[var(--warning)]">
                注册成功前不要关闭此页面。数据库确认通行密钥已保存后，系统才会结束初始化模式。
              </div>
              <ActionButton busy={busy}>注册通行密钥并完成</ActionButton>
            </form>
          )}
        </section>
      </main>
    </div>
  );
}

const schemaStatusLabels: Record<DatabaseTestResult["schemaStatus"], string> = {
  missing: "尚未创建",
  empty: "为空",
  managed: "已由本应用管理",
};

function schemaStatusLabel(status: DatabaseTestResult["schemaStatus"]): string {
  return schemaStatusLabels[status] ?? "状态异常";
}

const inputClass = "h-10 w-full rounded-[6px] border border-[var(--border)] bg-white px-3 text-sm text-[var(--foreground)] transition-colors hover:border-gray-400 focus:border-[var(--focus)] disabled:bg-gray-100";

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0 space-y-2" htmlFor={htmlFor}>
      <span className="block text-xs font-semibold text-[var(--muted)]">{label}</span>
      {children}
    </label>
  );
}

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="border-b border-[var(--border)] pb-5">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">{subtitle}</p>
    </div>
  );
}

function ActionButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="inline-flex h-10 min-w-32 items-center justify-center gap-2 rounded-[6px] bg-[var(--accent)] px-4 font-semibold text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-wait disabled:opacity-60"
    >
      {busy ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : null}
      {children}
      {!busy ? <ArrowRight aria-hidden="true" size={16} /> : null}
    </button>
  );
}

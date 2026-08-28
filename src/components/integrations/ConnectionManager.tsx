"use client";

import {
  Bell,
  Check,
  CircleAlert,
  CloudCog,
  KeyRound,
  Link2,
  LoaderCircle,
  Play,
  RefreshCw,
  Trash2,
  Unplug,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { ManagedAccount } from "@/accounts/schema";
import type {
  ConnectionSummary,
  RemoteCatalogItem,
} from "@/integrations/schema";
import { authClient } from "@/lib/auth-client";
import {
  apiErrorMessage,
  UserFacingError,
  userErrorMessage,
} from "@/lib/api-errors";
import type {
  IntegrationAlertView,
  IntegrationLinkView,
} from "@/server/integrations/service";

type ApiFailure = { code?: string; message?: string };
type ManagedAccountList = {
  items: ManagedAccount[];
  page: number;
  pages: number;
};
type WorkerDiagnostic = {
  healthy: boolean;
  status: string;
  heartbeatAt: string;
  releaseId: string;
} | null;

export function ConnectionManager() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [catalog, setCatalog] = useState<RemoteCatalogItem[]>([]);
  const [links, setLinks] = useState<IntegrationLinkView[]>([]);
  const [alerts, setAlerts] = useState<IntegrationAlertView[]>([]);
  const [worker, setWorker] = useState<WorkerDiagnostic>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [linkTargets, setLinkTargets] = useState<Record<string, string>>({});
  const [replaceTokenFor, setReplaceTokenFor] = useState<ConnectionSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    const [connectionResult, accountResult, linkResult, alertResult, diagnosticResult] =
      await Promise.all([
        api<{ connections: ConnectionSummary[] }>("/api/v1/connections"),
        loadActiveManagedAccounts(),
        api<{ links: IntegrationLinkView[] }>("/api/v1/links"),
        api<{ alerts: IntegrationAlertView[] }>("/api/v1/alerts"),
        api<{ worker: WorkerDiagnostic }>("/api/v1/diagnostics/worker"),
      ]);
    setConnections(connectionResult.connections);
    setAccounts(accountResult.items);
    setLinks(linkResult.links);
    setAlerts(alertResult.alerts);
    setWorker(diagnosticResult.worker);
    setSelectedConnectionId((current) =>
      current && connectionResult.connections.some((item) => item.id === current)
        ? current
        : connectionResult.connections[0]?.id ?? "",
    );
  }, []);

  const loadCatalog = useCallback(async (
    connectionId: string,
    signal?: AbortSignal,
  ) => {
    if (!connectionId) {
      setCatalog([]);
      return;
    }
    const result = await api<{ items: RemoteCatalogItem[] }>(
      `/api/v1/remote-catalog?connectionId=${encodeURIComponent(connectionId)}`,
      { signal },
    );
    setCatalog(result.items);
  }, []);

  useEffect(() => {
    const pending = window.setTimeout(() => {
      void loadOverview().catch((caught) =>
        setError(userErrorMessage(caught, "连接数据加载失败")),
      );
    }, 0);
    return () => clearTimeout(pending);
  }, [loadOverview]);

  useEffect(() => {
    const controller = new AbortController();
    const pending = window.setTimeout(() => {
      void loadCatalog(selectedConnectionId, controller.signal).catch((caught) => {
        if (!controller.signal.aborted) {
          setError(userErrorMessage(caught, "远端目录加载失败"));
        }
      });
    }, 0);
    return () => {
      clearTimeout(pending);
      controller.abort();
    };
  }, [loadCatalog, selectedConnectionId]);

  async function rotateServiceKey() {
    await action("rotate-service-key", async () => {
      await passkeyStepUp();
      const result = await api<{ keyRing: { currentKeyId: string }; migrated: number }>(
        "/api/v1/connections/service-key/rotate",
        { method: "POST" },
      );
      setStatus(`服务加密密钥已轮换为 ${result.keyRing.currentKeyId}；已重新加密 ${result.migrated} 个令牌`);
      await loadOverview();
    });
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy("create");
    setError(null);
    setStatus(null);
    try {
      await passkeyStepUp();
      const result = await api<{
        connection: ConnectionSummary;
        test: { instanceId: string; clockSkewSeconds: number | null };
        syncQueued: boolean;
      }>("/api/v1/connections", {
        method: "POST",
        body: JSON.stringify({
          name: values.get("name"),
          baseUrl: values.get("baseUrl"),
          token: values.get("token"),
          syncIntervalSeconds: Number(values.get("syncIntervalSeconds")),
        }),
      });
      form.reset();
      setSelectedConnectionId(result.connection.id);
      setStatus(
        result.test.clockSkewSeconds !== null &&
          Math.abs(result.test.clockSkewSeconds) > 30
          ? `连接成功；远端时钟偏差约 ${Math.abs(result.test.clockSkewSeconds)} 秒`
          : result.syncQueued
            ? "连接成功，首次同步已入队"
            : "连接成功，远端身份和数据格式已验证",
      );
      await loadOverview();
    } catch (caught) {
      setError(userErrorMessage(caught, "连接创建失败"));
    } finally {
      setBusy(null);
    }
  }

  async function testConnection(connection: ConnectionSummary) {
    await action(`test:${connection.id}`, async () => {
      const result = await api<{ test: { clockSkewSeconds: number | null } }>(
        `/api/v1/connections/${connection.id}/test`,
        { method: "POST" },
      );
      setStatus(
        result.test.clockSkewSeconds !== null
          ? `连接可用；远端时钟偏差 ${result.test.clockSkewSeconds} 秒`
          : "连接可用",
      );
    });
  }

  async function syncConnection(connection: ConnectionSummary) {
    await action(`sync:${connection.id}`, async () => {
      const result = await api<{ queued: boolean }>(
        `/api/v1/connections/${connection.id}/sync`,
        { method: "POST" },
      );
      setStatus(result.queued ? "同步任务已入队" : "该连接已有等待或执行中的同步任务");
    });
  }

  async function toggleConnection(connection: ConnectionSummary) {
    await action(`toggle:${connection.id}`, async () => {
      await api(`/api/v1/connections/${connection.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !connection.enabled }),
      });
      await loadOverview();
    });
  }

  async function removeConnection(connection: ConnectionSummary) {
    if (!window.confirm(`确认删除连接“${connection.name}”及其同步历史？`)) return;
    await action(`delete:${connection.id}`, async () => {
      await passkeyStepUp();
      await api(`/api/v1/connections/${connection.id}`, { method: "DELETE" });
      setStatus("连接及其关联同步数据已删除");
      await loadOverview();
    });
  }

  async function replaceToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!replaceTokenFor) return;
    const token = String(new FormData(event.currentTarget).get("token") ?? "");
    await action(`replace:${replaceTokenFor.id}`, async () => {
      await passkeyStepUp();
      await api(`/api/v1/connections/${replaceTokenFor.id}`, {
        method: "PATCH",
        body: JSON.stringify({ token }),
      });
      setReplaceTokenFor(null);
      setStatus("Sub2API 集成令牌已验证并替换");
      await loadOverview();
    });
  }

  async function linkRemote(item: RemoteCatalogItem) {
    const targetKey = accountLinkTargetKey(item);
    const managedAccountId = linkTargets[targetKey];
    if (!managedAccountId) return;
    await action(`link:${targetKey}`, async () => {
      await api("/api/v1/links", {
        method: "POST",
        body: JSON.stringify({
          managedAccountId,
          connectionId: item.connectionId,
          externalAccountId: item.externalAccountId,
        }),
      });
      await Promise.all([loadOverview(), loadCatalog(item.connectionId)]);
    });
  }

  async function unlink(linkId: string) {
    await action(`unlink:${linkId}`, async () => {
      await api(`/api/v1/links/${linkId}`, { method: "DELETE" });
      await Promise.all([loadOverview(), loadCatalog(selectedConnectionId)]);
    });
  }

  async function acknowledge(alertId: string) {
    await action(`ack:${alertId}`, async () => {
      await api(`/api/v1/alerts/${alertId}/acknowledge`, { method: "POST" });
      await loadOverview();
    });
  }

  async function action(key: string, operation: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setStatus(null);
    try {
      await operation();
    } catch (caught) {
      setError(userErrorMessage(caught, "操作失败"));
    } finally {
      setBusy(null);
    }
  }

  const managedById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );

  return (
    <main className="mx-auto w-full max-w-7xl px-5 py-8 lg:px-8">
      <div className="mb-7 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Sub2API 连接</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {connections.length} 个最小权限连接
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={`size-2 rounded-full ${worker?.healthy ? "bg-emerald-500" : "bg-red-500"}`} />
          <span>{worker?.healthy ? "后台同步正常" : "后台同步未连接"}</span>
          {worker?.heartbeatAt ? (
            <span className="text-[var(--muted)]">{formatDate(worker.heartbeatAt)}</span>
          ) : null}
          <button type="button" disabled={Boolean(busy)} onClick={() => void rotateServiceKey()} className={secondaryButton}>
            {busy === "rotate-service-key" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <RefreshCw aria-hidden="true" size={16} />}
            轮换服务密钥
          </button>
        </div>
      </div>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {status ? <Notice kind="success">{status}</Notice> : null}

      <section className="border-y border-[var(--border)] py-6" aria-labelledby="new-connection-title">
        <h2 id="new-connection-title" className="font-semibold">添加连接</h2>
        <form onSubmit={create} className="mt-4 grid gap-3 lg:grid-cols-[180px_minmax(260px,1fr)_minmax(260px,1fr)_140px_auto]">
          <Field label="名称"><input name="name" required maxLength={100} className={inputClass} /></Field>
          <Field label="HTTPS 基础地址"><input name="baseUrl" type="url" required placeholder="https://sub2api.example.com" className={inputClass} /></Field>
          <Field label="集成令牌（读取 + 删除）"><input name="token" type="password" required autoComplete="off" className={inputClass} /></Field>
          <Field label="同步周期"><select name="syncIntervalSeconds" defaultValue="300" className={inputClass}><option value="60">1 分钟</option><option value="300">5 分钟</option><option value="900">15 分钟</option><option value="3600">1 小时</option></select></Field>
          <button type="submit" disabled={Boolean(busy)} className={`${primaryButton} self-end`}>
            {busy === "create" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <KeyRound aria-hidden="true" size={16} />}
            验证并保存
          </button>
        </form>
      </section>

      <section className="py-7" aria-labelledby="connections-title">
        <h2 id="connections-title" className="font-semibold">连接状态</h2>
        <div className="mt-4 overflow-x-auto border border-[var(--border)] bg-white">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-[var(--surface-subtle)] text-xs text-[var(--muted)]"><tr><Th>连接</Th><Th>实例</Th><Th>同步</Th><Th>最近成功</Th><Th>凭据</Th><Th>操作</Th></tr></thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id} className="border-t border-[var(--border)]">
                  <Td><button type="button" onClick={() => setSelectedConnectionId(connection.id)} className="font-semibold hover:underline">{connection.name}</button><p className="mt-1 text-xs text-[var(--muted)]">{connection.baseUrl}</p></Td>
                  <Td><code className="text-xs">{connection.remoteInstanceId ?? "未验证"}</code></Td>
                  <Td><Status value={connection.syncHealth} /><p className="mt-1 text-xs text-[var(--muted)]">失败 {connection.consecutiveFailures} 次</p></Td>
                  <Td>{connection.lastSuccessAt ? formatDate(connection.lastSuccessAt) : "从未"}{connection.lastErrorCode ? <p className="mt-1 text-xs text-[var(--danger)]">错误代码：<code>{connection.lastErrorCode}</code></p> : null}</Td>
                  <Td><code className="text-xs">{connection.tokenHint}</code><p className="mt-1 text-xs text-[var(--muted)]">{connection.tokenKeyId}</p></Td>
                  <Td><div className="flex gap-2"><IconAction label="测试连接" busy={busy === `test:${connection.id}`} icon={CloudCog} onClick={() => void testConnection(connection)} /><IconAction label="立即同步" busy={busy === `sync:${connection.id}`} icon={Play} onClick={() => void syncConnection(connection)} /><IconAction label="替换 Sub2API 集成令牌" icon={KeyRound} onClick={() => setReplaceTokenFor(connection)} /><IconAction label={connection.enabled ? "停用连接" : "启用连接"} busy={busy === `toggle:${connection.id}`} icon={connection.enabled ? Unplug : RefreshCw} onClick={() => void toggleConnection(connection)} /><IconAction label="删除连接" busy={busy === `delete:${connection.id}`} icon={Trash2} onClick={() => void removeConnection(connection)} /></div></Td>
                </tr>
              ))}
              {!connections.length ? <tr><td colSpan={6} className="h-28 text-center text-[var(--muted)]">尚未配置连接</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="border-t border-[var(--border)] py-7" aria-labelledby="catalog-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="catalog-title" className="font-semibold">远端账号目录</h2>
          <select aria-label="选择连接" value={selectedConnectionId} onChange={(event) => setSelectedConnectionId(event.target.value)} className={`${inputClass} w-auto min-w-52`}>
            <option value="">选择连接</option>
            {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
          </select>
        </div>
        <div className="mt-4 overflow-x-auto border border-[var(--border)] bg-white">
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="bg-[var(--surface-subtle)] text-xs text-[var(--muted)]"><tr><Th>远端账号</Th><Th>平台</Th><Th>可用性</Th><Th>额度</Th><Th>人工关联</Th></tr></thead>
            <tbody>
              {catalog.map((item) => {
                const targetKey = accountLinkTargetKey(item);
                const eligible = accounts.filter((account) => account.platform === item.externalPlatform);
                return (
                  <tr key={item.externalAccountId} className="border-t border-[var(--border)]">
                    <Td><p className="font-semibold">{item.externalName}</p><code className="text-xs text-[var(--muted)]">{item.externalAccountId}</code></Td>
                    <Td>{platformLabel(item.externalPlatform)}<p className="text-xs text-[var(--muted)]">{item.externalType}</p></Td>
                    <Td><Status value={item.availability} /><p className="mt-1 text-xs text-[var(--muted)]">{statusLabel(item.remoteStatus)}</p></Td>
                    <Td>{quotaLabel(item)}</Td>
                    <Td>{item.linkedManagedAccountId ? <span className="inline-flex items-center gap-2"><Link2 aria-hidden="true" size={15} />{managedById.get(item.linkedManagedAccountId)?.displayName ?? "已关联"}</span> : <div className="flex gap-2"><select aria-label={`关联 ${item.externalName}`} value={linkTargets[targetKey] ?? ""} onChange={(event) => setLinkTargets((current) => ({ ...current, [targetKey]: event.target.value }))} className={`${inputClass} min-w-44`}><option value="">选择本地账号</option>{eligible.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select><IconAction label="确认关联" busy={busy === `link:${targetKey}`} disabled={!linkTargets[targetKey]} icon={Link2} onClick={() => void linkRemote(item)} /></div>}</Td>
                  </tr>
                );
              })}
              {!catalog.length ? <tr><td colSpan={5} className="h-28 text-center text-[var(--muted)]">同步后将在此显示远端账号</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="border-t border-[var(--border)] py-7" aria-labelledby="links-title">
        <h2 id="links-title" className="font-semibold">已关联状态</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {links.map((link) => (
            <div key={link.id} className="border-l-4 border-[var(--border)] bg-white px-4 py-3">
              <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{managedById.get(link.managedAccountId)?.displayName ?? link.externalName}</p><p className="mt-1 text-xs text-[var(--muted)]">{link.connectionName} · {link.externalName}</p></div><IconAction label="解除关联" busy={busy === `unlink:${link.id}`} icon={Unplug} onClick={() => void unlink(link.id)} /></div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs"><Status value={link.healthCode} /><Status value={link.syncHealth} />{link.observedAt ? <span className="text-[var(--muted)]">观测 {formatDate(link.observedAt)}</span> : null}</div>
            </div>
          ))}
          {!links.length ? <p className="text-sm text-[var(--muted)]">尚未建立关联</p> : null}
        </div>
      </section>

      <section className="border-t border-[var(--border)] py-7" aria-labelledby="alerts-title">
        <h2 id="alerts-title" className="flex items-center gap-2 font-semibold"><Bell aria-hidden="true" size={17} />站内告警</h2>
        <div className="mt-4 space-y-2">
          {alerts.map((alert) => (
            <div key={alert.id} className="flex flex-col gap-3 border-l-4 border-[var(--warning)] bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div><p className="font-semibold">{alert.accountName} · {alert.summary}</p><p className="mt-1 text-xs text-[var(--muted)]">{alert.connectionName} · {statusLabel(alert.status)} · {formatDate(alert.lastFiredAt)}</p></div>
              {alert.status === "firing" ? <button type="button" disabled={Boolean(busy)} onClick={() => void acknowledge(alert.id)} className={secondaryButton}>{busy === `ack:${alert.id}` ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Check aria-hidden="true" size={16} />}确认</button> : <Status value={alert.status} />}
            </div>
          ))}
          {!alerts.length ? <p className="text-sm text-[var(--muted)]">暂无告警</p> : null}
        </div>
      </section>

      {replaceTokenFor ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" role="presentation">
          <form onSubmit={replaceToken} role="dialog" aria-modal="true" aria-labelledby="replace-token-title" className="w-full max-w-lg border border-[var(--border)] bg-white p-5 shadow-xl">
            <h2 id="replace-token-title" className="text-lg font-semibold">替换 {replaceTokenFor.name} 的集成令牌</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">新令牌会先验证远端实例 ID，再使用当前服务密钥加密。</p>
            <label className="mt-5 block space-y-2"><span className="text-xs font-semibold text-[var(--muted)]">集成令牌（读取 + 删除）</span><input name="token" type="password" required autoComplete="off" className={inputClass} /></label>
            <div className="mt-5 flex justify-end gap-3"><button type="button" disabled={Boolean(busy)} onClick={() => setReplaceTokenFor(null)} className={secondaryButton}>取消</button><button type="submit" disabled={Boolean(busy)} className={primaryButton}>{busy === `replace:${replaceTokenFor.id}` ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <KeyRound aria-hidden="true" size={16} />}验证通行密钥并替换</button></div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

async function loadActiveManagedAccounts(): Promise<ManagedAccountList> {
  const items: ManagedAccount[] = [];
  let page = 1;
  let pages = 1;
  do {
    const result = await api<ManagedAccountList>(
      `/api/v1/accounts?page=${page}&pageSize=100&localStatus=active`,
    );
    items.push(...result.items);
    pages = result.pages;
    page += 1;
  } while (page <= pages);
  return { items, page: 1, pages };
}

function accountLinkTargetKey(item: RemoteCatalogItem): string {
  return `${item.connectionId}:${item.externalAccountId}`;
}

async function passkeyStepUp() {
  const result = await authClient.signIn.passkey();
  if (result.error) throw new UserFacingError("通行密钥验证失败，请重试");
}

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = (await response.json().catch(() => ({}))) as T & ApiFailure;
  if (!response.ok) throw new UserFacingError(apiErrorMessage(body));
  return body;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-2"><span className="text-xs font-semibold text-[var(--muted)]">{label}</span>{children}</label>;
}
function Th({ children }: { children: React.ReactNode }) { return <th className="px-4 py-3 font-semibold">{children}</th>; }
function Td({ children }: { children: React.ReactNode }) { return <td className="px-4 py-3 align-top">{children}</td>; }
function Status({ value }: { value: string }) { return <span className="inline-flex min-h-6 items-center rounded-[4px] bg-[var(--surface-subtle)] px-2 text-xs font-semibold">{statusLabel(value)}</span>; }
function statusLabel(value: string) {
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
    fresh: "已同步",
    stale: "同步延迟",
    disconnected: "连接中断",
    never_synced: "等待同步",
    firing: "告警中",
    acknowledged: "已确认",
    resolved: "已恢复",
    active: "运行中",
    inactive: "未启用",
  } as Record<string, string>)[value] ?? "状态未知";
}
function Notice({ kind, children }: { kind: "error" | "success"; children: React.ReactNode }) { return <p role={kind === "error" ? "alert" : "status"} className={`mb-4 flex items-start gap-2 border-l-4 px-4 py-3 text-sm ${kind === "error" ? "border-[var(--danger)] bg-red-50 text-[var(--danger)]" : "border-emerald-600 bg-emerald-50 text-emerald-800"}`}>{kind === "error" ? <CircleAlert className="mt-0.5 shrink-0" aria-hidden="true" size={16} /> : <Check className="mt-0.5 shrink-0" aria-hidden="true" size={16} />}{children}</p>; }
function IconAction({ label, icon: Icon, busy, disabled, onClick }: { label: string; icon: React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" | "false" }>; busy?: boolean; disabled?: boolean; onClick: () => void }) { return <button type="button" title={label} aria-label={label} disabled={busy || disabled} onClick={onClick} className="grid size-9 shrink-0 place-items-center rounded-[6px] border border-[var(--border)] bg-white text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40">{busy ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Icon aria-hidden="true" size={16} />}</button>; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
function platformLabel(value: string) { return ({ openai: "OpenAI", opencode_go: "OpenCode Go", antigravity: "Antigravity", clinepass: "ClinePass", openrouter: "OpenRouter" } as Record<string, string>)[value] ?? value; }
function quotaLabel(item: RemoteCatalogItem) { const windows = item.quota?.windows; if (!windows) return item.quotaErrorCode ? `配额不可用（${item.quotaErrorCode}）` : "无快照"; const entries = Object.entries(windows).slice(0, 3); return <div className="space-y-1 text-xs">{entries.map(([name, window]) => <p key={name}><span className="text-[var(--muted)]">{name.replaceAll("_", " ")}</span> {Math.round(window.utilization)}%</p>)}</div>; }

const inputClass = "min-h-10 w-full rounded-[6px] border border-[var(--border)] bg-white px-3 py-2 text-sm";
const primaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--accent)] px-4 font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50";
const secondaryButton = "inline-flex h-9 items-center justify-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-3 text-sm font-semibold hover:bg-[var(--surface-subtle)] disabled:opacity-50";

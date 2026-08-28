"use client";

import Link from "next/link";
import { CloudCog, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { IntegrationLinkView } from "@/server/integrations/service";

export function AccountIntegrationStatus({ managedAccountId }: { managedAccountId: string }) {
  const [links, setLinks] = useState<IntegrationLinkView[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/v1/links?managedAccountId=${encodeURIComponent(managedAccountId)}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("link status unavailable");
        return (await response.json()) as { links: IntegrationLinkView[] };
      })
      .then((result) => setLinks(result.links))
      .catch(() => {
        if (!controller.signal.aborted) setLinks([]);
      });
    return () => controller.abort();
  }, [managedAccountId]);

  return (
    <section className="mt-6 border-t border-[var(--border)] pt-6" aria-labelledby="sub2api-status-title">
      <div className="flex items-center justify-between gap-3">
        <h3 id="sub2api-status-title" className="flex items-center gap-2 font-semibold"><CloudCog aria-hidden="true" size={17} />Sub2API</h3>
        <Link href="/connections" className="text-sm font-semibold text-[var(--accent)] hover:underline">管理连接</Link>
      </div>
      {links === null ? (
        <LoaderCircle className="mt-4 animate-spin text-[var(--muted)]" aria-label="加载关联状态" size={18} />
      ) : links.length ? (
        <div className="mt-4 space-y-3">
          {links.map((link) => (
            <div key={link.id} className="border-l-4 border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{link.connectionName} · {link.externalName}</p><div className="flex gap-2"><Badge>{link.healthCode}</Badge><Badge>{link.syncHealth}</Badge></div></div>
              <p className="mt-2 text-xs text-[var(--muted)]">{link.observedAt ? `最近观测 ${formatDate(link.observedAt)}` : "尚未取得远端状态"}</p>
              {quotaSummary(link.quota)}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-[var(--muted)]">尚未关联远端账号。</p>
      )}
    </section>
  );
}

function Badge({ children }: { children: string }) {
  return <span className="rounded-[4px] bg-white px-2 py-1 text-xs font-semibold">{statusLabel(children)}</span>;
}

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
  } as Record<string, string>)[value] ?? "状态未知";
}

function quotaSummary(quota: unknown) {
  if (!quota || typeof quota !== "object" || !("windows" in quota)) return null;
  const windows = (quota as { windows?: Record<string, { utilization?: number }> }).windows;
  if (!windows) return null;
  return <div className="mt-3 flex flex-wrap gap-3 text-xs">{Object.entries(windows).slice(0, 3).map(([name, value]) => <span key={name}><span className="text-[var(--muted)]">{name.replaceAll("_", " ")}</span> {Math.round(value.utilization ?? 0)}%</span>)}</div>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

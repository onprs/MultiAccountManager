"use client";

import {
  Check,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

type Passkey = {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  aaguid: string | null;
};

type Failure = { message?: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = (await response.json().catch(() => ({}))) as T & Failure;
  if (!response.ok) throw new Error(body.message || "请求失败");
  return body;
}

export function PasskeySecurity() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [name, setName] = useState("Backup Passkey");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await request<{ passkeys: Passkey[] }>("/api/v1/security/passkeys");
    setPasskeys(result.passkeys);
  }, []);

  useEffect(() => {
    let cancelled = false;
    request<{ passkeys: Passkey[] }>("/api/v1/security/passkeys")
      .then((result) => {
        if (!cancelled) setPasskeys(result.passkeys);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Passkey 加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function stepUp() {
    const result = await authClient.signIn.passkey();
    if (result.error) throw new Error(result.error.message || "Passkey 验证失败");
  }

  async function addPasskey() {
    setBusy("add");
    setError(null);
    try {
      await stepUp();
      const result = await authClient.passkey.addPasskey({ name: name.trim() || undefined });
      if (result.error) throw new Error(result.error.message || "Passkey 注册失败");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Passkey 注册失败");
    } finally {
      setBusy(null);
    }
  }

  async function saveName(id: string) {
    setBusy(id);
    setError(null);
    try {
      await request(`/api/v1/security/passkeys/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName }),
      });
      setEditing(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Passkey 重命名失败");
    } finally {
      setBusy(null);
    }
  }

  async function removePasskey(id: string) {
    setBusy(id);
    setError(null);
    try {
      await stepUp();
      await request(`/api/v1/security/passkeys/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Passkey 删除失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      {error ? (
        <p className="border-l-4 border-[var(--danger)] bg-red-50 px-4 py-3 text-sm text-[var(--danger)]" role="alert">
          {error}
        </p>
      ) : null}

      <section aria-labelledby="registered-passkeys">
        <div className="mb-4 flex items-end justify-between gap-4 border-b border-[var(--border)] pb-4">
          <div>
            <h2 id="registered-passkeys" className="text-lg font-semibold">已注册 Passkey</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">删除前需要用现有 Passkey 重新验证。</p>
          </div>
          <span className="text-sm font-semibold tabular-nums">{passkeys.length}</span>
        </div>
        {busy === "load" ? (
          <div className="grid min-h-32 place-items-center text-[var(--muted)]"><LoaderCircle className="animate-spin" aria-label="正在加载" size={20} /></div>
        ) : (
          <div className="divide-y divide-[var(--border)] border-y border-[var(--border)] bg-white">
            {passkeys.map((passkey) => (
              <div key={passkey.id} className="grid min-h-20 gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_160px_auto] sm:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-[6px] bg-[var(--surface-subtle)] text-[var(--foreground)]"><KeyRound aria-hidden="true" size={17} /></span>
                  <div className="min-w-0">
                    {editing === passkey.id ? (
                      <input autoFocus value={editName} maxLength={100} onChange={(event) => setEditName(event.target.value)} className="h-9 w-full rounded-[6px] border border-[var(--border)] px-2" aria-label="Passkey 名称" />
                    ) : (
                      <p className="truncate font-semibold">{passkey.name || "Unnamed Passkey"}</p>
                    )}
                    <p className="text-xs text-[var(--muted)]">{passkey.backedUp ? "已同步" : "仅此设备"} · {passkey.deviceType}</p>
                  </div>
                </div>
                <time className="text-xs text-[var(--muted)]" dateTime={passkey.createdAt}>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(passkey.createdAt))}</time>
                <div className="flex justify-end gap-2">
                  {editing === passkey.id ? (
                    <>
                      <IconButton label="保存名称" disabled={busy === passkey.id || !editName.trim()} onClick={() => saveName(passkey.id)} icon={busy === passkey.id ? LoaderCircle : Check} spin={busy === passkey.id} />
                      <IconButton label="取消" onClick={() => setEditing(null)} icon={X} />
                    </>
                  ) : (
                    <>
                      <IconButton label="重命名" onClick={() => { setEditing(passkey.id); setEditName(passkey.name || ""); }} icon={Pencil} />
                      <IconButton label={passkeys.length <= 1 ? "不能删除最后一个 Passkey" : "删除 Passkey"} disabled={passkeys.length <= 1 || busy === passkey.id} onClick={() => removePasskey(passkey.id)} icon={busy === passkey.id ? LoaderCircle : Trash2} spin={busy === passkey.id} danger />
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="add-passkey" className="max-w-xl">
        <div className="mb-4 border-b border-[var(--border)] pb-4">
          <h2 id="add-passkey" className="text-lg font-semibold">添加备用 Passkey</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">建议至少保留两个不同设备或介质的凭据。</p>
        </div>
        <label className="block space-y-2">
          <span className="text-xs font-semibold text-[var(--muted)]">Passkey 名称</span>
          <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} className="h-10 w-full rounded-[6px] border border-[var(--border)] bg-white px-3" />
        </label>
        <button type="button" disabled={Boolean(busy) || !name.trim()} onClick={addPasskey} className="mt-4 inline-flex h-10 items-center gap-2 rounded-[6px] bg-[var(--accent)] px-4 font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-60">
          {busy === "add" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
          添加 Passkey
        </button>
      </section>
    </div>
  );
}

function IconButton({ label, icon: Icon, onClick, disabled, spin, danger }: { label: string; icon: typeof Fingerprint; onClick: () => void; disabled?: boolean; spin?: boolean; danger?: boolean }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className={`grid size-9 place-items-center rounded-[6px] border border-[var(--border)] bg-white disabled:cursor-not-allowed disabled:opacity-40 ${danger ? "text-[var(--danger)]" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
      <Icon aria-hidden="true" size={16} className={spin ? "animate-spin" : undefined} />
    </button>
  );
}

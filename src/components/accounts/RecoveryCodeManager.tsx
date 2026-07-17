"use client";

import {
  Check,
  CircleAlert,
  Clipboard,
  Eye,
  LoaderCircle,
  RotateCcw,
  Upload,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  recoveryCodePrivatePayloadSchema,
  type RecoveryCodeMetadata,
  type RevealedRecoveryCode,
} from "@/accounts/schema";
import type { VaultCryptoClient } from "@/crypto";
import { authClient } from "@/lib/auth-client";

type ApiFailure = { message?: string };

export function RecoveryCodeManager({
  ownerUserId,
  accountId,
  client,
}: {
  ownerUserId: string;
  accountId: string;
  client: VaultCryptoClient;
}) {
  const [codes, setCodes] = useState<RecoveryCodeMetadata[]>([]);
  const [remaining, setRemaining] = useState(0);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api<{ codes: RecoveryCodeMetadata[]; remaining: number }>(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/recovery-codes`,
    );
    setCodes(result.codes);
    setRemaining(result.remaining);
  }, [accountId]);

  useEffect(() => {
    let cancelled = false;
    api<{ codes: RecoveryCodeMetadata[]; remaining: number }>(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/recovery-codes`,
    )
      .then((result) => {
        if (!cancelled) {
          setCodes(result.codes);
          setRemaining(result.remaining);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "恢复码加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  async function importCodes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const raw = String(new FormData(form).get("codes") ?? "");
    const normalized = [...new Set(raw.split(/\r?\n/).map((code) => code.trim()).filter(Boolean))];
    if (!normalized.length) {
      setError("请至少输入一个恢复码");
      return;
    }
    if (normalized.length > 200) {
      setError("单次最多导入 200 个恢复码");
      return;
    }
    setBusy("import");
    setError(null);
    try {
      const encrypted = [];
      for (const code of normalized) {
        const id = crypto.randomUUID();
        const [codeCiphertext, codeBlindIndex] = await Promise.all([
          client.encryptRecord({
            ownerUserId,
            recordType: "managed-account-recovery-code-v1",
            recordId: id,
            value: recoveryCodePrivatePayloadSchema.parse({ version: 1, code }),
          }),
          client.blindIndex(
            code,
            `managed-account-recovery-code-v1:${accountId}`,
            "exact",
          ),
        ]);
        encrypted.push({
          id,
          codeCiphertext,
          codeBlindIndex,
          batchLabelCiphertext: null,
        });
      }
      await api(`/api/v1/accounts/${encodeURIComponent(accountId)}/recovery-codes`, {
        method: "POST",
        body: JSON.stringify({ codes: encrypted }),
      });
      form.reset();
      setRevealed({});
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "恢复码导入失败");
    } finally {
      setBusy(null);
    }
  }

  async function reveal() {
    setBusy("reveal");
    setError(null);
    try {
      const stepUp = await authClient.signIn.passkey();
      if (stepUp.error) {
        throw new Error(stepUp.error.message || "Passkey 验证失败");
      }
      const result = await api<{ codes: RevealedRecoveryCode[] }>(
        `/api/v1/accounts/${encodeURIComponent(accountId)}/recovery-codes/reveal`,
        { method: "POST", body: "{}" },
      );
      const plaintext: Record<string, string> = {};
      for (const code of result.codes) {
        const payload = recoveryCodePrivatePayloadSchema.parse(
          await client.decryptRecord({
            ownerUserId,
            recordType: "managed-account-recovery-code-v1",
            recordId: code.id,
            envelope: code.codeCiphertext,
          }),
        );
        plaintext[code.id] = payload.code;
      }
      setRevealed(plaintext);
    } catch (caught) {
      setRevealed({});
      setError(caught instanceof Error ? caught.message : "恢复码显示失败");
    } finally {
      setBusy(null);
    }
  }

  async function setUsed(code: RecoveryCodeMetadata, used: boolean) {
    setBusy(code.id);
    setError(null);
    try {
      await api(
        `/api/v1/accounts/${encodeURIComponent(accountId)}/recovery-codes/${encodeURIComponent(code.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ expectedRevision: code.revision, used }),
        },
      );
      setRevealed({});
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "恢复码状态更新失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="recovery-codes-title" className="border-t border-[var(--border)] pt-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 id="recovery-codes-title" className="font-semibold">平台恢复码</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {remaining} 个未使用，共 {codes.length} 个
          </p>
        </div>
        <button type="button" disabled={!codes.length || Boolean(busy)} onClick={() => void reveal()} className={secondaryButton}>
          {busy === "reveal" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}
          Passkey 验证并显示
        </button>
      </div>

      {error ? (
        <p role="alert" className="mb-4 flex items-start gap-2 border-l-4 border-[var(--danger)] bg-red-50 px-4 py-3 text-sm text-[var(--danger)]">
          <CircleAlert className="mt-0.5 shrink-0" aria-hidden="true" size={16} />{error}
        </p>
      ) : null}

      {busy === "load" ? (
        <div className="grid min-h-24 place-items-center text-[var(--muted)]"><LoaderCircle className="animate-spin" aria-label="正在加载" size={18} /></div>
      ) : codes.length ? (
        <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
          {codes.map((code, index) => (
            <div key={code.id} className="grid min-h-12 gap-2 py-2 sm:grid-cols-[80px_minmax(0,1fr)_auto] sm:items-center">
              <span className="text-xs font-semibold text-[var(--muted)]">#{index + 1}</span>
              <code className={`min-w-0 break-all text-sm ${code.usedAt ? "text-[var(--muted)] line-through" : ""}`}>
                {revealed[code.id] ?? "•••• •••• ••••"}
              </code>
              <div className="flex gap-2">
                {revealed[code.id] ? (
                  <IconButton label="复制恢复码" icon={Clipboard} onClick={() => void navigator.clipboard.writeText(revealed[code.id])} />
                ) : null}
                <IconButton
                  label={code.usedAt ? "恢复为未使用" : "标记为已使用"}
                  icon={busy === code.id ? LoaderCircle : code.usedAt ? RotateCcw : Check}
                  spin={busy === code.id}
                  disabled={Boolean(busy)}
                  onClick={() => void setUsed(code, !code.usedAt)}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="border-y border-[var(--border)] py-5 text-sm text-[var(--muted)]">尚未导入恢复码</p>
      )}

      <form onSubmit={importCodes} className="mt-5 space-y-3">
        <label className="block space-y-2">
          <span className="text-xs font-semibold text-[var(--muted)]">批量导入</span>
          <textarea name="codes" rows={4} autoComplete="off" placeholder="每行一个恢复码" className={inputClass} />
        </label>
        <button type="submit" disabled={Boolean(busy)} className={primaryButton}>
          {busy === "import" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Upload aria-hidden="true" size={16} />}
          加密并导入
        </button>
      </form>
    </section>
  );
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

function IconButton({ label, icon: Icon, onClick, disabled, spin }: { label: string; icon: typeof Eye; onClick: () => void; disabled?: boolean; spin?: boolean }) {
  return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="grid size-9 place-items-center rounded-[6px] border border-[var(--border)] bg-white text-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"><Icon className={spin ? "animate-spin" : undefined} aria-hidden="true" size={16} /></button>;
}

const inputClass = "min-h-10 w-full rounded-[6px] border border-[var(--border)] bg-white px-3 py-2 text-sm";
const primaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--accent)] px-4 font-semibold text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-4 font-semibold text-[var(--foreground)] hover:bg-[var(--surface-subtle)] disabled:cursor-not-allowed disabled:opacity-50";

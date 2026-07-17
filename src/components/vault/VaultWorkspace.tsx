"use client";

import {
  Check,
  CircleAlert,
  Download,
  KeyRound,
  LoaderCircle,
  Lock,
  Printer,
  RefreshCw,
  ShieldCheck,
  Unlock,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { VaultClientError, VaultCryptoClient } from "@/crypto";
import {
  AccountManager,
  type AccountManagerInitialQuery,
} from "@/components/accounts/AccountManager";
import type { VaultCryptoDocument } from "@/crypto/schema";

type Mode = "initialize" | "locked" | "unlocked" | "recovery";
type ApiFailure = { message?: string };

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

export function VaultWorkspace({
  ownerUserId,
  initialVault,
  initialQuery,
}: {
  ownerUserId: string;
  initialVault: VaultCryptoDocument | null;
  initialQuery: AccountManagerInitialQuery;
}) {
  const [vault, setVault] = useState(initialVault);
  const [mode, setMode] = useState<Mode>(initialVault ? "locked" : "initialize");
  const [unlockMethod, setUnlockMethod] = useState<"password" | "recovery">("password");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [client] = useState(
    () =>
      new VaultCryptoClient(10 * 60 * 1000, () => {
        setMode((current) =>
          current === "initialize" || current === "recovery" ? current : "locked",
        );
      }),
  );

  useEffect(() => {
    const lock = () => void client.lock();
    window.addEventListener("account-vault:lock", lock);
    return () => {
      window.removeEventListener("account-vault:lock", lock);
      client.dispose();
    };
  }, [client]);

  async function initialize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    const confirmation = String(values.get("confirmation") ?? "");
    if (password.normalize("NFKC").length < 12) {
      setError("主密码至少需要 12 个字符");
      return;
    }
    if (password !== confirmation) {
      setError("两次输入的主密码不一致");
      return;
    }

    setBusy("initialize");
    setError(null);
    try {
      setProgress("正在测定此设备的 Argon2id 参数");
      const benchmark = await client.benchmarkKdf();
      setProgress(`正在派生密钥，预计约 ${benchmark.estimatedMilliseconds} ms`);
      const initialized = await client.initialize({
        ownerUserId,
        vaultId: crypto.randomUUID(),
        password,
        kdfParams: benchmark.params,
      });
      setProgress("正在保存加密 envelope");
      const saved = await api<{ vault: VaultCryptoDocument }>("/api/v1/vault", {
        method: "POST",
        body: JSON.stringify({ vault: initialized.vault }),
      });
      setVault(saved.vault);
      setRecoveryKey(initialized.recoveryKey);
      setRecoveryConfirmed(false);
      setMode("recovery");
      form.reset();
    } catch (caught) {
      await client.lock();
      setError(message(caught, "保险库初始化失败"));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!vault) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy("unlock");
    setError(null);
    try {
      if (unlockMethod === "password") {
        await client.unlockWithPassword(vault, String(values.get("password") ?? ""));
      } else {
        await client.unlockWithRecovery(vault, String(values.get("recoveryKey") ?? ""));
      }
      form.reset();
      setMode("unlocked");
    } catch {
      setError("主密码错误或保险库数据已损坏");
    } finally {
      setBusy(null);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!vault) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const newPassword = String(values.get("newPassword") ?? "");
    const confirmation = String(values.get("confirmation") ?? "");
    if (newPassword.normalize("NFKC").length < 12 || newPassword !== confirmation) {
      setError("新主密码至少 12 个字符，且两次输入必须一致");
      return;
    }
    setBusy("change-password");
    setError(null);
    try {
      await stepUp();
      setProgress("正在测定并派生新的主密码密钥");
      const benchmark = await client.benchmarkKdf();
      const changed = await client.changePassword({
        vault,
        newPassword,
        kdfParams: benchmark.params,
      });
      const saved = await api<{ vault: VaultCryptoDocument }>("/api/v1/vault", {
        method: "PUT",
        body: JSON.stringify({ expectedRevision: vault.revision, ...changed }),
      });
      setVault(saved.vault);
      form.reset();
      setProgress("主密码已更新；账号密文未重新加密");
      setTimeout(() => setProgress(null), 3000);
    } catch (caught) {
      setError(message(caught, "主密码更新失败"));
      setProgress(null);
    } finally {
      setBusy(null);
    }
  }

  async function confirmRecovery() {
    if (!vault || !recoveryConfirmed) return;
    setBusy("confirm-recovery");
    setError(null);
    try {
      const saved = await api<{ vault: VaultCryptoDocument }>(
        "/api/v1/vault/recovery-envelope/confirm",
        {
          method: "POST",
          body: JSON.stringify({ expectedRevision: vault.revision }),
        },
      );
      setVault(saved.vault);
      setRecoveryKey(null);
      setMode("unlocked");
    } catch (caught) {
      setError(message(caught, "恢复资料确认失败"));
    } finally {
      setBusy(null);
    }
  }

  async function rotateRecovery() {
    if (!vault) return;
    setBusy("rotate-recovery");
    setError(null);
    try {
      await stepUp();
      const rotated = await client.rotateRecovery(vault);
      const saved = await api<{ vault: VaultCryptoDocument }>(
        "/api/v1/vault/recovery-envelope/rotate",
        {
          method: "POST",
          body: JSON.stringify({
            expectedRevision: vault.revision,
            recoveryEnvelope: rotated.recoveryEnvelope,
            recoveryKeyChecksum: rotated.recoveryKeyChecksum,
          }),
        },
      );
      setVault(saved.vault);
      setRecoveryKey(rotated.recoveryKey);
      setRecoveryConfirmed(false);
      setMode("recovery");
    } catch (caught) {
      setError(message(caught, "恢复密钥轮换失败"));
    } finally {
      setBusy(null);
    }
  }

  async function lock() {
    await client.lock();
    setMode("locked");
  }

  if (mode === "initialize") {
    return (
      <VaultShell status="未初始化">
        <form onSubmit={initialize} className="max-w-xl space-y-6">
          <Heading title="初始化客户端保险库" subtitle="主密码只在此浏览器的 Crypto Worker 中使用" />
          <PasswordField name="password" label="主密码" autoComplete="new-password" />
          <PasswordField name="confirmation" label="确认主密码" autoComplete="new-password" />
          <Notice>忘记主密码后只能使用稍后生成的恢复密钥解锁。系统无法替你恢复明文。</Notice>
          <Action busy={busy === "initialize"} icon={ShieldCheck}>创建保险库</Action>
          {progress ? <Progress>{progress}</Progress> : null}
          <ErrorMessage value={error} />
        </form>
      </VaultShell>
    );
  }

  if (mode === "recovery" && vault && recoveryKey) {
    return (
      <VaultShell status="恢复资料待保存">
        <div className="max-w-2xl space-y-6">
          <Heading title="保存保险库恢复资料" subtitle="恢复密钥只显示这一次" />
          <div className="border border-[var(--border)] bg-white p-5">
            <p className="mb-2 text-xs font-semibold text-[var(--muted)]">RECOVERY KEY</p>
            <code className="block break-all text-sm leading-7">{recoveryKey}</code>
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => downloadRecoveryKit(vault, recoveryKey)} className={secondaryButton}>
              <Download aria-hidden="true" size={16} />下载 Recovery Kit
            </button>
            <button type="button" onClick={() => window.print()} className={secondaryButton}>
              <Printer aria-hidden="true" size={16} />打印
            </button>
          </div>
          <label className="flex items-start gap-3 border-l-4 border-[var(--warning)] bg-amber-50 px-4 py-3 text-sm text-[var(--warning)]">
            <input type="checkbox" checked={recoveryConfirmed} onChange={(event) => setRecoveryConfirmed(event.target.checked)} className="mt-1 size-4" />
            <span>我已将 Recovery Kit 保存到独立的安全位置，并理解丢失主密码和恢复密钥后数据无法恢复。</span>
          </label>
          <button type="button" disabled={!recoveryConfirmed || busy === "confirm-recovery"} onClick={confirmRecovery} className={primaryButton}>
            {busy === "confirm-recovery" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Check aria-hidden="true" size={16} />}
            确认并进入保险库
          </button>
          <ErrorMessage value={error} />
        </div>
      </VaultShell>
    );
  }

  if (mode === "locked" && vault) {
    return (
      <VaultShell status="已锁定">
        <form onSubmit={unlock} className="max-w-xl space-y-6">
          <Heading title="解锁保险库" subtitle="网站登录与保险库主密码是两个独立安全层" />
          <div className="inline-flex rounded-[6px] border border-[var(--border)] bg-white p-1">
            <ModeButton active={unlockMethod === "password"} onClick={() => setUnlockMethod("password")}>主密码</ModeButton>
            <ModeButton active={unlockMethod === "recovery"} onClick={() => setUnlockMethod("recovery")}>恢复密钥</ModeButton>
          </div>
          {unlockMethod === "password" ? (
            <PasswordField name="password" label="主密码" autoComplete="current-password" />
          ) : (
            <label className="block space-y-2">
              <span className="text-xs font-semibold text-[var(--muted)]">恢复密钥</span>
              <textarea name="recoveryKey" required rows={3} autoComplete="off" className={inputClass} />
            </label>
          )}
          <Action busy={busy === "unlock"} icon={Unlock}>解锁</Action>
          <ErrorMessage value={error} />
        </form>
      </VaultShell>
    );
  }

  if (vault && !vault.recoveryConfirmedAt) {
    return (
      <VaultShell status="已解锁" action={<button type="button" onClick={lock} className={secondaryButton}><Lock aria-hidden="true" size={16} />锁定</button>}>
        <div className="max-w-xl space-y-6">
          <Heading title="恢复资料尚未确认" subtitle="生成一套新的 Recovery Kit 后才能进入账号工作区" />
          <Notice>之前显示的恢复密钥无法再次从服务器读取。轮换后旧恢复密钥将失效。</Notice>
          <button type="button" disabled={Boolean(busy)} onClick={rotateRecovery} className={primaryButton}>
            {busy === "rotate-recovery" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <RefreshCw aria-hidden="true" size={16} />}
            验证 Passkey 并重新生成
          </button>
          <ErrorMessage value={error} />
        </div>
      </VaultShell>
    );
  }

  return (
    <VaultShell status="已解锁" action={<button type="button" onClick={lock} className={secondaryButton}><Lock aria-hidden="true" size={16} />锁定</button>}>
      <ErrorMessage value={error} />
      {progress ? <Progress>{progress}</Progress> : null}
      <AccountManager
        ownerUserId={ownerUserId}
        client={client}
        initialQuery={initialQuery}
      />

      <details className="max-w-2xl border-t border-[var(--border)] pt-6">
        <summary className="cursor-pointer text-lg font-semibold">保险库安全</summary>
        <div className="mt-6 space-y-8">
          <form onSubmit={changePassword} className="space-y-4 border-b border-[var(--border)] pb-8">
            <div><h2 className="font-semibold">更改主密码</h2><p className="mt-1 text-sm text-[var(--muted)]">只重封装 Root Key，不重新加密账号记录。</p></div>
            <PasswordField name="newPassword" label="新主密码" autoComplete="new-password" />
            <PasswordField name="confirmation" label="确认新主密码" autoComplete="new-password" />
            <Action busy={busy === "change-password"} icon={KeyRound}>验证 Passkey 并更新</Action>
          </form>
          <div className="space-y-4">
            <div><h2 className="font-semibold">轮换恢复密钥</h2><p className="mt-1 text-sm text-[var(--muted)]">旧 Recovery Kit 将立即失效。</p></div>
            <button type="button" disabled={Boolean(busy)} onClick={rotateRecovery} className={secondaryButton}>
              {busy === "rotate-recovery" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <RefreshCw aria-hidden="true" size={16} />}
              验证 Passkey 并轮换
            </button>
          </div>
        </div>
      </details>
    </VaultShell>
  );
}

async function stepUp() {
  const result = await authClient.signIn.passkey();
  if (result.error) throw new Error(result.error.message || "Passkey 验证失败");
}

function downloadRecoveryKit(vault: VaultCryptoDocument, recoveryKey: string) {
  const kit = JSON.stringify(
    {
      format: "account-vault-recovery-kit",
      version: 1,
      vaultId: vault.id,
      recoveryKey,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  );
  const url = URL.createObjectURL(new Blob([kit], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `account-vault-recovery-${vault.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function message(error: unknown, fallback: string): string {
  if (error instanceof VaultClientError && error.code === "VAULT_UNLOCK_FAILED") {
    return "主密码错误或保险库数据已损坏";
  }
  return error instanceof Error ? error.message : fallback;
}

function VaultShell({ status, action, children }: { status: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-7xl px-5 py-8 lg:px-8">
      <div className="mb-8 flex items-center justify-between gap-4 border-b border-[var(--border)] pb-4">
        <div className="flex items-center gap-2 text-sm font-semibold"><span className={`size-2 rounded-full ${status === "已解锁" ? "bg-emerald-600" : "bg-[var(--warning)]"}`} />Vault {status}</div>
        {action}
      </div>
      {children}
    </main>
  );
}

function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return <div className="border-b border-[var(--border)] pb-5"><h1 className="text-2xl font-semibold">{title}</h1><p className="mt-1 text-sm text-[var(--muted)]">{subtitle}</p></div>;
}

function PasswordField({ name, label, autoComplete }: { name: string; label: string; autoComplete: string }) {
  return <label className="block space-y-2"><span className="text-xs font-semibold text-[var(--muted)]">{label}</span><input name={name} type="password" required autoComplete={autoComplete} className={inputClass} /></label>;
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="flex items-start gap-3 border-l-4 border-[var(--warning)] bg-amber-50 px-4 py-3 text-sm text-[var(--warning)]"><CircleAlert className="mt-0.5 shrink-0" aria-hidden="true" size={17} />{children}</div>;
}

function ErrorMessage({ value }: { value: string | null }) {
  return value ? <p className="flex items-start gap-2 border-l-4 border-[var(--danger)] bg-red-50 px-4 py-3 text-sm text-[var(--danger)]" role="alert"><CircleAlert className="mt-0.5 shrink-0" aria-hidden="true" size={16} />{value}</p> : null;
}

function Progress({ children }: { children: React.ReactNode }) {
  return <p className="flex items-center gap-2 text-sm text-[var(--muted)]" role="status"><LoaderCircle className="animate-spin" aria-hidden="true" size={16} />{children}</p>;
}

function Action({ busy, icon: Icon, children }: { busy: boolean; icon: typeof ShieldCheck; children: React.ReactNode }) {
  return <button type="submit" disabled={busy} className={primaryButton}>{busy ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Icon aria-hidden="true" size={16} />}{children}</button>;
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`h-8 rounded-[4px] px-4 text-sm font-semibold ${active ? "bg-[var(--foreground)] text-white" : "text-[var(--muted)]"}`}>{children}</button>;
}

const inputClass = "min-h-10 w-full rounded-[6px] border border-[var(--border)] bg-white px-3 py-2 text-sm";
const primaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--accent)] px-4 font-semibold text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-4 font-semibold text-[var(--foreground)] hover:bg-[var(--surface-subtle)] disabled:cursor-not-allowed disabled:opacity-50";

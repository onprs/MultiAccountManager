"use client";

import {
  CircleAlert,
  KeyRound,
  LoaderCircle,
  Save,
  Trash2,
} from "lucide-react";
import { FormEvent, useRef, useState } from "react";
import {
  managedAccountPrivatePayloadSchema,
  removeTotpFromPrivatePayload,
  totpConfigurationSchema,
  type ManagedAccount,
  type ManagedAccountPrivatePayload,
  type TotpConfiguration,
  type TotpResult,
} from "@/accounts/schema";
import type { VaultCryptoClient } from "@/crypto";
import {
  apiErrorMessage,
  UserFacingError,
  userErrorMessage,
} from "@/lib/api-errors";
import { QrCredentialInput } from "./QrCredentialInput";

type ApiFailure = { code?: string; message?: string };

export function TotpEditor({
  ownerUserId,
  account,
  decrypted,
  client,
  onChanged,
}: {
  ownerUserId: string;
  account: ManagedAccount;
  decrypted: ManagedAccountPrivatePayload;
  client: VaultCryptoClient;
  onChanged: () => Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState<TotpResult | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configurationOpen, setConfigurationOpen] = useState(!decrypted.totp);

  function setCredential(value: string) {
    const field = formRef.current?.elements.namedItem("totpInput");
    if (field instanceof HTMLTextAreaElement) field.value = value;
    setPreview(null);
    setError(null);
  }

  async function parseForm(): Promise<TotpConfiguration> {
    if (!formRef.current) throw new UserFacingError("TOTP 表单不可用");
    const values = new FormData(formRef.current);
    const input = String(values.get("totpInput") ?? "").trim();
    if (!input) throw new UserFacingError("请输入 TOTP 密钥或 otpauth URI");
    if (input.toLowerCase().startsWith("otpauth://")) {
      return client.parseTotpUri(input);
    }
    return totpConfigurationSchema.parse({
      type: "totp",
      issuer: String(values.get("issuer") ?? "").trim(),
      label:
        String(values.get("label") ?? "").trim() ||
        decrypted.loginEmail ||
        account.displayName,
      secretBase32: input
        .replace(/[\s-]/g, "")
        .replace(/=+$/g, "")
        .toUpperCase(),
      algorithm: values.get("algorithm"),
      digits: Number(values.get("digits")),
      period: Number(values.get("period")),
    });
  }

  async function previewCode() {
    setError(null);
    try {
      setPreview(await client.previewTotp(await parseForm()));
    } catch (caught) {
      setPreview(null);
      setError(userErrorMessage(caught, "TOTP 参数无效"));
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save");
    setError(null);
    try {
      await persistPayload(
        managedAccountPrivatePayloadSchema.parse({
          ...decrypted,
          totp: await parseForm(),
        }),
      );
      await onChanged();
    } catch (caught) {
      setError(userErrorMessage(caught, "TOTP 更新失败"));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setError(null);
    try {
      await persistPayload(removeTotpFromPrivatePayload(decrypted));
      await onChanged();
    } catch (caught) {
      setError(userErrorMessage(caught, "TOTP 移除失败"));
    } finally {
      setBusy(null);
    }
  }

  async function persistPayload(payload: ManagedAccountPrivatePayload) {
    const privatePayload = await client.encryptRecord({
      ownerUserId,
      recordType: "managed-account-private-v1",
      recordId: account.id,
      value: payload,
    });
    const email = payload.loginEmail?.toLowerCase();
    const domain = email?.split("@")[1];
    const [emailBlindIndex, emailDomainBlindIndex] = await Promise.all([
      email
        ? client.blindIndex(email, "managed-account-login-email-v1")
        : Promise.resolve(null),
      domain
        ? client.blindIndex(domain, "managed-account-email-domain-v1")
        : Promise.resolve(null),
    ]);
    await api(`/api/v1/accounts/${encodeURIComponent(account.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedRevision: account.revision,
        platform: account.platform,
        displayName: account.displayName,
        privatePayload,
        emailBlindIndex,
        emailDomainBlindIndex,
        hasTotp: Boolean(payload.totp),
        localStatus: account.localStatus,
      }),
    });
  }

  return (
    <section aria-labelledby="totp-details-title" className="mt-6 border-t border-[var(--border)] pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="totp-details-title" className="font-semibold">验证器（TOTP）</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">{decrypted.totp ? "已配置" : "未配置"}</p>
        </div>
        {decrypted.totp ? <button type="button" disabled={Boolean(busy)} onClick={() => void remove()} className={`${secondaryButton} text-[var(--danger)]`}>{busy === "remove" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Trash2 aria-hidden="true" size={16} />}移除 TOTP</button> : null}
      </div>

      {decrypted.totp ? (
        <dl className="mt-4 grid gap-x-5 gap-y-3 border-y border-[var(--border)] py-4 sm:grid-cols-2 lg:grid-cols-5">
          <ConfigValue label="服务名称" value={decrypted.totp.issuer} />
          <ConfigValue label="账号标签" value={decrypted.totp.label} />
          <ConfigValue label="哈希算法" value={decrypted.totp.algorithm} />
          <ConfigValue label="验证码位数" value={`${decrypted.totp.digits} 位`} />
          <ConfigValue label="刷新周期" value={`${decrypted.totp.period} 秒`} />
        </dl>
      ) : null}

      {error ? <p role="alert" className="mt-4 flex items-start gap-2 border-l-4 border-[var(--danger)] bg-red-50 px-4 py-3 text-sm text-[var(--danger)]"><CircleAlert className="mt-0.5 shrink-0" aria-hidden="true" size={16} />{error}</p> : null}

      <details className="mt-5" open={configurationOpen} onToggle={(event) => setConfigurationOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-semibold">{decrypted.totp ? "更换 TOTP 配置" : "添加 TOTP 配置"}</summary>
        <form ref={formRef} onSubmit={save} className="mt-5 space-y-5">
          <Field label="TOTP 密钥或 otpauth URI"><textarea name="totpInput" rows={3} autoComplete="off" className={inputClass} /></Field>
          <QrCredentialInput onValue={setCredential} />

          <details>
            <summary className="cursor-pointer text-sm font-semibold">参数设置</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="服务名称（Issuer）"><input name="issuer" defaultValue={decrypted.totp?.issuer ?? platformIssuer(account.platform)} maxLength={120} className={inputClass} /></Field>
              <Field label="账号标签（Label）"><input name="label" defaultValue={decrypted.totp?.label ?? decrypted.loginEmail} maxLength={240} className={inputClass} /></Field>
              <Field label="哈希算法"><select name="algorithm" defaultValue={decrypted.totp?.algorithm ?? "SHA1"} className={inputClass}><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></Field>
              <Field label="验证码位数"><select name="digits" defaultValue={String(decrypted.totp?.digits ?? 6)} className={inputClass}><option value="6">6 位</option><option value="7">7 位</option><option value="8">8 位</option></select></Field>
              <Field label="刷新周期（秒）"><input name="period" type="number" min={15} max={120} defaultValue={decrypted.totp?.period ?? 30} className={inputClass} /></Field>
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-4">
            <button type="button" onClick={() => void previewCode()} className={secondaryButton}><KeyRound aria-hidden="true" size={16} />生成测试验证码</button>
            {preview ? <output aria-live="polite" className="inline-flex items-center gap-2"><span className="text-xs font-semibold text-[var(--muted)]">测试验证码</span><code className="font-semibold tabular-nums text-[var(--accent)]">{groupCode(preview.code)}</code></output> : null}
            <button type="submit" disabled={Boolean(busy)} className={primaryButton}>{busy === "save" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Save aria-hidden="true" size={16} />}保存 TOTP 配置</button>
          </div>
        </form>
      </details>
    </section>
  );
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
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

function ConfigValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-[var(--muted)]">{label}</dt>
      <dd className="mt-1 break-words text-sm">{value}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-0 space-y-2"><span className="text-xs font-semibold text-[var(--muted)]">{label}</span>{children}</label>;
}

function platformIssuer(platform: ManagedAccount["platform"]): string {
  if (platform === "openai") return "OpenAI";
  if (platform === "opencode_go") return "OpenCode Go";
  if (platform === "antigravity") return "Antigravity";
  if (platform === "clinepass") return "ClinePass";
  return "OpenRouter";
}

function groupCode(code: string): string {
  const split = Math.ceil(code.length / 2);
  return `${code.slice(0, split)} ${code.slice(split)}`;
}

const inputClass = "min-h-10 w-full min-w-0 rounded-[6px] border border-[var(--border)] bg-white px-3 py-2 text-sm";
const primaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--accent)] px-4 font-semibold text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-4 font-semibold hover:bg-[var(--surface-subtle)] disabled:cursor-not-allowed disabled:opacity-50";

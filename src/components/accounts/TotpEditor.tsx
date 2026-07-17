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
  totpConfigurationSchema,
  type ManagedAccount,
  type ManagedAccountPrivatePayload,
  type TotpConfiguration,
  type TotpResult,
} from "@/accounts/schema";
import type { VaultCryptoClient } from "@/crypto";
import { QrCredentialInput } from "./QrCredentialInput";

type ApiFailure = { message?: string };

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

  function setCredential(value: string) {
    const field = formRef.current?.elements.namedItem("totpInput");
    if (field instanceof HTMLTextAreaElement) field.value = value;
    setPreview(null);
    setError(null);
  }

  async function parseForm(): Promise<TotpConfiguration> {
    if (!formRef.current) throw new Error("TOTP 表单不可用");
    const values = new FormData(formRef.current);
    const input = String(values.get("totpInput") ?? "").trim();
    if (!input) throw new Error("请输入新的 otpauth URI 或 Base32 Secret");
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
      setError(caught instanceof Error ? caught.message : "TOTP 参数无效");
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
      setError(caught instanceof Error ? caught.message : "TOTP 更新失败");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setError(null);
    try {
      await persistPayload(
        managedAccountPrivatePayloadSchema.parse({
          version: 1,
          loginEmail: decrypted.loginEmail,
          phone: decrypted.phone,
          smsEndpoint: decrypted.smsEndpoint,
          notes: decrypted.notes,
        }),
      );
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "TOTP 移除失败");
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
          <h3 id="totp-details-title" className="font-semibold">双重验证</h3>
          {decrypted.totp ? <p className="mt-1 text-sm text-[var(--muted)]">{decrypted.totp.issuer} · {decrypted.totp.algorithm} · {decrypted.totp.digits} 位 · {decrypted.totp.period} 秒</p> : <p className="mt-1 text-sm text-[var(--muted)]">未配置 TOTP</p>}
        </div>
        {decrypted.totp ? <button type="button" disabled={Boolean(busy)} onClick={() => void remove()} className={`${secondaryButton} text-[var(--danger)]`}>{busy === "remove" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Trash2 aria-hidden="true" size={16} />}移除 TOTP</button> : null}
      </div>

      {error ? <p role="alert" className="mt-4 flex items-start gap-2 border-l-4 border-[var(--danger)] bg-red-50 px-4 py-3 text-sm text-[var(--danger)]"><CircleAlert className="mt-0.5 shrink-0" aria-hidden="true" size={16} />{error}</p> : null}

      <form ref={formRef} onSubmit={save} className="mt-4 space-y-4">
        <label className="block space-y-2"><span className="text-xs font-semibold text-[var(--muted)]">新的 otpauth URI 或 Base32 Secret</span><textarea name="totpInput" rows={3} autoComplete="off" className={inputClass} /></label>
        <QrCredentialInput onValue={setCredential} />
        <details>
          <summary className="cursor-pointer text-sm font-semibold">高级 TOTP 参数</summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Issuer"><input name="issuer" defaultValue={decrypted.totp?.issuer ?? platformIssuer(account.platform)} maxLength={120} className={inputClass} /></Field>
            <Field label="Label"><input name="label" defaultValue={decrypted.totp?.label ?? decrypted.loginEmail} maxLength={240} className={inputClass} /></Field>
            <Field label="Algorithm"><select name="algorithm" defaultValue={decrypted.totp?.algorithm ?? "SHA1"} className={inputClass}><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></Field>
            <Field label="Digits / Period"><div className="grid grid-cols-2 gap-2"><select name="digits" defaultValue={String(decrypted.totp?.digits ?? 6)} className={inputClass}><option>6</option><option>7</option><option>8</option></select><input name="period" type="number" min={15} max={120} defaultValue={decrypted.totp?.period ?? 30} className={inputClass} /></div></Field>
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void previewCode()} className={secondaryButton}><KeyRound aria-hidden="true" size={16} />本地验证</button>
          {preview ? <code className="font-semibold tabular-nums text-[var(--accent)]">{groupCode(preview.code)}</code> : null}
          <button type="submit" disabled={Boolean(busy)} className={primaryButton}>{busy === "save" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Save aria-hidden="true" size={16} />}保存 TOTP</button>
        </div>
      </form>
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
  if (!response.ok) throw new Error(body.message || "请求失败");
  return body;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-2"><span className="text-xs font-semibold text-[var(--muted)]">{label}</span>{children}</label>;
}

function platformIssuer(platform: ManagedAccount["platform"]): string {
  if (platform === "openai") return "OpenAI";
  if (platform === "opencode_go") return "OpenCode Go";
  return "Antigravity";
}

function groupCode(code: string): string {
  const split = Math.ceil(code.length / 2);
  return `${code.slice(0, split)} ${code.slice(split)}`;
}

const inputClass = "min-h-10 w-full rounded-[6px] border border-[var(--border)] bg-white px-3 py-2 text-sm";
const primaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--accent)] px-4 font-semibold text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-4 font-semibold hover:bg-[var(--surface-subtle)] disabled:cursor-not-allowed disabled:opacity-50";

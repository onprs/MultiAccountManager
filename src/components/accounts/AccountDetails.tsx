"use client";

import {
  Archive,
  CircleAlert,
  LoaderCircle,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { FormEvent, useState } from "react";
import {
  managedAccountPrivatePayloadSchema,
  phoneBindingHistoryForUpdate,
  type AccountLocalStatus,
  type AccountPlatform,
  type ManagedAccount,
  type ManagedAccountPrivatePayload,
} from "@/accounts/schema";
import type { VaultCryptoClient } from "@/crypto";
import {
  apiErrorMessage,
  UserFacingError,
  userErrorMessage,
} from "@/lib/api-errors";
import { AccountIntegrationStatus } from "@/components/integrations/AccountIntegrationStatus";
import { RecoveryCodeManager } from "./RecoveryCodeManager";
import { SecretInput } from "./SecretInput";
import { TotpEditor } from "./TotpEditor";

type ApiFailure = { code?: string; message?: string };
const platformLabels = {
  openai: "OpenAI",
  opencode_go: "OpenCode Go",
  antigravity: "Antigravity",
  clinepass: "ClinePass",
  openrouter: "OpenRouter",
} as const;

export function AccountDetails({
  ownerUserId,
  account,
  decrypted,
  client,
  onClose,
  onChanged,
}: {
  ownerUserId: string;
  account: ManagedAccount;
  decrypted: ManagedAccountPrivatePayload;
  client: VaultCryptoClient;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy("save");
    setError(null);
    try {
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
      const phone = optional("phone");
      const payload = managedAccountPrivatePayloadSchema.parse({
        version: 1,
        loginEmail,
        password: optionalSecret("password"),
        phone,
        phoneBindingHistory: phoneBindingHistoryForUpdate(decrypted, phone),
        emailOtpEndpoint: optional("emailOtpEndpoint"),
        emailOtpCdk: optionalSecret("emailOtpCdk"),
        smsEndpoint: optional("smsEndpoint"),
        smsEndpointCdk: optionalSecret("smsEndpointCdk"),
        notes: optional("notes"),
        totp: decrypted.totp,
      });
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
          platform: values.get("platform") as AccountPlatform,
          displayName: account.displayName,
          privatePayload,
          emailBlindIndex,
          emailDomainBlindIndex,
          hasTotp: Boolean(payload.totp),
          localStatus: values.get("localStatus") as AccountLocalStatus,
        }),
      });
      await onChanged();
    } catch (caught) {
      setError(userErrorMessage(caught, "账号更新失败"));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    setError(null);
    try {
      await api(`/api/v1/accounts/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ expectedRevision: account.revision }),
      });
      await onChanged();
    } catch (caught) {
      setError(userErrorMessage(caught, "账号删除失败"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid overflow-y-auto bg-black/45 p-4 sm:place-items-center" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="account-details-title" className="my-auto w-full max-w-4xl border border-[var(--border)] bg-white shadow-xl">
        <div className="flex min-h-14 items-center justify-between gap-4 border-b border-[var(--border)] px-5 py-3">
          <div className="min-w-0">
            <h2 id="account-details-title" className="truncate text-lg font-semibold">{decrypted.loginEmail ?? "账号详情"}</h2>
            <p className="text-xs text-[var(--muted)]">{platformLabels[account.platform]}</p>
          </div>
          <button type="button" title="关闭" aria-label="关闭" onClick={onClose} className="grid size-9 shrink-0 place-items-center rounded-[6px] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"><X aria-hidden="true" size={16} /></button>
        </div>
        <div className="max-h-[calc(100vh-7rem)] overflow-y-auto p-5">
          {error ? <p role="alert" className="mb-4 flex items-start gap-2 border-l-4 border-[var(--danger)] bg-red-50 px-4 py-3 text-sm text-[var(--danger)]"><CircleAlert className="mt-0.5 shrink-0" aria-hidden="true" size={16} />{error}</p> : null}

          <form onSubmit={save} className="space-y-7">
            <FormSection title="账号信息" first>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="登录邮箱"><input name="loginEmail" type="email" required maxLength={320} defaultValue={decrypted.loginEmail} className={inputClass} /></Field>
                <Field label="平台"><select name="platform" defaultValue={account.platform} className={inputClass}><option value="openai">OpenAI</option><option value="opencode_go">OpenCode Go</option><option value="antigravity">Antigravity</option><option value="clinepass">ClinePass</option><option value="openrouter">OpenRouter</option></select></Field>
                <Field label="本地状态"><select name="localStatus" defaultValue={account.localStatus} className={inputClass}><option value="active">使用中</option><option value="archived">已归档</option></select></Field>
              </div>
            </FormSection>

            <FormSection title="凭据与联系">
              <div className="grid gap-4 sm:grid-cols-2">
                <SecretInput label="登录密码（可选）" name="password" defaultValue={decrypted.password} autoComplete="new-password" />
                <Field label="绑定手机号"><input name="phone" maxLength={80} defaultValue={decrypted.phone} className={inputClass} /></Field>
              </div>
            </FormSection>

            <FormSection title="接码服务">
              <div className="divide-y divide-[var(--border)]">
                <div className="grid gap-4 pb-5 sm:grid-cols-2 lg:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] lg:items-end">
                  <p className="text-sm font-semibold lg:pb-3">邮箱接码</p>
                  <Field label="邮箱接码地址（可选）"><input name="emailOtpEndpoint" type="url" maxLength={2000} defaultValue={decrypted.emailOtpEndpoint} className={inputClass} /></Field>
                  <SecretInput label="邮箱接码 CDK（可选）" name="emailOtpCdk" defaultValue={decrypted.emailOtpCdk} />
                </div>
                <div className="grid gap-4 pt-5 sm:grid-cols-2 lg:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] lg:items-end">
                  <p className="text-sm font-semibold lg:pb-3">手机号接码</p>
                  <Field label="手机号接码地址（可选）"><input name="smsEndpoint" type="url" maxLength={2000} defaultValue={decrypted.smsEndpoint} className={inputClass} /></Field>
                  <SecretInput label="手机号接码 CDK（可选）" name="smsEndpointCdk" defaultValue={decrypted.smsEndpointCdk} />
                </div>
              </div>
            </FormSection>

            <FormSection title="备注">
              <Field label="敏感备注"><textarea name="notes" rows={4} maxLength={20000} defaultValue={decrypted.notes} className={inputClass} /></Field>
            </FormSection>

            <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-5">
              <button type="submit" disabled={Boolean(busy)} className={primaryButton}>{busy === "save" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Save aria-hidden="true" size={16} />}保存更改</button>
              <span className="inline-flex items-center gap-2 text-sm text-[var(--muted)]"><Archive aria-hidden="true" size={15} />归档不会删除密文</span>
            </div>
          </form>

          <TotpEditor
            ownerUserId={ownerUserId}
            account={account}
            decrypted={decrypted}
            client={client}
            onChanged={onChanged}
          />

          <RecoveryCodeManager ownerUserId={ownerUserId} accountId={account.id} client={client} />

          <AccountIntegrationStatus managedAccountId={account.id} />

          <section aria-labelledby="delete-account-title" className="mt-6 border-t border-[var(--border)] pt-6">
            <h3 id="delete-account-title" className="font-semibold text-[var(--danger)]">删除账号</h3>
            {confirmDelete ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <p className="text-sm text-[var(--danger)]">账号、恢复码及已关联的 Sub2API 账号将一并删除。</p>
                <button type="button" disabled={Boolean(busy)} onClick={() => void remove()} className={dangerButton}>{busy === "delete" ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <Trash2 aria-hidden="true" size={16} />}确认删除</button>
                <button type="button" disabled={Boolean(busy)} onClick={() => setConfirmDelete(false)} className={secondaryButton}>取消</button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className={`${secondaryButton} mt-3 text-[var(--danger)]`}><Trash2 aria-hidden="true" size={16} />删除账号</button>
            )}
          </section>
        </div>
      </div>
    </div>
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

const inputClass = "min-h-10 w-full min-w-0 rounded-[6px] border border-[var(--border)] bg-white px-3 py-2 text-sm";
const primaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--accent)] px-4 font-semibold text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-4 font-semibold hover:bg-[var(--surface-subtle)] disabled:cursor-not-allowed disabled:opacity-50";
const dangerButton = "inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--danger)] px-4 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50";

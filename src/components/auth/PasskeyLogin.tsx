"use client";

import { Fingerprint, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";

export function PasskeyLogin() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [emailHint, setEmailHint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const conditionalStarted = useRef(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.passkey();
      if (result.error) throw new Error("通行密钥验证失败，请重试");
      router.replace("/accounts");
    } catch {
      setError("通行密钥验证失败，请重试");
      setBusy(false);
    }
  }

  async function startConditionalSignIn() {
    if (conditionalStarted.current || !window.PublicKeyCredential) return;
    const available = await window.PublicKeyCredential.isConditionalMediationAvailable?.();
    if (!available) return;
    conditionalStarted.current = true;
    const result = await authClient.signIn.passkey({ autoFill: true });
    if (result.data) {
      router.replace("/accounts");
    } else if (
      result.error &&
      (!("code" in result.error) || result.error.code !== "AUTH_CANCELLED")
    ) {
      setError("通行密钥验证失败，请重试");
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <section className="w-full max-w-sm border-t-4 border-[var(--foreground)] bg-[var(--surface)] px-6 py-7 shadow-sm">
        <div className="mb-8 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-[6px] bg-[var(--foreground)] text-white">
            <Fingerprint aria-hidden="true" size={21} />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Account Vault</h1>
            <p className="text-sm text-[var(--muted)]">通行密钥登录</p>
          </div>
        </div>
        {error ? (
          <p className="mb-4 border-l-4 border-[var(--danger)] bg-red-50 px-3 py-2 text-sm text-[var(--danger)]" role="alert">
            {error}
          </p>
        ) : null}
        <label className="mb-4 block space-y-2">
          <span className="text-xs font-semibold text-[var(--muted)]">账户</span>
          <input
            type="email"
            autoComplete="username webauthn"
            value={emailHint}
            onChange={(event) => setEmailHint(event.target.value)}
            onFocus={startConditionalSignIn}
            className="h-10 w-full rounded-[6px] border border-[var(--border)] bg-white px-3"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={signIn}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[6px] bg-[var(--accent)] px-4 font-semibold text-white hover:bg-[var(--accent-hover)] disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? <LoaderCircle className="animate-spin" aria-hidden="true" size={17} /> : <Fingerprint aria-hidden="true" size={17} />}
          使用通行密钥登录
        </button>
      </section>
    </main>
  );
}

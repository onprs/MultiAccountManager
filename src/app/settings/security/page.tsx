import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import { getAuth } from "@/server/auth";
import { PasskeySecurity } from "@/components/security/PasskeySecurity";
import { SignOutButton } from "@/components/auth/SignOutButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "通行密钥安全" };

export default async function SecuritySettingsPage() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  if (session.user.role !== "owner") redirect("/accounts");

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b border-[var(--border)] bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-[6px] bg-[var(--foreground)] text-white"><LockKeyhole aria-hidden="true" size={18} /></span>
            <div><p className="font-semibold">Account Vault</p><p className="text-xs text-[var(--muted)]">安全设置</p></div>
          </div>
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-8 lg:px-8">
        <Link href="/accounts" className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-[var(--muted)] hover:text-[var(--foreground)]"><ArrowLeft aria-hidden="true" size={16} />返回账号</Link>
        <div className="mb-8"><h1 className="text-2xl font-semibold">登录安全</h1><p className="mt-1 text-sm text-[var(--muted)]">管理管理员账户的通行密钥</p></div>
        <PasskeySecurity />
      </main>
    </div>
  );
}

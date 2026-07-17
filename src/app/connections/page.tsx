import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { KeyRound, LockKeyhole, UsersRound } from "lucide-react";
import { ConnectionManager } from "@/components/integrations/ConnectionManager";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { getAuth } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sub2API 连接" };

export default async function ConnectionsPage() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.role !== "owner") redirect("/login");

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b border-[var(--border)] bg-white">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-5 py-3 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-[6px] bg-[var(--foreground)] text-white">
              <LockKeyhole aria-hidden="true" size={18} />
            </span>
            <div><p className="font-semibold">Account Vault</p><p className="text-xs text-[var(--muted)]">连接与同步</p></div>
          </div>
          <nav className="flex items-center gap-2" aria-label="主导航">
            <Link href="/accounts" title="账号" className={iconLink}><UsersRound aria-hidden="true" size={16} /><span className="sr-only">账号</span></Link>
            <Link href="/settings/security" title="登录安全" className={iconLink}><KeyRound aria-hidden="true" size={16} /><span className="sr-only">登录安全</span></Link>
            <SignOutButton />
          </nav>
        </div>
      </header>
      <ConnectionManager />
    </div>
  );
}

const iconLink = "grid size-9 place-items-center rounded-[6px] border border-[var(--border)] bg-white text-[var(--muted)] hover:text-[var(--foreground)]";

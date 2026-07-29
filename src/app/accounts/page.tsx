import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CloudCog, KeyRound, LockKeyhole } from "lucide-react";
import { getAuth } from "@/server/auth";
import { getVault } from "@/server/vault/service";
import { SignOutButton } from "@/components/auth/SignOutButton";
import type { AccountManagerInitialQuery } from "@/components/accounts/AccountManager";
import { VaultWorkspace } from "@/components/vault/VaultWorkspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "账号" };

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  if (session.user.role !== "owner") redirect("/login");
  const vault = await getVault(session.user.id);
  const initialQuery = parseInitialQuery(await searchParams);

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b border-[var(--border)] bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-[6px] bg-[var(--foreground)] text-white">
              <LockKeyhole aria-hidden="true" size={18} />
            </span>
            <div>
              <p className="font-semibold">Account Vault</p>
              <p className="text-xs text-[var(--muted)]">账号管理</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="mr-1 hidden text-sm text-[var(--muted)] sm:inline">{session.user.name}</span>
            <Link href="/connections" title="Sub2API 连接" className="grid size-9 place-items-center rounded-[6px] border border-[var(--border)] bg-white text-[var(--muted)] hover:text-[var(--foreground)]">
              <CloudCog aria-hidden="true" size={16} />
              <span className="sr-only">Sub2API 连接</span>
            </Link>
            <Link href="/settings/security" title="登录安全" className="grid size-9 place-items-center rounded-[6px] border border-[var(--border)] bg-white text-[var(--muted)] hover:text-[var(--foreground)]">
              <KeyRound aria-hidden="true" size={16} />
              <span className="sr-only">登录安全</span>
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>
      <VaultWorkspace
        ownerUserId={session.user.id}
        initialVault={vault}
        initialQuery={initialQuery}
      />
    </div>
  );
}

function parseInitialQuery(
  params: Record<string, string | string[] | undefined>,
): AccountManagerInitialQuery {
  const scalar = (name: string) => {
    const value = params[name];
    return typeof value === "string" ? value : "";
  };
  const parsedPage = Number.parseInt(scalar("page"), 10);
  const rawSearch = scalar("search").normalize("NFKC").trim().slice(0, 120);
  const rawPlatform = scalar("platform");
  const rawStatus = scalar("localStatus");
  const rawTotp = scalar("hasTotp");
  return {
    page: Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    search: rawSearch.includes("@") ? "" : rawSearch,
    platform: ["openai", "opencode_go", "antigravity", "clinepass"].includes(rawPlatform)
      ? (rawPlatform as AccountManagerInitialQuery["platform"])
      : "",
    localStatus: rawStatus === "archived" ? "archived" : "active",
    hasTotp: rawTotp === "true" || rawTotp === "false" ? rawTotp : "",
  };
}

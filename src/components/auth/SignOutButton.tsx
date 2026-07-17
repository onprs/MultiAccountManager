"use client";

import { LogOut } from "lucide-react";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  return (
    <button
      type="button"
      title="退出登录"
      onClick={async () => {
        window.dispatchEvent(new Event("account-vault:lock"));
        await authClient.signOut();
        window.location.assign("/login");
      }}
      className="grid size-9 place-items-center rounded-[6px] border border-[var(--border)] bg-white text-[var(--muted)] hover:text-[var(--foreground)]"
    >
      <LogOut aria-hidden="true" size={16} />
      <span className="sr-only">退出登录</span>
    </button>
  );
}

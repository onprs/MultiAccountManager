import type { ObserverAccount } from "@/integrations/schema";

export type AccountHealthObservation = Pick<
  ObserverAccount,
  "status" | "availability" | "available" | "error_code"
>;

export function normalizeHealthCode(account: AccountHealthObservation): string {
  if (account.status === "disabled" || account.status === "inactive") return "disabled";
  if (account.error_code === "banned") return "banned";
  if (account.error_code === "verification_required") return "verification_required";
  if (account.error_code === "unauthenticated") return "reauth_required";
  if (account.status === "error" || account.error_code === "upstream_account_error") return "error";
  switch (account.availability) {
    case "temporarily_unavailable": return "temporarily_unavailable";
    case "rate_limited": return "rate_limited";
    case "overloaded": return "overloaded";
    case "paused": return "paused";
    case "available": return account.available ? "healthy" : "unknown";
    default: return account.available ? "healthy" : "unknown";
  }
}

import type { AccountLocalStatus, AccountPlatform } from "@/accounts/schema";

export type AutoLinkLocalCandidate = {
  id: string;
  platform: AccountPlatform;
  localStatus: AccountLocalStatus;
  emailBlindIndex: string | null;
};

export type AutoLinkRemoteCandidate = {
  externalAccountId: string;
  externalPlatform: string;
  emailBlindIndex: string | null;
};

export type AutoLinkPair = {
  managedAccountId: string;
  externalAccountId: string;
};

export function normalizeRemoteAccountEmail(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!normalized || /\s/.test(normalized)) return null;
  const at = normalized.indexOf("@");
  if (at <= 0 || at !== normalized.lastIndexOf("@") || at === normalized.length - 1) {
    return null;
  }
  return normalized;
}

const automaticLinkPlatforms = [
  "openai",
  "opencode_go",
  "antigravity",
  "clinepass",
  "openrouter",
] as const satisfies readonly AccountPlatform[];

export function supportsAutomaticAccountLink(platform: AccountPlatform): boolean {
  return automaticLinkPlatforms.some((candidate) => candidate === platform);
}

export function selectUniqueEmailLinks(input: {
  local: AutoLinkLocalCandidate[];
  remote: AutoLinkRemoteCandidate[];
  linkedManagedAccountIds: Set<string>;
  linkedExternalAccountIds: Set<string>;
}): AutoLinkPair[] {
  const pairs: AutoLinkPair[] = [];

  for (const platform of automaticLinkPlatforms) {
    const localByIndex = groupByBlindIndex(
      input.local.filter(
        (account) =>
          account.platform === platform &&
          account.localStatus === "active" &&
          account.emailBlindIndex &&
          !input.linkedManagedAccountIds.has(account.id),
      ),
    );
    const remoteByIndex = groupByBlindIndex(
      input.remote.filter(
        (account) =>
          account.externalPlatform === platform &&
          account.emailBlindIndex &&
          !input.linkedExternalAccountIds.has(account.externalAccountId),
      ),
    );

    for (const [index, localAccounts] of localByIndex) {
      const remoteAccounts = remoteByIndex.get(index);
      if (localAccounts.length !== 1 || remoteAccounts?.length !== 1) continue;
      pairs.push({
        managedAccountId: localAccounts[0].id,
        externalAccountId: remoteAccounts[0].externalAccountId,
      });
    }
  }

  return pairs;
}

function groupByBlindIndex<T extends { emailBlindIndex: string | null }>(
  values: T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    if (!value.emailBlindIndex) continue;
    const items = grouped.get(value.emailBlindIndex) ?? [];
    items.push(value);
    grouped.set(value.emailBlindIndex, items);
  }
  return grouped;
}

import { describe, expect, it } from "vitest";
import type { AccountPlatform } from "@/accounts/schema";
import {
  normalizeRemoteAccountEmail,
  selectUniqueEmailLinks,
  supportsAutomaticAccountLink,
} from "@/integrations/auto-link";

function local(
  id: string,
  emailBlindIndex: string | null,
  platform: AccountPlatform = "openai",
) {
  return {
    id,
    platform,
    localStatus: "active" as const,
    emailBlindIndex,
  };
}

function remote(
  externalAccountId: string,
  emailBlindIndex: string | null,
  externalPlatform = "openai",
) {
  return {
    externalAccountId,
    externalPlatform,
    emailBlindIndex,
  };
}

const unlinked = {
  linkedManagedAccountIds: new Set<string>(),
  linkedExternalAccountIds: new Set<string>(),
};

describe("Sub2API automatic account linking", () => {
  it("normalizes only exact email-shaped remote names", () => {
    expect(normalizeRemoteAccountEmail("  OWNER@Example.Test ")).toBe("owner@example.test");
    expect(normalizeRemoteAccountEmail("OpenAI owner@example.test")).toBeNull();
    expect(normalizeRemoteAccountEmail("not-an-email")).toBeNull();
  });

  it("supports OpenAI, OpenCode Go, ClinePass and OpenRouter automatic linking", () => {
    expect(supportsAutomaticAccountLink("openai")).toBe(true);
    expect(supportsAutomaticAccountLink("opencode_go")).toBe(true);
    expect(supportsAutomaticAccountLink("clinepass")).toBe(true);
    expect(supportsAutomaticAccountLink("openrouter")).toBe(true);
    expect(supportsAutomaticAccountLink("antigravity")).toBe(false);
  });

  it("links unique OpenAI, OpenCode Go, ClinePass and OpenRouter email matches within each platform", () => {
    expect(selectUniqueEmailLinks({
      local: [
        local("local-openai", "shared-index"),
        local("local-opencode-go", "shared-index", "opencode_go"),
        local("local-clinepass", "shared-index", "clinepass"),
        local("local-openrouter", "shared-index", "openrouter"),
      ],
      remote: [
        remote("remote-openai", "shared-index"),
        remote("remote-opencode-go", "shared-index", "opencode_go"),
        remote("remote-clinepass", "shared-index", "clinepass"),
        remote("remote-openrouter", "shared-index", "openrouter"),
      ],
      ...unlinked,
    })).toEqual([
      { managedAccountId: "local-openai", externalAccountId: "remote-openai" },
      { managedAccountId: "local-opencode-go", externalAccountId: "remote-opencode-go" },
      { managedAccountId: "local-clinepass", externalAccountId: "remote-clinepass" },
      { managedAccountId: "local-openrouter", externalAccountId: "remote-openrouter" },
    ]);
  });

  it("skips linked accounts and cross-platform email matches", () => {
    expect(selectUniqueEmailLinks({
      local: [
        local("local-openai", "index-1"),
        local("local-clinepass", "index-2", "clinepass"),
      ],
      remote: [
        remote("remote-clinepass", "index-1", "clinepass"),
        remote("remote-openai", "index-2"),
      ],
      ...unlinked,
    })).toEqual([]);

    expect(selectUniqueEmailLinks({
      local: [local("local-1", "index-1"), local("local-2", "index-2")],
      remote: [remote("remote-1", "index-1"), remote("remote-2", "index-2")],
      linkedManagedAccountIds: new Set(["local-2"]),
      linkedExternalAccountIds: new Set<string>(),
    })).toEqual([{ managedAccountId: "local-1", externalAccountId: "remote-1" }]);
  });

  it("skips ambiguous local or remote matches within a platform", () => {
    expect(selectUniqueEmailLinks({
      local: [
        local("local-1", "same", "clinepass"),
        local("local-2", "same", "clinepass"),
      ],
      remote: [remote("remote-1", "same", "clinepass")],
      ...unlinked,
    })).toEqual([]);
    expect(selectUniqueEmailLinks({
      local: [local("local-1", "same", "clinepass")],
      remote: [
        remote("remote-1", "same", "clinepass"),
        remote("remote-2", "same", "clinepass"),
      ],
      ...unlinked,
    })).toEqual([]);
  });
});

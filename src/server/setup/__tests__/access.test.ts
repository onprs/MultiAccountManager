import { NextRequest, NextResponse } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasSetupSession,
  issueSetupSession,
  revokeSetupSessions,
} from "../access";

function requestWithCookie(value: string): NextRequest {
  return new NextRequest("https://vault.example.com/api/setup/owner", {
    headers: {
      cookie: `av_setup=${value}`,
      origin: "https://vault.example.com",
      host: "vault.example.com",
    },
  });
}

afterEach(() => {
  revokeSetupSessions();
});

describe("setup sessions", () => {
  it("keeps exactly one active short-lived setup session", () => {
    const firstResponse = NextResponse.json({ ok: true });
    issueSetupSession(firstResponse);
    const first = firstResponse.cookies.get("av_setup")?.value;
    expect(first).toBeTruthy();
    expect(hasSetupSession(requestWithCookie(first!))).toBe(true);

    const secondResponse = NextResponse.json({ ok: true });
    issueSetupSession(secondResponse);
    const second = secondResponse.cookies.get("av_setup")?.value;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(hasSetupSession(requestWithCookie(first!))).toBe(false);
    expect(hasSetupSession(requestWithCookie(second!))).toBe(true);
  });

  it("revokes server state and expires the browser cookie", () => {
    const issued = NextResponse.json({ ok: true });
    issueSetupSession(issued);
    const token = issued.cookies.get("av_setup")!.value;

    const revoked = NextResponse.json({ ok: true });
    revokeSetupSessions(revoked);

    expect(hasSetupSession(requestWithCookie(token))).toBe(false);
    expect(revoked.cookies.get("av_setup")?.value).toBe("");
  });
});

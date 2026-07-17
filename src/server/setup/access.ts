import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { NextRequest, NextResponse } from "next/server";
import { setupTokenPath } from "@/runtime/paths";

const SESSION_COOKIE = "av_setup";
const SESSION_TTL_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type AccessState = {
  sessions: Map<string, number>;
  attempts: Map<string, { count: number; resetAt: number }>;
};

const globalAccess = globalThis as typeof globalThis & {
  __accountVaultSetupAccess?: AccessState;
};
const state = (globalAccess.__accountVaultSetupAccess ??= {
  sessions: new Map(),
  attempts: new Map(),
});

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function clientKey(request: NextRequest): string {
  return request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

function prune(now = Date.now()): void {
  for (const [key, expiresAt] of state.sessions) {
    if (expiresAt <= now) state.sessions.delete(key);
  }
  for (const [key, attempt] of state.attempts) {
    if (attempt.resetAt <= now) state.attempts.delete(key);
  }
}

export function validateWriteOrigin(request: NextRequest): boolean {
  const originHeader = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!originHeader || !host) return false;
  try {
    const origin = new URL(originHeader);
    return origin.host === host;
  } catch {
    return false;
  }
}

export async function createSetupSession(
  request: NextRequest,
  suppliedToken: string,
): Promise<"ok" | "invalid" | "rate_limited"> {
  prune();
  const key = clientKey(request);
  const now = Date.now();
  const attempts = state.attempts.get(key);
  if (attempts && attempts.count >= MAX_ATTEMPTS && attempts.resetAt > now) {
    return "rate_limited";
  }

  let expected: string;
  try {
    expected = (
      await readFile(/* turbopackIgnore: true */ setupTokenPath(), "utf8")
    ).trim();
  } catch {
    return "invalid";
  }
  const valid = suppliedToken.length > 0 && timingSafeEqual(digest(suppliedToken), digest(expected));
  if (!valid) {
    state.attempts.set(key, {
      count: (attempts?.count ?? 0) + 1,
      resetAt: attempts?.resetAt ?? now + ATTEMPT_WINDOW_MS,
    });
    return "invalid";
  }

  state.attempts.delete(key);
  return "ok";
}

export function issueSetupSession(response: NextResponse): void {
  const token = randomBytes(32).toString("base64url");
  state.sessions.clear();
  state.sessions.set(digest(token).toString("hex"), Date.now() + SESSION_TTL_MS);
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/api/setup",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function hasSetupSession(request: NextRequest): boolean {
  prune();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const expiresAt = state.sessions.get(digest(token).toString("hex"));
  return Boolean(expiresAt && expiresAt > Date.now());
}

export function revokeSetupSessions(response?: NextResponse): void {
  state.sessions.clear();
  response?.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/api/setup",
    maxAge: 0,
  });
}

import { noStoreJson } from "@/lib/http";
import { getRuntimeStatus } from "@/runtime/status";
import { getAuth } from "@/server/auth";
import {
  recordFailedPasskeyLogin,
  recordSuccessfulPasskeyLogin,
} from "@/server/auth/audit";
import { getOwnerSession, type OwnerSession } from "@/server/auth/authorization";
import {
  consumePasskeyStepUp,
  hasRecentPasskeyStepUp,
  markPasskeyStepUp,
} from "@/server/auth/step-up";

const registrationPaths = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
]);

const authenticationPaths = new Set([
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
  "/get-session",
  "/sign-out",
]);

const readyPaths = new Set([...registrationPaths, ...authenticationPaths]);

function authError(status: number, code: string, message: string): Response {
  return noStoreJson({ code, message }, { status });
}

async function handle(request: Request): Promise<Response> {
  const runtime = await getRuntimeStatus();
  const path = new URL(request.url).pathname.slice("/api/auth".length);
  const allowed =
    runtime.state === "creating_owner"
      ? registrationPaths.has(path)
      : runtime.state === "creating_vault"
        ? authenticationPaths.has(path)
        : runtime.state === "ready" && readyPaths.has(path);
  if (!allowed) return authError(404, "NOT_FOUND", "Not found");

  try {
    const auth = await getAuth();
    let registrationSession: OwnerSession | null = null;
    let priorSession: OwnerSession | null = null;
    let authenticationRequest: Request | null = null;

    if (runtime.state === "ready" && registrationPaths.has(path)) {
      registrationSession = await getOwnerSession(request);
      if (!registrationSession) {
        return authError(401, "OWNER_SESSION_REQUIRED", "An owner session is required");
      }
      if (!(await hasRecentPasskeyStepUp(registrationSession))) {
        return authError(403, "PASSKEY_STEP_UP_REQUIRED", "Recent Passkey verification is required");
      }
    }

    if (path === "/passkey/verify-authentication") {
      priorSession = await getOwnerSession(request);
      authenticationRequest = request.clone();
    }

    let response = await auth.handler(request);

    if (path === "/passkey/generate-authenticate-options" && response.ok) {
      const options = await response.json();
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("content-type", "application/json");
      response = new Response(
        JSON.stringify({ ...options, userVerification: "required" }),
        { status: response.status, headers },
      );
    }

    if (path === "/passkey/verify-authentication") {
      const requestId = request.headers.get("x-request-id") ?? undefined;
      if (!response.ok) {
        await recordFailedPasskeyLogin(requestId).catch(() => undefined);
      } else {
        const [requestBody, responseBody] = await Promise.all([
          authenticationRequest?.json().catch(() => null),
          response.clone().json().catch(() => null),
        ]);
        const credentialId = requestBody?.response?.id;
        const authenticatedUserId = responseBody?.user?.id;
        const authenticatedSessionId = responseBody?.session?.id;
        if (typeof credentialId === "string") {
          await recordSuccessfulPasskeyLogin(credentialId, requestId);
        }
        if (
          priorSession &&
          authenticatedUserId === priorSession.userId &&
          typeof authenticatedSessionId === "string"
        ) {
          await markPasskeyStepUp({
            sessionId: authenticatedSessionId,
            userId: priorSession.userId,
          });
        }
      }
    }

    if (
      path === "/passkey/verify-registration" &&
      response.ok &&
      registrationSession
    ) {
      await consumePasskeyStepUp(registrationSession);
    }

    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Pragma", "no-cache");
    return response;
  } catch {
    return authError(503, "AUTH_UNAVAILABLE", "Authentication is unavailable");
  }
}

export const GET = handle;
export const POST = handle;

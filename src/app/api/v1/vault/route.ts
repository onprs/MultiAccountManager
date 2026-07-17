import { apiError, noStoreJson, requestId } from "@/lib/http";
import {
  initializeVaultRequestSchema,
  updatePasswordEnvelopeRequestSchema,
} from "@/crypto/schema";
import { getOwnerSession } from "@/server/auth/authorization";
import { validateApplicationOrigin } from "@/server/auth/request-security";
import {
  getVault,
  initializeVault,
  updatePasswordEnvelope,
  VaultServiceError,
} from "@/server/vault/service";

export async function GET(request: Request) {
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  try {
    return noStoreJson({ vault: await getVault(owner.userId) });
  } catch {
    return apiError(request, 503, "VAULT_UNAVAILABLE", "Vault metadata is unavailable");
  }
}

export async function POST(request: Request) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  const body = initializeVaultRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(request, 400, "INVALID_VAULT_ENVELOPE", "Vault envelope is invalid");
  try {
    const vault = await initializeVault({
      ownerUserId: owner.userId,
      vault: body.data.vault,
      requestId: requestId(request),
    });
    return noStoreJson({ vault }, { status: 201 });
  } catch (error) {
    if (error instanceof VaultServiceError) {
      const status = error.code === "VAULT_ALREADY_INITIALIZED" ? 409 : 400;
      return apiError(request, status, error.code, error.message);
    }
    return apiError(request, 503, "VAULT_INITIALIZATION_FAILED", "Vault initialization failed");
  }
}

export async function PUT(request: Request) {
  if (!(await validateApplicationOrigin(request))) {
    return apiError(request, 403, "ORIGIN_REJECTED", "The request origin is not allowed");
  }
  const owner = await getOwnerSession(request).catch(() => null);
  if (!owner) return apiError(request, 401, "OWNER_SESSION_REQUIRED", "An owner session is required");
  const body = updatePasswordEnvelopeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(request, 400, "INVALID_VAULT_ENVELOPE", "Vault envelope is invalid");
  try {
    const vault = await updatePasswordEnvelope({
      ownerUserId: owner.userId,
      sessionId: owner.sessionId,
      ...body.data,
      requestId: requestId(request),
    });
    return noStoreJson({ vault });
  } catch (error) {
    if (error instanceof VaultServiceError) {
      const status = error.code === "PASSKEY_STEP_UP_REQUIRED" ? 403 : 409;
      return apiError(request, status, error.code, error.message);
    }
    return apiError(request, 503, "VAULT_UPDATE_FAILED", "Vault update failed");
  }
}

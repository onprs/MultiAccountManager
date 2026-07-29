/// <reference lib="webworker" />

import {
  benchmarkArgon2id,
  VaultCryptoSession,
  VaultLockedError,
  VaultUnlockError,
} from "./core";
import type {
  VaultWorkerRequest,
  VaultWorkerResponse,
  VaultWorkerResult,
} from "./protocol";

const session = new VaultCryptoSession();
let queue = Promise.resolve();

async function handle(request: VaultWorkerRequest): Promise<VaultWorkerResult> {
  switch (request.type) {
    case "benchmark-kdf":
      return benchmarkArgon2id();
    case "initialize":
      return session.initialize(request);
    case "unlock-password":
      await session.unlockWithPassword(request.vault, request.password);
      return { unlocked: true };
    case "unlock-recovery":
      await session.unlockWithRecovery(request.vault, request.recoveryKey);
      return { unlocked: true };
    case "change-password":
      return session.changePassword(request);
    case "rotate-recovery":
      return session.rotateRecovery(request.vault);
    case "encrypt-record":
      return session.encryptRecord(request);
    case "decrypt-record":
      return session.decryptRecord(request);
    case "count-managed-account-phone-bindings":
      return session.countManagedAccountPhoneBindings(request);
    case "blind-index":
      return session.blindIndex(
        request.value,
        request.context,
        request.normalization,
      );
    case "parse-totp-uri":
      return session.parseTotpUri(request.uri);
    case "preview-totp":
      return session.generateTotp(request.configuration, request.timestamp);
    case "generate-record-totp":
      return session.generateRecordTotp(request);
    case "status":
      return { unlocked: session.isUnlocked() };
    case "lock":
      session.lock();
      return { locked: true };
  }
}

function errorResponse(id: string, error: unknown): VaultWorkerResponse {
  if (error instanceof VaultLockedError) {
    return { id, ok: false, error: { code: "VAULT_LOCKED", message: error.message } };
  }
  if (error instanceof VaultUnlockError) {
    return { id, ok: false, error: { code: "VAULT_UNLOCK_FAILED", message: error.message } };
  }
  return {
    id,
    ok: false,
    error: { code: "CRYPTO_OPERATION_FAILED", message: "Cryptographic operation failed" },
  };
}

self.onmessage = (event: MessageEvent<VaultWorkerRequest>) => {
  const request = event.data;
  if (!request || typeof request.id !== "string" || typeof request.type !== "string") return;
  queue = queue.then(async () => {
    try {
      const result = await handle(request);
      self.postMessage({ id: request.id, ok: true, result } satisfies VaultWorkerResponse);
    } catch (error) {
      self.postMessage(errorResponse(request.id, error));
    }
  });
};

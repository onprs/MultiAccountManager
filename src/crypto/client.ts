import type { TotpConfiguration, TotpResult } from "@/accounts/schema";
import type {
  KdfBenchmarkResult,
  VaultInitializationResult,
} from "./core";
import type {
  Argon2Params,
  EncryptedEnvelope,
  VaultCryptoDocument,
} from "./schema";
import type {
  VaultWorkerRequest,
  VaultWorkerRequestBody,
  VaultWorkerResponse,
  VaultWorkerResult,
} from "./protocol";

export class VaultClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultClientError";
    this.code = code;
  }
}

type Pending = {
  resolve: (value: VaultWorkerResult) => void;
  reject: (error: Error) => void;
};

export class VaultCryptoClient {
  private worker?: Worker;
  private readonly pending = new Map<string, Pending>();
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly idleMilliseconds = 10 * 60 * 1000,
    private readonly onLocked?: () => void,
  ) {}

  benchmarkKdf(): Promise<KdfBenchmarkResult> {
    return this.request({ type: "benchmark-kdf" }) as Promise<KdfBenchmarkResult>;
  }

  initialize(input: {
    ownerUserId: string;
    vaultId: string;
    password: string;
    kdfParams: Argon2Params;
  }): Promise<VaultInitializationResult> {
    return this.request({ type: "initialize", ...input }, true) as Promise<VaultInitializationResult>;
  }

  async unlockWithPassword(vault: VaultCryptoDocument, password: string): Promise<void> {
    await this.request({ type: "unlock-password", vault, password }, true);
  }

  async unlockWithRecovery(vault: VaultCryptoDocument, recoveryKey: string): Promise<void> {
    await this.request({ type: "unlock-recovery", vault, recoveryKey }, true);
  }

  changePassword(input: {
    vault: VaultCryptoDocument;
    newPassword: string;
    kdfParams: Argon2Params;
  }) {
    return this.request({ type: "change-password", ...input }, true) as Promise<
      Pick<VaultCryptoDocument, "kdfSalt" | "kdfParams" | "passwordEnvelope">
    >;
  }

  rotateRecovery(vault: VaultCryptoDocument) {
    return this.request({ type: "rotate-recovery", vault }, true) as Promise<{
      recoveryEnvelope: VaultCryptoDocument["recoveryEnvelope"];
      recoveryKeyChecksum: string;
      recoveryKey: string;
    }>;
  }

  encryptRecord(input: {
    ownerUserId: string;
    recordType: string;
    recordId: string;
    value: unknown;
  }): Promise<EncryptedEnvelope> {
    return this.request({ type: "encrypt-record", ...input }, true) as Promise<EncryptedEnvelope>;
  }

  decryptRecord<T>(input: {
    ownerUserId: string;
    recordType: string;
    recordId: string;
    envelope: EncryptedEnvelope;
  }): Promise<T> {
    return this.request({ type: "decrypt-record", ...input }, true) as Promise<T>;
  }

  blindIndex(
    value: string,
    context: string,
    normalization: "case-fold" | "exact" = "case-fold",
  ): Promise<string> {
    return this.request(
      { type: "blind-index", value, context, normalization },
      true,
    ) as Promise<string>;
  }

  parseTotpUri(uri: string): Promise<TotpConfiguration> {
    return this.request({ type: "parse-totp-uri", uri }, true) as Promise<TotpConfiguration>;
  }

  previewTotp(
    configuration: TotpConfiguration,
    timestamp?: number,
  ): Promise<TotpResult> {
    return this.request(
      { type: "preview-totp", configuration, timestamp },
      true,
    ) as Promise<TotpResult>;
  }

  generateRecordTotp(input: {
    ownerUserId: string;
    recordId: string;
    envelope: EncryptedEnvelope;
    timestamp?: number;
  }): Promise<TotpResult> {
    return this.request(
      { type: "generate-record-totp", ...input },
      true,
    ) as Promise<TotpResult>;
  }

  async lock(): Promise<void> {
    if (!this.worker) return;
    try {
      await this.request({ type: "lock" });
    } finally {
      this.terminate(true);
    }
  }

  dispose(): void {
    this.terminate(false);
  }

  private request(
    body: VaultWorkerRequestBody,
    resetIdle = false,
  ): Promise<VaultWorkerResult> {
    const worker = this.ensureWorker();
    const id = crypto.randomUUID();
    return new Promise<VaultWorkerResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => {
          if (resetIdle) this.resetIdleTimer();
          resolve(value);
        },
        reject,
      });
      worker.postMessage({ id, ...body } as VaultWorkerRequest);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker("/_workers/vault.worker.js", {
      type: "module",
      name: "account-vault-crypto",
    });
    worker.onmessage = (event: MessageEvent<VaultWorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new VaultClientError(response.error.code, response.error.message));
    };
    worker.onerror = () => {
      this.terminate(
        true,
        new VaultClientError("CRYPTO_WORKER_FAILED", "Crypto Worker failed"),
      );
    };
    this.worker = worker;
    return worker;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.lock();
    }, this.idleMilliseconds);
  }

  private terminate(locked: boolean, reason = new VaultClientError("VAULT_LOCKED", "Vault is locked")): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    if (locked) this.onLocked?.();
  }
}

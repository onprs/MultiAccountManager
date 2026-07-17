import type { TotpConfiguration, TotpResult } from "@/accounts/schema";
import type {
  Argon2Params,
  EncryptedEnvelope,
  VaultCryptoDocument,
} from "./schema";
import type {
  KdfBenchmarkResult,
  VaultInitializationResult,
} from "./core";

export type VaultWorkerRequest =
  | { id: string; type: "benchmark-kdf" }
  | {
      id: string;
      type: "initialize";
      ownerUserId: string;
      vaultId: string;
      password: string;
      kdfParams: Argon2Params;
    }
  | { id: string; type: "unlock-password"; vault: VaultCryptoDocument; password: string }
  | { id: string; type: "unlock-recovery"; vault: VaultCryptoDocument; recoveryKey: string }
  | {
      id: string;
      type: "change-password";
      vault: VaultCryptoDocument;
      newPassword: string;
      kdfParams: Argon2Params;
    }
  | { id: string; type: "rotate-recovery"; vault: VaultCryptoDocument }
  | {
      id: string;
      type: "encrypt-record";
      ownerUserId: string;
      recordType: string;
      recordId: string;
      value: unknown;
    }
  | {
      id: string;
      type: "decrypt-record";
      ownerUserId: string;
      recordType: string;
      recordId: string;
      envelope: EncryptedEnvelope;
    }
  | {
      id: string;
      type: "blind-index";
      value: string;
      context: string;
      normalization: "case-fold" | "exact";
    }
  | { id: string; type: "parse-totp-uri"; uri: string }
  | {
      id: string;
      type: "preview-totp";
      configuration: TotpConfiguration;
      timestamp?: number;
    }
  | {
      id: string;
      type: "generate-record-totp";
      ownerUserId: string;
      recordId: string;
      envelope: EncryptedEnvelope;
      timestamp?: number;
    }
  | { id: string; type: "status" }
  | { id: string; type: "lock" };

export type VaultWorkerRequestBody = VaultWorkerRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, "id">
    : never
  : never;

export type VaultWorkerResult =
  | KdfBenchmarkResult
  | VaultInitializationResult
  | Pick<VaultCryptoDocument, "kdfSalt" | "kdfParams" | "passwordEnvelope">
  | {
      recoveryEnvelope: VaultCryptoDocument["recoveryEnvelope"];
      recoveryKeyChecksum: string;
      recoveryKey: string;
    }
  | EncryptedEnvelope
  | TotpConfiguration
  | TotpResult
  | unknown
  | string
  | { unlocked: boolean }
  | { locked: true }
  | { unlocked: true };

export type VaultWorkerResponse =
  | { id: string; ok: true; result: VaultWorkerResult }
  | { id: string; ok: false; error: { code: string; message: string } };

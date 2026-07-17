import { argon2id } from "hash-wasm";
import sodium from "libsodium-wrappers-sumo";
import * as OTPAuth from "otpauth";
import {
  managedAccountPrivatePayloadSchema,
  totpConfigurationSchema,
  type TotpConfiguration,
  type TotpResult,
} from "@/accounts/schema";
import {
  DEFAULT_ARGON2_PARAMS,
  encryptedEnvelopeSchema,
  type Argon2Params,
  type EncryptedEnvelope,
  type VaultCryptoDocument,
} from "./schema";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const RECOVERY_PREFIX = "avrk1_";
const PASSWORD_KEY_ID = "vault-wrap-password-v1" as const;
const RECOVERY_KEY_ID = "vault-wrap-recovery-v1" as const;
const DATA_KEY_ID = "vault-data-v1" as const;

export class VaultLockedError extends Error {
  constructor() {
    super("Vault is locked");
    this.name = "VaultLockedError";
  }
}

export class VaultUnlockError extends Error {
  constructor() {
    super("Master password is incorrect or vault data is damaged");
    this.name = "VaultUnlockError";
  }
}

function base64Url(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function decodeBase64Url(value: string): Uint8Array {
  const decoded = sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
  if (base64Url(decoded) !== value) throw new Error("Invalid base64url encoding");
  return decoded;
}

export function normalizeMasterPassword(password: string): string {
  return password.normalize("NFKC");
}

export function createRootAad(
  ownerUserId: string,
  vaultId: string,
  method: "password" | "recovery",
): string {
  return JSON.stringify([
    "account-vault",
    "crypto-v1",
    ownerUserId,
    "vault-root",
    vaultId,
    method,
  ]);
}

export function createRecordAad(
  ownerUserId: string,
  recordType: string,
  recordId: string,
): string {
  return JSON.stringify([
    "account-vault",
    "data-v1",
    ownerUserId,
    recordType,
    recordId,
  ]);
}

async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  params: Argon2Params,
): Promise<Uint8Array> {
  const normalized = encoder.encode(normalizeMasterPassword(password));
  try {
    return await argon2id({
      password: normalized,
      salt,
      iterations: params.iterations,
      parallelism: params.parallelism,
      memorySize: params.memorySize,
      hashLength: params.hashLength,
      outputType: "binary",
    });
  } finally {
    sodium.memzero(normalized);
  }
}

function deriveRecoveryKey(recoveryKey: Uint8Array): Uint8Array {
  return sodium.crypto_kdf_derive_from_key(32, 1, "AVRecov1", recoveryKey);
}

function envelope(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: string,
  keyId: EncryptedEnvelope["keyId"],
): EncryptedEnvelope {
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    key,
  );
  return {
    version: 1,
    algorithm: "xchacha20poly1305-ietf",
    keyId,
    nonce: base64Url(nonce),
    ciphertext: base64Url(ciphertext),
  };
}

function openEnvelope(
  value: EncryptedEnvelope,
  key: Uint8Array,
  aad: string,
  expectedKeyId: EncryptedEnvelope["keyId"],
): Uint8Array {
  const parsed = encryptedEnvelopeSchema.parse(value);
  if (parsed.keyId !== expectedKeyId) throw new Error("Envelope key domain mismatch");
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    decodeBase64Url(parsed.ciphertext),
    aad,
    decodeBase64Url(parsed.nonce),
    key,
  );
}

function recoveryKeyText(bytes: Uint8Array): string {
  return `${RECOVERY_PREFIX}${base64Url(bytes)}`;
}

function parseRecoveryKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed.startsWith(RECOVERY_PREFIX)) throw new VaultUnlockError();
  const key = decodeBase64Url(trimmed.slice(RECOVERY_PREFIX.length));
  if (key.length !== 32) throw new VaultUnlockError();
  return key;
}

function recoveryChecksum(key: Uint8Array): string {
  return base64Url(sodium.crypto_generichash(16, "account-vault|recovery-check-v1", key));
}

export type VaultInitializationResult = {
  vault: VaultCryptoDocument;
  recoveryKey: string;
};

export type KdfBenchmarkResult = {
  params: Argon2Params;
  measuredMilliseconds: number;
  estimatedMilliseconds: number;
};

export async function benchmarkArgon2id(
  targetMilliseconds = 700,
): Promise<KdfBenchmarkResult> {
  await sodium.ready;
  const salt = sodium.randombytes_buf(16);
  const probe = sodium.randombytes_buf(32);
  const started = performance.now();
  await argon2id({
    password: probe,
    salt,
    iterations: 2,
    parallelism: 1,
    memorySize: DEFAULT_ARGON2_PARAMS.memorySize,
    hashLength: 32,
    outputType: "binary",
  });
  const measuredMilliseconds = Math.max(1, performance.now() - started);
  sodium.memzero(probe);
  const iterations = Math.max(
    2,
    Math.min(10, Math.ceil((2 * targetMilliseconds) / measuredMilliseconds)),
  );
  return {
    params: { ...DEFAULT_ARGON2_PARAMS, iterations },
    measuredMilliseconds: Math.round(measuredMilliseconds),
    estimatedMilliseconds: Math.round((measuredMilliseconds * iterations) / 2),
  };
}

export class VaultCryptoSession {
  private rootKey?: Uint8Array;
  private dataKey?: Uint8Array;
  private indexKey?: Uint8Array;

  isUnlocked(): boolean {
    return Boolean(this.rootKey && this.dataKey && this.indexKey);
  }

  async initialize(input: {
    ownerUserId: string;
    vaultId: string;
    password: string;
    kdfParams: Argon2Params;
  }): Promise<VaultInitializationResult> {
    await sodium.ready;
    this.lock();
    const salt = sodium.randombytes_buf(16);
    const rootKey = sodium.randombytes_buf(32);
    const recoveryKey = sodium.randombytes_buf(32);
    let passwordKey: Uint8Array | undefined;
    let recoveryWrappingKey: Uint8Array | undefined;
    try {
      passwordKey = await derivePasswordKey(input.password, salt, input.kdfParams);
      recoveryWrappingKey = deriveRecoveryKey(recoveryKey);
      const vault: VaultCryptoDocument = {
        id: input.vaultId,
        ownerUserId: input.ownerUserId,
        cryptoVersion: 1,
        kdfAlgorithm: "argon2id",
        kdfSalt: base64Url(salt),
        kdfParams: input.kdfParams,
        passwordEnvelope: envelope(
          rootKey,
          passwordKey,
          createRootAad(input.ownerUserId, input.vaultId, "password"),
          PASSWORD_KEY_ID,
        ) as VaultCryptoDocument["passwordEnvelope"],
        recoveryEnvelope: envelope(
          rootKey,
          recoveryWrappingKey,
          createRootAad(input.ownerUserId, input.vaultId, "recovery"),
          RECOVERY_KEY_ID,
        ) as VaultCryptoDocument["recoveryEnvelope"],
        recoveryKeyChecksum: recoveryChecksum(recoveryKey),
        revision: 1,
      };
      this.installRootKey(rootKey);
      return { vault, recoveryKey: recoveryKeyText(recoveryKey) };
    } finally {
      sodium.memzero(rootKey);
      sodium.memzero(recoveryKey);
      if (passwordKey) sodium.memzero(passwordKey);
      if (recoveryWrappingKey) sodium.memzero(recoveryWrappingKey);
    }
  }

  async unlockWithPassword(vault: VaultCryptoDocument, password: string): Promise<void> {
    await sodium.ready;
    this.lock();
    let passwordKey: Uint8Array | undefined;
    let rootKey: Uint8Array | undefined;
    try {
      passwordKey = await derivePasswordKey(
        password,
        decodeBase64Url(vault.kdfSalt),
        vault.kdfParams,
      );
      rootKey = openEnvelope(
        vault.passwordEnvelope,
        passwordKey,
        createRootAad(vault.ownerUserId, vault.id, "password"),
        PASSWORD_KEY_ID,
      );
      if (rootKey.length !== 32) throw new VaultUnlockError();
      this.installRootKey(rootKey);
    } catch {
      this.lock();
      throw new VaultUnlockError();
    } finally {
      if (passwordKey) sodium.memzero(passwordKey);
      if (rootKey) sodium.memzero(rootKey);
    }
  }

  async unlockWithRecovery(vault: VaultCryptoDocument, recoveryKeyText: string): Promise<void> {
    await sodium.ready;
    this.lock();
    let recoveryKey: Uint8Array | undefined;
    let wrappingKey: Uint8Array | undefined;
    let rootKey: Uint8Array | undefined;
    try {
      recoveryKey = parseRecoveryKey(recoveryKeyText);
      const checksum = decodeBase64Url(vault.recoveryKeyChecksum);
      const suppliedChecksum = decodeBase64Url(recoveryChecksum(recoveryKey));
      if (!sodium.memcmp(checksum, suppliedChecksum)) throw new VaultUnlockError();
      wrappingKey = deriveRecoveryKey(recoveryKey);
      rootKey = openEnvelope(
        vault.recoveryEnvelope,
        wrappingKey,
        createRootAad(vault.ownerUserId, vault.id, "recovery"),
        RECOVERY_KEY_ID,
      );
      if (rootKey.length !== 32) throw new VaultUnlockError();
      this.installRootKey(rootKey);
    } catch {
      this.lock();
      throw new VaultUnlockError();
    } finally {
      if (recoveryKey) sodium.memzero(recoveryKey);
      if (wrappingKey) sodium.memzero(wrappingKey);
      if (rootKey) sodium.memzero(rootKey);
    }
  }

  async changePassword(input: {
    vault: VaultCryptoDocument;
    newPassword: string;
    kdfParams: Argon2Params;
  }): Promise<Pick<VaultCryptoDocument, "kdfSalt" | "kdfParams" | "passwordEnvelope">> {
    await sodium.ready;
    const rootKey = this.requireRootKey();
    const salt = sodium.randombytes_buf(16);
    const passwordKey = await derivePasswordKey(input.newPassword, salt, input.kdfParams);
    try {
      return {
        kdfSalt: base64Url(salt),
        kdfParams: input.kdfParams,
        passwordEnvelope: envelope(
          rootKey,
          passwordKey,
          createRootAad(input.vault.ownerUserId, input.vault.id, "password"),
          PASSWORD_KEY_ID,
        ) as VaultCryptoDocument["passwordEnvelope"],
      };
    } finally {
      sodium.memzero(passwordKey);
    }
  }

  async rotateRecovery(vault: VaultCryptoDocument): Promise<{
    recoveryEnvelope: VaultCryptoDocument["recoveryEnvelope"];
    recoveryKeyChecksum: string;
    recoveryKey: string;
  }> {
    await sodium.ready;
    const rootKey = this.requireRootKey();
    const recoveryKey = sodium.randombytes_buf(32);
    const wrappingKey = deriveRecoveryKey(recoveryKey);
    try {
      return {
        recoveryEnvelope: envelope(
          rootKey,
          wrappingKey,
          createRootAad(vault.ownerUserId, vault.id, "recovery"),
          RECOVERY_KEY_ID,
        ) as VaultCryptoDocument["recoveryEnvelope"],
        recoveryKeyChecksum: recoveryChecksum(recoveryKey),
        recoveryKey: recoveryKeyText(recoveryKey),
      };
    } finally {
      sodium.memzero(recoveryKey);
      sodium.memzero(wrappingKey);
    }
  }

  async encryptRecord(input: {
    ownerUserId: string;
    recordType: string;
    recordId: string;
    value: unknown;
  }): Promise<EncryptedEnvelope> {
    await sodium.ready;
    const serialized = JSON.stringify(input.value);
    if (typeof serialized !== "string") {
      throw new Error("Record value must be JSON serializable");
    }
    const plaintext = encoder.encode(serialized);
    try {
      return envelope(
        plaintext,
        this.requireDataKey(),
        createRecordAad(input.ownerUserId, input.recordType, input.recordId),
        DATA_KEY_ID,
      );
    } finally {
      sodium.memzero(plaintext);
    }
  }

  async decryptRecord<T>(input: {
    ownerUserId: string;
    recordType: string;
    recordId: string;
    envelope: EncryptedEnvelope;
  }): Promise<T> {
    await sodium.ready;
    const plaintext = openEnvelope(
      input.envelope,
      this.requireDataKey(),
      createRecordAad(input.ownerUserId, input.recordType, input.recordId),
      DATA_KEY_ID,
    );
    try {
      return JSON.parse(decoder.decode(plaintext)) as T;
    } finally {
      sodium.memzero(plaintext);
    }
  }

  parseTotpUri(uri: string): TotpConfiguration {
    const parsed = OTPAuth.URI.parse(uri.trim());
    if (!(parsed instanceof OTPAuth.TOTP)) {
      throw new Error("Only TOTP credentials are supported");
    }
    try {
      return totpConfigurationSchema.parse({
        type: "totp",
        issuer: parsed.issuer,
        label: parsed.label,
        secretBase32: parsed.secret.base32.replaceAll("=", "").toUpperCase(),
        algorithm: parsed.algorithm.toUpperCase(),
        digits: parsed.digits,
        period: parsed.period,
      });
    } finally {
      sodium.memzero(parsed.secret.bytes);
    }
  }

  generateTotp(configuration: TotpConfiguration, timestamp = Date.now()): TotpResult {
    const parsed = totpConfigurationSchema.parse(configuration);
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new Error("Invalid TOTP timestamp");
    }
    const totp = new OTPAuth.TOTP({
      issuer: parsed.issuer,
      label: parsed.label,
      secret: OTPAuth.Secret.fromBase32(parsed.secretBase32),
      algorithm: parsed.algorithm,
      digits: parsed.digits,
      period: parsed.period,
    });
    const generatedAt = Math.floor(timestamp);
    const elapsed = Math.floor(generatedAt / 1_000) % parsed.period;
    try {
      return {
        code: totp.generate({ timestamp: generatedAt }),
        period: parsed.period,
        secondsRemaining: parsed.period - elapsed,
        generatedAt,
      };
    } finally {
      sodium.memzero(totp.secret.bytes);
    }
  }

  async generateRecordTotp(input: {
    ownerUserId: string;
    recordId: string;
    envelope: EncryptedEnvelope;
    timestamp?: number;
  }): Promise<TotpResult> {
    const payload = managedAccountPrivatePayloadSchema.parse(
      await this.decryptRecord({
        ownerUserId: input.ownerUserId,
        recordType: "managed-account-private-v1",
        recordId: input.recordId,
        envelope: input.envelope,
      }),
    );
    if (!payload.totp) throw new Error("Account has no TOTP configuration");
    return this.generateTotp(payload.totp, input.timestamp);
  }

  async blindIndex(
    value: string,
    context: string,
    normalization: "case-fold" | "exact" = "case-fold",
  ): Promise<string> {
    await sodium.ready;
    const canonical = value.normalize("NFKC").trim();
    const normalized = normalization === "case-fold" ? canonical.toLowerCase() : canonical;
    const message = encoder.encode(
      JSON.stringify(["account-vault", "blind-index-v1", context, normalized]),
    );
    try {
      return base64Url(sodium.crypto_generichash(32, message, this.requireIndexKey()));
    } finally {
      sodium.memzero(message);
    }
  }

  lock(): void {
    for (const key of [this.rootKey, this.dataKey, this.indexKey]) {
      if (key) sodium.memzero(key);
    }
    this.rootKey = undefined;
    this.dataKey = undefined;
    this.indexKey = undefined;
  }

  private installRootKey(rootKey: Uint8Array): void {
    this.lock();
    this.rootKey = new Uint8Array(rootKey);
    this.dataKey = sodium.crypto_kdf_derive_from_key(32, 1, "AVData01", rootKey);
    this.indexKey = sodium.crypto_kdf_derive_from_key(32, 2, "AVIndex1", rootKey);
  }

  private requireRootKey(): Uint8Array {
    if (!this.rootKey) throw new VaultLockedError();
    return this.rootKey;
  }

  private requireDataKey(): Uint8Array {
    if (!this.dataKey) throw new VaultLockedError();
    return this.dataKey;
  }

  private requireIndexKey(): Uint8Array {
    if (!this.indexKey) throw new VaultLockedError();
    return this.indexKey;
  }
}

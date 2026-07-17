import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import sodium from "libsodium-wrappers-sumo";
import {
  encryptedRuntimeConfigSchema,
  runtimeConfigSchema,
  type EncryptedRuntimeConfig,
  type RuntimeConfig,
} from "./types";
import { configDirectory, configMasterKeyPath, runtimeConfigPath } from "./paths";
import { decodeBase64Url, decodeSecretFile, encodeBase64Url } from "./encoding";

const CONFIG_AAD = "account-vault|runtime-config|v1";

export class RuntimeConfigNotFoundError extends Error {
  constructor() {
    super("Runtime configuration has not been initialized");
    this.name = "RuntimeConfigNotFoundError";
  }
}

async function loadMasterKey(): Promise<Uint8Array> {
  const key = decodeSecretFile(
    await readFile(/* turbopackIgnore: true */ configMasterKeyPath()),
  );
  await sodium.ready;
  if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    throw new Error("Config master key has an invalid length");
  }
  return key;
}

export async function runtimeConfigExists(): Promise<boolean> {
  try {
    await access(/* turbopackIgnore: true */ runtimeConfigPath(), constants.R_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function encryptRuntimeConfig(
  config: RuntimeConfig,
  key: Uint8Array,
): Promise<EncryptedRuntimeConfig> {
  await sodium.ready;
  const parsed = runtimeConfigSchema.parse(config);
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
  );
  const plaintext = sodium.from_string(JSON.stringify(parsed));
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    sodium.from_string(CONFIG_AAD),
    null,
    nonce,
    key,
  );
  sodium.memzero(plaintext);
  return {
    version: 1,
    algorithm: "xchacha20poly1305-ietf",
    keyId: "config-master-v1",
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(ciphertext),
  };
}

export async function decryptRuntimeConfig(
  envelope: EncryptedRuntimeConfig,
  key: Uint8Array,
): Promise<RuntimeConfig> {
  await sodium.ready;
  const parsed = encryptedRuntimeConfigSchema.parse(envelope);
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    decodeBase64Url(parsed.ciphertext),
    sodium.from_string(CONFIG_AAD),
    decodeBase64Url(parsed.nonce),
    key,
  );
  try {
    return runtimeConfigSchema.parse(JSON.parse(sodium.to_string(plaintext)));
  } finally {
    sodium.memzero(plaintext);
  }
}

export async function readRuntimeConfig(): Promise<RuntimeConfig> {
  if (!(await runtimeConfigExists())) throw new RuntimeConfigNotFoundError();
  const [serialized, key] = await Promise.all([
    readFile(/* turbopackIgnore: true */ runtimeConfigPath(), "utf8"),
    loadMasterKey(),
  ]);
  try {
    return await decryptRuntimeConfig(JSON.parse(serialized), key);
  } finally {
    sodium.memzero(key);
  }
}

export async function writeRuntimeConfig(config: RuntimeConfig): Promise<void> {
  const directory = configDirectory();
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const key = await loadMasterKey();
  let envelope: EncryptedRuntimeConfig;
  try {
    envelope = await encryptRuntimeConfig(config, key);
  } finally {
    sodium.memzero(key);
  }

  const target = runtimeConfigPath();
  const temporary = path.join(directory, `.runtime.enc.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o640);
  try {
    await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, target);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const unsupported = ["EINVAL", "ENOTSUP"].includes(code ?? "");
      const windowsDirectorySync = process.platform === "win32" && code === "EPERM";
      if (!unsupported && !windowsDirectorySync) throw error;
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

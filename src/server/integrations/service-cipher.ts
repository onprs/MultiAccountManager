import sodium from "libsodium-wrappers-sumo";
import { serviceCiphertextSchema, type ServiceCiphertext } from "@/integrations/schema";
import { decodeBase64Url, encodeBase64Url } from "@/runtime/encoding";
import { readRuntimeConfig } from "@/runtime/config-store";
import type { RuntimeConfig } from "@/runtime/types";

const PURPOSE = "sub2api-observer-token-v1";

function aad(connectionId: string, ownerUserId: string): Uint8Array {
  return sodium.from_string(
    `account-vault|${PURPOSE}|owner=${ownerUserId}|connection=${connectionId}`,
  );
}

function currentKey(config: RuntimeConfig) {
  const key = config.serviceEncryption.keys.find((entry) => entry.status === "current");
  if (!key) throw new Error("Current service encryption key is unavailable");
  return key;
}

export async function encryptServiceToken(input: {
  connectionId: string;
  ownerUserId: string;
  token: string;
  config?: RuntimeConfig;
}): Promise<ServiceCiphertext> {
  await sodium.ready;
  const config = input.config ?? (await readRuntimeConfig());
  const selected = currentKey(config);
  const key = decodeBase64Url(selected.key);
  if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    sodium.memzero(key);
    throw new Error("Service encryption key has an invalid length");
  }
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
  );
  const plaintext = sodium.from_string(input.token);
  try {
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      aad(input.connectionId, input.ownerUserId),
      null,
      nonce,
      key,
    );
    return serviceCiphertextSchema.parse({
      version: 1,
      algorithm: "xchacha20poly1305-ietf",
      keyId: selected.id,
      nonce: encodeBase64Url(nonce),
      ciphertext: encodeBase64Url(ciphertext),
    });
  } finally {
    sodium.memzero(plaintext);
    sodium.memzero(key);
  }
}

export async function decryptServiceToken(input: {
  connectionId: string;
  ownerUserId: string;
  envelope: ServiceCiphertext;
  config?: RuntimeConfig;
}): Promise<string> {
  await sodium.ready;
  const envelope = serviceCiphertextSchema.parse(input.envelope);
  const config = input.config ?? (await readRuntimeConfig());
  const selected = config.serviceEncryption.keys.find(
    (entry) => entry.id === envelope.keyId,
  );
  if (!selected) throw new Error("Service encryption key is unavailable");
  const key = decodeBase64Url(selected.key);
  if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    sodium.memzero(key);
    throw new Error("Service encryption key has an invalid length");
  }
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      decodeBase64Url(envelope.ciphertext),
      aad(input.connectionId, input.ownerUserId),
      decodeBase64Url(envelope.nonce),
      key,
    );
    return sodium.to_string(plaintext);
  } finally {
    if (plaintext) sodium.memzero(plaintext);
    sodium.memzero(key);
  }
}

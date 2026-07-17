export function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function decodeSecretFile(value: Buffer): Uint8Array {
  const trimmed = value.toString("utf8").trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    return decodeBase64Url(trimmed);
  }
  if (value.length === 32) {
    return new Uint8Array(value);
  }
  if (trimmed.length === 32) {
    return new Uint8Array(Buffer.from(trimmed, "utf8"));
  }
  throw new Error("Secret file must contain exactly 32 raw bytes or 32 base64url-encoded bytes");
}

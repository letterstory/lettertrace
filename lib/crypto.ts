import crypto from "node:crypto";

// AES-256-GCM encryption for BYOK provider keys at rest.
// Payload format:  v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>
// The master key comes from ENCRYPTION_KEY (base64, 32 bytes decoded).

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must decode to 32 bytes (base64 of 32 random bytes).",
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Malformed encrypted secret.");
  }
  const key = getKey();
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ciphertext = Buffer.from(parts[3], "base64");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

// A non-reversible hint so users can recognize which key is stored, e.g. "sk-ant-…4a9c".
export function keyHint(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length <= 10) return "…";
  const prefix = trimmed.slice(0, 7);
  const suffix = trimmed.slice(-4);
  return `${prefix}…${suffix}`;
}

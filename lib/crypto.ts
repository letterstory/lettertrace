import crypto from "node:crypto";

// AES-256-GCM encryption for BYOK provider keys at rest.
// Payload format:  v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>
// The master key comes from ENCRYPTION_KEY (base64, 32 bytes decoded).

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

/**
 * The deployment is misconfigured — nothing the end user did is wrong.
 *
 * Distinguished from ordinary errors so routes can say so. Without it a broken
 * ENCRYPTION_KEY surfaces under the "Anthropic API key" field as though the
 * user pasted a bad key, which is the opposite of what happened: the key was
 * verified against the provider first and only then failed to encrypt.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new ConfigurationError(
      "ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    // Buffer.from(..., "base64") is lenient, so a hex key decodes happily to
    // 48 bytes rather than failing — the usual cause is `openssl rand -hex 32`
    // (meant for CRON_SECRET) being used here instead of `-base64 32`.
    throw new ConfigurationError(
      `ENCRYPTION_KEY must decode to 32 bytes, but decoded to ${key.length}. ` +
        "Generate one with: openssl rand -base64 32",
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

// ------------------------------------------------------------------
// Lettertrace API keys (programmatic REST/MCP access). Unlike provider keys we
// never need the plaintext back, so these are hashed, not encrypted: the
// plaintext is shown once at creation and only the SHA-256 digest is stored.
// ------------------------------------------------------------------

const API_KEY_PREFIX = "lt_live_";

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
}

/**
 * The single hashing convention for every bearer secret we store — classic API
 * keys and every OAuth token/code alike. A plain SHA-256 hex digest of the
 * trimmed plaintext: fast (these are high-entropy random tokens, not passwords,
 * so no KDF is needed) and non-reversible, so a database leak never yields a
 * usable credential.
 */
export function sha256Hex(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext.trim()).digest("hex");
}

export function hashApiKey(plaintext: string): string {
  return sha256Hex(plaintext);
}

// A non-reversible hint so users can recognize which key is stored, e.g. "sk-ant-…4a9c".
export function keyHint(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length <= 10) return "…";
  const prefix = trimmed.slice(0, 7);
  const suffix = trimmed.slice(-4);
  return `${prefix}…${suffix}`;
}

// ------------------------------------------------------------------
// OAuth 2.1 credentials. Every one is an opaque, high-entropy random string
// stored only as its SHA-256 digest (sha256Hex) — never in plaintext, never
// encrypted-and-recoverable. The plaintext is handed to the client exactly once
// (in a redirect, a token response, or on-screen) and cannot be read back.
// Prefixes make a leaked value instantly recognizable in logs/secret scanners.
// ------------------------------------------------------------------

/** Access token: short-lived (~1h), presented as `Authorization: Bearer`. */
export function generateOAuthAccessToken(): string {
  return `lt_oauth_${crypto.randomBytes(24).toString("base64url")}`;
}

/** Refresh token: longer-lived, rotates on every use. */
export function generateRefreshToken(): string {
  return `lt_refr_${crypto.randomBytes(32).toString("base64url")}`;
}

/** Authorization code: single-use, ~5 min, delivered via the redirect. */
export function generateAuthCode(): string {
  return `lt_code_${crypto.randomBytes(32).toString("base64url")}`;
}

/** Device code (RFC 8628): the CLI's polling handle, single-use, ~15 min. */
export function generateDeviceCode(): string {
  return `lt_dev_${crypto.randomBytes(32).toString("base64url")}`;
}

// Crockford base32 (no I, L, O, U — the characters people misread). We map 40
// random bits (5 bytes) onto exactly 8 characters, so there is no modulo bias.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Human-typed device code, e.g. "WXYZ-1234" (~40 bits). Short enough to read off
 * one screen and type on another, high-entropy enough that guessing is hopeless
 * within the 15-minute window — and we additionally cap attempts and store only
 * its hash, so the plaintext never sits in the database.
 */
export function generateUserCode(): string {
  const bytes = crypto.randomBytes(5); // 40 bits
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 0x1f];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

/** Normalize a user-entered code for hash lookup: uppercase, strip separators. */
export function normalizeUserCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, "");
}

/** A masked hint for an OAuth token, mirroring keyHint's shape. */
export function oauthTokenHint(plaintext: string): string {
  return keyHint(plaintext);
}

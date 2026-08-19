import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  ConfigurationError,
  encryptSecret,
  decryptSecret,
  keyHint,
  generateShareToken,
  sha256Hex,
} from "@/lib/crypto";

const VALID = crypto.randomBytes(32).toString("base64");
const original = process.env.ENCRYPTION_KEY;

afterEach(() => {
  if (original === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = original;
});

describe("ENCRYPTION_KEY validation", () => {
  it("round-trips a secret with a valid key", () => {
    process.env.ENCRYPTION_KEY = VALID;
    const secret = "sk-ant-api03-not-a-real-key";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("throws ConfigurationError when unset, so routes can tell it apart", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(ConfigurationError);
  });

  // The actual misconfiguration seen in production: `openssl rand -hex 32`
  // (which belongs to CRON_SECRET) used here. Buffer.from(_, "base64") is
  // lenient enough to decode 64 hex chars to 48 bytes rather than rejecting.
  it("rejects a hex key and reports the length it actually decoded to", () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    expect(() => encryptSecret("x")).toThrow(ConfigurationError);
    expect(() => encryptSecret("x")).toThrow(/decoded to 48/);
  });

  it("rejects a key of the wrong byte length", () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(16).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/must decode to 32 bytes/);
  });

  it("names the command that generates a correct key", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/openssl rand -base64 32/);
  });

  it("fails to decrypt a payload written under a different key", () => {
    process.env.ENCRYPTION_KEY = VALID;
    const payload = encryptSecret("secret");
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    expect(() => decryptSecret(payload)).toThrow();
  });
});

describe("keyHint", () => {
  it("shows only enough to tell two keys apart", () => {
    const hint = keyHint("sk-ant-api03-abcdefghijklmnop4a9c");
    expect(hint).not.toContain("abcdefghijklmnop");
    expect(hint).toContain("4a9c");
  });
});

describe("generateShareToken", () => {
  it("is prefixed and unique across calls", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).toMatch(/^lt_share_[A-Za-z0-9_-]{32,}$/);
    expect(a).not.toBe(b);
  });

  it("hashes deterministically and ignores surrounding whitespace", () => {
    const token = generateShareToken();
    expect(sha256Hex(token)).toBe(sha256Hex(`  ${token}\n`));
    expect(sha256Hex(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(token)).not.toBe(sha256Hex(generateShareToken()));
  });
});

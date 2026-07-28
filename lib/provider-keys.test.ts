import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyKey } from "@/lib/llm";
import { decryptSecret } from "@/lib/crypto";
import {
  ENCRYPTION_UNAVAILABLE_MESSAGE,
  listProviderKeys,
  parseProvider,
  removeProviderKey,
  setProviderKey,
  supportedProviders,
  unknownProviderMessage,
} from "@/lib/provider-keys";

vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  verifyKey: vi.fn(),
}));

const PLAINTEXT = "sk-ant-api03-definitely-not-a-real-key-0000";
const VALID_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const originalEncryptionKey = process.env.ENCRYPTION_KEY;

const STORED_ROW = {
  id: "key-1",
  provider: "anthropic",
  label: null,
  key_hint: "sk-ant-…0000",
  created_at: "2026-07-20T00:00:00Z",
};

/**
 * Minimal stand-in for the PostgREST query builder: every call is recorded and
 * returns the same chain, and the terminal methods resolve to a fixed result.
 * The point of the recording is that these tests can assert on the row that
 * WOULD have been written — which is the only way to prove the plaintext key
 * never reaches the database.
 */
function stubClient(result: { data: unknown; error?: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const settled = Promise.resolve({ data: result.data, error: result.error ?? null });
  const record = (method: string, args: unknown[]) => calls.push({ method, args });

  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ["upsert", "delete", "select", "eq"]) {
    chain[method] = (...args: unknown[]) => {
      record(method, args);
      return chain;
    };
  }
  for (const method of ["order", "single", "maybeSingle"]) {
    chain[method] = (...args: unknown[]) => {
      record(method, args);
      return settled;
    };
  }

  const supabase = {
    from: (table: string) => {
      record("from", [table]);
      return chain;
    },
  } as unknown as SupabaseClient;

  const argsOf = (method: string) => calls.find((c) => c.method === method)?.args;
  return { supabase, calls, argsOf };
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = VALID_ENCRYPTION_KEY;
  vi.mocked(verifyKey).mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
});

describe("the provider catalog is the server's, not the client's", () => {
  it("derives the supported providers from the model catalog", () => {
    const ids = supportedProviders().map((p) => p.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    // Each entry carries enough for a client to render a picker unaided.
    expect(supportedProviders()[0]).toMatchObject({
      label: expect.any(String),
      key_url: expect.any(String),
    });
  });

  it("names the working providers when one is rejected", () => {
    expect(parseProvider("gemini")).toBeNull();
    expect(parseProvider("anthropic")).toBe("anthropic");
    expect(unknownProviderMessage()).toContain("anthropic");
    expect(unknownProviderMessage()).toContain("openai");
  });
});

describe("setProviderKey", () => {
  it("rejects an unknown provider without calling the provider or the database", async () => {
    const db = stubClient({ data: null });
    const outcome = await setProviderKey(db.supabase, "user-1", {
      provider: "gemini",
      apiKey: PLAINTEXT,
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid" });
    expect(verifyKey).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });

  it("rejects an empty key", async () => {
    const db = stubClient({ data: null });
    const outcome = await setProviderKey(db.supabase, "user-1", {
      provider: "anthropic",
      apiKey: "   ",
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid" });
    expect(verifyKey).not.toHaveBeenCalled();
  });

  // The ordering guarantee: a key the provider refuses must never be persisted,
  // not even encrypted. Verification is what makes the stored key trustworthy.
  it("never writes a key the provider rejected", async () => {
    vi.mocked(verifyKey).mockResolvedValue({ ok: false, error: "Invalid API key." });
    const db = stubClient({ data: null });
    const outcome = await setProviderKey(db.supabase, "user-1", {
      provider: "anthropic",
      apiKey: PLAINTEXT,
    });
    expect(outcome).toMatchObject({ ok: false, code: "unverified", message: "Invalid API key." });
    expect(db.calls).toHaveLength(0);
  });

  it("stores ciphertext plus a hint, and never the plaintext", async () => {
    const db = stubClient({ data: STORED_ROW });
    const outcome = await setProviderKey(db.supabase, "user-1", {
      provider: "anthropic",
      apiKey: `  ${PLAINTEXT}  `,
      label: "  work  ",
    });

    expect(outcome).toEqual({ ok: true, key: STORED_ROW });
    expect(verifyKey).toHaveBeenCalledWith("anthropic", PLAINTEXT);

    const row = db.argsOf("upsert")?.[0] as Record<string, string>;
    expect(row.user_id).toBe("user-1");
    expect(row.label).toBe("work");
    // The row is inspected as a whole: no field anywhere may equal the key.
    expect(JSON.stringify(row)).not.toContain(PLAINTEXT);
    expect(decryptSecret(row.encrypted_key)).toBe(PLAINTEXT);
    expect(row.key_hint).toBe("sk-ant-…0000");

    // Upsert on (user_id, provider): setting a key replaces, never duplicates.
    expect(db.argsOf("upsert")?.[1]).toEqual({ onConflict: "user_id,provider" });
  });

  it("blanks an empty label rather than storing an empty string", async () => {
    const db = stubClient({ data: STORED_ROW });
    await setProviderKey(db.supabase, "user-1", {
      provider: "anthropic",
      apiKey: PLAINTEXT,
      label: "   ",
    });
    expect((db.argsOf("upsert")?.[0] as Record<string, unknown>).label).toBeNull();
  });

  // The distinction the whole ConfigurationError machinery exists for: the user
  // pasted a good key and the DEPLOYMENT is broken. Reporting this as a bad key
  // sends them off to rotate a credential that was never the problem.
  it("reports a missing ENCRYPTION_KEY as the operator's problem, not a bad key", async () => {
    delete process.env.ENCRYPTION_KEY;
    const db = stubClient({ data: STORED_ROW });
    const outcome = await setProviderKey(db.supabase, "user-1", {
      provider: "anthropic",
      apiKey: PLAINTEXT,
    });
    expect(outcome).toEqual({
      ok: false,
      code: "misconfigured",
      message: ENCRYPTION_UNAVAILABLE_MESSAGE,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/ENCRYPTION_KEY/);
      expect(outcome.message).not.toMatch(/invalid api key/i);
    }
    // Verified first, stored never: nothing reached the database.
    expect(verifyKey).toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });

  it("reports a hex ENCRYPTION_KEY the same way, not as a 500", async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    const db = stubClient({ data: STORED_ROW });
    const outcome = await setProviderKey(db.supabase, "user-1", {
      provider: "anthropic",
      apiKey: PLAINTEXT,
    });
    expect(outcome).toMatchObject({ ok: false, code: "misconfigured" });
  });

  it("surfaces a storage failure as `failed`, distinct from a bad key", async () => {
    const db = stubClient({ data: null, error: new Error("connection reset") });
    const outcome = await setProviderKey(db.supabase, "user-1", {
      provider: "anthropic",
      apiKey: PLAINTEXT,
    });
    expect(outcome).toMatchObject({ ok: false, code: "failed" });
  });
});

describe("listProviderKeys / removeProviderKey", () => {
  it("scopes the listing to the caller and returns hints only", async () => {
    const db = stubClient({ data: [STORED_ROW] });
    const keys = await listProviderKeys(db.supabase, "user-1");
    expect(keys).toEqual([STORED_ROW]);
    expect(db.argsOf("eq")).toEqual(["user_id", "user-1"]);
    // encrypted_key is decryptable by the server; it is never selected.
    expect(db.argsOf("select")?.[0]).not.toContain("encrypted_key");
  });

  it("returns an empty list rather than throwing when the query yields nothing", async () => {
    const db = stubClient({ data: null });
    await expect(listProviderKeys(db.supabase, "user-1")).resolves.toEqual([]);
  });

  it("returns the removed row so the caller can confirm which key went", async () => {
    const db = stubClient({ data: STORED_ROW });
    await expect(removeProviderKey(db.supabase, "user-1", "anthropic")).resolves.toEqual(
      STORED_ROW,
    );
    expect(db.calls.filter((c) => c.method === "eq").map((c) => c.args)).toEqual([
      ["user_id", "user-1"],
      ["provider", "anthropic"],
    ]);
  });

  it("returns null when nothing was stored, so a no-op can't read as success", async () => {
    const db = stubClient({ data: null });
    await expect(removeProviderKey(db.supabase, "user-1", "openai")).resolves.toBeNull();
  });

  // Both of these used to swallow the error and collapse into the same value
  // the "nothing there" case returns, which made a failed query indistinguishable
  // from a true answer about the account.
  it("throws on a failed read instead of claiming the account has no keys", async () => {
    const db = stubClient({ data: null, error: new Error("connection reset") });
    await expect(listProviderKeys(db.supabase, "user-1")).rejects.toThrow("connection reset");
  });

  // The dangerous direction: a delete that failed must never be reported as
  // "no key is stored", which reads as "already revoked" for a live credential.
  it("throws on a failed delete rather than reporting nothing was stored", async () => {
    const db = stubClient({ data: null, error: new Error("connection reset") });
    await expect(removeProviderKey(db.supabase, "user-1", "anthropic")).rejects.toThrow(
      "connection reset",
    );
  });
});

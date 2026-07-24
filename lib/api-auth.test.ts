import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey, hashApiKey, keyHint } from "@/lib/crypto";
import { authenticateApiKey, bearerToken } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn() }));

// A minimal stand-in for the supabase client covering the exact chains
// lib/api-auth uses: select().eq().maybeSingle() and update().eq() (awaited).
function fakeServiceClient(row: { id: string; user_id: string } | null) {
  const eqCalls: unknown[][] = [];
  const updates: unknown[] = [];
  const client = {
    eqCalls,
    updates,
    from(_table: string) {
      const q = {
        select: () => q,
        update: (patch: unknown) => {
          updates.push(patch);
          return q;
        },
        eq: (...args: unknown[]) => {
          eqCalls.push(args);
          return q;
        },
        maybeSingle: async () => ({ data: row, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return q;
    },
  };
  return client;
}

describe("lettertrace api keys", () => {
  it("generates prefixed, unique keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).toMatch(/^lt_live_[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });

  it("hashes deterministically and ignores surrounding whitespace", () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toBe(hashApiKey(`  ${key}\n`));
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).not.toBe(hashApiKey(generateApiKey()));
  });

  it("produces a recognizable hint without leaking the key", () => {
    const key = generateApiKey();
    const hint = keyHint(key);
    expect(hint.startsWith("lt_live")).toBe(true);
    expect(hint.length).toBeLessThan(15);
  });
});

describe("authenticateApiKey", () => {
  beforeEach(() => {
    vi.mocked(createServiceClient).mockReset();
  });

  it("returns null without a token and never opens a client", async () => {
    expect(await authenticateApiKey(null)).toBeNull();
    expect(await authenticateApiKey(undefined)).toBeNull();
    expect(await authenticateApiKey("")).toBeNull();
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it("returns null for an unknown key", async () => {
    const client = fakeServiceClient(null);
    vi.mocked(createServiceClient).mockReturnValue(client as never);
    expect(await authenticateApiKey(generateApiKey())).toBeNull();
  });

  it("resolves a valid key to its owner, looking up by hash only", async () => {
    const client = fakeServiceClient({ id: "key-1", user_id: "user-1" });
    vi.mocked(createServiceClient).mockReturnValue(client as never);

    const token = generateApiKey();
    const ctx = await authenticateApiKey(token);

    expect(ctx).toMatchObject({ userId: "user-1", keyId: "key-1" });
    // The plaintext must never be used as a filter — only its hash.
    expect(client.eqCalls).toContainEqual(["key_hash", hashApiKey(token)]);
    for (const call of client.eqCalls) expect(call).not.toContain(token);
    // Usage is stamped for the settings page.
    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]).toHaveProperty("last_used_at");
  });
});

describe("bearerToken", () => {
  it("extracts the token case-insensitively", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
  });

  it("rejects missing or malformed headers", () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken("Basic abc123")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
  });
});

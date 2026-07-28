import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey, hashApiKey, keyHint } from "@/lib/crypto";
import {
  allowsAudience,
  authenticateApiKey,
  bearerToken,
  FULL_SCOPES,
  hasScope,
  isOAuthToken,
  type ApiAuthContext,
} from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn() }));

// A minimal stand-in for the supabase client covering the exact chains
// lib/api-auth uses: for api_keys, select().eq().maybeSingle(); for
// oauth_access_tokens, select().eq().is().gt().maybeSingle(); and
// update().eq() (awaited) on both. maybeSingle returns the row registered for
// the table being queried, so a request can hit the api_keys path, the OAuth
// fallback, or neither.
function fakeServiceClient(
  apiKeyRow: { id: string; user_id: string } | null,
  oauthRow: Record<string, unknown> | null = null,
) {
  const eqCalls: unknown[][] = [];
  const updates: unknown[] = [];
  const client = {
    eqCalls,
    updates,
    from(table: string) {
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
        is: () => q,
        gt: () => q,
        maybeSingle: async () => ({
          data: table === "api_keys" ? apiKeyRow : oauthRow,
          error: null,
        }),
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

  it("resolves a classic api key to full access, looking up by hash only", async () => {
    const client = fakeServiceClient({ id: "key-1", user_id: "user-1" });
    vi.mocked(createServiceClient).mockReturnValue(client as never);

    const token = generateApiKey();
    const ctx = await authenticateApiKey(token);

    expect(ctx).toMatchObject({
      userId: "user-1",
      keyId: "key-1",
      tokenType: "api_key",
      clientId: null,
      expiresAt: null,
      aud: null,
    });
    // A classic key carries the full scope set and no audience binding, so it
    // behaves exactly as it did before OAuth existed.
    expect(ctx!.scopes).toEqual([...FULL_SCOPES]);
    expect(hasScope(ctx!, "runs:trigger")).toBe(true);
    expect(allowsAudience(ctx!, "v1")).toBe(true);
    expect(allowsAudience(ctx!, "mcp")).toBe(true);
    expect(isOAuthToken(ctx!)).toBe(false);

    // The plaintext must never be used as a filter — only its hash.
    expect(client.eqCalls).toContainEqual(["key_hash", hashApiKey(token)]);
    for (const call of client.eqCalls) expect(call).not.toContain(token);
    // Usage is stamped for the settings page (one update: the api_keys row).
    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]).toHaveProperty("last_used_at");
  });

  it("falls back to an OAuth access token, carrying its scopes and audience", async () => {
    const client = fakeServiceClient(null, {
      id: "at-1",
      user_id: "user-2",
      client_id: "lt_cli",
      scopes: ["runs:read"],
      resource: "mcp",
      expires_at: "2999-01-01T00:00:00.000Z",
      authorization_id: "az-1",
    });
    vi.mocked(createServiceClient).mockReturnValue(client as never);

    const ctx = await authenticateApiKey("lt_oauth_whatever");

    expect(ctx).toMatchObject({
      userId: "user-2",
      keyId: "at-1",
      tokenType: "oauth",
      clientId: "lt_cli",
      aud: "mcp",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(ctx!.scopes).toEqual(["runs:read"]);
    // Scoped and audience-bound: it can read runs but not trigger them, and it
    // is valid for MCP only — never the REST surface.
    expect(hasScope(ctx!, "runs:read")).toBe(true);
    expect(hasScope(ctx!, "runs:trigger")).toBe(false);
    expect(allowsAudience(ctx!, "mcp")).toBe(true);
    expect(allowsAudience(ctx!, "v1")).toBe(false);
    expect(isOAuthToken(ctx!)).toBe(true);

    // Looked up by hash, and expiry/revocation pushed into the query (is/gt).
    expect(client.eqCalls).toContainEqual(["token_hash", hashApiKey("lt_oauth_whatever")]);
    // Stamps last_used on both the token and its standing authorization.
    expect(client.updates).toHaveLength(2);
  });
});

describe("scope + audience helpers", () => {
  const oauth: ApiAuthContext = {
    supabase: {} as never,
    userId: "u",
    keyId: "at",
    tokenType: "oauth",
    scopes: ["projects:read"],
    clientId: "lt_cli",
    expiresAt: "2999-01-01T00:00:00.000Z",
    aud: "v1",
  };

  it("hasScope is deny-by-default for a scope not granted", () => {
    expect(hasScope(oauth, "projects:read")).toBe(true);
    expect(hasScope(oauth, "projects:write")).toBe(false);
  });

  it("an audience-bound token is rejected on the other surface", () => {
    expect(allowsAudience(oauth, "v1")).toBe(true);
    expect(allowsAudience(oauth, "mcp")).toBe(false);
  });

  it("an empty-scope token grants nothing", () => {
    const empty: ApiAuthContext = { ...oauth, scopes: [] };
    expect(hasScope(empty, "projects:read")).toBe(false);
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

import crypto from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  authenticateClient,
  dataScopesOf,
  getClient,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  OAuthError,
  parseBasicAuth,
  parseScopeString,
  redirectUriAllowed,
  resolveAudience,
  validateScopes,
  validCodeVerifier,
  verifyClientSecret,
  verifyPkce,
  type OAuthClient,
} from "@/lib/oauth";
import { sha256Hex } from "@/lib/crypto";

// A real 32-byte key so the refresh-retry successor pair can be encrypted.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

const cliClient: OAuthClient = {
  client_id: "lt_cli",
  user_id: null,
  is_first_party: true,
  client_name: "Lettertrace CLI",
  client_type: "public",
  client_secret_hash: null,
  token_endpoint_auth_method: "none",
  redirect_uris: ["http://127.0.0.1/callback", "http://[::1]/callback"],
  allowed_scopes: ["projects:read", "projects:write", "runs:read", "runs:trigger", "offline_access"],
  logo_uri: null,
  client_uri: null,
};

const httpsClient: OAuthClient = {
  ...cliClient,
  client_id: "acme",
  is_first_party: false,
  client_type: "confidential",
  client_secret_hash: sha256Hex("s3cret"),
  token_endpoint_auth_method: "client_secret_basic",
  redirect_uris: ["https://acme.example.com/oauth/callback"],
};

function s256(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

describe("PKCE", () => {
  const verifier = "a".repeat(64);
  const challenge = s256(verifier);

  it("accepts a correct S256 verifier", () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    expect(verifyPkce("b".repeat(64), challenge)).toBe(false);
  });

  it("rejects a verifier that is too short or has illegal chars", () => {
    expect(validCodeVerifier("short")).toBe(false);
    expect(validCodeVerifier("a".repeat(42))).toBe(false);
    expect(validCodeVerifier("a".repeat(43))).toBe(true);
    expect(validCodeVerifier("a".repeat(129))).toBe(false);
    expect(validCodeVerifier("has spaces " + "a".repeat(40))).toBe(false);
    // A malformed verifier never passes PKCE even against a matching-looking hash.
    expect(verifyPkce("short", s256("short"))).toBe(false);
  });
});

describe("redirectUriAllowed", () => {
  it("allows any port on a registered loopback template", () => {
    expect(redirectUriAllowed(cliClient, "http://127.0.0.1:49152/callback")).toBe(true);
    expect(redirectUriAllowed(cliClient, "http://127.0.0.1:1/callback")).toBe(true);
    expect(redirectUriAllowed(cliClient, "http://[::1]:8080/callback")).toBe(true);
  });

  it("rejects a non-loopback host even on the right path", () => {
    expect(redirectUriAllowed(cliClient, "http://evil.com/callback")).toBe(false);
    expect(redirectUriAllowed(cliClient, "http://127.0.0.1.evil.com/callback")).toBe(false);
    // localhost (DNS) is deliberately not accepted — only the IP literal.
    expect(redirectUriAllowed(cliClient, "http://localhost:5000/callback")).toBe(false);
  });

  it("rejects a wrong path, embedded userinfo, query, or fragment", () => {
    expect(redirectUriAllowed(cliClient, "http://127.0.0.1:5000/evil")).toBe(false);
    expect(redirectUriAllowed(cliClient, "http://127.0.0.1:5000/callback/../evil")).toBe(false);
    expect(redirectUriAllowed(cliClient, "http://user:pass@127.0.0.1:5000/callback")).toBe(false);
    expect(redirectUriAllowed(cliClient, "http://127.0.0.1:5000/callback?x=1")).toBe(false);
    expect(redirectUriAllowed(cliClient, "http://127.0.0.1:5000/callback#frag")).toBe(false);
    expect(redirectUriAllowed(cliClient, "https://127.0.0.1:5000/callback")).toBe(false);
  });

  it("requires an exact match for an https client", () => {
    expect(redirectUriAllowed(httpsClient, "https://acme.example.com/oauth/callback")).toBe(true);
    expect(redirectUriAllowed(httpsClient, "https://acme.example.com/oauth/callback/")).toBe(false);
    expect(redirectUriAllowed(httpsClient, "https://acme.example.com.evil.com/oauth/callback")).toBe(false);
    expect(redirectUriAllowed(httpsClient, "https://acme.example.com/oauth/callback?x=1")).toBe(false);
  });

  it("rejects unparseable input", () => {
    expect(redirectUriAllowed(cliClient, "not a url")).toBe(false);
    expect(redirectUriAllowed(cliClient, "")).toBe(false);
  });
});

describe("scopes", () => {
  it("parses and dedupes a scope string", () => {
    expect(parseScopeString("a  b\tb")).toEqual(["a", "b"]);
    expect(parseScopeString("")).toEqual([]);
    expect(parseScopeString(null)).toEqual([]);
  });

  it("grants only known scopes allowed for the client, rest are invalid", () => {
    const v = validateScopes(
      ["projects:read", "runs:trigger", "made:up", "runs:read"],
      ["projects:read", "runs:read"],
    );
    expect(v.granted).toEqual(["projects:read", "runs:read"]);
    expect(v.invalid).toEqual(["runs:trigger", "made:up"]);
  });

  it("drops offline_access from the data-scope set", () => {
    expect(dataScopesOf(["projects:read", "offline_access"])).toEqual(["projects:read"]);
  });
});

describe("resolveAudience", () => {
  it("defaults to the REST API when absent", () => {
    expect(resolveAudience(null)).toBe("v1");
    expect(resolveAudience(undefined)).toBe("v1");
  });
  it("accepts short tokens and full resource URLs", () => {
    expect(resolveAudience("mcp")).toBe("mcp");
    expect(resolveAudience("v1")).toBe("v1");
    expect(resolveAudience("https://app.example.com/api/mcp")).toBe("mcp");
    expect(resolveAudience("https://app.example.com/api/v1/")).toBe("v1");
  });
  it("rejects an explicit but unrecognized resource", () => {
    expect(resolveAudience("https://app.example.com/other")).toBeNull();
    expect(resolveAudience("garbage")).toBeNull();
  });
});

describe("client auth primitives", () => {
  it("parses Basic auth, tolerating malformed input", () => {
    const header = "Basic " + Buffer.from("acme:s3cret").toString("base64");
    expect(parseBasicAuth(header)).toEqual({ clientId: "acme", secret: "s3cret" });
    expect(parseBasicAuth(null)).toBeNull();
    expect(parseBasicAuth("Bearer x")).toBeNull();
  });

  it("verifies a client secret in constant time", () => {
    expect(verifyClientSecret(httpsClient, "s3cret")).toBe(true);
    expect(verifyClientSecret(httpsClient, "wrong")).toBe(false);
    expect(verifyClientSecret(cliClient, "anything")).toBe(false); // public: no secret
  });
});

// --- programmable fake supabase client for the state machines --------
function makeClient(
  responder: (table: string, chain: unknown[][], terminal: string) => { data?: unknown; error?: unknown },
) {
  return {
    from(table: string) {
      const chain: unknown[][] = [];
      const rec = (op: string) => (...a: unknown[]) => (chain.push([op, ...a]), builder);
      const builder: Record<string, unknown> = {
        select: rec("select"),
        insert: rec("insert"),
        update: rec("update"),
        upsert: rec("upsert"),
        delete: rec("delete"),
        eq: rec("eq"),
        is: rec("is"),
        gt: rec("gt"),
        maybeSingle: () => Promise.resolve(responder(table, chain, "maybeSingle")),
        single: () => Promise.resolve(responder(table, chain, "single")),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(responder(table, chain, "await")).then(resolve, reject),
      };
      return builder;
    },
  } as never;
}

const patchOf = (chain: unknown[][], op: string): Record<string, unknown> | undefined =>
  chain.find((c) => c[0] === op)?.[1] as Record<string, unknown> | undefined;
const hasOp = (chain: unknown[][], op: string): boolean => chain.some((c) => c[0] === op);

describe("exchangeAuthorizationCode", () => {
  const verifier = "a".repeat(64);
  const challenge = s256(verifier);
  const codeRow = {
    client_id: "lt_cli",
    redirect_uri: "http://127.0.0.1:5000/callback",
    code_challenge: challenge,
    scopes: ["projects:read", "offline_access"],
    resource: "v1",
    user_id: "u1",
    authorization_id: "az1",
  };

  const responder =
    (row: unknown) => (table: string, chain: unknown[][], terminal: string) => {
      if (table === "oauth_authorization_codes") return { data: row, error: null };
      if (table === "oauth_access_tokens") return { data: null, error: null };
      if (table === "oauth_refresh_tokens" && terminal === "single")
        return { data: { id: "rt1" }, error: null };
      return { data: null, error: null };
    };

  it("mints an access + refresh pair on the happy path", async () => {
    const client = makeClient(responder(codeRow));
    const resp = await exchangeAuthorizationCode(client, cliClient, {
      code: "lt_code_x",
      redirectUri: "http://127.0.0.1:5000/callback",
      codeVerifier: verifier,
    });
    expect(resp.access_token).toMatch(/^lt_oauth_/);
    expect(resp.refresh_token).toMatch(/^lt_refr_/); // offline_access requested
    expect(resp.scope).toBe("projects:read"); // offline_access is not a data scope
    expect(resp.token_type).toBe("Bearer");
  });

  it("rejects a mismatched redirect_uri", async () => {
    const client = makeClient(responder(codeRow));
    await expect(
      exchangeAuthorizationCode(client, cliClient, {
        code: "lt_code_x",
        redirectUri: "http://127.0.0.1:9999/callback",
        codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects a bad PKCE verifier", async () => {
    const client = makeClient(responder(codeRow));
    await expect(
      exchangeAuthorizationCode(client, cliClient, {
        code: "lt_code_x",
        redirectUri: "http://127.0.0.1:5000/callback",
        codeVerifier: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects an already-used or expired code (atomic consume returns nothing)", async () => {
    const client = makeClient(responder(null));
    await expect(
      exchangeAuthorizationCode(client, cliClient, {
        code: "lt_code_x",
        redirectUri: "http://127.0.0.1:5000/callback",
        codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("exchangeRefreshToken rotation + reuse detection", () => {
  const liveRow = {
    id: "rt-old",
    client_id: "lt_cli",
    family_id: "fam1",
    scopes: ["runs:read"],
    resource: "v1",
    user_id: "u1",
    authorization_id: "az1",
  };

  it("rotates: consumes the old token and issues a new pair", async () => {
    const client = makeClient((table, chain, terminal) => {
      if (table === "oauth_refresh_tokens" && hasOp(chain, "update") && patchOf(chain, "update")?.used_at) {
        return { data: liveRow, error: null }; // atomic consume succeeds
      }
      if (table === "oauth_refresh_tokens" && terminal === "single") return { data: { id: "rt-new" }, error: null };
      return { data: null, error: null };
    });
    const resp = await exchangeRefreshToken(client, cliClient, "lt_refr_old");
    expect(resp.access_token).toMatch(/^lt_oauth_/);
    expect(resp.refresh_token).toMatch(/^lt_refr_/);
  });

  it("detects reuse of a spent token and revokes the whole family", async () => {
    const revoked: string[] = [];
    const usedAt = new Date(Date.now() - 60_000).toISOString(); // well outside grace
    const client = makeClient((table, chain, _terminal) => {
      // Atomic consume finds nothing (already used).
      if (table === "oauth_refresh_tokens" && hasOp(chain, "update") && patchOf(chain, "update")?.used_at) {
        return { data: null, error: null };
      }
      // Lookup-by-hash returns the spent token.
      if (table === "oauth_refresh_tokens" && hasOp(chain, "select") && !hasOp(chain, "update")) {
        return { data: { ...liveRow, used_at: usedAt, revoked_at: null, successor_pair: null }, error: null };
      }
      // Family revocation sweeps.
      if (hasOp(chain, "update") && patchOf(chain, "update")?.revoked_at) {
        revoked.push(table);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });

    await expect(exchangeRefreshToken(client, cliClient, "lt_refr_spent")).rejects.toMatchObject({
      code: "invalid_grant",
    });
    expect(revoked).toContain("oauth_access_tokens");
    expect(revoked).toContain("oauth_refresh_tokens");
  });
});

describe("authenticateClient", () => {
  it("rejects an unknown client id", async () => {
    const client = makeClient(() => ({ data: null, error: null }));
    await expect(
      authenticateClient(client, { bodyClientId: "nope", authHeader: null }),
    ).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("getClient", () => {
  const fake = (result: { data?: unknown; error?: { message: string } | null }) =>
    ({
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null, ...result }) }),
        }),
      }),
    }) as never;

  it("returns null for a missing row and for an empty id", async () => {
    expect(await getClient(fake({ data: null }), "nope")).toBeNull();
    expect(await getClient(fake({ data: cliClient }), "")).toBeNull();
  });

  it("returns the row when present", async () => {
    expect(await getClient(fake({ data: cliClient }), "lt_cli")).toEqual(cliClient);
  });

  it("throws on a query error instead of reporting an unknown client (#115)", async () => {
    await expect(getClient(fake({ error: { message: "boom" } }), "lt_cli")).rejects.toMatchObject({
      code: "server_error",
      status: 500,
    });
  });
});

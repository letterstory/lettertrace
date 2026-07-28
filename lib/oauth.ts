import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decryptSecret,
  encryptSecret,
  generateAuthCode,
  generateOAuthAccessToken,
  generateRefreshToken,
  oauthTokenHint,
  sha256Hex,
} from "@/lib/crypto";
import { resolveRedirectBase } from "@/lib/utils";
import type { ResourceAudience } from "@/lib/api-auth";

// ==================================================================
// OAuth 2.1 Authorization Server core.
//
// This module is the trusted center of the AS: PKCE verification, exact
// redirect-URI matching, client authentication, and the atomic state machines
// for authorization codes and refresh-token rotation. The pure functions here
// (verifyPkce, redirectUriAllowed, parseScopes, resolveAudience, …) carry the
// security-critical logic and are unit-tested without a database. The
// DB-touching functions all run through the service-role client and scope every
// row by a SERVER-derived user id — never a value from the request body.
// ==================================================================

// --- config ---------------------------------------------------------

const int = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const ACCESS_TTL_SEC = int(process.env.OAUTH_ACCESS_TTL, 3600); // 1 hour
export const REFRESH_TTL_SEC = int(process.env.OAUTH_REFRESH_TTL, 30 * 24 * 3600); // 30 days
export const REFRESH_GRACE_SEC = int(process.env.OAUTH_REFRESH_GRACE, 10); // retry window
export const CODE_TTL_SEC = 300; // 5 minutes
export const PENDING_TTL_SEC = 600; // 10 minutes to complete login + consent

// Data-access scopes (what an access token can carry) plus offline_access, the
// request-time flag that additionally asks for a refresh token.
export const DATA_SCOPES = [
  "projects:read",
  "projects:write",
  "runs:read",
  "runs:trigger",
  // BYOK provider keys get their own pair rather than riding on projects:write.
  // Handing someone the ability to swap the key that every run is billed to is
  // a different decision from letting them add a prompt, and the consent screen
  // is the only place a user ever gets to make it.
  "keys:read",
  "keys:write",
] as const;
export const OFFLINE_ACCESS = "offline_access";
export const KNOWN_SCOPES = [...DATA_SCOPES, OFFLINE_ACCESS] as const;

// Human-readable scope descriptions for the consent screen.
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "projects:read": "View your organizations and their prompts",
  "projects:write": "Create organizations and add or edit prompts",
  "runs:read": "Read your monitoring runs and share-of-voice reports",
  "runs:trigger": "Start new monitoring runs (spends your provider key)",
  "keys:read": "See which AI provider keys you've stored (masked, never the key itself)",
  "keys:write": "Replace or remove the AI provider keys your runs are billed to",
  [OFFLINE_ACCESS]: "Stay connected without you signing in again",
};

export interface OAuthClient {
  client_id: string;
  user_id: string | null;
  is_first_party: boolean;
  client_name: string;
  client_type: "public" | "confidential";
  client_secret_hash: string | null;
  token_endpoint_auth_method: "none" | "client_secret_basic";
  redirect_uris: string[];
  allowed_scopes: string[];
  logo_uri: string | null;
  client_uri: string | null;
}

/** An OAuth error carrying an RFC 6749 §5.2 error code. Machine endpoints render
 *  ONLY this code (never a raw message), so nothing internal leaks. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number = 400,
    readonly description?: string,
  ) {
    super(code);
    this.name = "OAuthError";
  }
}

// --- base URL -------------------------------------------------------

export function siteBase(request: Request): string {
  const origin = (() => {
    try {
      return new URL(request.url).origin;
    } catch {
      return "";
    }
  })();
  return resolveRedirectBase(process.env.NEXT_PUBLIC_SITE_URL, origin).replace(/\/+$/, "");
}

// --- scopes ---------------------------------------------------------

/** Split a scope string into a deduped list of recognized scopes. Unknown
 *  scopes are dropped by the caller's validation, not silently kept. */
export function parseScopeString(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const s of raw.split(/\s+/)) {
    const t = s.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

export interface ScopeValidation {
  granted: string[]; // the scopes to actually grant (intersection, order-stable)
  invalid: string[]; // requested scopes that are unknown or not allowed for this client
}

/**
 * Reconcile requested scopes against what exists and what this client may hold.
 * Deny-by-default: anything unknown or outside the client's allow-list is
 * reported as invalid and never granted.
 */
export function validateScopes(
  requested: string[],
  clientAllowed: string[],
): ScopeValidation {
  const known = new Set<string>(KNOWN_SCOPES);
  const allowed = new Set(clientAllowed);
  const granted: string[] = [];
  const invalid: string[] = [];
  for (const s of requested) {
    if (known.has(s) && allowed.has(s)) granted.push(s);
    else invalid.push(s);
  }
  return { granted, invalid };
}

/** The data-access subset (drops offline_access, which is not a data permission
 *  and would violate the access-token scope CHECK if stored). */
export function dataScopesOf(scopes: string[]): string[] {
  return scopes.filter((s) => s !== OFFLINE_ACCESS);
}

// --- audience (RFC 8707 resource indicator) -------------------------

/** Map the `resource` parameter to the surface a token is bound to. Absent =>
 *  the REST API (the default a CLI wants). An explicit-but-unrecognized resource
 *  returns null so the caller can reject it rather than guess. */
export function resolveAudience(
  resourceParam: string | null | undefined,
): ResourceAudience | null {
  if (!resourceParam) return "v1";
  const v = resourceParam.trim().toLowerCase();
  if (v === "v1" || v === "mcp") return v;
  try {
    const path = new URL(resourceParam).pathname.replace(/\/+$/, "");
    if (path.endsWith("/api/mcp")) return "mcp";
    if (path.endsWith("/api/v1")) return "v1";
  } catch {
    /* not a URL */
  }
  return null;
}

// --- PKCE (RFC 7636, S256 only) -------------------------------------

/** A code_verifier per RFC 7636: 43–128 chars from the unreserved set. */
export function validCodeVerifier(v: string | null | undefined): boolean {
  return typeof v === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}

/** Constant-time S256 PKCE check: base64url(sha256(verifier)) === challenge. */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!validCodeVerifier(codeVerifier)) return false;
  const computed = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- redirect URI matching (RFC 8252 for loopback) ------------------

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/**
 * Whether `redirectUri` is permitted for `client`. Two rules:
 *   - A registered loopback template (http + 127.0.0.1/::1) matches any port on
 *     the same scheme/host/path — and ONLY loopback, with no embedded userinfo,
 *     query, or fragment. This is the native-app pattern the CLI uses.
 *   - Every other registered URI (https confidential/DCR clients) must match
 *     the full string EXACTLY.
 * Parsing is via the URL API, never substring checks, so userinfo, subdomain,
 * and path-traversal evasions all fail.
 */
export function redirectUriAllowed(client: OAuthClient, redirectUri: string): boolean {
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return false;
  }
  // Embedded credentials can disguise the true destination host.
  if (u.username !== "" || u.password !== "") return false;

  for (const registered of client.redirect_uris) {
    let r: URL;
    try {
      r = new URL(registered);
    } catch {
      continue;
    }
    const registeredIsLoopback = r.protocol === "http:" && isLoopbackHost(r.hostname);
    if (registeredIsLoopback) {
      if (
        u.protocol === "http:" &&
        isLoopbackHost(u.hostname) &&
        u.pathname === r.pathname &&
        u.search === "" &&
        u.hash === ""
      ) {
        return true;
      }
    } else if (redirectUri === registered) {
      return true;
    }
  }
  return false;
}

// --- client authentication ------------------------------------------

export function parseBasicAuth(
  header: string | null,
): { clientId: string; secret: string } | null {
  if (!header) return null;
  const m = header.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return {
    clientId: decodeURIComponent(decoded.slice(0, idx)),
    secret: decodeURIComponent(decoded.slice(idx + 1)),
  };
}

export function verifyClientSecret(client: OAuthClient, presentedSecret: string): boolean {
  if (!client.client_secret_hash) return false;
  const a = Buffer.from(sha256Hex(presentedSecret));
  const b = Buffer.from(client.client_secret_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- DB helpers -----------------------------------------------------

const CLIENT_COLUMNS =
  "client_id, user_id, is_first_party, client_name, client_type, client_secret_hash, token_endpoint_auth_method, redirect_uris, allowed_scopes, logo_uri, client_uri";

export async function getClient(
  supabase: SupabaseClient,
  clientId: string,
): Promise<OAuthClient | null> {
  if (!clientId) return null;
  const { data } = await supabase
    .from("oauth_clients")
    .select(CLIENT_COLUMNS)
    .eq("client_id", clientId)
    .maybeSingle();
  return (data as OAuthClient | null) ?? null;
}

/** Resolve and authenticate the client at the token endpoint. Confidential
 *  clients MUST present a valid client_secret_basic; public clients must NOT
 *  present a secret (they are identified by PKCE + exact redirect match). */
export async function authenticateClient(
  supabase: SupabaseClient,
  opts: { bodyClientId?: string | null; authHeader: string | null },
): Promise<OAuthClient> {
  const basic = parseBasicAuth(opts.authHeader);
  const clientId = basic?.clientId ?? opts.bodyClientId ?? "";
  const client = await getClient(supabase, clientId);
  if (!client) throw new OAuthError("invalid_client", 401);

  if (client.token_endpoint_auth_method === "client_secret_basic") {
    if (!basic || basic.clientId !== client.client_id || !verifyClientSecret(client, basic.secret)) {
      throw new OAuthError("invalid_client", 401);
    }
  } else if (basic && basic.secret) {
    // A public client that suddenly presents a secret is misconfigured or spoofed.
    throw new OAuthError("invalid_client", 401);
  }
  return client;
}

// --- pending authorize requests -------------------------------------

export interface PendingRequest {
  id: string;
  user_id: string | null;
  client_id: string;
  redirect_uri: string;
  scopes: string[];
  resource: string;
  state: string | null;
  code_challenge: string;
  consent_nonce: string | null;
  expires_at: string;
}

export async function createPendingRequest(
  supabase: SupabaseClient,
  data: {
    userId: string | null;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    resource: string;
    state: string | null;
    codeChallenge: string;
  },
): Promise<string> {
  const expires = new Date(Date.now() + PENDING_TTL_SEC * 1000).toISOString();
  const { data: row, error } = await supabase
    .from("oauth_pending_requests")
    .insert({
      user_id: data.userId,
      client_id: data.clientId,
      redirect_uri: data.redirectUri,
      scopes: data.scopes,
      resource: data.resource,
      state: data.state,
      code_challenge: data.codeChallenge,
      expires_at: expires,
    })
    .select("id")
    .single();
  if (error || !row) throw new OAuthError("server_error", 500);
  return row.id as string;
}

export async function getPendingRequest(
  supabase: SupabaseClient,
  id: string,
): Promise<PendingRequest | null> {
  if (!id) return null;
  const { data } = await supabase
    .from("oauth_pending_requests")
    .select("*")
    .eq("id", id)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return (data as PendingRequest | null) ?? null;
}

/**
 * Bind a logged-in user to their pending request and set a fresh consent nonce.
 * Refuses if the request already belongs to a different user. Returns the nonce
 * the consent form must echo back, or null if the request is gone/mismatched.
 */
export async function claimPendingForUser(
  supabase: SupabaseClient,
  id: string,
  userId: string,
): Promise<{ pending: PendingRequest; nonce: string } | null> {
  const pending = await getPendingRequest(supabase, id);
  if (!pending) return null;
  if (pending.user_id && pending.user_id !== userId) return null;

  const nonce = crypto.randomBytes(24).toString("base64url");
  const { data, error } = await supabase
    .from("oauth_pending_requests")
    .update({ user_id: userId, consent_nonce: nonce })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error || !data) return null;
  return { pending: data as PendingRequest, nonce };
}

/** Atomically single-use-consume a pending request at consent time: it must
 *  match the id, the current user, and the nonce shown on the page. Returns the
 *  row (and removes it) or null. */
export async function consumePendingForConsent(
  supabase: SupabaseClient,
  id: string,
  userId: string,
  nonce: string,
): Promise<PendingRequest | null> {
  if (!id || !nonce) return null;
  const { data } = await supabase
    .from("oauth_pending_requests")
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .eq("consent_nonce", nonce)
    .gt("expires_at", new Date().toISOString())
    .select("*")
    .maybeSingle();
  return (data as PendingRequest | null) ?? null;
}

// --- authorizations + codes -----------------------------------------

export async function upsertAuthorization(
  supabase: SupabaseClient,
  data: { userId: string; clientId: string; resource: string; scopes: string[] },
): Promise<string> {
  const { data: row, error } = await supabase
    .from("oauth_authorizations")
    .upsert(
      {
        user_id: data.userId,
        client_id: data.clientId,
        resource: data.resource,
        scopes: data.scopes,
        granted_at: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: "user_id,client_id,resource" },
    )
    .select("id")
    .single();
  if (error || !row) throw new OAuthError("server_error", 500);
  return row.id as string;
}

/** Mint a single-use authorization code, returning the plaintext (delivered via
 *  the redirect). Only the hash is stored. */
export async function issueAuthorizationCode(
  supabase: SupabaseClient,
  data: {
    userId: string;
    clientId: string;
    authorizationId: string;
    codeChallenge: string;
    redirectUri: string;
    scopes: string[];
    resource: string;
  },
): Promise<string> {
  const code = generateAuthCode();
  const { error } = await supabase.from("oauth_authorization_codes").insert({
    user_id: data.userId,
    client_id: data.clientId,
    authorization_id: data.authorizationId,
    code_hash: sha256Hex(code),
    code_challenge: data.codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: data.redirectUri,
    scopes: data.scopes,
    resource: data.resource,
    expires_at: new Date(Date.now() + CODE_TTL_SEC * 1000).toISOString(),
  });
  if (error) throw new OAuthError("server_error", 500);
  return code;
}

// --- token minting + rotation ---------------------------------------

interface MintResult {
  response: Record<string, unknown>;
  refreshId: string | null;
}

async function mintTokenPair(
  supabase: SupabaseClient,
  data: {
    userId: string;
    clientId: string;
    authorizationId: string | null;
    familyId: string;
    dataScopes: string[];
    resource: string;
    withRefresh: boolean;
  },
): Promise<MintResult> {
  const now = Date.now();
  const accessPlain = generateOAuthAccessToken();
  const { error: atErr } = await supabase.from("oauth_access_tokens").insert({
    user_id: data.userId,
    client_id: data.clientId,
    authorization_id: data.authorizationId,
    family_id: data.familyId,
    token_hash: sha256Hex(accessPlain),
    token_hint: oauthTokenHint(accessPlain),
    scopes: data.dataScopes,
    resource: data.resource,
    expires_at: new Date(now + ACCESS_TTL_SEC * 1000).toISOString(),
  });
  if (atErr) throw new OAuthError("server_error", 500);

  const response: Record<string, unknown> = {
    access_token: accessPlain,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    scope: data.dataScopes.join(" "),
  };

  let refreshId: string | null = null;
  if (data.withRefresh) {
    const refreshPlain = generateRefreshToken();
    const { data: rt, error: rtErr } = await supabase
      .from("oauth_refresh_tokens")
      .insert({
        user_id: data.userId,
        client_id: data.clientId,
        authorization_id: data.authorizationId,
        family_id: data.familyId,
        token_hash: sha256Hex(refreshPlain),
        scopes: data.dataScopes,
        resource: data.resource,
        expires_at: new Date(now + REFRESH_TTL_SEC * 1000).toISOString(),
      })
      .select("id")
      .single();
    if (rtErr || !rt) throw new OAuthError("server_error", 500);
    refreshId = rt.id as string;
    response.refresh_token = refreshPlain;
  }
  return { response, refreshId };
}

/** Revoke an entire token family (all access + refresh tokens sharing the id).
 *  Used both by explicit revocation and by refresh-reuse detection. */
export async function revokeFamily(
  supabase: SupabaseClient,
  familyId: string,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  await supabase
    .from("oauth_access_tokens")
    .update({ revoked_at: nowIso })
    .eq("family_id", familyId)
    .is("revoked_at", null);
  await supabase
    .from("oauth_refresh_tokens")
    .update({ revoked_at: nowIso })
    .eq("family_id", familyId)
    .is("revoked_at", null);
}

/** authorization_code grant. Atomically consumes the code, then verifies client,
 *  exact redirect_uri, and PKCE before minting tokens. */
export async function exchangeAuthorizationCode(
  supabase: SupabaseClient,
  client: OAuthClient,
  params: { code?: string | null; redirectUri?: string | null; codeVerifier?: string | null },
): Promise<Record<string, unknown>> {
  const { code, redirectUri, codeVerifier } = params;
  if (!code || !redirectUri) throw new OAuthError("invalid_request", 400);
  if (!validCodeVerifier(codeVerifier ?? "")) throw new OAuthError("invalid_grant", 400);

  const nowIso = new Date().toISOString();
  const { data: row } = await supabase
    .from("oauth_authorization_codes")
    .update({ used_at: nowIso })
    .eq("code_hash", sha256Hex(code))
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .select("*")
    .maybeSingle();
  if (!row) throw new OAuthError("invalid_grant", 400);
  if (row.client_id !== client.client_id) throw new OAuthError("invalid_grant", 400);
  if (row.redirect_uri !== redirectUri) throw new OAuthError("invalid_grant", 400);
  if (!verifyPkce(codeVerifier!, row.code_challenge)) throw new OAuthError("invalid_grant", 400);

  const scopes = row.scopes as string[];
  const dataScopes = dataScopesOf(scopes);
  if (dataScopes.length === 0) throw new OAuthError("invalid_scope", 400);

  const { response } = await mintTokenPair(supabase, {
    userId: row.user_id,
    clientId: row.client_id,
    authorizationId: row.authorization_id,
    familyId: crypto.randomUUID(),
    dataScopes,
    resource: row.resource,
    withRefresh: scopes.includes(OFFLINE_ACCESS),
  });
  return response;
}

/** refresh_token grant with rotation, reuse detection, and an encrypted
 *  idempotency window so a network-retried refresh does not self-revoke. */
export async function exchangeRefreshToken(
  supabase: SupabaseClient,
  client: OAuthClient,
  refreshTokenPlain: string | null | undefined,
): Promise<Record<string, unknown>> {
  if (!refreshTokenPlain) throw new OAuthError("invalid_request", 400);
  const hash = sha256Hex(refreshTokenPlain);
  const nowIso = new Date().toISOString();

  // Atomic single-use consume of a live token.
  const { data: consumed } = await supabase
    .from("oauth_refresh_tokens")
    .update({ used_at: nowIso })
    .eq("token_hash", hash)
    .is("used_at", null)
    .is("revoked_at", null)
    .gt("expires_at", nowIso)
    .select("*")
    .maybeSingle();

  if (consumed) {
    if (consumed.client_id !== client.client_id) {
      await revokeFamily(supabase, consumed.family_id, nowIso);
      throw new OAuthError("invalid_grant", 400);
    }
    const dataScopes = dataScopesOf(consumed.scopes as string[]);
    const { response } = await mintTokenPair(supabase, {
      userId: consumed.user_id,
      clientId: consumed.client_id,
      authorizationId: consumed.authorization_id,
      familyId: consumed.family_id,
      dataScopes,
      resource: consumed.resource,
      withRefresh: true,
    });
    // Record the successor pair (encrypted) so a retried refresh replays it.
    let successor: string | null = null;
    try {
      successor = encryptSecret(JSON.stringify(response));
    } catch {
      successor = null; // encryption unavailable: degrade to no-replay, not a crash
    }
    await supabase
      .from("oauth_refresh_tokens")
      .update({ successor_pair: successor })
      .eq("id", consumed.id);
    return response;
  }

  // Consume failed. Distinguish reuse (revoke family) from a retriable replay.
  const { data: existing } = await supabase
    .from("oauth_refresh_tokens")
    .select("*")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!existing || existing.revoked_at) throw new OAuthError("invalid_grant", 400);

  if (existing.used_at) {
    const withinGrace =
      Date.now() - new Date(existing.used_at).getTime() <= REFRESH_GRACE_SEC * 1000;
    if (withinGrace && existing.successor_pair) {
      try {
        return JSON.parse(decryptSecret(existing.successor_pair as string));
      } catch {
        /* fall through to reuse handling */
      }
    }
    // A used refresh token presented outside the grace window is a leak signal.
    await revokeFamily(supabase, existing.family_id, nowIso);
    throw new OAuthError("invalid_grant", 400);
  }

  throw new OAuthError("invalid_grant", 400);
}

/** RFC 7009 revoke-by-token: possession is the authorization. Revokes the whole
 *  family so presenting any token in a session kills the session. Always a no-op
 *  when the token is unknown (the endpoint still returns 200). */
export async function revokeByToken(
  supabase: SupabaseClient,
  tokenPlain: string,
): Promise<void> {
  const hash = sha256Hex(tokenPlain);
  const nowIso = new Date().toISOString();

  const { data: at } = await supabase
    .from("oauth_access_tokens")
    .select("family_id")
    .eq("token_hash", hash)
    .maybeSingle();
  if (at?.family_id) {
    await revokeFamily(supabase, at.family_id, nowIso);
    return;
  }
  const { data: rt } = await supabase
    .from("oauth_refresh_tokens")
    .select("family_id")
    .eq("token_hash", hash)
    .maybeSingle();
  if (rt?.family_id) {
    await revokeFamily(supabase, rt.family_id, nowIso);
  }
}

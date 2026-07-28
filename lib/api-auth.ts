import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { hashApiKey } from "@/lib/crypto";

// Bearer-token auth for the programmatic surface (/api/v1 and /api/mcp).
// Requests carry a Lettertrace credential instead of a Supabase session, so the
// returned client is the service-role client: RLS is bypassed and every query
// made with it MUST be scoped by userId explicitly.
//
// Two credential classes resolve through here to the SAME context shape:
//   - classic api_keys ("lt_live_…"): indefinite, full-access, hand-minted.
//   - OAuth access tokens ("lt_oauth_…"): short-lived, scoped, revocable,
//     audience-bound, obtained via the OAuth flow (lib/oauth.ts). A classic key
//     behaves exactly as before because it is handed the full scope set and no
//     audience restriction.

/** The scopes a classic api_keys credential is treated as holding. Also the
 *  full set an OAuth client can ever be granted (minus offline_access, which is
 *  a request-time flag for a refresh token, not a data permission). */
export const FULL_SCOPES = [
  "projects:read",
  "projects:write",
  "runs:read",
  "runs:trigger",
  "keys:read",
  "keys:write",
] as const;

export type Scope = (typeof FULL_SCOPES)[number];
export type TokenType = "api_key" | "oauth";
/** RFC 8707 resource audience: which programmatic surface a token may call. */
export type ResourceAudience = "v1" | "mcp";

export interface ApiAuthContext {
  supabase: SupabaseClient;
  userId: string;
  /** Row id of the resolving credential (api_keys.id or oauth_access_tokens.id). */
  keyId: string;
  tokenType: TokenType;
  /** Granted scopes. A classic api_key carries FULL_SCOPES. */
  scopes: string[];
  /** OAuth client id, or null for a classic api_key. */
  clientId: string | null;
  /** ISO expiry, or null for a (non-expiring) classic api_key. */
  expiresAt: string | null;
  /** Bound audience, or null for a classic api_key (which may call anything). */
  aud: ResourceAudience | null;
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** True when the context is allowed to exercise `scope`. */
export function hasScope(ctx: ApiAuthContext, scope: Scope): boolean {
  return ctx.scopes.includes(scope);
}

/** True when the context may call the given surface. A classic api_key (aud
 *  null) may call anything; an OAuth token is bound to exactly one audience. */
export function allowsAudience(ctx: ApiAuthContext, aud: ResourceAudience): boolean {
  return ctx.aud === null || ctx.aud === aud;
}

export function isOAuthToken(
  ctx: ApiAuthContext,
): ctx is ApiAuthContext & { tokenType: "oauth"; clientId: string; aud: ResourceAudience } {
  return ctx.tokenType === "oauth";
}

/**
 * Resolve a bearer token to its owner and permissions. Returns null for a
 * missing, unknown, expired, or revoked credential.
 *
 * Fail-closed: expiry and revocation are pushed into the SQL WHERE clause, so a
 * query error or a missing row yields null (no access), never a context.
 * Touches last_used_at so the settings pages can show stale credentials.
 */
export async function authenticateApiKey(
  token: string | null | undefined,
): Promise<ApiAuthContext | null> {
  if (!token) return null;
  const supabase = createServiceClient();
  const hash = hashApiKey(token);

  // 1. Classic Lettertrace API key. Unchanged behavior: full access, no expiry.
  const { data: apiKey } = await supabase
    .from("api_keys")
    .select("id, user_id")
    .eq("key_hash", hash)
    .maybeSingle();
  if (apiKey) {
    await supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", apiKey.id);
    return {
      supabase,
      userId: apiKey.user_id as string,
      keyId: apiKey.id as string,
      tokenType: "api_key",
      scopes: [...FULL_SCOPES],
      clientId: null,
      expiresAt: null,
      aud: null,
    };
  }

  // 2. OAuth access token. Expiry + revocation are enforced in SQL, so this
  //    only ever returns a live token. Revocation cascades to this row (the
  //    revoke path and refresh-reuse detection both stamp revoked_at here), so
  //    the grant does not need a second lookup on the hot path.
  const nowIso = new Date().toISOString();
  const { data: oauth } = await supabase
    .from("oauth_access_tokens")
    .select("id, user_id, client_id, scopes, resource, expires_at, authorization_id")
    .eq("token_hash", hash)
    .is("revoked_at", null)
    .gt("expires_at", nowIso)
    .maybeSingle();
  if (oauth) {
    await supabase
      .from("oauth_access_tokens")
      .update({ last_used_at: nowIso })
      .eq("id", oauth.id);
    if (oauth.authorization_id) {
      await supabase
        .from("oauth_authorizations")
        .update({ last_used_at: nowIso })
        .eq("id", oauth.authorization_id);
    }
    return {
      supabase,
      userId: oauth.user_id as string,
      keyId: oauth.id as string,
      tokenType: "oauth",
      scopes: (oauth.scopes as string[]) ?? [],
      clientId: oauth.client_id as string,
      expiresAt: oauth.expires_at as string,
      aud: oauth.resource as ResourceAudience,
    };
  }

  return null;
}

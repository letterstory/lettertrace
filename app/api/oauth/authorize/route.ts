import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { clientIp, rateLimit } from "@/lib/oauth-ratelimit";
import { oauthErrorPage, oauthRedirectError } from "@/lib/oauth-responses";
import {
  createPendingRequest,
  dataScopesOf,
  getClient,
  parseScopeString,
  redirectUriAllowed,
  resolveAudience,
  siteBase,
  validateScopes,
} from "@/lib/oauth";

export const dynamic = "force-dynamic";

// GET /api/oauth/authorize — the OAuth 2.1 authorization endpoint.
//
// Validates the client and redirect URI FIRST (so an error can never be
// reflected to an unregistered destination), then PKCE, scopes, and the
// resource audience. The validated request is persisted server-side; only an
// opaque id travels through the (possible) login bounce and on to the consent
// screen, so the authorize parameters cannot be tampered with in transit.
export async function GET(request: Request) {
  const base = siteBase(request);
  const p = new URL(request.url).searchParams;

  // Pending rows are created here, before login — cap creation per IP.
  const rl = await rateLimit(`authorize:${clientIp(request)}`, 60, 60);
  if (!rl.allowed) {
    return oauthErrorPage("Too many authorization requests. Try again shortly.", 429);
  }

  const service = createServiceClient();
  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";

  const client = await getClient(service, clientId);
  if (!client) return oauthErrorPage("Unknown OAuth client.");
  if (!redirectUri || !redirectUriAllowed(client, redirectUri)) {
    return oauthErrorPage("The redirect URI is not registered for this client.");
  }

  // Past this point the redirect_uri is trusted, so protocol errors go back to it.
  const state = p.get("state");
  const fail = (code: string) => oauthRedirectError(redirectUri, code, state, base);

  if (p.get("response_type") !== "code") return fail("unsupported_response_type");

  const codeChallenge = p.get("code_challenge") ?? "";
  if (!codeChallenge || p.get("code_challenge_method") !== "S256") {
    // PKCE with S256 is mandatory for every client (OAuth 2.1 baseline).
    return fail("invalid_request");
  }

  const audience = resolveAudience(p.get("resource"));
  if (!audience) return fail("invalid_target");

  const requested = parseScopeString(p.get("scope"));
  const { granted, invalid } = validateScopes(
    requested.length ? requested : client.allowed_scopes,
    client.allowed_scopes,
  );
  if (invalid.length > 0) return fail("invalid_scope");
  if (dataScopesOf(granted).length === 0) return fail("invalid_scope");

  // Identify the approving user via the existing Supabase cookie session.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pendingId = await createPendingRequest(service, {
    userId: user?.id ?? null,
    clientId: client.client_id,
    redirectUri,
    scopes: granted,
    resource: audience,
    state,
    codeChallenge,
  });

  const consentPath = `/oauth/consent?req=${encodeURIComponent(pendingId)}`;
  if (!user) {
    const login = new URL("/login", base);
    login.searchParams.set("next", consentPath);
    return NextResponse.redirect(login, { status: 302 });
  }
  return NextResponse.redirect(new URL(consentPath, base), { status: 302 });
}

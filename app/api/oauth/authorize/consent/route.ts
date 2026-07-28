import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { oauthErrorPage, oauthRedirectError } from "@/lib/oauth-responses";
import {
  consumePendingForConsent,
  issueAuthorizationCode,
  OAuthError,
  siteBase,
  upsertAuthorization,
} from "@/lib/oauth";
import { clientLabel, logDashboard } from "@/lib/activity";

export const dynamic = "force-dynamic";

// POST /api/oauth/authorize/consent — the user's Approve/Deny decision.
//
// Session + CSRF: the user is re-derived from the Supabase session (never a
// hidden field), and the single-use nonce must match the one stored on the
// server-persisted request. Every grant parameter is read back from that
// persisted request, so nothing the form submitted can widen the grant.
export async function POST(request: Request) {
  const base = siteBase(request);

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return oauthErrorPage("Your session has expired. Start the authorization again.", 401);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthErrorPage("Malformed consent submission.");
  }
  const reqId = String(form.get("req") ?? "");
  const nonce = String(form.get("nonce") ?? "");
  const decision = String(form.get("decision") ?? "");

  const service = createServiceClient();
  const pending = await consumePendingForConsent(service, reqId, user.id, nonce);
  if (!pending) {
    return oauthErrorPage(
      "This authorization request has expired or was already used. Start again from your CLI or app.",
    );
  }

  // Re-derive EVERYTHING from the persisted request.
  const fail = (code: string) => oauthRedirectError(pending.redirect_uri, code, pending.state, base);

  if (decision !== "approve") {
    await logDashboard(user, request, {
      category: "oauth",
      action: "oauth.denied",
      status: "info",
      summary: `Denied ${clientLabel(pending.client_id)} access to ${pending.resource.toUpperCase()}`,
      targetType: "oauth_client",
      targetId: pending.client_id,
      metadata: { resource: pending.resource, scopes: pending.scopes },
    });
    return fail("access_denied");
  }

  try {
    const authorizationId = await upsertAuthorization(service, {
      userId: user.id,
      clientId: pending.client_id,
      resource: pending.resource,
      scopes: pending.scopes,
    });
    const code = await issueAuthorizationCode(service, {
      userId: user.id,
      clientId: pending.client_id,
      authorizationId,
      codeChallenge: pending.code_challenge,
      redirectUri: pending.redirect_uri,
      scopes: pending.scopes,
      resource: pending.resource,
    });

    await logDashboard(user, request, {
      category: "oauth",
      action: "oauth.authorized",
      summary: `Authorized ${clientLabel(pending.client_id)} for ${pending.resource.toUpperCase()} access`,
      targetType: "oauth_client",
      targetId: pending.client_id,
      metadata: { resource: pending.resource, scopes: pending.scopes },
    });

    const u = new URL(pending.redirect_uri);
    u.searchParams.set("code", code);
    if (pending.state) u.searchParams.set("state", pending.state);
    u.searchParams.set("iss", base);
    return NextResponse.redirect(u, { status: 302 });
  } catch (e) {
    if (e instanceof OAuthError) return fail("server_error");
    console.error("[oauth/consent] unexpected:", e instanceof Error ? e.message : e);
    return fail("server_error");
  }
}

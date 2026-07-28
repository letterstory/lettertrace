import { createServiceClient } from "@/lib/supabase/service";
import { clientIp, rateLimit } from "@/lib/oauth-ratelimit";
import { oauthErrorJson, tokenJson } from "@/lib/oauth-responses";
import {
  authenticateClient,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  OAuthError,
} from "@/lib/oauth";

export const dynamic = "force-dynamic";

// POST /api/oauth/token — the OAuth 2.1 token endpoint.
// Supports authorization_code (PKCE) and refresh_token (rotation + reuse
// detection). Device-code arrives in a later phase. Returns ONLY RFC 6749 §5.2
// error codes — never an internal message — so nothing leaks through the body.
export async function POST(request: Request) {
  const rl = await rateLimit(`token:${clientIp(request)}`, 60, 120);
  if (!rl.allowed) return oauthErrorJson("slow_down", 429);

  let form: URLSearchParams;
  try {
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const j = (await request.json()) as Record<string, string>;
      form = new URLSearchParams(j);
    } else {
      form = new URLSearchParams(await request.text());
    }
  } catch {
    return oauthErrorJson("invalid_request", 400);
  }

  const service = createServiceClient();

  try {
    const client = await authenticateClient(service, {
      bodyClientId: form.get("client_id"),
      authHeader: request.headers.get("authorization"),
    });

    switch (form.get("grant_type")) {
      case "authorization_code":
        return tokenJson(
          await exchangeAuthorizationCode(service, client, {
            code: form.get("code"),
            redirectUri: form.get("redirect_uri"),
            codeVerifier: form.get("code_verifier"),
          }),
        );
      case "refresh_token":
        return tokenJson(
          await exchangeRefreshToken(service, client, form.get("refresh_token")),
        );
      default:
        throw new OAuthError("unsupported_grant_type", 400);
    }
  } catch (e) {
    if (e instanceof OAuthError) return oauthErrorJson(e.code, e.status);
    console.error("[oauth/token] unexpected:", e instanceof Error ? e.message : e);
    return oauthErrorJson("server_error", 500);
  }
}

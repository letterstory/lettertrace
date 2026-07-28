import { NextResponse } from "next/server";
import {
  allowsAudience,
  authenticateApiKey,
  bearerToken,
  hasScope,
  type ApiAuthContext,
  type ResourceAudience,
  type Scope,
} from "@/lib/api-auth";

// Shared bearer-auth guard for the REST surface (/api/v1). It resolves the
// token, then enforces — fail-closed — the resource audience and the required
// scope. Returns the authenticated context on success, or a ready-to-return
// 401/403 Response the caller forwards unchanged:
//
//   const auth = await requireApiAuth(request, "projects:read", "v1");
//   if (auth instanceof Response) return auth;
//   // ...use auth.supabase / auth.userId...
//
// A classic Lettertrace API key carries FULL_SCOPES and no audience binding, so
// it passes every check exactly as it did before OAuth existed. An OAuth access
// token only passes when it was granted this scope AND minted for this surface,
// so the consent screen the user approved is enforced on every request, reads
// included — never advisory.

function unauthorized(): Response {
  return NextResponse.json(
    { error: "Invalid or missing API key" },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="lettertrace"' } },
  );
}

function forbidden(message: string, challenge: string): Response {
  return NextResponse.json(
    { error: message },
    { status: 403, headers: { "WWW-Authenticate": `Bearer ${challenge}` } },
  );
}

export async function requireApiAuth(
  request: Request,
  scope: Scope,
  aud: ResourceAudience,
): Promise<ApiAuthContext | Response> {
  const auth = await authenticateApiKey(
    bearerToken(request.headers.get("authorization")),
  );
  if (!auth) return unauthorized();

  // Audience first: an OAuth token minted for MCP must not reach the REST API
  // (and vice versa). A classic key (aud null) may call anything.
  if (!allowsAudience(auth, aud)) {
    return forbidden(
      "This token is not authorized for the Lettertrace REST API.",
      'error="invalid_token", error_description="wrong resource audience"',
    );
  }

  if (!hasScope(auth, scope)) {
    return forbidden(
      `This token is missing the required "${scope}" scope.`,
      `error="insufficient_scope", scope="${scope}"`,
    );
  }

  return auth;
}

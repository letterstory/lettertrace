import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { reportAccess } from "@/lib/owned-access";

// Credentials that must never survive in a URL. Before the login form forced
// POST, a submit that beat hydration sent them as a GET query string.
const CREDENTIAL_PARAMS = ["password", "email"];

export async function middleware(request: NextRequest, event: NextFetchEvent) {
  // Strip credentials from the URL before the page renders, so they don't
  // stay in the address bar or get captured by analytics as $current_url.
  const leaked = CREDENTIAL_PARAMS.filter((p) => request.nextUrl.searchParams.has(p));
  if (leaked.length > 0) {
    const clean = request.nextUrl.clone();
    for (const p of leaked) clean.searchParams.delete(p);
    return NextResponse.redirect(clean, 303);
  }

  // Owned-site access telemetry for the marketing blog. Middleware runs before
  // the CDN cache, so it captures AI crawlers and search bots that never execute
  // JS (the in-page beacon only sees humans). Fire-and-forget via waitUntil so
  // it never delays the response; scoped to /blog so the authenticated app is
  // never reported as public page access; and a no-op unless owned-access
  // reporting is configured — inert on forks / self-hosted deployments.
  if (request.nextUrl.pathname.startsWith("/blog")) {
    event.waitUntil(
      reportAccess({
        path: request.nextUrl.pathname,
        userAgent: request.headers.get("user-agent"),
      })
    );
  }
  return updateSession(request);
}

export const config = {
  matcher: [
    // Run on everything except static assets, image files, and the
    // token-authenticated programmatic surface (API keys, not cookies).
    //
    // Load-bearing: /api/oauth and /.well-known are deliberately NOT excluded.
    // The interactive OAuth endpoints (/api/oauth/authorize, /oauth/consent,
    // /activate) need the Supabase cookie session to identify the approving
    // user, so they MUST pass through here. updateSession itself early-returns
    // for the machine OAuth endpoints and metadata (see lib/supabase/
    // middleware.ts), so those run no session logic. Never add `api/oauth` to
    // this negative-lookahead: it would strip the session from the consent
    // screen and make every approval anonymous.
    "/((?!_next/static|_next/image|favicon.ico|api/v1|api/mcp|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

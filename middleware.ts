import { type NextRequest, type NextFetchEvent } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { reportAccess } from "@/lib/owned-access";
import { forwardAgentVisit, isAgentRequest, isLettervisitPath } from "@/lib/lettervisit";

export async function middleware(request: NextRequest, event: NextFetchEvent) {
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
  // LetterVisit: forward crawler requests on public pages (lib/lettervisit.ts). Crawlers
  // never run the script, so only the server sees them. Inert unless its key is set.
  const userAgent = request.headers.get("user-agent");
  const signatureAgent = request.headers.get("signature-agent");
  if (isLettervisitPath(request.nextUrl.pathname) && isAgentRequest(userAgent, signatureAgent)) {
    event.waitUntil(
      forwardAgentVisit({
        userAgent,
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        path: request.nextUrl.pathname,
        host: request.nextUrl.hostname,
        signatureAgent,
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

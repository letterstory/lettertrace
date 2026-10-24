import { type NextRequest, type NextFetchEvent } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { reportAccess } from "@/lib/owned-access";

// AI agents and crawlers that never run JavaScript, counted by Letter
// Visitors (lettervisit.com). Env-gated on the same public key as the in-page
// script (components/lettervisit-script.tsx), so forks / self-hosted
// deployments report nothing.
const AGENT_UA =
  /bot|crawl|spider|agent|fetch|chatgpt|claude|perplexity|anthropic|openai|gemini|google|mistral|cohere|externalhit|-user/i;

function reportAgentVisit(request: NextRequest, event: NextFetchEvent) {
  const key = process.env.NEXT_PUBLIC_LETTERVISIT_KEY;
  if (!key) return;
  const path = request.nextUrl.pathname;
  if (path.startsWith("/api/")) return;
  const ua = request.headers.get("user-agent") ?? "";
  if (!AGENT_UA.test(ua) && !request.headers.has("signature-agent")) return;
  // waitUntil keeps the forward alive after the response is sent, without
  // making the visitor wait for it.
  event.waitUntil(
    fetch("https://lettervisit.com/api/v1/agent-visit", {
      method: "POST",
      body: JSON.stringify({
        k: key,
        ua,
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        path,
        host: request.nextUrl.hostname,
        signature_agent: request.headers.get("signature-agent"),
      }),
    }).catch(() => {}),
  );
}

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
  reportAgentVisit(request, event);
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

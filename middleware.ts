import { type NextRequest, type NextFetchEvent } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { reportAccess } from "@/lib/owned-access";

// Letter Visitors server snippet v2 (lettervisit.com): install once. Counts AI agents and crawlers
// that never run JavaScript, visits from AI answers, and Letter's daily site check; which requests
// it forwards is decided by Letter and updates on its own. Never slows the page, and never sends
// cookies or credentials.
type LetterRules = { v: number; ttl: number; all: boolean; ua: string; path: string; referer: string; query: string; headers: string[]; skip: string };
// Env-gated on the same public key as the in-page script (components/lettervisit-script.tsx), so
// forks and self-hosted deployments report nothing.
const LETTER_KEY = process.env.NEXT_PUBLIC_LETTERVISIT_KEY ?? "";
const LETTER_ENDPOINT = "https://lettervisit.com/api/v1/agent-visit";
const LETTER_RULES_URL = `https://app.letterstory.com/api/visitors/snippet-rules?kind=nextjs&k=${LETTER_KEY}`;
const LETTER_DROP = new Set(["cookie","set-cookie","authorization","proxy-authorization","x-api-key","x-auth-token","x-csrf-token","x-vercel-oidc-token","cf-access-jwt-assertion"]);
// Which requests to forward comes from Letter and refreshes on its own; these are the defaults
// until the first refresh, and if it ever fails.
let letterRules = letterCompile({"v":2,"ttl":600,"all":false,"ua":"bot|crawl|spider|agent|fetch|chatgpt|claude|perplexity|anthropic|openai|gemini|google|mistral|cohere|externalhit|-user\\b|letter-visitors-sitecheck|^curl/|^wget/|python-requests|python-urllib|python-httpx|aiohttp|^node\\b|undici|axios/|got \\(|^go-http-client|okhttp|^java/|libwww-perl|^ruby\\b|guzzlehttp|^php\\b|scrapy|^httpie","path":"(^|/)(llms(-full)?\\.txt|agents\\.md)$|\\.mdx?$","referer":"chatgpt|openai|claude|perplexity|gemini|copilot","query":"utm_source=(chatgpt|openai|claude|perplexity|gemini|copilot)","headers":["signature-agent","signature"],"skip":"\\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3)$|^/_next/"});
let letterFetchedAt = 0;

function letterCompile(r: LetterRules) {
	const re = (s: string) => new RegExp(s, "i");
	return { ...r, re: { ua: re(r.ua), path: re(r.path), referer: re(r.referer), query: re(r.query), skip: re(r.skip) } };
}

function letterRefresh(): Promise<void> | null {
	if (Date.now() - letterFetchedAt < letterRules.ttl * 1000) return null;
	letterFetchedAt = Date.now();
	return fetch(LETTER_RULES_URL)
		.then((r) => r.json())
		.then((r: LetterRules) => {
			if (r && r.v === 2) letterRules = letterCompile(r);
		})
		.catch(() => {});
}

function letterWanted(pathname: string, search: string, get: (name: string) => string | null, has: (name: string) => boolean): boolean {
	const r = letterRules;
	if (r.re.skip.test(pathname)) return false;
	return (
		r.all ||
		r.re.ua.test(get("user-agent") || "") ||
		r.headers.some((n: string) => has(n)) ||
		r.re.path.test(pathname) ||
		r.re.referer.test(get("referer") || "") ||
		r.re.query.test(search)
	);
}

function letterQuery(params: Iterable<[string, string]>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of params) if (/^(utm_[a-z]+|ref)$/i.test(name)) out[name] = value;
	return out;
}

function reportAgentVisit(request: NextRequest, event: NextFetchEvent) {
	// The authenticated app's API is never public page access.
	if (!LETTER_KEY || request.nextUrl.pathname.startsWith("/api/")) return;
	const refreshing = letterRefresh();
	if (refreshing) event.waitUntil(refreshing);
	const url = request.nextUrl;
	const h = request.headers;
	if (letterWanted(url.pathname, url.search, (n: string) => h.get(n), (n: string) => h.has(n))) {
		const headers: Record<string, string> = {};
		h.forEach((value, name) => {
			if (!LETTER_DROP.has(name)) headers[name] = value;
		});
		event.waitUntil(
			fetch(LETTER_ENDPOINT, {
				method: "POST",
				body: JSON.stringify({
					k: LETTER_KEY,
					v: 2,
					kind: "nextjs",
					scope: letterRules.all ? "all" : "agents",
					method: request.method,
					url: url.origin + url.pathname,
					query: letterQuery(url.searchParams),
					ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
					headers,
				}),
			}).catch(() => {}),
		);
	}
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

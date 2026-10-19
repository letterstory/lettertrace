// LetterVisit (lettervisit.com) on lettertrace.com's public pages: AI agents and people
// per page, read in Letterstory's Visitors. Two halves:
//
//   - components/lettervisit.tsx loads the Visitors script tag on public pages (people,
//     through its visitor pixel, and agents that drive a real browser).
//   - middleware.ts forwards crawler requests here (ChatGPT, Claude, Perplexity and the
//     search crawlers fetch HTML without running JavaScript, so only the server sees them).
//
// Env-gated: inert unless NEXT_PUBLIC_LETTERVISIT_KEY is set, so forks and self-hosted
// deployments send nothing (same posture as the RB2B pixel). The key is publishable, not a
// secret. Public pages only: the authenticated product is never reported.

export const LETTERVISIT_KEY = process.env.NEXT_PUBLIC_LETTERVISIT_KEY ?? "";

const AGENT_VISIT_URL = "https://lettervisit.com/api/v1/agent-visit";

// Public, unauthenticated surface. An allowlist on purpose, as in rb2b-pixel.tsx: a new
// private route is never reported by accident.
const PUBLIC_PATHS = ["/blog", "/privacy", "/terms"];

export function isLettervisitPath(pathname: string): boolean {
  return pathname === "/" || PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// The crawlers and assistants worth forwarding. Everything else (people's browsers) is
// counted by the script, so it isn't sent.
const AGENT_UA =
  /bot|crawl|spider|agent|fetch|chatgpt|claude|perplexity|anthropic|openai|gemini|google|mistral|cohere|externalhit|-user\b/i;

export function isAgentRequest(userAgent: string | null, signatureAgent: string | null): boolean {
  return AGENT_UA.test(userAgent ?? "") || !!signatureAgent;
}

/** Forward one crawler request. Fire-and-forget; resolves either way. */
export async function forwardAgentVisit(input: {
  userAgent: string | null;
  ip: string | null;
  path: string;
  host: string;
  signatureAgent: string | null;
}): Promise<void> {
  if (!LETTERVISIT_KEY) return;
  try {
    await fetch(AGENT_VISIT_URL, {
      method: "POST",
      body: JSON.stringify({
        k: LETTERVISIT_KEY,
        ua: input.userAgent ?? "",
        ip: input.ip,
        path: input.path,
        host: input.host,
        signature_agent: input.signatureAgent,
      }),
      cache: "no-store",
    });
  } catch {
    // Swallowed by design: a lost report is cheaper than a page error.
  }
}

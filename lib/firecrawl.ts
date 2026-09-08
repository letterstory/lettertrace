// ------------------------------------------------------------------
// Firecrawl: the page reader behind onboarding.
//
// The plain fetch-and-strip scraper in lib/scrape.ts reads a static marketing
// page well enough and a JavaScript-rendered one not at all — the text it gets
// back is the shell, and the model asked to suggest topics from it has nothing
// to work with. Firecrawl renders the page in a real browser and returns its
// main content as markdown, which is a far better signal for the same 6,000
// characters. It is the primary reader whenever a key is set, and the plain
// scraper stays as the fallback (and the only reader for a self-hosted install
// that never sets one).
//
// Feature-agnostic on purpose: transport, auth, envelopes, nothing else. The
// caller decides what a failure means, and MUST run the SSRF check before a
// URL gets here — Firecrawl fetches from its own infrastructure, but an
// internal address should never leave this deployment at all.
// ------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.firecrawl.dev";

/** Onboarding answers inside a 60s route; a render that takes longer than
 *  this is handed to the plain scraper rather than waited on. */
const SCRAPE_TIMEOUT_MS = 30_000;

export function firecrawlApiKey(): string | null {
  const v = process.env.FIRECRAWL_API_KEY;
  return v && v.trim() ? v.trim() : null;
}

export function firecrawlBaseUrl(): string {
  const v = process.env.FIRECRAWL_BASE_URL;
  return (v && v.trim() ? v.trim() : DEFAULT_BASE_URL).replace(/\/$/, "");
}

/** True when a Firecrawl key is set; every feature here is inert without one. */
export function isFirecrawlConfigured(): boolean {
  return firecrawlApiKey() !== null;
}

export interface FirecrawlScrapeResult {
  /** The page's main content, JS-rendered, as markdown. Empty when the page
   *  rendered to nothing readable. */
  markdown: string;
  title: string | null;
  description: string | null;
}

interface ScrapeEnvelope {
  success?: boolean;
  error?: string;
  data?: {
    markdown?: string;
    metadata?: { title?: string; description?: string; ogDescription?: string };
  };
}

/**
 * Scrape one URL with JS rendering and return its main content as markdown.
 * Throws on transport or API errors; the caller decides whether that is fatal
 * (onboarding treats it as "use the plain scraper instead").
 */
export async function firecrawlScrape(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FirecrawlScrapeResult> {
  const apiKey = firecrawlApiKey();
  if (!apiKey) throw new Error("Firecrawl is not configured (FIRECRAWL_API_KEY is unset).");
  const timeoutMs = opts.timeoutMs ?? SCRAPE_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${firecrawlBaseUrl()}/v2/scrape`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      // Firecrawl's own render budget, kept under ours so its timeout error
      // arrives as a clean envelope rather than as our abort.
      timeout: Math.max(timeoutMs - 5_000, 5_000),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as ScrapeEnvelope;
  if (!res.ok || json.success === false) {
    throw new Error(`Firecrawl scrape failed (${res.status}): ${json.error ?? "unknown error"}`);
  }
  const meta = json.data?.metadata ?? {};
  return {
    markdown: (json.data?.markdown ?? "").trim(),
    title: meta.title?.trim() || null,
    description: (meta.description ?? meta.ogDescription)?.trim() || null,
  };
}

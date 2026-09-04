// Firecrawl adapter: reads one page and returns its main content as markdown
// plus the site's own metadata (name, description, icon).
//
// It exists because the built-in reader in lib/scrape.ts fetches raw HTML and
// strips tags with regex, which returns nothing at all for a JS-rendered site —
// the single most common reason onboarding fell back to "we couldn't read your
// site". Firecrawl renders the page first. lib/scrape.ts prefers this when
// FIRECRAWL_API_KEY is set and falls back to its own reader otherwise, so an
// unkeyed deployment behaves exactly as it did before.
//
// Raw fetch, no dependency, so error mapping and response parsing stay ours.

const API_URL = "https://api.firecrawl.dev/v2/scrape";

// One scrape sits inside /api/onboarding/suggest, which has 60s total to also
// run an LLM call. 30s leaves room for that; past it the fallback reader is a
// better use of the remaining budget than waiting longer.
const TIMEOUT_MS = 30_000;

// Shared with lib/scrape.ts so both readers apply the same floor and the user
// sees one phrasing regardless of which one ran. Under this much text the model
// has nothing to suggest topics from, and a cookie wall or a bare SPA shell
// clears a smaller threshold while carrying no information about the brand.
export const MIN_CONTENT_CHARS = 40;
export const TOO_LITTLE_CONTENT = "Couldn't read enough content from the site.";
export function siteStatusError(status: number): string {
  return `Site returned ${status}.`;
}

export interface FirecrawlResult {
  ok: boolean;
  url?: string;
  title?: string;
  siteName?: string;
  description?: string;
  imageUrl?: string;
  text?: string;
  error?: string;
}

/** The part of the response we read. Firecrawl returns a great deal more
 *  (links, screenshots, JSON extraction); everything else is ignored.
 *
 *  Probed 2026-09-04 with a live key against stripe.com: one /v2/scrape call
 *  returned 24413 characters of markdown in ~1.0s, plus metadata.title and
 *  metadata.ogImage. ogSiteName was ABSENT for that site, which is why the name
 *  falls through title-then-domain rather than trusting it. Read defensively
 *  anyway: a missing field must degrade to the built-in reader, never throw. */
interface FirecrawlResponse {
  success?: boolean;
  error?: string;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      description?: string;
      ogTitle?: string;
      ogDescription?: string;
      ogSiteName?: string;
      ogImage?: string;
      favicon?: string;
      sourceURL?: string;
      statusCode?: number;
    };
  };
}

/** True if the operator has configured Firecrawl. Empty and whitespace-only
 *  read as unset, matching the other optional-feature accessors in lib/trial.ts
 *  — a blank line in a .env file is a variable someone chose not to set. */
export function firecrawlEnabled(): boolean {
  const v = process.env.FIRECRAWL_API_KEY;
  return Boolean(v && v.trim());
}

// Messages name the fix rather than the status (§5): an operator reading
// "Firecrawl is out of credits" knows where to go, where "HTTP 402" is a
// puzzle. These reach the operator's logs, not the end user — lib/scrape.ts
// falls back before anything here is shown.
function keyError(status: number): string {
  if (status === 401 || status === 403) {
    return "Firecrawl rejected FIRECRAWL_API_KEY. Check the key in your Firecrawl dashboard.";
  }
  if (status === 402) {
    return "Firecrawl is out of credits. Top up the account or unset FIRECRAWL_API_KEY to use the built-in reader.";
  }
  if (status === 429) return "Firecrawl rate limit reached.";
  return `Firecrawl error ${status}.`;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * Scrape one page. Never throws: every failure is `{ ok: false, error }` so the
 * caller can fall back without a try/catch around the whole read.
 *
 * `url` must already be normalized and SSRF-checked by the caller — this hands
 * the URL to a third party that will fetch it, so an internal address must be
 * refused before it leaves here, not after.
 */
export async function firecrawlScrape(url: string): Promise<FirecrawlResult> {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) return { ok: false, url, error: "Firecrawl is not configured." };

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // onlyMainContent drops nav, footers and cookie banners, which is most of
      // what the built-in reader's regex pass used to hand the model.
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false,
      url,
      error: timedOut ? "The site took too long to respond." : "Couldn't reach Firecrawl.",
    };
  }

  if (!res.ok) return { ok: false, url, error: keyError(res.status) };

  let payload: FirecrawlResponse;
  try {
    payload = (await res.json()) as FirecrawlResponse;
  } catch {
    return { ok: false, url, error: "Firecrawl returned a response we couldn't read." };
  }

  if (payload.success !== true) {
    return { ok: false, url, error: payload.error?.trim() || "Firecrawl couldn't read that page." };
  }

  const meta = payload.data?.metadata ?? {};

  // A 200 from Firecrawl only means Firecrawl worked. The page it fetched
  // carries its own status, and a 404 page's boilerplate would otherwise be
  // scraped and fed to the model as if it described the brand.
  const siteStatus = meta.statusCode;
  if (typeof siteStatus === "number" && siteStatus >= 400) {
    return { ok: false, url, error: siteStatusError(siteStatus) };
  }

  const text = (payload.data?.markdown ?? "").trim();
  if (text.replace(/\s/g, "").length < MIN_CONTENT_CHARS) {
    return { ok: false, url, error: TOO_LITTLE_CONTENT };
  }

  return {
    ok: true,
    url: firstNonEmpty(meta.sourceURL) ?? url,
    title: firstNonEmpty(meta.title, meta.ogTitle),
    siteName: firstNonEmpty(meta.ogSiteName),
    description: firstNonEmpty(meta.description, meta.ogDescription),
    // og:image is the brand's chosen social card; favicon is the fallback
    // because every site has one and a card is optional.
    imageUrl: firstNonEmpty(meta.ogImage, meta.favicon),
    text,
  };
}

import dns from "node:dns/promises";
import net from "node:net";
import {
  firecrawlEnabled,
  firecrawlScrape,
  MIN_CONTENT_CHARS,
  TOO_LITTLE_CONTENT,
  siteStatusError,
} from "./firecrawl";

// Best-effort domain scraper used during onboarding to learn what a brand does.
// Returns visible text plus whatever identity the page declares about itself;
// the caller feeds the text to the LLM to suggest topics. If it can't
// fetch/parse the site, the caller falls back to manual entry.
//
// Two readers, one result shape. Firecrawl runs when the operator has
// configured it (it renders JavaScript, which this file's regex pass cannot),
// and the built-in fetch below runs otherwise or when Firecrawl fails.
//
// Falling back rather than refusing is deliberate, and is the same exception
// resolveKey documents: what a scrape produces is a list of SUGGESTIONS a human
// reviews on the next screen, not a measurement that gets stored and charted.
// Nothing here reaches a run. A monitoring run must never substitute a
// different source for the one it was asked for.
//
// Because this fetches a URL the user supplies, it is hardened against SSRF:
// only http/https, internal/private hosts blocked, DNS resolved and re-checked
// on every redirect hop. The check runs before the Firecrawl path too — handing
// an internal address to a third party to fetch is the same exposure.

export interface ScrapeResult {
  ok: boolean;
  url?: string;
  title?: string;
  /** The site's own name for itself (og:site_name), when it declares one. */
  siteName?: string;
  /** The meta description, separately from `text`, for display rather than
   *  for the model — `text` already folds it in. */
  description?: string;
  /** Absolute URL of the site's social card or favicon. */
  imageUrl?: string;
  text?: string;
  error?: string;
}

const MAX_REDIRECTS = 3;
const BLOCKED_HOST_ERROR = "For security we can't fetch that host. Add your topics manually instead.";
// A name that resolves to nothing is a typo or a domain with no website, not a
// security refusal. Reporting it as BLOCKED_HOST_ERROR sent a staff user to
// retype "optim.media" as "www.optim.media" by hand, where the site lived.
const UNRESOLVED_HOST_ERROR =
  "We couldn't find a website at that domain. Check the spelling, or add your topics manually instead.";

function normalizeUrl(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".") && net.isIP(u.hostname) === 0) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function ipIsPrivate(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.split(":").pop() ?? "";
      if (net.isIP(mapped) === 4) return ipIsPrivate(mapped);
    }
    return false;
  }
  return true;
}

function hostnameBlocked(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal") return true;
  if (net.isIP(h) !== 0 && ipIsPrivate(h)) return true;
  return false;
}

// Confirm the hostname resolves only to public IPs (blocks DNS pointing inward).
// "unresolved" is still a refusal (nothing is fetched), just a differently
// worded one.
async function resolveHost(hostname: string): Promise<"public" | "private" | "unresolved"> {
  if (net.isIP(hostname) !== 0) return ipIsPrivate(hostname) ? "private" : "public";
  try {
    const results = await dns.lookup(hostname, { all: true });
    if (results.length === 0) return "unresolved";
    return results.every((r) => !ipIsPrivate(r.address)) ? "public" : "private";
  } catch {
    return "unresolved";
  }
}

async function assertSafe(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http and https URLs are supported." };
  }
  if (hostnameBlocked(parsed.hostname)) return { ok: false, error: BLOCKED_HOST_ERROR };
  const resolved = await resolveHost(parsed.hostname);
  if (resolved === "private") return { ok: false, error: BLOCKED_HOST_ERROR };
  if (resolved === "unresolved") return { ok: false, error: UNRESOLVED_HOST_ERROR };
  return { ok: true };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  return decodeEntities(stripped).trim();
}

// Reads the first of `keys` the page declares. Both attribute orders are tried:
// `content` precedes `property` often enough in real markup that matching only
// name-then-content silently missed og: tags.
function metaTag(html: string, keys: string[]): string {
  for (const key of keys) {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m =
      html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i")) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${k}["']`, "i"));
    const value = m ? decodeEntities(m[1]).trim() : "";
    if (value) return value;
  }
  return "";
}

function metaDescription(html: string): string {
  return metaTag(html, ["description", "og:description"]);
}

// og:image and favicon hrefs are routinely relative ("/og.png"), which is a
// broken image once it is rendered on our origin instead of theirs.
function absoluteUrl(raw: string, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, base).toString();
  } catch {
    return undefined;
  }
}

function iconFromHtml(html: string, baseUrl: string): string | undefined {
  const og = metaTag(html, ["og:image", "twitter:image"]);
  if (og) return absoluteUrl(og, baseUrl);
  const link = html.match(
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i,
  );
  return link ? absoluteUrl(decodeEntities(link[1]).trim(), baseUrl) : undefined;
}

// Fetch with manual redirect handling so every hop is re-validated for SSRF.
async function safeFetch(startUrl: string, signal: AbortSignal): Promise<Response> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = await assertSafe(current);
    if (!safe.ok) throw new Error(safe.error);
    const res = await fetch(current, {
      signal,
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LettertraceBot/1.0; +https://lettertrace.com)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects.");
}

// The built-in reader: fetch the root URL and pull identity + visible text out
// of the raw HTML. Used when Firecrawl isn't configured, and as the fallback
// when it is but didn't return anything usable.
async function fetchAndParse(url: string): Promise<ScrapeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await safeFetch(url, controller.signal);
    if (!res.ok) return { ok: false, url, error: siteStatusError(res.status) };
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      return { ok: false, url, error: "That URL isn't an HTML page." };
    }
    const html = (await res.text()).slice(0, 400_000);
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
    const desc = metaDescription(html);
    const body = htmlToText(html);
    const text = `${desc ? desc + "\n\n" : ""}${body}`.slice(0, 6000);
    if (text.replace(/\s/g, "").length < MIN_CONTENT_CHARS) {
      return { ok: false, url, error: TOO_LITTLE_CONTENT };
    }
    return {
      ok: true,
      url,
      title: decodeEntities(title),
      siteName: metaTag(html, ["og:site_name", "application-name"]) || undefined,
      description: desc || undefined,
      imageUrl: iconFromHtml(html, url),
      text,
    };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === BLOCKED_HOST_ERROR || err.message === UNRESOLVED_HOST_ERROR)
    ) {
      return { ok: false, url, error: err.message };
    }
    const msg =
      err instanceof Error && err.name === "AbortError"
        ? "The site took too long to respond."
        : "Couldn't reach the site.";
    return { ok: false, url, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

/** The same URL on the www host, or null when that isn't a different host. */
function wwwVariant(url: string): string | null {
  const u = new URL(url);
  if (net.isIP(u.hostname) !== 0 || u.hostname.toLowerCase().startsWith("www.")) return null;
  u.hostname = `www.${u.hostname}`;
  return u.toString();
}

export async function scrapeDomain(rawDomain: string): Promise<ScrapeResult> {
  const url = normalizeUrl(rawDomain);
  if (!url) return { ok: false, error: "That doesn't look like a valid domain." };

  // Plenty of sites publish only www, with no record at the bare domain at all
  // (optim.media, Oct 2026). People type the bare domain, so try www before
  // giving up on a name that doesn't resolve.
  const result = await scrapeUrl(url);
  if (result.error !== UNRESOLVED_HOST_ERROR) return result;
  const www = wwwVariant(url);
  if (!www) return result;
  const viaWww = await scrapeUrl(www);
  return viaWww.error === UNRESOLVED_HOST_ERROR ? result : viaWww;
}

async function scrapeUrl(url: string): Promise<ScrapeResult> {
  if (firecrawlEnabled()) {
    // Firecrawl fetches from its own infrastructure, so our SSRF guards don't
    // apply on their side — which is exactly why the address has to clear them
    // HERE, before we ask a third party to reach it on our behalf.
    const safe = await assertSafe(url);
    if (!safe.ok) return { ok: false, url, error: safe.error };

    const viaFirecrawl = await firecrawlScrape(url);
    if (viaFirecrawl.ok) return viaFirecrawl;
    // Deliberately fall through rather than surfacing Firecrawl's error: the
    // built-in reader sometimes succeeds where Firecrawl doesn't, and its
    // failure message describes the USER'S site ("Site returned 404.") rather
    // than our vendor, which is the only thing they can act on.
    console.warn("[scrape] firecrawl failed, falling back:", viaFirecrawl.error);
  }

  return fetchAndParse(url);
}

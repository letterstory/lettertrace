import dns from "node:dns/promises";
import net from "node:net";

// Best-effort domain scraper used during onboarding to learn what a brand does.
// Returns visible text; the caller feeds it to the LLM to suggest topics. If it
// can't fetch/parse the site, the caller falls back to manual entry.
//
// Because this fetches a URL the user supplies, it is hardened against SSRF:
// only http/https, internal/private hosts blocked, DNS resolved and re-checked
// on every redirect hop.

export interface ScrapeResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  error?: string;
}

const MAX_REDIRECTS = 3;
const BLOCKED_HOST_ERROR = "For security we can't fetch that host. Add your topics manually instead.";

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
async function hostIsPublic(hostname: string): Promise<boolean> {
  if (net.isIP(hostname) !== 0) return !ipIsPrivate(hostname);
  try {
    const results = await dns.lookup(hostname, { all: true });
    return results.length > 0 && results.every((r) => !ipIsPrivate(r.address));
  } catch {
    return false;
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
  if (hostnameBlocked(parsed.hostname) || !(await hostIsPublic(parsed.hostname))) {
    return { ok: false, error: BLOCKED_HOST_ERROR };
  }
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

function metaDescription(html: string): string {
  const m =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]).trim() : "";
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

export async function scrapeDomain(rawDomain: string): Promise<ScrapeResult> {
  const url = normalizeUrl(rawDomain);
  if (!url) return { ok: false, error: "That doesn't look like a valid domain." };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await safeFetch(url, controller.signal);
    if (!res.ok) return { ok: false, url, error: `Site returned ${res.status}.` };
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      return { ok: false, url, error: "That URL isn't an HTML page." };
    }
    const html = (await res.text()).slice(0, 400_000);
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
    const desc = metaDescription(html);
    const body = htmlToText(html);
    const text = `${desc ? desc + "\n\n" : ""}${body}`.slice(0, 6000);
    if (text.replace(/\s/g, "").length < 40) {
      return { ok: false, url, error: "Couldn't read enough content from the site." };
    }
    return { ok: true, url, title: decodeEntities(title), text };
  } catch (err) {
    if (err instanceof Error && err.message === BLOCKED_HOST_ERROR) {
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

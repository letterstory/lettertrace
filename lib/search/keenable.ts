import type { SearchOptions, SearchProvider, SearchResult } from "./types";
import { SearchRateLimitError } from "./types";

// Keenable search adapter. Works without a key on the public endpoint;
// a stored key switches to the keyed endpoint for higher limits. Docs:
// https://docs.keenable.ai/api-reference/search
const PUBLIC_SEARCH_URL = "https://api.keenable.ai/v1/search/public";
const KEYED_SEARCH_URL = "https://api.keenable.ai/v1/search";
const APP_TITLE = "Lettertrace";

const TIMEOUT_MS = 15_000;
const MAX_COUNT = 50;

const PUBLISHED_AFTER: Record<NonNullable<SearchOptions["freshness"]>, string> = {
  week: "7d",
  year: "1y",
};

interface KeenableResponse {
  results?: {
    url?: string;
    title?: string;
    description?: string;
    snippet?: string;
  }[];
}

function endpoint(apiKey: string): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Keenable-Title": APP_TITLE,
  };
  if (apiKey) headers["X-API-Key"] = apiKey;
  return { url: apiKey ? KEYED_SEARCH_URL : PUBLIC_SEARCH_URL, headers };
}

async function search(
  apiKey: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const { url, headers } = endpoint(apiKey.trim());
  const body: Record<string, unknown> = {
    query,
    max_results: Math.min(Math.max(opts.count ?? 10, 1), MAX_COUNT),
  };
  if (opts.freshness) body.published_after = PUBLISHED_AFTER[opts.freshness];

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 429) throw new SearchRateLimitError("Keenable");
  if (apiKey && (res.status === 401 || res.status === 403)) {
    throw new Error("Keenable rejected the API key.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Keenable error ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  const payload = (await res.json()) as KeenableResponse;
  const results: SearchResult[] = [];
  for (const [i, r] of (payload.results ?? []).entries()) {
    if (!r.url) continue;
    results.push({
      url: r.url,
      title: r.title?.trim() || null,
      snippet: r.description?.trim() || r.snippet?.trim() || null,
      rank: i + 1,
    });
  }
  return results;
}

async function verifyKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { url, headers } = endpoint(apiKey.trim());
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "test", max_results: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Keenable rejected this key." };
    }
    if (res.status === 429) {
      // The key IS valid — an invalid key can't be rate-limited.
      return { ok: true };
    }
    return { ok: false, error: `Keenable verification failed (HTTP ${res.status}).` };
  } catch {
    return { ok: false, error: "Couldn't reach Keenable to verify the key. Please try again." };
  }
}

export const keenableProvider: SearchProvider = {
  id: "keenable",
  label: "Keenable",
  keyUrl: "https://keenable.ai",
  keyPrefix: "",
  search,
  verifyKey,
};

import type { SearchOptions, SearchProvider, SearchResult } from "./types";
import { SearchRateLimitError } from "./types";

// Brave Search API adapter. Independent index, flat per-query pricing, and a
// free tier that covers development and pilots. Docs:
// https://api-dashboard.search.brave.com/app/documentation/web-search
const API_URL = "https://api.search.brave.com/res/v1/web/search";

// One query should never hang a collection tick: the weekly window means a
// lost query costs nothing, so fail fast and move on.
const TIMEOUT_MS = 15_000;

// Brave's own page-size ceiling; asking for more is a 422, not extra results.
const MAX_COUNT = 20;

const FRESHNESS: Record<NonNullable<SearchOptions["freshness"]>, string> = {
  week: "pw",
  year: "py",
};

/** The shape of the Brave response we actually read. Everything else in the
 *  payload (mixed results, videos, infoboxes) is deliberately ignored. */
interface BraveResponse {
  web?: {
    results?: { url?: string; title?: string; description?: string }[];
  };
}

function requestInit(apiKey: string): RequestInit {
  return {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

async function search(
  apiKey: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(Math.max(opts.count ?? MAX_COUNT, 1), MAX_COUNT)),
  });
  if (opts.freshness) params.set("freshness", FRESHNESS[opts.freshness]);

  const res = await fetch(`${API_URL}?${params}`, requestInit(apiKey));

  if (res.status === 429) throw new SearchRateLimitError("Brave Search");
  if (res.status === 401 || res.status === 403) {
    throw new Error("Brave Search rejected the API key.");
  }
  if (!res.ok) {
    // 422s carry a useful message (bad freshness value, count too high) that
    // names our bug, not the user's — surface it rather than a bare status.
    const detail = await res.text().catch(() => "");
    throw new Error(`Brave Search error ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  const payload = (await res.json()) as BraveResponse;
  const results: SearchResult[] = [];
  for (const [i, r] of (payload.web?.results ?? []).entries()) {
    if (!r.url) continue;
    results.push({
      url: r.url,
      title: r.title?.trim() || null,
      snippet: r.description?.trim() || null,
      rank: i + 1,
    });
  }
  return results;
}

/** A real (billable) one-result query, because Brave has no dedicated
 *  key-validation endpoint. Cheapest possible probe: one query at the
 *  smallest page size. */
async function verifyKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const params = new URLSearchParams({ q: "test", count: "1" });
    const res = await fetch(`${API_URL}?${params}`, requestInit(apiKey));
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Brave Search rejected this key." };
    }
    if (res.status === 429) {
      // The key IS valid — an invalid key can't be rate-limited. Refusing to
      // store it here would tell the user their key is bad when the only
      // problem is that we probed too fast.
      return { ok: true };
    }
    return { ok: false, error: `Brave Search verification failed (HTTP ${res.status}).` };
  } catch {
    return { ok: false, error: "Couldn't reach Brave Search to verify the key. Please try again." };
  }
}

export const braveProvider: SearchProvider = {
  id: "brave",
  label: "Brave Search",
  keyUrl: "https://api-dashboard.search.brave.com/app/keys",
  keyPrefix: "BSA",
  search,
  verifyKey,
};

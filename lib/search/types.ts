// Shared contracts for web-search providers. Kept apart from the registry in
// index.ts so an adapter never has to import the module that imports it.

export type SearchProviderId = "brave";

/** One organic result, normalized across providers. */
export interface SearchResult {
  url: string;
  title: string | null;
  snippet: string | null;
  /** 1-based position on the result page — recorded as a rough salience
   *  signal, compared across sightings by keeping the best. */
  rank: number;
}

/** How far back the query looks. "week" is the steady-state collection
 *  window (a weekly tick with a past-week window misses nothing); "year" is
 *  the one-time seed run when a project enables the signal, so the feed
 *  isn't empty for its first week. */
export type SearchFreshness = "week" | "year";

export interface SearchOptions {
  freshness?: SearchFreshness;
  /** Max results to return (provider page-size cap applies, 20 for Brave). */
  count?: number;
}

export interface SearchProvider {
  id: SearchProviderId;
  label: string;
  keyUrl: string;
  keyPrefix: string;
  /** Run one query. Throws SearchRateLimitError on 429 so the collector can
   *  back off; throws Error with a human-readable message otherwise. */
  search(apiKey: string, query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  /** True when the key is accepted by the provider. Same contract as
   *  lib/llm's verifyKey: called before a key may be stored. */
  verifyKey(apiKey: string): Promise<{ ok: boolean; error?: string }>;
}

/** Thrown on provider 429s. A distinct class because the collector treats
 *  rate limits differently from every other failure: back off and retry
 *  once, then stop the tick — the weekly freshness window guarantees the
 *  next tick loses nothing. */
export class SearchRateLimitError extends Error {
  constructor(providerLabel: string) {
    super(`${providerLabel} rate-limited the request.`);
    this.name = "SearchRateLimitError";
  }
}

// ==================================================================
// Web-search providers, behind one interface.
//
// The web-mentions signal discovers third-party chatter (Reddit threads,
// forum posts) by running scoped queries through a general web-search API —
// deliberately NOT the official Reddit API, which requires pre-approval,
// has no comment or date-range search, and treats commercial use as a paid
// agreement. Any site is reachable the same way: `site:` scoping is the
// only per-site integration.
//
// Brave is the first provider. The interface exists so a second provider
// (a Google-backed index, say) is one adapter file and a registry entry —
// never a rewrite of the collector.
// ==================================================================

import { braveProvider } from "./brave";
import type { SearchProvider, SearchProviderId } from "./types";

export type {
  SearchFreshness,
  SearchOptions,
  SearchProvider,
  SearchProviderId,
  SearchResult,
} from "./types";
export { SearchRateLimitError } from "./types";

export const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProvider> = {
  brave: braveProvider,
};

export const SEARCH_PROVIDER_LIST: SearchProvider[] = Object.values(SEARCH_PROVIDERS);

export function isSearchProvider(value: string): value is SearchProviderId {
  return value in SEARCH_PROVIDERS;
}

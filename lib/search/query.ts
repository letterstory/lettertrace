// Query construction for the web-mentions collector. Pure functions, because
// every query is money: the collector's cost model is exactly the length of
// the arrays these return, so they must be predictable enough to unit-test
// against the budget math.

/** Brave treats long OR-chains unevenly; three quoted terms per query is the
 *  chunk size that keeps recall without splitting one brand into five bills. */
const TERMS_PER_QUERY = 3;

/** `"Acme" OR "AcmeHQ"` — quoted, exact-ish matching. The re-verification
 *  pass (word-boundary matcher on title+snippet) is what actually decides
 *  whether a result counts; the quotes just keep the search engine honest. */
function orGroup(terms: string[]): string {
  return `(${terms.map((t) => `"${t}"`).join(" OR ")})`;
}

/** Dedup + drop blanks, preserving order. Case-insensitive: "Acme" and
 *  "acme" are the same query term to a search engine. */
function cleanTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Brand queries for one site: name + aliases, chunked three-per-query.
 *   brandQueries("reddit.com", "Acme", ["AcmeHQ", "Acme Labs"])
 *   → ['site:reddit.com ("Acme" OR "AcmeHQ" OR "Acme Labs")']
 * A brand with 5 aliases costs 2 queries, not 6.
 */
export function brandQueries(site: string, brandName: string, aliases: string[] = []): string[] {
  const terms = cleanTerms([brandName, ...aliases]);
  if (terms.length === 0) return [];
  const queries: string[] = [];
  for (let i = 0; i < terms.length; i += TERMS_PER_QUERY) {
    queries.push(`site:${site} ${orGroup(terms.slice(i, i + TERMS_PER_QUERY))}`);
  }
  return queries;
}

/**
 * The topic query for one site: topic name plus its extra keywords, unquoted.
 * Recall first — precision is recovered downstream, where results that don't
 * re-verify against a brand term are stored as kind='topic', not dropped.
 */
export function topicQuery(site: string, topicName: string, extraKeywords: string[] = []): string {
  const terms = cleanTerms([topicName, ...extraKeywords]);
  return `site:${site} ${terms.join(" ")}`;
}

/**
 * Which watched sites to query this tick. The primary site (first entry —
 * reddit.com by default) is queried every tick; secondaries rotate one per
 * tick round-robin, so cost stays flat no matter how many sites a client
 * watches. `tick` is any monotonic-ish counter; the collector passes weeks
 * since epoch, so the rotation advances once per weekly collection.
 */
export function sitesForTick(sites: string[], tick: number): string[] {
  const list = cleanTerms(sites);
  if (list.length <= 1) return list;
  const [primary, ...rest] = list;
  const secondary = rest[((tick % rest.length) + rest.length) % rest.length];
  return [primary, secondary];
}

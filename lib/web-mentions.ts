import type { SupabaseClient } from "@supabase/supabase-js";
import { hostOf, isOwnedDomain } from "@/lib/engine";
import { brandTerms, detectMention } from "@/lib/mentions";
import { pageKey } from "@/lib/metrics";
import { recordOps, recordOpsError } from "@/lib/ops";
import { SEARCH_PROVIDERS, SearchRateLimitError } from "@/lib/search";
import type { SearchProvider, SearchResult } from "@/lib/search";
import { brandQueries, sitesForTick, topicQuery } from "@/lib/search/query";
import type { Project, Topic, WebMention, WebMentionWatch } from "@/lib/types";

// ==================================================================
// The web-mentions collector: one project, one tick.
//
// Runs the site-scoped brand and topic queries through a search provider,
// filters what comes back (owned domains out, exclude-terms out), re-verifies
// every result with the same word-boundary matcher the AI Answers signal
// uses — never the search engine's own matching — and upserts one row per
// (project, page). Re-sightings update the row; the topic trend derives from
// first_seen_at, which an update never touches.
//
// Collection is WEEKLY: each steady-state tick queries a past-week window,
// so a lost tick costs nothing but latency. The first tick after enabling
// (last_collected_at null) is the seed run — a past-year window, so the feed
// isn't empty for its first week.
// ==================================================================

/** Between queries, to stay under provider per-second limits (Brave's free
 *  tier allows 1/s). The budget caps a tick at ~a minute of spacing, well
 *  inside the route ceiling. */
const QUERY_SPACING_MS = 1100;

/** One retry after one backoff on a 429; a second 429 ends the tick early.
 *  The weekly window guarantees the next tick recovers anything missed. */
const RATE_LIMIT_BACKOFF_MS = 2500;

export interface CollectParams {
  supabase: SupabaseClient;
  project: Project;
  watch: WebMentionWatch;
  topics: Topic[];
  apiKey: string;
  /** Cross-project ceiling for this cron tick; the collector never exceeds
   *  min(watch.query_budget, maxQueries). Defaults to the watch budget. */
  maxQueries?: number;
  /** Test seams. Callers outside tests leave these unset. */
  provider?: SearchProvider;
  pauseMs?: number;
  backoffMs?: number;
  now?: () => number;
}

export interface CollectResult {
  runId: string;
  status: "completed" | "failed";
  queryCount: number;
  newCount: number;
  seenCount: number;
  /** Set when the tick ended early or failed; stored on the run row. */
  error?: string;
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Brave descriptions carry markup (<strong>…) and entities; the matcher
 *  needs prose. Tags out, the few common entities decoded, whitespace
 *  collapsed. */
export function cleanSnippet(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/** Which of `terms` actually appear in the text, word-boundary matched.
 *  Recorded on the row so a human can catch a bad alias at a glance. */
export function matchedTerms(text: string, terms: string[]): string[] {
  return terms.filter((t) => detectMention(text, [t]).mentioned);
}

/** The planned queries for one tick, in execution order: brand queries first
 *  (they can upgrade rows the topic queries created, never the reverse), then
 *  one query per topic. Each entry carries the topic it inherits. */
export function buildQueryPlan(
  project: Project,
  watch: WebMentionWatch,
  topics: Topic[],
  tick: number,
): { query: string; topicId: string | null }[] {
  const sites = sitesForTick(watch.sites, tick);
  const plan: { query: string; topicId: string | null }[] = [];
  for (const site of sites) {
    for (const q of brandQueries(site, project.brand_name, project.brand_aliases)) {
      plan.push({ query: q, topicId: null });
    }
  }
  for (const site of sites) {
    for (const topic of topics) {
      plan.push({ query: topicQuery(site, topic.name, watch.extra_keywords), topicId: topic.id });
    }
  }
  return plan;
}

interface Candidate {
  page_key: string;
  url: string;
  domain: string;
  title: string | null;
  snippet: string | null;
  kind: "brand" | "topic";
  topic_id: string | null;
  matched_terms: string[];
  search_rank: number | null;
}

/**
 * Turn one query's results into storable candidates. Exported for tests:
 * this is where every filtering decision lives.
 */
export function classifyResults(
  results: SearchResult[],
  project: Project,
  watch: WebMentionWatch,
  topics: Topic[],
  queryTopicId: string | null,
): Candidate[] {
  const terms = brandTerms(project.brand_name, project.brand_aliases);
  const out: Candidate[] = [];
  for (const r of results) {
    const key = pageKey(r.url);
    if (!key) continue;

    // Chatter on the client's own sites (main domain AND phantoms) is not
    // third-party chatter.
    const domain = hostOf(r.url);
    if (project.brand_domains.some((d) => isOwnedDomain(domain, hostOf(d)))) continue;

    const title = cleanSnippet(r.title);
    const snippet = cleanSnippet(r.snippet);
    const text = [title, snippet].filter(Boolean).join(" ");

    // The name-collision guard: one hit on an exclude term drops the page.
    if (watch.exclude_terms.length > 0 && detectMention(text, watch.exclude_terms).mentioned) {
      continue;
    }

    // Never trust the search engine's matching: a result only counts as a
    // brand mention if OUR matcher sees a brand term in the text. Topic-query
    // results without one still count — as topic chatter, which is what the
    // query asked about.
    const matched = matchedTerms(text, terms);
    const isBrand = matched.length > 0;
    if (!isBrand && queryTopicId === null) continue; // brand query, no verified brand term

    // Query inheritance first (deterministic, free); brand-query results get
    // a keyword pass against topic names so obvious ones don't land in the
    // unassigned bucket.
    let topicId = queryTopicId;
    if (topicId === null) {
      topicId = topics.find((t) => detectMention(text, [t.name]).mentioned)?.id ?? null;
    }

    out.push({
      page_key: key,
      url: r.url,
      domain,
      title,
      snippet,
      kind: isBrand ? "brand" : "topic",
      topic_id: topicId,
      matched_terms: matched,
      search_rank: r.rank,
    });
  }
  return out;
}

/** Merge a fresh sighting onto what is already stored. Kind only ever
 *  upgrades to brand; rank keeps the best (lowest); the crawl-time capture
 *  (title/snippet) refreshes to the newest; first_seen_at is never touched. */
export function mergeSighting(
  existing: Pick<WebMention, "kind" | "topic_id" | "matched_terms" | "search_rank" | "seen_count">,
  fresh: Candidate,
  nowIso: string,
): Partial<WebMention> {
  return {
    url: fresh.url,
    title: fresh.title,
    snippet: fresh.snippet,
    kind: existing.kind === "brand" || fresh.kind === "brand" ? "brand" : "topic",
    topic_id: existing.topic_id ?? fresh.topic_id,
    matched_terms: [...new Set([...existing.matched_terms, ...fresh.matched_terms])],
    search_rank:
      existing.search_rank === null || fresh.search_rank === null
        ? (existing.search_rank ?? fresh.search_rank)
        : Math.min(existing.search_rank, fresh.search_rank),
    seen_count: existing.seen_count + 1,
    last_seen_at: nowIso,
  };
}

/**
 * Collect web mentions for one project. Settles its own run row on every
 * path and stamps watch.last_collected_at on every attempt — a failing
 * config must wait for the next weekly tick like everyone else, not hot-loop.
 */
export async function collectWebMentions(params: CollectParams): Promise<CollectResult> {
  const { supabase, project, watch, topics, apiKey } = params;
  const provider = params.provider ?? SEARCH_PROVIDERS.brave;
  const pauseMs = params.pauseMs ?? QUERY_SPACING_MS;
  const backoffMs = params.backoffMs ?? RATE_LIMIT_BACKOFF_MS;
  const now = params.now ?? Date.now;

  const { data: runRow, error: runErr } = await supabase
    .from("web_mention_runs")
    .insert({ project_id: project.id })
    .select("id")
    .single();
  if (runErr || !runRow) {
    return {
      runId: "",
      status: "failed",
      queryCount: 0,
      newCount: 0,
      seenCount: 0,
      error: runErr?.message || "Could not create the collection run.",
    };
  }
  const runId = (runRow as { id: string }).id;

  const seed = watch.last_collected_at === null;
  const freshness = seed ? ("year" as const) : ("week" as const);
  const tick = Math.floor(now() / (7 * 24 * 60 * 60 * 1000));
  const budget = Math.max(0, Math.min(watch.query_budget, params.maxQueries ?? Infinity));

  const plan = buildQueryPlan(project, watch, topics, tick);
  const truncated = plan.length > budget;
  const toRun = plan.slice(0, budget);

  let queryCount = 0;
  let newCount = 0;
  let seenCount = 0;
  let stoppedEarly: string | null = null;
  let hardError: string | null = null;

  for (const step of toRun) {
    if (queryCount > 0) await sleep(pauseMs);
    let results: SearchResult[];
    try {
      try {
        queryCount++;
        results = await provider.search(apiKey, step.query, { freshness });
      } catch (err) {
        if (!(err instanceof SearchRateLimitError)) throw err;
        await sleep(backoffMs);
        queryCount++;
        results = await provider.search(apiKey, step.query, { freshness });
      }
    } catch (err) {
      if (err instanceof SearchRateLimitError) {
        // Still limited after one backoff: end the tick. What was stored is
        // real; the weekly window recovers the rest next tick.
        stoppedEarly = "Stopped early: the search provider rate-limited the collection.";
        recordOps("web_mentions.rate_limited", {
          level: "warn",
          signature: "web_mentions.rate_limited",
        });
        break;
      }
      // Any other failure: skip this query, keep the tick alive, and let the
      // FIRST failure narrate the run — mirroring how LLM runs report.
      if (!hardError) hardError = err instanceof Error ? err.message : "Search query failed.";
      recordOpsError("web-mentions.query", err, { project_id: project.id });
      continue;
    }

    const candidates = classifyResults(results, project, watch, topics, step.topicId);
    if (candidates.length === 0) continue;

    // Read what we already have for these pages, then split into inserts and
    // per-row merges. Not a blind upsert: seen_count increments, kind only
    // upgrades, and rank keeps the best — none of which a set-style upsert
    // can express.
    const keys = candidates.map((c) => c.page_key);
    const { data: existingRows } = await supabase
      .from("web_mentions")
      .select("id, page_key, kind, topic_id, matched_terms, search_rank, seen_count")
      .eq("project_id", project.id)
      .in("page_key", keys);
    const byKey = new Map(
      ((existingRows ?? []) as (Pick<
        WebMention,
        "id" | "page_key" | "kind" | "topic_id" | "matched_terms" | "search_rank" | "seen_count"
      >)[]).map((r) => [r.page_key, r]),
    );

    const nowIso = new Date(now()).toISOString();
    const inserts: (Candidate & { project_id: string })[] = [];
    for (const c of candidates) {
      const existing = byKey.get(c.page_key);
      if (!existing) {
        inserts.push({ ...c, project_id: project.id });
        continue;
      }
      const { error } = await supabase
        .from("web_mentions")
        .update(mergeSighting(existing, c, nowIso))
        .eq("id", existing.id);
      if (!error) seenCount++;
    }
    if (inserts.length > 0) {
      // Two queries in one tick can both surface a page the table has never
      // seen; the second insert must merge, not die on the unique constraint.
      const { error } = await supabase
        .from("web_mentions")
        .upsert(inserts, { onConflict: "project_id,page_key", ignoreDuplicates: false });
      if (error) {
        if (!hardError) hardError = error.message;
        recordOpsError("web-mentions.store", error, { project_id: project.id });
      } else {
        newCount += inserts.length;
      }
    }
  }

  const notes = [
    stoppedEarly,
    truncated ? `Stopped at the query budget (${toRun.length} of ${plan.length} planned).` : null,
    hardError,
  ].filter(Boolean);
  const status: CollectResult["status"] =
    queryCount > 0 && (newCount > 0 || seenCount > 0 || !hardError) ? "completed" : "failed";

  await supabase
    .from("web_mention_runs")
    .update({
      status,
      query_count: queryCount,
      new_count: newCount,
      seen_count: seenCount,
      error: notes.length > 0 ? notes.join(" ") : null,
      finished_at: new Date(now()).toISOString(),
    })
    .eq("id", runId);
  await supabase
    .from("web_mention_watch")
    .update({ last_collected_at: new Date(now()).toISOString() })
    .eq("id", watch.id);

  return {
    runId,
    status,
    queryCount,
    newCount,
    seenCount,
    error: notes.length > 0 ? notes.join(" ") : undefined,
  };
}

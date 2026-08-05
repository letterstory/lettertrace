import type { Mention, Sentiment, Source } from "@/lib/types";

// Aggregations over stored (positive) mention rows. `totalResponses` is the
// number of assistant answers in scope, the denominator for mention rate.

/** A 95% confidence range for a rate, both bounds 0..1. */
export interface Interval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a proportion.
 *
 * Mention rate is an estimate from a handful of answers, not a measurement, and
 * the product's core claim is that "not mentioned" means something. 0 out of 1
 * and 0 out of 30 are both a rate of zero and are not remotely the same
 * evidence — this is what tells them apart.
 *
 * Wilson rather than the textbook normal approximation because the interesting
 * cases are exactly where that one breaks: zero successes (it returns a
 * degenerate +/-0) and single-digit sample sizes. Wilson stays sane at both,
 * never escapes [0, 1], and needs no special-casing.
 */
export function wilsonInterval(successes: number, trials: number, z = 1.96): Interval {
  if (trials <= 0) return { low: 0, high: 1 };
  const hits = Math.min(Math.max(successes, 0), trials);
  const p = hits / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return {
    low: Math.max(0, (centre - margin) / denominator),
    high: Math.min(1, (centre + margin) / denominator),
  };
}

export interface EntityStat {
  key: string; // 'brand' or a competitor id
  name: string;
  type: "brand" | "competitor";
  responsesMentioned: number;
  totalResponses: number;
  mentionRate: number; // 0..1
  /** How much to trust mentionRate. Wide at small n; a zero rate with a high
   *  upper bound means "no evidence yet", not "confirmed absent". */
  mentionRateInterval: Interval;
  totalMentionCount: number;
  shareOfVoice: number; // 0..1 across all entities
  avgProminence: number; // 0..1, higher = appears earlier
  recommendRate: number; // 0..1 among mentioned
  sentiment: { positive: number; neutral: number; negative: number };
  sentimentScore: number; // -1..1
}

function entityKey(m: Mention): string {
  return m.entity_type === "brand" ? "brand" : m.competitor_id ?? m.entity_name;
}

/**
 * `brandName` is optional only for backwards compatibility. Pass it: without it
 * a run in which the brand was never mentioned reports no brand row at all.
 */
export function computeEntityStats(
  mentions: Mention[],
  totalResponses: number,
  brandName?: string,
): EntityStat[] {
  const groups = new Map<string, Mention[]>();
  for (const m of mentions) {
    const k = entityKey(m);
    const list = groups.get(k) ?? [];
    list.push(m);
    groups.set(k, list);
  }

  const grandTotalMentions = mentions.reduce((s, m) => s + (m.mention_count || 0), 0);

  const stats: EntityStat[] = [];
  for (const [key, rows] of groups) {
    const responsesMentioned = new Set(rows.map((r) => r.response_id)).size;
    const totalMentionCount = rows.reduce((s, r) => s + (r.mention_count || 0), 0);
    const prominenceVals = rows
      .filter((r) => r.first_position >= 0)
      .map((r) => 1 - r.first_position);
    const avgProminence = prominenceVals.length
      ? prominenceVals.reduce((s, v) => s + v, 0) / prominenceVals.length
      : 0;
    const recommended = rows.filter((r) => r.recommended).length;
    const sentiment = { positive: 0, neutral: 0, negative: 0 };
    for (const r of rows) {
      const s: Sentiment = r.sentiment ?? "neutral";
      sentiment[s]++;
    }
    const judged = sentiment.positive + sentiment.neutral + sentiment.negative;
    const sentimentScore = judged ? (sentiment.positive - sentiment.negative) / judged : 0;

    stats.push({
      key,
      name: rows[0].entity_name,
      type: rows[0].entity_type,
      responsesMentioned,
      totalResponses,
      mentionRate: totalResponses ? responsesMentioned / totalResponses : 0,
      mentionRateInterval: wilsonInterval(responsesMentioned, totalResponses),
      totalMentionCount,
      shareOfVoice: grandTotalMentions ? totalMentionCount / grandTotalMentions : 0,
      avgProminence,
      recommendRate: responsesMentioned ? recommended / responsesMentioned : 0,
      sentiment,
      sentimentScore,
    });
  }

  // An entity with no mentions has no rows, so the brand silently vanishes from
  // the report on exactly the runs where its absence is the finding. Synthesise
  // the zero row when the caller tells us who the brand is, so a run always
  // states something about it — with an interval showing what the zero is worth.
  if (brandName && !stats.some((s) => s.type === "brand")) {
    stats.push({
      key: "brand",
      name: brandName,
      type: "brand",
      responsesMentioned: 0,
      totalResponses,
      mentionRate: 0,
      mentionRateInterval: wilsonInterval(0, totalResponses),
      totalMentionCount: 0,
      shareOfVoice: 0,
      avgProminence: 0,
      recommendRate: 0,
      sentiment: { positive: 0, neutral: 0, negative: 0 },
      sentimentScore: 0,
    });
  }

  // Brand first, then competitors by share of voice.
  return stats.sort((a, b) => {
    if (a.type !== b.type) return a.type === "brand" ? -1 : 1;
    return b.shareOfVoice - a.shareOfVoice;
  });
}

export interface RunSummary {
  brandMentionRate: number;
  /** Confidence range on brandMentionRate — read it before acting on a zero. */
  brandMentionRateInterval: Interval;
  /** Numerator and denominator behind the rate, so a consumer can judge it. */
  brandResponsesMentioned: number;
  totalResponses: number;
  brandShareOfVoice: number;
  brandSentimentScore: number;
  brandAvgProminence: number;
}

export function computeRunSummary(
  mentions: Mention[],
  totalResponses: number,
  brandName?: string,
): RunSummary {
  const stats = computeEntityStats(mentions, totalResponses, brandName);
  const brand = stats.find((s) => s.type === "brand");
  return {
    brandMentionRate: brand?.mentionRate ?? 0,
    brandMentionRateInterval:
      brand?.mentionRateInterval ?? wilsonInterval(0, totalResponses),
    brandResponsesMentioned: brand?.responsesMentioned ?? 0,
    totalResponses,
    brandShareOfVoice: brand?.shareOfVoice ?? 0,
    brandSentimentScore: brand?.sentimentScore ?? 0,
    brandAvgProminence: brand?.avgProminence ?? 0,
  };
}

/**
 * Whether the models read the brand's own site while answering.
 *
 * This is the leading indicator, and for a young brand it is the only one that
 * moves. Being cited as a source and being named in the prose are separate
 * events won by different content: measured live, a how-to question cited the
 * brand's domain while naming nobody at all, and the list-style questions that
 * did name companies cited roundups instead of any vendor's own site. So a
 * client publishing articles can be making real progress for months while
 * mention rate sits flat at zero — this is what shows it.
 */
export interface CitationStat {
  responsesWithOwnedSource: number;
  totalResponses: number;
  ownedCitationRate: number; // 0..1
  ownedCitationRateInterval: Interval;
  /** Distinct owned URLs cited, i.e. how many of their pages are landing. */
  distinctOwnedUrls: number;
  totalSources: number;
}

export function computeCitationStats(
  sources: Pick<Source, "response_id" | "url" | "is_owned">[],
  totalResponses: number,
): CitationStat {
  const owned = sources.filter((s) => s.is_owned);
  const responsesWithOwnedSource = new Set(owned.map((s) => s.response_id)).size;
  return {
    responsesWithOwnedSource,
    totalResponses,
    ownedCitationRate: totalResponses ? responsesWithOwnedSource / totalResponses : 0,
    ownedCitationRateInterval: wilsonInterval(responsesWithOwnedSource, totalResponses),
    distinctOwnedUrls: new Set(owned.map((s) => s.url)).size,
    totalSources: sources.length,
  };
}

/**
 * How much of a run actually measured anything.
 *
 * An answer that names no tracked company at all is not a zero — it's a failed
 * measurement, and today it's stored identically to a real miss. The two mean
 * opposite things: "three competitors were named and you weren't" is a
 * competitive finding, while "the model explained the category and named nobody"
 * says only that the question was the wrong shape. Measured live, how-to and
 * best-X phrasings named ~0.1 companies per answer while list-style phrasings
 * named 3.7, so a run built from the wrong shapes can look like total invisibility
 * while carrying no information whatsoever.
 *
 * Derived rather than stored: a response with no mention rows named nobody.
 */
export interface MeasurementQuality {
  totalResponses: number;
  responsesNamingSomeone: number;
  responsesNamingNobody: number;
  /** Share of answers that named at least one tracked entity. Low means the
   *  prompts need reshaping, not that the brand is absent. */
  informativeRate: number; // 0..1
}

export function computeMeasurementQuality(
  mentions: Pick<Mention, "response_id">[],
  totalResponses: number,
): MeasurementQuality {
  const responsesNamingSomeone = new Set(mentions.map((m) => m.response_id)).size;
  // Guard against a caller passing a stale/short response count.
  const naming = Math.min(responsesNamingSomeone, totalResponses);
  return {
    totalResponses,
    responsesNamingSomeone: naming,
    responsesNamingNobody: Math.max(0, totalResponses - naming),
    informativeRate: totalResponses ? naming / totalResponses : 0,
  };
}

/** Below this share of informative answers, a run's rates rest on too thin a
 *  sample to read as a competitive result. */
export const LOW_INFORMATIVE_RATE = 0.5;

export type MeasurementVerdict =
  | "no-data"
  /** Nothing to compare against, so informativeRate says nothing about prompts. */
  | "no-competitors"
  /** Too few answers recommended anyone; the rates aren't measuring much yet. */
  | "thin-sample"
  /** Answers did recommend, and consistently not this brand. A real finding. */
  | "real-gap"
  | "healthy";

/**
 * How to read a run's rates.
 *
 * A 0% brand visibility means two entirely different things depending on this,
 * and the UI used to present them identically. Observed live: one brand at 0%
 * with 70% of answers naming its competitors (a genuine authority gap) and
 * another at 0% with 16% (prompts that elicited explanations, not
 * recommendations, so the 0% measured almost nothing).
 */
export function measurementVerdict(input: {
  totalResponses: number;
  informativeRate: number;
  brandMentioned: boolean;
  competitorsTracked: number;
  /** The naming-quality sample behind informativeRate. When provided, the
   *  thin-sample gate becomes interval-aware: a run reads thin-sample only
   *  when the sample is CONFIDENTLY uninformative (Wilson upper bound below
   *  the floor), so a 0.47 on 30 answers doesn't flap a verdict that a 0.50
   *  would have passed. */
  informativeBasis?: number;
}): MeasurementVerdict {
  if (input.totalResponses === 0) return "no-data";
  if (input.competitorsTracked === 0) return "no-competitors";
  const thin =
    input.informativeBasis && input.informativeBasis > 0
      ? wilsonInterval(Math.round(input.informativeRate * input.informativeBasis), input.informativeBasis).high <
        LOW_INFORMATIVE_RATE
      : input.informativeRate < LOW_INFORMATIVE_RATE;
  if (thin) return "thin-sample";
  if (!input.brandMentioned) return "real-gap";
  return "healthy";
}

// ------------------------------------------------------------------
// Per-URL cited-hit rates, for prompts mapped to a target page.
//
// Content teams map questions to pages. A prompt carrying a target_url asks
// exactly one measurable thing: when this question gets asked, is MY page the
// one the answer cites? Brand-level citation stats can't answer that — a run
// can cite the site plenty while the page built for the question never
// surfaces.
// ------------------------------------------------------------------

/** A URL reduced to what identifies the PAGE: host + path, no scheme/www,
 *  no query/fragment (search results carry tracking params like
 *  ?utm_source=openai), no trailing slash, case-insensitive. */
export function pageKey(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    // Lowercasing the path is deliberate and technically wrong: paths are
    // case-sensitive per RFC 3986, so /Blog/Post and /blog/post collide here.
    // The trade favours recall, which is the right side for citation matching —
    // an engine that reformats a URL's casing should not read as "your page
    // wasn't cited". Revisit only if a real site serves different content at
    // two casings of one path.
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return null;
  }
}

export interface PageStat {
  /** The target_url as the caller entered it (first spelling wins). */
  url: string;
  /** Prompts aimed at this page. */
  prompts: number;
  /** Answers those prompts produced this run. */
  totalResponses: number;
  /** Answers that cited THIS page (host+path match, params ignored). */
  responsesCiting: number;
  citedRate: number;
  /** Page-level samples are tiny — the interval is the honest number. */
  citedRateInterval: Interval;
}

export function computePageStats(
  prompts: { id: string; target_url: string | null }[],
  responses: { id: string; prompt_id: string | null }[],
  sources: { response_id: string; url: string }[],
): PageStat[] {
  // target page key -> { url as entered, prompt ids }
  const targets = new Map<string, { url: string; promptIds: Set<string> }>();
  for (const p of prompts) {
    if (!p.target_url) continue;
    const key = pageKey(p.target_url);
    if (!key) continue;
    const t = targets.get(key) ?? { url: p.target_url, promptIds: new Set<string>() };
    t.promptIds.add(p.id);
    targets.set(key, t);
  }
  if (targets.size === 0) return [];

  const citedByResponse = new Map<string, Set<string>>();
  for (const s of sources) {
    const key = pageKey(s.url);
    if (!key) continue;
    const set = citedByResponse.get(s.response_id) ?? new Set<string>();
    set.add(key);
    citedByResponse.set(s.response_id, set);
  }

  const stats: PageStat[] = [];
  for (const [key, target] of targets) {
    let total = 0;
    let citing = 0;
    for (const r of responses) {
      if (!r.prompt_id || !target.promptIds.has(r.prompt_id)) continue;
      total++;
      if (citedByResponse.get(r.id)?.has(key)) citing++;
    }
    stats.push({
      url: target.url,
      prompts: target.promptIds.size,
      totalResponses: total,
      responsesCiting: citing,
      citedRate: total > 0 ? citing / total : 0,
      citedRateInterval: wilsonInterval(citing, total),
    });
  }
  // Most-asked first, then most-cited — the pages being pressed hardest on top.
  return stats.sort(
    (a, b) => b.totalResponses - a.totalResponses || b.responsesCiting - a.responsesCiting,
  );
}

// Per-topic breakdown for the brand (uses topic_id stored on mention rows).
export interface TopicStat {
  topicId: string | null;
  brandMentions: number;
  totalResponses: number;
  mentionRate: number;
  /** Per-topic samples are small — a topic's rate needs its interval even more
   *  than the run-level one does. */
  mentionRateInterval: Interval;
}

export function computeTopicStats(
  mentions: Mention[],
  responsesByTopic: Map<string | null, number>,
): TopicStat[] {
  const brandByTopic = new Map<string | null, Set<string>>();
  for (const m of mentions) {
    if (m.entity_type !== "brand") continue;
    const set = brandByTopic.get(m.topic_id) ?? new Set<string>();
    set.add(m.response_id);
    brandByTopic.set(m.topic_id, set);
  }
  const out: TopicStat[] = [];
  for (const [topicId, total] of responsesByTopic) {
    const brandMentions = brandByTopic.get(topicId)?.size ?? 0;
    out.push({
      topicId,
      brandMentions,
      totalResponses: total,
      mentionRate: total ? brandMentions / total : 0,
      mentionRateInterval: wilsonInterval(brandMentions, total),
    });
  }
  return out.sort((a, b) => b.mentionRate - a.mentionRate);
}

// ------------------------------------------------------------------
// Per-prompt entity breakdown — "who shows up for THIS question".
//
// The run-level entities[] answers "who owns the category". This answers the
// more actionable question a content team acts on: for a specific question, do
// competitors get named while we don't? A prompt where three rivals are named
// in every answer and the brand in none is a build-for-it target, and it's
// invisible in the run aggregate that averages it against questions nobody
// contests. Same math as the run report (computeEntityStats), scoped to one
// prompt's answers.
// ------------------------------------------------------------------

export interface PromptEntityStats {
  promptId: string;
  /** The question as asked, when the caller supplied it. */
  promptText: string | null;
  topicId: string | null;
  /** Answers to this prompt this run — the denominator behind every rate. */
  totalResponses: number;
  /** Brand first, then competitors by share of voice — the run's ordering,
   *  scoped to this one question. Brand row is always present (a zero when the
   *  brand went unnamed here) so "they show up, we don't" reads directly. */
  entities: EntityStat[];
}

export function computePromptEntityStats(
  mentions: Mention[],
  responses: { id: string; prompt_id: string | null; topic_id?: string | null }[],
  prompts: { id: string; text: string | null }[],
  brandName?: string,
): PromptEntityStats[] {
  const promptText = new Map(prompts.map((p) => [p.id, p.text]));
  // prompt_id -> its answers (the per-question denominator) and topic.
  const byPrompt = new Map<string, { ids: Set<string>; topicId: string | null }>();
  const promptByResponse = new Map<string, string>();
  for (const r of responses) {
    if (!r.prompt_id) continue;
    promptByResponse.set(r.id, r.prompt_id);
    const g = byPrompt.get(r.prompt_id) ?? { ids: new Set<string>(), topicId: r.topic_id ?? null };
    g.ids.add(r.id);
    byPrompt.set(r.prompt_id, g);
  }

  const mentionsByPrompt = new Map<string, Mention[]>();
  for (const m of mentions) {
    const pid = promptByResponse.get(m.response_id);
    if (!pid) continue;
    const list = mentionsByPrompt.get(pid) ?? [];
    list.push(m);
    mentionsByPrompt.set(pid, list);
  }

  const out: PromptEntityStats[] = [];
  for (const [promptId, { ids, topicId }] of byPrompt) {
    out.push({
      promptId,
      promptText: promptText.get(promptId) ?? null,
      topicId,
      totalResponses: ids.size,
      entities: computeEntityStats(mentionsByPrompt.get(promptId) ?? [], ids.size, brandName),
    });
  }

  // Questions where competitors show up strongest first — the build-for-it
  // queue. Rank by the top competitor's mention rate, then by sample size.
  const topCompetitorRate = (p: PromptEntityStats) =>
    p.entities
      .filter((e) => e.type === "competitor")
      .reduce((mx, e) => Math.max(mx, e.mentionRate), 0);
  return out.sort(
    (a, b) => topCompetitorRate(b) - topCompetitorRate(a) || b.totalResponses - a.totalResponses,
  );
}

// ------------------------------------------------------------------
// Per-prompt competitor CITATIONS — "whose site did the model read for this".
//
// Being named in the prose and having your page cited as a source are separate
// events (see the citation-stat note above). This is the citation half, split by
// competitor: for a question, which tracked rivals' domains did the answers
// actually cite? A domain the model keeps reaching for is a page worth
// out-writing. Only competitors with a resolvable domain can be attributed;
// names alone can't be matched to a URL.
// ------------------------------------------------------------------

/** A host reduced to its registrable form: no scheme, no www, lower-cased.
 *  Accepts either a full URL or a bare domain ("acme.com"). */
export function hostKey(value: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export interface CompetitorCitationStat {
  competitorId: string;
  name: string;
  /** The matched host (registrable form), so the UI can show what was cited. */
  domain: string;
  /** Distinct answers to this prompt that cited a page on this domain. */
  responsesCiting: number;
  totalResponses: number;
  citedRate: number;
  citedRateInterval: Interval;
}

export interface PromptCompetitorCitations {
  promptId: string;
  promptText: string | null;
  totalResponses: number;
  competitors: CompetitorCitationStat[];
}

export function computeCompetitorCitations(
  sources: { response_id: string; url: string }[],
  competitors: { id: string; name: string; domain: string | null }[],
  responses: { id: string; prompt_id: string | null }[],
  prompts: { id: string; text: string | null }[] = [],
): PromptCompetitorCitations[] {
  const tracked = competitors
    .map((c) => ({ ...c, host: c.domain ? hostKey(c.domain) : null }))
    .filter((c): c is (typeof c) & { host: string } => !!c.host);
  if (tracked.length === 0) return [];

  const promptText = new Map(prompts.map((p) => [p.id, p.text]));
  const promptByResponse = new Map<string, string>();
  const responsesByPrompt = new Map<string, Set<string>>();
  for (const r of responses) {
    if (!r.prompt_id) continue;
    promptByResponse.set(r.id, r.prompt_id);
    const set = responsesByPrompt.get(r.prompt_id) ?? new Set<string>();
    set.add(r.id);
    responsesByPrompt.set(r.prompt_id, set);
  }

  // prompt -> competitor host -> distinct responses that cited it.
  const hits = new Map<string, Map<string, Set<string>>>();
  for (const s of sources) {
    const pid = promptByResponse.get(s.response_id);
    if (!pid) continue;
    const host = hostKey(s.url);
    if (!host) continue;
    for (const c of tracked) {
      // A subdomain (blog.acme.com) counts as the competitor's site too.
      if (host === c.host || host.endsWith(`.${c.host}`)) {
        const perComp = hits.get(pid) ?? new Map<string, Set<string>>();
        const set = perComp.get(c.host) ?? new Set<string>();
        set.add(s.response_id);
        perComp.set(c.host, set);
        hits.set(pid, perComp);
      }
    }
  }
  if (hits.size === 0) return [];

  const byHost = new Map(tracked.map((c) => [c.host, c]));
  const out: PromptCompetitorCitations[] = [];
  for (const [promptId, perComp] of hits) {
    const total = responsesByPrompt.get(promptId)?.size ?? 0;
    const stats: CompetitorCitationStat[] = [];
    for (const [host, respSet] of perComp) {
      const c = byHost.get(host)!;
      const citing = respSet.size;
      stats.push({
        competitorId: c.id,
        name: c.name,
        domain: host,
        responsesCiting: citing,
        totalResponses: total,
        citedRate: total ? citing / total : 0,
        citedRateInterval: wilsonInterval(citing, total),
      });
    }
    stats.sort((a, b) => b.responsesCiting - a.responsesCiting);
    out.push({
      promptId,
      promptText: promptText.get(promptId) ?? null,
      totalResponses: total,
      competitors: stats,
    });
  }
  // Most-cited-against questions first.
  return out.sort(
    (a, b) => (b.competitors[0]?.responsesCiting ?? 0) - (a.competitors[0]?.responsesCiting ?? 0),
  );
}

// A single color per sentiment, matching the brand palette.
export const SENTIMENT_COLORS: Record<Sentiment, string> = {
  positive: "#82EAD1", // aqua-mint
  neutral: "#CBB9A0", // warm sand
  negative: "#E07850", // terracotta
};

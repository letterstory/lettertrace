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

// A single color per sentiment, matching the brand palette.
export const SENTIMENT_COLORS: Record<Sentiment, string> = {
  positive: "#82EAD1", // aqua-mint
  neutral: "#CBB9A0", // warm sand
  negative: "#E07850", // terracotta
};

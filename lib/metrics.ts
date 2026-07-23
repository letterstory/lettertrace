import type { Mention, Sentiment } from "@/lib/types";

// Aggregations over stored (positive) mention rows. `totalResponses` is the
// number of assistant answers in scope, the denominator for mention rate.

export interface EntityStat {
  key: string; // 'brand' or a competitor id
  name: string;
  type: "brand" | "competitor";
  responsesMentioned: number;
  totalResponses: number;
  mentionRate: number; // 0..1
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

export function computeEntityStats(mentions: Mention[], totalResponses: number): EntityStat[] {
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
      totalMentionCount,
      shareOfVoice: grandTotalMentions ? totalMentionCount / grandTotalMentions : 0,
      avgProminence,
      recommendRate: responsesMentioned ? recommended / responsesMentioned : 0,
      sentiment,
      sentimentScore,
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
  brandShareOfVoice: number;
  brandSentimentScore: number;
  brandAvgProminence: number;
}

export function computeRunSummary(mentions: Mention[], totalResponses: number): RunSummary {
  const stats = computeEntityStats(mentions, totalResponses);
  const brand = stats.find((s) => s.type === "brand");
  return {
    brandMentionRate: brand?.mentionRate ?? 0,
    brandShareOfVoice: brand?.shareOfVoice ?? 0,
    brandSentimentScore: brand?.sentimentScore ?? 0,
    brandAvgProminence: brand?.avgProminence ?? 0,
  };
}

// Per-topic breakdown for the brand (uses topic_id stored on mention rows).
export interface TopicStat {
  topicId: string | null;
  brandMentions: number;
  totalResponses: number;
  mentionRate: number;
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

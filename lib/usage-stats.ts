/**
 * Public usage statistics for lettertrace.com, counted by Letterprove and
 * recounted daily. Read on the server at request time (cached for at most five
 * minutes) so the footer line, llms.txt section and JSON-LD counters are all in
 * the HTML an agent fetches, and never hard-coded. When the data can't be read
 * this returns null and nothing about usage renders anywhere.
 */

export const USAGE_DATA_URL = "https://app.letterstory.com/shared/usage/xnsik8j0gjjc/data.json";

const REVALIDATE_SECONDS = 300;
const TIMEOUT_MS = 3000;

export type UsageStats = {
  line: string;
  llms: string;
  url: string;
  interactionStatistic: Record<string, unknown>[];
};

export function parseUsageStats(data: unknown): UsageStats | null {
  if (!data || typeof data !== "object") return null;
  const { line, llms, url, interaction_statistic } = data as Record<string, unknown>;
  if (typeof line !== "string" || !line.trim()) return null;
  if (typeof llms !== "string" || !llms.trim()) return null;
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return null;
  if (!Array.isArray(interaction_statistic) || interaction_statistic.length === 0) return null;
  if (!interaction_statistic.every((s) => s && typeof s === "object" && !Array.isArray(s))) return null;
  return {
    line,
    llms,
    url,
    interactionStatistic: interaction_statistic as Record<string, unknown>[],
  };
}

export async function getUsageStats(): Promise<UsageStats | null> {
  try {
    const res = await fetch(USAGE_DATA_URL, {
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseUsageStats(await res.json());
  } catch {
    return null;
  }
}

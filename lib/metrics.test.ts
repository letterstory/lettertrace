import { describe, it, expect } from "vitest";
import { wilsonInterval, computeEntityStats, computeRunSummary } from "@/lib/metrics";
import type { Mention } from "@/lib/types";

function mention(over: Partial<Mention> = {}): Mention {
  return {
    id: crypto.randomUUID(),
    response_id: crypto.randomUUID(),
    run_id: "run-1",
    project_id: "proj-1",
    topic_id: null,
    entity_type: "brand",
    competitor_id: null,
    entity_name: "Acme",
    mentioned: true,
    mention_count: 1,
    first_position: 0.1,
    sentiment: "positive",
    recommended: true,
    created_at: new Date(0).toISOString(),
    ...over,
  };
}

describe("wilsonInterval", () => {
  // The reason this function exists: both are a rate of zero, and only one of
  // them is evidence of anything.
  it("separates a zero from one answer from a zero from thirty", () => {
    const one = wilsonInterval(0, 1);
    const thirty = wilsonInterval(0, 30);
    expect(one.low).toBe(0);
    expect(thirty.low).toBe(0);
    expect(one.high).toBeGreaterThan(0.7); // could plausibly be a common mention
    expect(thirty.high).toBeLessThan(0.15); // genuinely looks absent
  });

  it("stays inside [0,1] at the extremes where the normal approximation breaks", () => {
    for (const [s, n] of [[0, 1], [1, 1], [0, 3], [3, 3], [0, 100], [100, 100]] as const) {
      const { low, high } = wilsonInterval(s, n);
      expect(low).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(1);
      expect(low).toBeLessThanOrEqual(high);
    }
  });

  it("does not collapse to a point at 0 or 100 percent", () => {
    expect(wilsonInterval(0, 5).high).toBeGreaterThan(0);
    expect(wilsonInterval(5, 5).low).toBeLessThan(1);
  });

  it("narrows as the sample grows at a fixed rate", () => {
    const width = (s: number, n: number) => {
      const i = wilsonInterval(s, n);
      return i.high - i.low;
    };
    expect(width(5, 10)).toBeGreaterThan(width(50, 100));
    expect(width(50, 100)).toBeGreaterThan(width(500, 1000));
  });

  it("brackets the observed rate", () => {
    const i = wilsonInterval(3, 10);
    expect(i.low).toBeLessThanOrEqual(0.3);
    expect(i.high).toBeGreaterThanOrEqual(0.3);
  });

  it("returns the full range for an empty sample rather than dividing by zero", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it("clamps a nonsensical success count instead of producing NaN", () => {
    const i = wilsonInterval(7, 3);
    expect(Number.isNaN(i.low)).toBe(false);
    expect(Number.isNaN(i.high)).toBe(false);
    expect(i.high).toBeLessThanOrEqual(1);
  });
});

describe("computeEntityStats zero-mention brand row", () => {
  it("reports a brand row with rate 0 when the brand was never mentioned", () => {
    const mentions = [mention({ entity_type: "competitor", competitor_id: "c1", entity_name: "Rival" })];
    const stats = computeEntityStats(mentions, 12, "Acme");
    const brand = stats.find((s) => s.type === "brand");
    expect(brand).toBeDefined();
    expect(brand!.name).toBe("Acme");
    expect(brand!.mentionRate).toBe(0);
    expect(brand!.totalResponses).toBe(12);
    expect(brand!.mentionRateInterval.high).toBeLessThan(0.3);
  });

  it("still omits the brand when no name is supplied (back-compat)", () => {
    const mentions = [mention({ entity_type: "competitor", competitor_id: "c1", entity_name: "Rival" })];
    expect(computeEntityStats(mentions, 12).some((s) => s.type === "brand")).toBe(false);
  });

  it("does not synthesise a duplicate when the brand was mentioned", () => {
    const stats = computeEntityStats([mention()], 4, "Acme");
    expect(stats.filter((s) => s.type === "brand")).toHaveLength(1);
    expect(stats[0].mentionRate).toBe(0.25);
  });

  it("keeps the brand sorted first", () => {
    const mentions = [
      mention({ entity_type: "competitor", competitor_id: "c1", entity_name: "Rival", mention_count: 9 }),
    ];
    expect(computeEntityStats(mentions, 10, "Acme")[0].type).toBe("brand");
  });
});

describe("computeRunSummary", () => {
  it("carries the interval and the raw counts behind the rate", () => {
    const s = computeRunSummary([mention()], 8, "Acme");
    expect(s.brandResponsesMentioned).toBe(1);
    expect(s.totalResponses).toBe(8);
    expect(s.brandMentionRate).toBeCloseTo(0.125);
    expect(s.brandMentionRateInterval.low).toBeLessThanOrEqual(0.125);
    expect(s.brandMentionRateInterval.high).toBeGreaterThanOrEqual(0.125);
  });

  it("reports a believable zero for an unmentioned brand", () => {
    const s = computeRunSummary([], 30, "Acme");
    expect(s.brandMentionRate).toBe(0);
    expect(s.brandResponsesMentioned).toBe(0);
    expect(s.totalResponses).toBe(30);
    expect(s.brandMentionRateInterval.high).toBeLessThan(0.15);
  });

  it("reports an unconvincing zero when only one answer was collected", () => {
    const s = computeRunSummary([], 1, "Acme");
    expect(s.brandMentionRate).toBe(0);
    expect(s.brandMentionRateInterval.high).toBeGreaterThan(0.7);
  });
});

import { describe, it, expect } from "vitest";
import {
  wilsonInterval,
  computeEntityStats,
  computeRunSummary,
  computeCitationStats,
  computeMeasurementQuality,
  measurementVerdict,
  LOW_INFORMATIVE_RATE,
  computePageStats,
  pageKey,
} from "@/lib/metrics";
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

describe("computeCitationStats", () => {
  const src = (response_id: string, url: string, is_owned: boolean) => ({ response_id, url, is_owned });

  it("counts answers that cited the brand's own site, not raw citations", () => {
    // Two owned citations inside one answer is still one answer.
    const s = computeCitationStats(
      [
        src("r1", "https://acme.com/a", true),
        src("r1", "https://acme.com/b", true),
        src("r2", "https://other.com/x", false),
      ],
      4,
    );
    expect(s.responsesWithOwnedSource).toBe(1);
    expect(s.ownedCitationRate).toBe(0.25);
    expect(s.distinctOwnedUrls).toBe(2);
    expect(s.totalSources).toBe(3);
  });

  it("reports a believable zero when nothing of the brand's was cited", () => {
    const s = computeCitationStats([src("r1", "https://other.com", false)], 20);
    expect(s.ownedCitationRate).toBe(0);
    expect(s.distinctOwnedUrls).toBe(0);
    expect(s.ownedCitationRateInterval.high).toBeLessThan(0.2);
  });

  it("does not double-count the same page cited across answers", () => {
    const s = computeCitationStats(
      [src("r1", "https://acme.com/a", true), src("r2", "https://acme.com/a", true)],
      2,
    );
    expect(s.responsesWithOwnedSource).toBe(2);
    expect(s.distinctOwnedUrls).toBe(1);
    expect(s.ownedCitationRate).toBe(1);
  });

  it("handles a run with no sources at all", () => {
    const s = computeCitationStats([], 5);
    expect(s.ownedCitationRate).toBe(0);
    expect(s.totalSources).toBe(0);
    expect(s.ownedCitationRateInterval.high).toBeGreaterThan(0);
  });
});

describe("computeMeasurementQuality", () => {
  const at = (response_id: string) => ({ response_id });

  it("separates answers that named someone from answers that named nobody", () => {
    // 5 answers, 2 of which named a tracked company (one named two).
    const q = computeMeasurementQuality([at("r1"), at("r1"), at("r2")], 5);
    expect(q.responsesNamingSomeone).toBe(2);
    expect(q.responsesNamingNobody).toBe(3);
    expect(q.informativeRate).toBeCloseTo(0.4);
  });

  it("flags a run where every answer named nobody as measuring nothing", () => {
    const q = computeMeasurementQuality([], 12);
    expect(q.responsesNamingSomeone).toBe(0);
    expect(q.responsesNamingNobody).toBe(12);
    expect(q.informativeRate).toBe(0);
  });

  it("reports a fully informative run", () => {
    const q = computeMeasurementQuality([at("r1"), at("r2")], 2);
    expect(q.informativeRate).toBe(1);
    expect(q.responsesNamingNobody).toBe(0);
  });

  it("never reports negative unnamed answers if the counts disagree", () => {
    const q = computeMeasurementQuality([at("r1"), at("r2"), at("r3")], 1);
    expect(q.responsesNamingNobody).toBe(0);
    expect(q.responsesNamingSomeone).toBe(1);
  });

  it("handles an empty run", () => {
    expect(computeMeasurementQuality([], 0).informativeRate).toBe(0);
  });
});

describe("measurementVerdict", () => {
  const base = {
    totalResponses: 20,
    informativeRate: 0.8,
    brandMentioned: true,
    competitorsTracked: 5,
  };

  it("says nothing when there are no answers", () => {
    expect(measurementVerdict({ ...base, totalResponses: 0 })).toBe("no-data");
  });

  // With nothing to compare against, informativeRate can only count the brand,
  // so a low value says nothing about the prompts and mustn't blame them.
  it("blames the missing competitors, not the prompts, when none are tracked", () => {
    expect(
      measurementVerdict({ ...base, competitorsTracked: 0, informativeRate: 0, brandMentioned: false }),
    ).toBe("no-competitors");
  });

  // The Runlayer case: 3 of 19 answers named anyone, so 0% measured almost
  // nothing and must not be read as losing.
  it("calls a run with few informative answers a thin sample", () => {
    expect(
      measurementVerdict({ ...base, informativeRate: 3 / 19, brandMentioned: false }),
    ).toBe("thin-sample");
  });

  // The Archil case: 14 of 20 answers named a competitor and none named the
  // brand. That is a finding, not a measurement problem.
  it("calls a well-measured absence a real gap", () => {
    expect(
      measurementVerdict({ ...base, informativeRate: 14 / 20, brandMentioned: false }),
    ).toBe("real-gap");
  });

  it("treats a thin sample as thin even when the brand did appear", () => {
    expect(measurementVerdict({ ...base, informativeRate: 0.1 })).toBe("thin-sample");
  });

  it("is healthy when the sample is informative and the brand appears", () => {
    expect(measurementVerdict(base)).toBe("healthy");
  });

  it("puts the threshold boundary on the informative side", () => {
    expect(
      measurementVerdict({ ...base, informativeRate: LOW_INFORMATIVE_RATE, brandMentioned: false }),
    ).toBe("real-gap");
    expect(
      measurementVerdict({ ...base, informativeRate: LOW_INFORMATIVE_RATE - 0.01, brandMentioned: false }),
    ).toBe("thin-sample");
  });
});

describe("pageKey", () => {
  it("reduces a URL to host + path, dropping noise that varies per citation", () => {
    expect(pageKey("https://www.acme.io/Blog/Best-CRM/?utm_source=openai#top")).toBe(
      "acme.io/blog/best-crm",
    );
    expect(pageKey("acme.io/blog/best-crm")).toBe("acme.io/blog/best-crm");
    expect(pageKey("not a url")).toBeNull();
  });
});

describe("computePageStats", () => {
  const prompts = [
    { id: "p1", target_url: "https://acme.io/blog/best-crm" },
    { id: "p2", target_url: "acme.io/blog/best-crm/" }, // same page, different spelling
    { id: "p3", target_url: null }, // unmapped prompts don't produce a row
  ];
  const responses = [
    { id: "r1", prompt_id: "p1" },
    { id: "r2", prompt_id: "p1" },
    { id: "r3", prompt_id: "p2" },
    { id: "r4", prompt_id: "p3" },
    { id: "r5", prompt_id: null },
  ];
  const sources = [
    // r1 cited the page (with tracking params, as search engines append them).
    { response_id: "r1", url: "https://acme.io/blog/best-crm?utm_source=openai" },
    // r2 cited the site but a DIFFERENT page — that's the whole point of
    // page-level tracking: the site being cited isn't the page being cited.
    { response_id: "r2", url: "https://acme.io/blog/other-post" },
    { response_id: "r4", url: "https://acme.io/blog/best-crm" },
  ];

  it("counts only answers from the page's own prompts, matching by host+path", () => {
    const stats = computePageStats(prompts, responses, sources);
    expect(stats).toHaveLength(1);
    const stat = stats[0];
    // Two spellings of the same page collapse into one row (first wins).
    expect(stat.url).toBe("https://acme.io/blog/best-crm");
    expect(stat.prompts).toBe(2);
    expect(stat.totalResponses).toBe(3); // r1, r2, r3 — r4's prompt is unmapped
    expect(stat.responsesCiting).toBe(1); // only r1; r2 cited another page
    expect(stat.citedRate).toBeCloseTo(1 / 3);
    expect(stat.citedRateInterval.low).toBeGreaterThanOrEqual(0);
    expect(stat.citedRateInterval.high).toBeLessThanOrEqual(1);
  });

  it("returns [] when no prompt is mapped to a page", () => {
    expect(computePageStats([{ id: "p1", target_url: null }], responses, sources)).toEqual([]);
  });
});

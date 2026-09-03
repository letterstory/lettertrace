import { describe, expect, it } from "vitest";
import { isPeriod, periodFrom, periodLabel, periodStart } from "./periods";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-09-03T17:00:00.000Z");

describe("periodStart", () => {
  it("opens the rolling windows a whole number of days back", () => {
    expect(periodStart("7d", NOW)).toBe(NOW - 7 * DAY_MS);
    expect(periodStart("30d", NOW)).toBe(NOW - 30 * DAY_MS);
  });

  it("anchors year-to-date on Jan 1 UTC, matching the day-bucketing elsewhere", () => {
    expect(periodStart("ytd", NOW)).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("returns null for all-time rather than a very old timestamp", () => {
    // Null is what tells a loader to drop the filter entirely; a sentinel date
    // would silently cut off anything older than it.
    expect(periodStart("all", NOW)).toBeNull();
  });
});

describe("periodFrom", () => {
  it("reads a valid value, from a bare string or the first of an array", () => {
    expect(periodFrom("7d")).toBe("7d");
    expect(periodFrom(["ytd", "7d"])).toBe("ytd");
  });

  it("falls back rather than throwing on junk — an odd URL must still render", () => {
    expect(periodFrom(undefined)).toBe("30d");
    expect(periodFrom("last-tuesday")).toBe("30d");
    expect(periodFrom([])).toBe("30d");
    expect(periodFrom("7d ")).toBe("30d");
  });

  it("takes a caller-chosen fallback", () => {
    expect(periodFrom(undefined, "all")).toBe("all");
  });
});

describe("isPeriod", () => {
  it("accepts only the four windows", () => {
    for (const good of ["7d", "30d", "ytd", "all"]) expect(isPeriod(good)).toBe(true);
    for (const bad of ["1d", "", null, undefined, 7, {}]) expect(isPeriod(bad)).toBe(false);
  });
});

describe("periodLabel", () => {
  it("reads mid-sentence, lowercased", () => {
    expect(periodLabel("7d")).toBe("last 7 days");
    expect(periodLabel("all")).toBe("all time");
  });
});

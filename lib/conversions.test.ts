import { describe, expect, it } from "vitest";
import {
  clicksSince,
  isPeriod,
  normalizeProductUrl,
  periodStart,
  productOf,
  median,
  shapeConversionStats,
  shapeConnectedUsers,
  shapeKeyedStats,
  shapeRateSeries,
  type KeyRow,
  type OutboundClickRow,
} from "./conversions";
import type { GrowthProfileRow } from "./growth";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-08-24T12:00:00.000Z");

function iso(daysAgo: number, hoursAgo = 0): string {
  return new Date(NOW - daysAgo * DAY_MS - hoursAgo * 3_600_000).toISOString();
}

function click(overrides: Partial<OutboundClickRow>): OutboundClickRow {
  return {
    user_id: "u1",
    url: "https://phantomstory.com",
    clicked_at: iso(0, 1),
    ...overrides,
  };
}

const PROFILES: GrowthProfileRow[] = [
  { id: "u1", email: "jo@acme.io", created_at: iso(60) },
  { id: "u2", email: "sam@gmail.com", created_at: iso(20) },
  { id: "u3", email: "eval@mailinator.com", created_at: iso(3) },
  { id: "u4", email: null, created_at: iso(10) },
];

describe("normalizeProductUrl", () => {
  it("keeps origin + path, drops query and hash, trims trailing slashes", () => {
    expect(normalizeProductUrl("https://phantomstory.com/?utm_source=lt#top")).toBe(
      "https://phantomstory.com",
    );
    expect(normalizeProductUrl("https://letterbrace.com/pricing/?ref=lt")).toBe(
      "https://letterbrace.com/pricing",
    );
  });

  it("accepts subdomains of allow-listed hosts", () => {
    expect(normalizeProductUrl("https://app.letterprove.com/start")).toBe(
      "https://app.letterprove.com/start",
    );
  });

  it("rejects hosts off the allow-list, including suffix look-alikes", () => {
    expect(normalizeProductUrl("https://example.com")).toBeNull();
    expect(normalizeProductUrl("https://evilphantomstory.com")).toBeNull();
    expect(normalizeProductUrl("https://phantomstory.com.evil.io")).toBeNull();
  });

  it("rejects non-http(s) and unparseable input", () => {
    expect(normalizeProductUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeProductUrl("not a url")).toBeNull();
    expect(normalizeProductUrl(null)).toBeNull();
    expect(normalizeProductUrl(undefined)).toBeNull();
  });
});

describe("productOf", () => {
  it("maps a URL to its allow-list host, subdomains included", () => {
    expect(productOf("https://phantomstory.com/foo")).toBe("phantomstory.com");
    expect(productOf("https://app.letterprove.com/start")).toBe("letterprove.com");
  });

  it("falls back to the hostname for an unexpected row", () => {
    expect(productOf("https://example.com/x")).toBe("example.com");
  });
});

describe("periods", () => {
  it("validates period strings", () => {
    expect(isPeriod("7d")).toBe(true);
    expect(isPeriod("all")).toBe(true);
    expect(isPeriod("90d")).toBe(false);
    expect(isPeriod(undefined)).toBe(false);
  });

  it("opens 7d/30d as rolling windows, ytd at Jan 1 UTC, all as null", () => {
    expect(periodStart("7d", NOW)).toBe(NOW - 7 * DAY_MS);
    expect(periodStart("30d", NOW)).toBe(NOW - 30 * DAY_MS);
    expect(periodStart("ytd", NOW)).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(periodStart("all", NOW)).toBeNull();
  });

  it("clicksSince keeps everything for null and filters otherwise", () => {
    const clicks = [click({ clicked_at: iso(1) }), click({ clicked_at: iso(20) })];
    expect(clicksSince(clicks, null)).toHaveLength(2);
    expect(clicksSince(clicks, NOW - 7 * DAY_MS)).toHaveLength(1);
    expect(clicksSince([click({ clicked_at: "not a date" })], NOW - 7 * DAY_MS)).toHaveLength(0);
  });
});

describe("shapeConversionStats", () => {
  it("counts distinct connected and computes a one-decimal rate", () => {
    const clicks = [
      click({ user_id: "u1" }),
      click({ user_id: "u1", clicked_at: iso(1) }),
      click({ user_id: "u2", url: "https://letterbrace.com/pricing" }),
    ];
    const stats = shapeConversionStats(clicks, 4, null);
    expect(stats.connectedUsers).toBe(2);
    expect(stats.totalUsers).toBe(4);
    expect(stats.rate).toBe(50);
    expect(stats.clicks).toBe(3);
  });

  it("keeps sub-percent rates visible instead of rounding to zero", () => {
    const stats = shapeConversionStats([click({})], 300, null);
    expect(stats.rate).toBe(0.3);
  });

  it("scopes to the period while keeping all-time companions", () => {
    const clicks = [
      click({ user_id: "u1", clicked_at: iso(0, 2) }),
      click({ user_id: "u2", clicked_at: iso(10) }),
      click({ user_id: "u3", clicked_at: iso(45) }),
    ];
    const stats = shapeConversionStats(clicks, 10, NOW - 7 * DAY_MS);
    expect(stats.connectedUsers).toBe(1);
    expect(stats.clicks).toBe(1);
    expect(stats.rate).toBe(10);
    expect(stats.connectedAllTime).toBe(3);
    expect(stats.clicksAllTime).toBe(3);
  });

  it("picks the most clicked product in the period as top destination", () => {
    const clicks = [
      click({}),
      click({ clicked_at: iso(1) }),
      click({ user_id: "u2", url: "https://letterbrace.com", clicked_at: iso(45) }),
    ];
    expect(shapeConversionStats(clicks, 10, NOW - 30 * DAY_MS).topProduct).toEqual({
      product: "phantomstory.com",
      clicks: 2,
    });
  });

  it("returns null rate and top product when there is nothing to divide", () => {
    const stats = shapeConversionStats([], 0, null);
    expect(stats.rate).toBeNull();
    expect(stats.topProduct).toBeNull();
    expect(stats.connectedUsers).toBe(0);
  });
});

describe("shapeRateSeries", () => {
  it("builds one point per day with that day's rate over signups as of that day", () => {
    // u2 signed up 20d ago, u3 3d ago (PROFILES); period covers last 7 days.
    const clicks = [
      click({ user_id: "u2", clicked_at: iso(5) }),
      click({ user_id: "u2", clicked_at: iso(5, 2) }),
      click({ user_id: "u2", clicked_at: iso(2) }),
      click({ user_id: "u3", clicked_at: iso(2) }),
    ];
    const series = shapeRateSeries(clicks, PROFILES, NOW - 7 * DAY_MS, NOW);
    expect(series).toHaveLength(8); // 7 full days back plus today

    const day5 = series.find((p) => p.day === iso(5).slice(0, 10))!;
    // 5d ago: u1/u2/u4 had signed up (u3 hadn't yet); u2 clicked twice, one user.
    expect(day5.connected).toBe(1);
    expect(day5.signups).toBe(3);
    expect(day5.rate).toBe(33.33);
    expect(day5.clicks).toBe(2);

    const day2 = series.find((p) => p.day === iso(2).slice(0, 10))!;
    // 2d ago: all four signed up; u2 and u3 clicked — u2's earlier day doesn't carry over.
    expect(day2.connected).toBe(2);
    expect(day2.signups).toBe(4);
    expect(day2.rate).toBe(50);
  });

  it("puts a quiet day at zero rather than carrying the last rate forward", () => {
    const clicks = [click({ user_id: "u2", clicked_at: iso(5) })];
    const series = shapeRateSeries(clicks, PROFILES, NOW - 7 * DAY_MS, NOW);
    const day4 = series.find((p) => p.day === iso(4).slice(0, 10))!;
    expect(day4.connected).toBe(0);
    expect(day4.rate).toBe(0);
    expect(series.at(-1)!.rate).toBe(0);
  });

  it("keeps two decimals so one clicker in a big base is not rounded to zero", () => {
    const profiles: GrowthProfileRow[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `p${i}`,
      email: null,
      created_at: iso(30),
    }));
    const series = shapeRateSeries([click({ user_id: "p1", clicked_at: iso(1) })], profiles, NOW - 7 * DAY_MS, NOW);
    expect(series.find((p) => p.day === iso(1).slice(0, 10))!.rate).toBe(0.05);
  });

  it("is null on days before anyone had signed up", () => {
    const profiles: GrowthProfileRow[] = [{ id: "u1", email: null, created_at: iso(2) }];
    const series = shapeRateSeries([click({ clicked_at: iso(1) })], profiles, NOW - 7 * DAY_MS, NOW);
    expect(series.find((p) => p.day === iso(5).slice(0, 10))!.rate).toBeNull();
    expect(series.find((p) => p.day === iso(1).slice(0, 10))!.rate).toBe(100);
  });

  it("starts at the first click for all-time, and is empty with no clicks", () => {
    const series = shapeRateSeries([click({ clicked_at: iso(3) })], PROFILES, null, NOW);
    expect(series[0].day).toBe(iso(3).slice(0, 10));
    expect(shapeRateSeries([], PROFILES, null, NOW)).toEqual([]);
  });

  it("ignores clicks from the future and unparseable timestamps", () => {
    const clicks = [
      click({ clicked_at: iso(-2) }),
      click({ clicked_at: "not a date" }),
      click({ user_id: "u2", clicked_at: iso(1) }),
    ];
    const series = shapeRateSeries(clicks, PROFILES, NOW - 7 * DAY_MS, NOW);
    expect(series.find((p) => p.day === iso(1).slice(0, 10))!.connected).toBe(1);
    expect(series.reduce((n, p) => n + p.clicks, 0)).toBe(1);
  });
});

describe("shapeConnectedUsers", () => {
  it("groups clicks per user with destinations, first/last, most recent user first", () => {
    const clicks = [
      click({ user_id: "u1", clicked_at: iso(5) }),
      click({ user_id: "u1", clicked_at: iso(1) }),
      click({ user_id: "u1", url: "https://letterbrace.com/pricing", clicked_at: iso(3) }),
      click({ user_id: "u2", clicked_at: iso(0, 1) }),
    ];
    const connected = shapeConnectedUsers(clicks, PROFILES);
    expect(connected.map((c) => c.userId)).toEqual(["u2", "u1"]);

    const u1 = connected[1];
    expect(u1.email).toBe("jo@acme.io");
    expect(u1.emailClass).toBe("work");
    expect(u1.clicks).toBe(3);
    expect(u1.firstClickAt).toBe(iso(5));
    expect(u1.lastClickAt).toBe(iso(1));
    expect(u1.destinations).toEqual([
      { url: "https://phantomstory.com", product: "phantomstory.com", clicks: 2 },
      { url: "https://letterbrace.com/pricing", product: "letterbrace.com", clicks: 1 },
    ]);
  });

  it("keeps rows whose profile is missing or has no email", () => {
    const clicks = [click({ user_id: "u4" }), click({ user_id: "gone" })];
    const connected = shapeConnectedUsers(clicks, PROFILES);
    expect(connected).toHaveLength(2);
    for (const c of connected) {
      expect(c.email).toBeNull();
      expect(c.emailClass).toBe("personal");
    }
  });
});

describe("shapeKeyedStats", () => {
  const keys: KeyRow[] = [
    // u1 converted 40 days ago and added a second key inside the window; the
    // period must still credit them to the older date, not count them twice.
    { user_id: "u1", created_at: iso(40) },
    { user_id: "u1", created_at: iso(3) },
    { user_id: "u2", created_at: iso(5) },
    { user_id: "u3", created_at: iso(0, 2) },
  ];
  // u1 took 10 days, u2 took 2 days, u3 took 1 hour. 47 more signups with no
  // key, so the denominator is 50.
  const keyed: GrowthProfileRow[] = [
    { id: "u1", email: "a@x.com", created_at: iso(50) },
    { id: "u2", email: "b@x.com", created_at: iso(7) },
    { id: "u3", email: "c@x.com", created_at: iso(0, 3) },
  ];
  const profiles: GrowthProfileRow[] = [
    ...keyed,
    ...Array.from({ length: 47 }, (_, i) => ({
      id: `n${i}`,
      email: null,
      created_at: iso(10),
    })),
  ];

  it("counts a user by their first key, once", () => {
    const stats = shapeKeyedStats(keys, profiles, NOW - 30 * DAY_MS);
    expect(stats.users).toBe(2);
    expect(stats.allTime).toBe(3);
  });

  it("counts everyone for an all-time period", () => {
    expect(shapeKeyedStats(keys, profiles, null).users).toBe(3);
  });

  it("rates the window's SIGNUP COHORT, so the numerator can't escape the denominator", () => {
    // All time: 3 of 50 accounts hold a key.
    const allTime = shapeKeyedStats(keys, profiles, null);
    expect(allTime).toMatchObject({ cohortSize: 50, cohortKeyed: 3, rate: 6 });

    // Last 30 days: u2 (7d) and u3 (3h) signed up in it, and both hold a key.
    // The 47 keyless accounts signed up 10 days ago, so they are in the cohort
    // too — 2 of 49.
    const monthly = shapeKeyedStats(keys, profiles, NOW - 30 * DAY_MS);
    expect(monthly).toMatchObject({ cohortSize: 49, cohortKeyed: 2 });
    expect(monthly.rate).toBeCloseTo(4.1, 1);
  });

  it("never exceeds 100%, unlike keys-added-over-signups", () => {
    // u1 signed up 50 days ago and first keyed 40 days ago. In a 7-day window
    // they contribute a key event but no signup, which is exactly the case
    // that would push a naive ratio past 100%.
    const week = shapeKeyedStats(keys, profiles, NOW - 7 * DAY_MS);
    expect(week.cohortKeyed).toBeLessThanOrEqual(week.cohortSize);
    expect(week.rate!).toBeLessThanOrEqual(100);
  });

  it("keeps one decimal so an early rate does not round to zero", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({
      id: `n${i}`,
      email: null,
      created_at: iso(5),
    }));
    expect(shapeKeyedStats([{ user_id: "n0", created_at: iso(1) }], many, null).rate).toBe(0.1);
  });

  it("medians the signup-to-first-key gap over the period cohort", () => {
    // In the last 30 days: u2 (2 days) and u3 (1 hour). Two values, so the
    // median averages them.
    const stats = shapeKeyedStats(keys, profiles, NOW - 30 * DAY_MS);
    expect(stats.medianMs).toBe(Math.round((2 * DAY_MS + 3_600_000) / 2));
    // All time adds u1's 10 days, making three values with 2 days in the middle.
    expect(stats.medianAllTimeMs).toBe(2 * DAY_MS);
  });

  it("nulls the period median when nobody activated in it, keeping the all-time one", () => {
    const stats = shapeKeyedStats(keys, profiles, NOW + DAY_MS);
    expect(stats.users).toBe(0);
    expect(stats.medianMs).toBeNull();
    expect(stats.medianAllTimeMs).toBe(2 * DAY_MS);
  });

  it("still counts a key whose owner has no profile row, but draws no gap from it", () => {
    const orphan: KeyRow[] = [{ user_id: "gone", created_at: iso(1) }];
    const stats = shapeKeyedStats(orphan, profiles, null);
    expect(stats.allTime).toBe(1);
    expect(stats.medianMs).toBeNull();
  });

  it("skips unparseable timestamps and nulls the rate with no users", () => {
    expect(shapeKeyedStats([{ user_id: "u1", created_at: "nope" }], [], null)).toEqual({
      users: 0,
      allTime: 0,
      rate: null,
      cohortSize: 0,
      cohortKeyed: 0,
      medianMs: null,
      medianAllTimeMs: null,
    });
  });
});

describe("median", () => {
  it("takes the middle of an odd count and averages the two middles of an even one", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(median([])).toBeNull();
  });
});

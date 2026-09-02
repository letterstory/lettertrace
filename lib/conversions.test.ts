import { describe, expect, it } from "vitest";
import {
  clicksSince,
  isPeriod,
  normalizeProductUrl,
  periodStart,
  productOf,
  shapeConversionStats,
  shapeConnectedUsers,
  shapeRateSeries,
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

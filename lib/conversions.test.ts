import { describe, expect, it } from "vitest";
import {
  normalizeProductUrl,
  productOf,
  shapeConversionStats,
  shapeConnectedUsers,
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

describe("shapeConversionStats", () => {
  it("counts distinct connected and computes a one-decimal rate", () => {
    const clicks = [
      click({ user_id: "u1" }),
      click({ user_id: "u1", clicked_at: iso(1) }),
      click({ user_id: "u2", url: "https://letterbrace.com/pricing" }),
    ];
    const stats = shapeConversionStats(clicks, 4, NOW);
    expect(stats.connectedUsers).toBe(2);
    expect(stats.totalUsers).toBe(4);
    expect(stats.rate).toBe(50);
    expect(stats.clicksTotal).toBe(3);
  });

  it("keeps sub-percent rates visible instead of rounding to zero", () => {
    const stats = shapeConversionStats([click({})], 300, NOW);
    expect(stats.rate).toBe(0.3);
  });

  it("windows clicks at 7 and 30 days", () => {
    const clicks = [
      click({ clicked_at: iso(0, 2) }),
      click({ clicked_at: iso(10) }),
      click({ clicked_at: iso(45) }),
    ];
    const stats = shapeConversionStats(clicks, 10, NOW);
    expect(stats.clicks7d).toBe(1);
    expect(stats.clicks30d).toBe(2);
    expect(stats.clicksTotal).toBe(3);
  });

  it("picks the most clicked product as top destination", () => {
    const clicks = [
      click({}),
      click({ clicked_at: iso(1) }),
      click({ user_id: "u2", url: "https://letterbrace.com" }),
    ];
    expect(shapeConversionStats(clicks, 10, NOW).topProduct).toEqual({
      product: "phantomstory.com",
      clicks: 2,
    });
  });

  it("returns null rate and top product when there is nothing to divide", () => {
    const stats = shapeConversionStats([], 0, NOW);
    expect(stats.rate).toBeNull();
    expect(stats.topProduct).toBeNull();
    expect(stats.connectedUsers).toBe(0);
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

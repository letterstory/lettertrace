import { describe, it, expect } from "vitest";
import { brandQueries, topicQuery, sitesForTick } from "@/lib/search/query";

describe("brandQueries", () => {
  it("builds one site-scoped OR-group for a brand with few aliases", () => {
    expect(brandQueries("reddit.com", "Acme", ["AcmeHQ", "Acme Labs"])).toEqual([
      'site:reddit.com ("Acme" OR "AcmeHQ" OR "Acme Labs")',
    ]);
  });

  it("chunks three terms per query — the cost model depends on it", () => {
    const queries = brandQueries("reddit.com", "Acme", ["A1", "A2", "A3", "A4"]);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe('site:reddit.com ("Acme" OR "A1" OR "A2")');
    expect(queries[1]).toBe('site:reddit.com ("A3" OR "A4")');
  });

  it("dedupes case-insensitively and drops blank aliases", () => {
    expect(brandQueries("news.ycombinator.com", "Acme", ["acme", "  ", "ACME"])).toEqual([
      'site:news.ycombinator.com ("Acme")',
    ]);
  });

  it("returns no queries for a blank brand — zero queries, zero spend", () => {
    expect(brandQueries("reddit.com", "  ", [])).toEqual([]);
  });
});

describe("topicQuery", () => {
  it("keeps topic terms unquoted — recall first, precision downstream", () => {
    expect(topicQuery("reddit.com", "best crm for freelancers")).toBe(
      "site:reddit.com best crm for freelancers",
    );
  });

  it("appends deduped extra keywords", () => {
    expect(topicQuery("reddit.com", "crm", ["pricing", "CRM", "pricing"])).toBe(
      "site:reddit.com crm pricing",
    );
  });
});

describe("sitesForTick", () => {
  const sites = ["reddit.com", "news.ycombinator.com", "indiehackers.com"];

  it("always includes the primary site", () => {
    for (const tick of [0, 1, 2, 3]) {
      expect(sitesForTick(sites, tick)[0]).toBe("reddit.com");
    }
  });

  it("rotates exactly one secondary per tick, round-robin", () => {
    expect(sitesForTick(sites, 0)).toEqual(["reddit.com", "news.ycombinator.com"]);
    expect(sitesForTick(sites, 1)).toEqual(["reddit.com", "indiehackers.com"]);
    expect(sitesForTick(sites, 2)).toEqual(["reddit.com", "news.ycombinator.com"]);
  });

  it("keeps cost flat: never more than two sites per tick", () => {
    const many = ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"];
    expect(sitesForTick(many, 7)).toHaveLength(2);
  });

  it("handles a single watched site and an empty list", () => {
    expect(sitesForTick(["reddit.com"], 5)).toEqual(["reddit.com"]);
    expect(sitesForTick([], 5)).toEqual([]);
  });
});

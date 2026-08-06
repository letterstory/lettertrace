import { describe, it, expect, vi } from "vitest";
import {
  buildQueryPlan,
  classifyResults,
  cleanSnippet,
  collectWebMentions,
  matchedTerms,
  mergeSighting,
} from "@/lib/web-mentions";
import { SearchRateLimitError } from "@/lib/search/types";
import type { SearchProvider, SearchResult } from "@/lib/search";
import type { Project, Topic, WebMentionWatch } from "@/lib/types";

const project = {
  id: "p1",
  user_id: "u1",
  brand_name: "Acme",
  brand_aliases: ["AcmeHQ"],
  brand_domains: ["acme.com", "acme-phantom.com"],
} as Project;

const watch: WebMentionWatch = {
  id: "w1",
  project_id: "p1",
  enabled: true,
  sites: ["reddit.com"],
  extra_keywords: [],
  exclude_terms: ["Acme Insurance"],
  query_budget: 60,
  last_collected_at: "2026-07-30T00:00:00Z",
  created_at: "2026-07-01T00:00:00Z",
};

const topics: Topic[] = [
  { id: "t1", project_id: "p1", name: "best crm", description: null, created_at: "" },
];

function result(url: string, title: string, snippet = "", rank = 1): SearchResult {
  return { url, title, snippet, rank };
}

describe("cleanSnippet", () => {
  it("strips markup, decodes entities, collapses whitespace", () => {
    expect(cleanSnippet("Try <strong>Acme</strong> &amp; friends  &#39;today&#39;")).toBe(
      "Try Acme & friends 'today'",
    );
  });
  it("returns null for empty or markup-only input", () => {
    expect(cleanSnippet(null)).toBeNull();
    expect(cleanSnippet("<b></b>")).toBeNull();
  });
});

describe("classifyResults", () => {
  it("drops results on the client's own domains, phantoms included", () => {
    const out = classifyResults(
      [
        result("https://acme.com/blog/post", "Acme post"),
        result("https://www.acme-phantom.com/x", "Acme phantom"),
        result("https://reddit.com/r/crm/1", "Acme thread"),
      ],
      project,
      watch,
      topics,
      null,
    );
    expect(out.map((c) => c.domain)).toEqual(["reddit.com"]);
  });

  it("drops results hitting an exclude term — the name-collision guard", () => {
    const out = classifyResults(
      [result("https://reddit.com/r/x/1", "Acme Insurance rates thread")],
      project,
      watch,
      topics,
      null,
    );
    expect(out).toEqual([]);
  });

  it("never trusts the engine: brand-query results without a verified term are dropped", () => {
    const out = classifyResults(
      [result("https://reddit.com/r/x/1", "A thread about acmeish things")],
      project,
      watch,
      topics,
      null,
    );
    expect(out).toEqual([]);
  });

  it("verifies brand terms word-boundary and records which matched", () => {
    const out = classifyResults(
      [result("https://reddit.com/r/x/1", "Comparing AcmeHQ to others", "Acme wins")],
      project,
      watch,
      topics,
      null,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("brand");
    expect(out[0].matched_terms).toEqual(["Acme", "AcmeHQ"]);
  });

  it("keeps topic-query results without a brand term as kind=topic with the query's topic", () => {
    const out = classifyResults(
      [result("https://reddit.com/r/crm/2", "What is the best crm for freelancers?")],
      project,
      watch,
      topics,
      "t1",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "topic", topic_id: "t1", matched_terms: [] });
  });

  it("upgrades a topic-query result to brand when the brand appears", () => {
    const out = classifyResults(
      [result("https://reddit.com/r/crm/3", "best crm?", "I use Acme")],
      project,
      watch,
      topics,
      "t1",
    );
    expect(out[0]).toMatchObject({ kind: "brand", topic_id: "t1" });
  });

  it("assigns brand-query results a topic by name pass, else leaves unassigned", () => {
    const out = classifyResults(
      [
        result("https://reddit.com/r/a/1", "Acme is the best crm around"),
        result("https://reddit.com/r/a/2", "Acme raised a round"),
      ],
      project,
      watch,
      topics,
      null,
    );
    expect(out[0].topic_id).toBe("t1");
    expect(out[1].topic_id).toBeNull();
  });

  it("drops unparseable URLs", () => {
    expect(classifyResults([result("::::", "Acme")], project, watch, topics, null)).toEqual([]);
  });
});

describe("mergeSighting", () => {
  const existing = {
    kind: "topic" as const,
    topic_id: null,
    matched_terms: [],
    search_rank: 9,
    seen_count: 2,
  };
  const fresh = {
    page_key: "reddit.com/r/x/1",
    url: "https://reddit.com/r/x/1",
    domain: "reddit.com",
    title: "t",
    snippet: "s",
    kind: "brand" as const,
    topic_id: "t1",
    matched_terms: ["Acme"],
    search_rank: 3,
  };

  it("upgrades kind, fills topic, unions terms, keeps best rank, bumps seen_count", () => {
    expect(mergeSighting(existing, fresh, "2026-08-06T00:00:00Z")).toMatchObject({
      kind: "brand",
      topic_id: "t1",
      matched_terms: ["Acme"],
      search_rank: 3,
      seen_count: 3,
      last_seen_at: "2026-08-06T00:00:00Z",
    });
  });

  it("never downgrades brand to topic and never replaces an assigned topic", () => {
    const merged = mergeSighting(
      { ...existing, kind: "brand", topic_id: "t-old", search_rank: 2 },
      { ...fresh, kind: "topic", topic_id: "t-new", search_rank: 5 },
      "now",
    );
    expect(merged).toMatchObject({ kind: "brand", topic_id: "t-old", search_rank: 2 });
  });

  it("treats a null rank as worse than any real rank", () => {
    expect(mergeSighting({ ...existing, search_rank: null }, fresh, "now").search_rank).toBe(3);
    expect(
      mergeSighting(existing, { ...fresh, search_rank: null }, "now").search_rank,
    ).toBe(9);
  });
});

describe("buildQueryPlan", () => {
  it("brand queries first, then one topic query per site", () => {
    const plan = buildQueryPlan(project, watch, topics, 0);
    expect(plan).toEqual([
      { query: 'site:reddit.com ("Acme" OR "AcmeHQ")', topicId: null },
      { query: "site:reddit.com best crm", topicId: "t1" },
    ]);
  });

  it("applies the primary + rotating-secondary site rule", () => {
    const multi = { ...watch, sites: ["reddit.com", "news.ycombinator.com", "x.com"] };
    const plan = buildQueryPlan(project, multi, topics, 0);
    const sitesUsed = new Set(plan.map((p) => p.query.split(" ")[0]));
    expect(sitesUsed).toEqual(new Set(["site:reddit.com", "site:news.ycombinator.com"]));
  });
});

// ---- collectWebMentions against a fake db + provider ----

function fakeDb(existing: { page_key: string }[] = []) {
  const calls: Record<string, unknown[]> = { runUpdates: [], mentionUpdates: [], upserts: [], watchUpdates: [] };
  const db = {
    from(table: string) {
      return {
        insert: () => ({
          select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }),
        }),
        select: () => ({
          eq: () => ({ in: async () => ({ data: existing, error: null }) }),
        }),
        update: (values: unknown) => ({
          eq: async () => {
            if (table === "web_mention_runs") calls.runUpdates.push(values);
            if (table === "web_mentions") calls.mentionUpdates.push(values);
            if (table === "web_mention_watch") calls.watchUpdates.push(values);
            return { error: null };
          },
        }),
        upsert: async (rows: unknown) => {
          calls.upserts.push(rows);
          return { error: null };
        },
      };
    },
  };
  return { db: db as never, calls };
}

function fakeProvider(fn: (query: string) => SearchResult[]): SearchProvider {
  return {
    id: "brave",
    label: "Fake",
    keyUrl: "",
    keyPrefix: "",
    search: vi.fn(async (_key: string, query: string) => fn(query)),
    verifyKey: async () => ({ ok: true }),
  };
}

const base = { apiKey: "k", pauseMs: 0, backoffMs: 0, now: () => Date.parse("2026-08-06T12:00:00Z") };

describe("collectWebMentions", () => {
  it("stores new mentions, settles the run, stamps the watch", async () => {
    const { db, calls } = fakeDb();
    const provider = fakeProvider((q) =>
      q.includes('"Acme"') ? [result("https://reddit.com/r/x/1", "Acme thread")] : [],
    );
    const out = await collectWebMentions({
      supabase: db, project, watch, topics, provider, ...base,
    });
    expect(out).toMatchObject({ status: "completed", queryCount: 2, newCount: 1, seenCount: 0 });
    expect(calls.upserts).toHaveLength(1);
    expect((calls.upserts[0] as unknown[])[0]).toMatchObject({ project_id: "p1", kind: "brand" });
    expect(calls.runUpdates[0]).toMatchObject({ status: "completed", query_count: 2, new_count: 1 });
    expect(calls.watchUpdates).toHaveLength(1);
  });

  it("merges re-sightings instead of inserting duplicates", async () => {
    const { db, calls } = fakeDb([
      { page_key: "reddit.com/r/x/1", kind: "topic", topic_id: null, matched_terms: [], search_rank: 9, seen_count: 1, id: "m1" } as never,
    ]);
    const provider = fakeProvider((q) =>
      q.includes('"Acme"') ? [result("https://reddit.com/r/x/1", "Acme thread", "", 2)] : [],
    );
    const out = await collectWebMentions({
      supabase: db, project, watch, topics, provider, ...base,
    });
    expect(out).toMatchObject({ newCount: 0, seenCount: 1 });
    expect(calls.upserts).toHaveLength(0);
    expect(calls.mentionUpdates[0]).toMatchObject({ kind: "brand", seen_count: 2, search_rank: 2 });
  });

  it("uses the year window on the seed run and the week window after", async () => {
    const { db } = fakeDb();
    const provider = fakeProvider(() => []);
    await collectWebMentions({
      supabase: db, project, watch: { ...watch, last_collected_at: null }, topics, provider, ...base,
    });
    expect((provider.search as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({ freshness: "year" });
    await collectWebMentions({ supabase: db, project, watch, topics, provider, ...base });
    expect((provider.search as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]).toEqual({ freshness: "week" });
  });

  it("stops the tick after a backed-off retry is still rate-limited", async () => {
    const { db, calls } = fakeDb();
    const provider: SearchProvider = {
      ...fakeProvider(() => []),
      search: vi.fn(async () => {
        throw new SearchRateLimitError("Fake");
      }),
    };
    const out = await collectWebMentions({
      supabase: db, project, watch, topics, provider, ...base,
    });
    // First plan step: attempt + one retry, then stop — the second step never runs.
    expect(provider.search).toHaveBeenCalledTimes(2);
    expect(out.error).toMatch(/rate-limited/);
    expect(calls.runUpdates[0]).toMatchObject({ status: "completed" });
  });

  it("respects the per-tick allowance and says what it dropped", async () => {
    const { db } = fakeDb();
    const provider = fakeProvider(() => []);
    const out = await collectWebMentions({
      supabase: db, project, watch, topics, provider, ...base, maxQueries: 1,
    });
    expect(out.queryCount).toBe(1);
    expect(out.error).toMatch(/query budget \(1 of 2 planned\)/);
  });

  it("skips a failing query but lets the first failure narrate the run", async () => {
    const { db } = fakeDb();
    let n = 0;
    const provider: SearchProvider = {
      ...fakeProvider(() => []),
      search: vi.fn(async () => {
        n++;
        if (n === 1) throw new Error("HTTP 500 from provider");
        return [result("https://reddit.com/r/crm/9", "best crm talk")];
      }),
    };
    const out = await collectWebMentions({
      supabase: db, project, watch, topics, provider, ...base,
    });
    expect(out).toMatchObject({ status: "completed", queryCount: 2, newCount: 1 });
    expect(out.error).toMatch(/HTTP 500/);
  });
});

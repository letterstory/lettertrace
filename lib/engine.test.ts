import { describe, it, expect } from "vitest";
import {
  hostOf,
  isOwnedDomain,
  isAbandoned,
  settleAbandonedRun,
  sweepAbandonedRuns,
  ABANDONED_RUN_MS,
} from "@/lib/engine";

describe("hostOf", () => {
  it("normalizes a messy domain entry to a registrable host", () => {
    expect(hostOf("https://www.notion.so/pricing")).toBe("notion.so");
    expect(hostOf("Notion.so")).toBe("notion.so");
    expect(hostOf("http://acme.co.uk/path?x=1")).toBe("acme.co.uk");
  });

  it("returns empty for null/blank", () => {
    expect(hostOf(null)).toBe("");
    expect(hostOf("")).toBe("");
  });
});

describe("isOwnedDomain", () => {
  it("matches the exact host", () => {
    expect(isOwnedDomain("notion.so", "notion.so")).toBe(true);
  });

  it("matches subdomains of the owned host", () => {
    expect(isOwnedDomain("blog.notion.so", "notion.so")).toBe(true);
    expect(isOwnedDomain("help.docs.notion.so", "notion.so")).toBe(true);
  });

  it("does not match unrelated or look-alike hosts", () => {
    expect(isOwnedDomain("notnotion.so", "notion.so")).toBe(false);
    expect(isOwnedDomain("evil-notion.so", "notion.so")).toBe(false);
    expect(isOwnedDomain("notion.so.evil.com", "notion.so")).toBe(false);
  });

  it("is false when either side is empty", () => {
    expect(isOwnedDomain("notion.so", "")).toBe(false);
    expect(isOwnedDomain("", "notion.so")).toBe(false);
  });
});

describe("extractInlineLinks", () => {
  it("extracts markdown targets and bare URLs, dedupes by page, trims punctuation", async () => {
    const { extractInlineLinks } = await import("@/lib/engine");
    const links = extractInlineLinks(
      "See [the guide](https://blog.example.com/posts/guide?utm_source=openai) and https://blog.example.com/posts/guide. Also https://other.io/x.",
    );
    expect(links).toHaveLength(2);
    expect(links[0].domain).toBe("blog.example.com");
    expect(links[1].url).toBe("https://other.io/x");
  });
});

describe("isAbandoned", () => {
  const started = (msAgo: number) => ({
    status: "running",
    started_at: new Date(Date.now() - msAgo).toISOString(),
  });

  it("leaves a run alone while an invocation could still be working on it", () => {
    expect(isAbandoned(started(0))).toBe(false);
    expect(isAbandoned(started(4 * 60_000))).toBe(false);
    // Right up to the threshold: never race a run that is merely slow.
    expect(isAbandoned(started(ABANDONED_RUN_MS - 1000))).toBe(false);
  });

  it("flags a run that has outlived any invocation that could settle it", () => {
    expect(isAbandoned(started(ABANDONED_RUN_MS + 1000))).toBe(true);
    expect(isAbandoned(started(6 * 60 * 60_000))).toBe(true);
  });

  it("only ever considers running rows", () => {
    const old = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    expect(isAbandoned({ status: "completed", started_at: old })).toBe(false);
    expect(isAbandoned({ status: "failed", started_at: old })).toBe(false);
    expect(isAbandoned({ status: "pending", started_at: old })).toBe(false);
  });

  it("does not flag a running row with no start time", () => {
    // Nothing can be concluded about its age; the alternative is failing runs
    // at random on a row shape the writer never produces.
    expect(isAbandoned({ status: "running", started_at: null })).toBe(false);
  });

  // The threshold has to sit above the platform ceiling every run route caps
  // at (maxDuration = 300s), or the sweeper starts killing live runs.
  it("is comfortably above the longest an invocation can last", () => {
    expect(ABANDONED_RUN_MS).toBeGreaterThan(300_000);
  });
});

describe("settleAbandonedRun", () => {
  /** Records the filters a chained update was scoped by. */
  function fakeDb(rows: { id: string }[]) {
    const filters: [string, unknown][] = [];
    let updated: Record<string, unknown> | null = null;
    const db = {
      from: () => ({
        update: (values: Record<string, unknown>) => {
          updated = values;
          const chain = {
            eq: (col: string, val: unknown) => {
              filters.push([col, val]);
              return chain;
            },
            select: async () => ({ data: rows }),
          };
          return chain;
        },
      }),
    };
    return { db: db as never, filters, updated: () => updated };
  }

  it("settles the row as failed, with the reason and a finish time", async () => {
    const { db, updated } = fakeDb([{ id: "run-1" }]);
    expect(await settleAbandonedRun(db, "run-1", "interrupted")).toBe(true);
    expect(updated()).toMatchObject({ status: "failed", error: "interrupted" });
    expect(typeof (updated() as { finished_at: string }).finished_at).toBe("string");
  });

  // The guard is the whole safety property: a run that settled itself between
  // the sweeper's read and this write must not have its real result replaced
  // by a failure.
  it("only touches rows still marked running", async () => {
    const { db, filters } = fakeDb([{ id: "run-1" }]);
    await settleAbandonedRun(db, "run-1", "interrupted");
    expect(filters).toContainEqual(["id", "run-1"]);
    expect(filters).toContainEqual(["status", "running"]);
  });

  it("reports false when it changed nothing, so callers can't double-count", async () => {
    const { db } = fakeDb([]);
    expect(await settleAbandonedRun(db, "run-1", "interrupted")).toBe(false);
  });

  it("leaves completed_count alone — answers stored before the cut are real", async () => {
    const { db, updated } = fakeDb([{ id: "run-1" }]);
    await settleAbandonedRun(db, "run-1", "interrupted");
    expect(Object.keys(updated() ?? {})).not.toContain("completed_count");
  });
});

describe("sweepAbandonedRuns", () => {
  /** Serves one read of stale running rows; records which of them the
   *  per-row settle actually won (rows outside `settleable` lost the race). */
  function fakeDb(staleRows: { id: string }[], settleable = staleRows) {
    const cutoffs: string[] = [];
    const db = {
      from: () => ({
        select: () => {
          const chain = {
            eq: () => chain,
            lt: (_col: string, val: string) => {
              cutoffs.push(val);
              return Promise.resolve({ data: staleRows });
            },
          };
          return chain;
        },
        update: () => {
          let id: unknown;
          const chain = {
            eq: (col: string, val: unknown) => {
              if (col === "id") id = val;
              return chain;
            },
            select: async () => ({
              data: settleable.some((r) => r.id === id) ? [{ id }] : [],
            }),
          };
          return chain;
        },
      }),
    };
    return { db: db as never, cutoffs };
  }

  it("settles every stale row and reports which", async () => {
    const { db } = fakeDb([{ id: "run-1" }, { id: "run-2" }]);
    expect(await sweepAbandonedRuns(db)).toEqual(["run-1", "run-2"]);
  });

  it("asks only for rows older than the abandonment threshold", async () => {
    const { db, cutoffs } = fakeDb([]);
    const before = Date.now();
    await sweepAbandonedRuns(db);
    const cutoff = new Date(cutoffs[0]).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - ABANDONED_RUN_MS - 1000);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - ABANDONED_RUN_MS);
  });

  it("does not report a row that settled itself between read and write", async () => {
    // The guard inside settleAbandonedRun is what actually protects the row;
    // the sweep must simply not count the ones the guard turned away.
    const { db } = fakeDb([{ id: "run-1" }, { id: "run-2" }], [{ id: "run-2" }]);
    expect(await sweepAbandonedRuns(db)).toEqual(["run-2"]);
  });

  it("settles nothing on a quiet table", async () => {
    const { db } = fakeDb([]);
    expect(await sweepAbandonedRuns(db)).toEqual([]);
  });
});

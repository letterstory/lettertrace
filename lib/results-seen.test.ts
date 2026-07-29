import { describe, expect, it } from "vitest";
import type { Project, Run } from "@/lib/types";
import { getUnseenRun, markResultsSeen } from "@/lib/results-seen";

const PROJECT: Project = {
  id: "proj-1",
  user_id: "user-1",
  name: "Credal",
  brand_name: "Credal",
  brand_aliases: [],
  brand_domains: ["credal.ai"],
  description: null,
  default_provider: "anthropic",
  default_model: "claude-sonnet-4-6",
  schedule: "off",
  use_web_search: true,
  replicates: 1,
  last_run_at: null,
  results_seen_at: null,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

function project(overrides: Partial<Project> = {}): Project {
  return { ...PROJECT, ...overrides };
}

const RUN: Run = {
  id: "run-1",
  project_id: "proj-1",
  status: "completed",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  prompt_count: 10,
  completed_count: 10,
  replicates: 1,
  error: null,
  started_at: "2026-07-20T10:00:00.000Z",
  finished_at: "2026-07-20T10:05:00.000Z",
  created_at: "2026-07-20T10:00:00.000Z",
};

function run(overrides: Partial<Run> = {}): Run {
  return { ...RUN, ...overrides };
}

/**
 * Records every update and answers reads from the given rows. Chains are
 * terminal at maybeSingle(), which is all these two helpers use.
 */
function fakeDb(rows: { runs?: unknown }) {
  const updates: Record<string, unknown>[] = [];
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "eq", "in", "not", "order", "limit"]) chain[m] = self;
    chain.update = (values: Record<string, unknown>) => {
      updates.push(values);
      return { eq: async () => ({ error: null }) };
    };
    chain.maybeSingle = async () => ({
      data: table === "runs" ? (rows.runs ?? null) : null,
    });
    return chain;
  };
  return { db: { from: builder } as never, updates };
}

describe("getUnseenRun", () => {
  it("flags the newest finished run when results have never been opened", async () => {
    const { db } = fakeDb({ runs: run() });
    expect(await getUnseenRun(db, project({ results_seen_at: null }))).toMatchObject({
      id: "run-1",
    });
  });

  it("stays quiet once the run has been seen", async () => {
    const { db } = fakeDb({ runs: run() });
    const seen = project({ results_seen_at: "2026-07-20T10:05:00.000Z" });
    expect(await getUnseenRun(db, seen)).toBeNull();
  });

  it("flags a run that finished after the last look", async () => {
    const { db } = fakeDb({ runs: run({ finished_at: "2026-07-21T09:00:00.000Z" }) });
    const seen = project({ results_seen_at: "2026-07-20T10:05:00.000Z" });
    expect(await getUnseenRun(db, seen)).toMatchObject({ id: "run-1" });
  });

  // A silent failure is worse than a silent success: monitoring has stopped
  // collecting and nothing said so.
  it("flags a failed run too", async () => {
    const { db } = fakeDb({
      runs: run({ status: "failed", completed_count: 0, error: "Invalid API key" }),
    });
    expect(await getUnseenRun(db, project())).toMatchObject({ status: "failed" });
  });

  it("has nothing to say when there are no finished runs", async () => {
    const { db } = fakeDb({ runs: null });
    expect(await getUnseenRun(db, project())).toBeNull();
  });

  it("ignores a run row with no finish time", async () => {
    const { db } = fakeDb({ runs: run({ finished_at: null }) });
    expect(await getUnseenRun(db, project())).toBeNull();
  });

  // Postgres renders timestamptz as "+00:00" and toISOString() produces "Z",
  // so these two are the same instant written two ways. Compared as text the
  // suffix decides it ('Z' > '+') and an already-seen run reads as unseen.
  it("compares instants, not the string they were written as", async () => {
    const { db } = fakeDb({ runs: run({ finished_at: "2026-07-20T10:05:00.000+00:00" }) });
    const seen = project({ results_seen_at: "2026-07-20T10:05:00.000Z" });
    expect(await getUnseenRun(db, seen)).toBeNull();
  });

  it("still flags a genuinely newer run across the two formats", async () => {
    const { db } = fakeDb({ runs: run({ finished_at: "2026-07-20T10:06:00.000+00:00" }) });
    const seen = project({ results_seen_at: "2026-07-20T10:05:00.000Z" });
    expect(await getUnseenRun(db, seen)).toMatchObject({ id: "run-1" });
  });
});

describe("markResultsSeen", () => {
  it("marks against the viewed run's finish time, not now", async () => {
    const { db, updates } = fakeDb({ runs: { finished_at: "2026-07-20T10:05:00.000Z" } });
    const outcome = await markResultsSeen(db, project(), "run-1");
    expect(outcome).toMatchObject({ ok: true, changed: true });
    expect(updates[0]).toEqual({ results_seen_at: "2026-07-20T10:05:00.000Z" });
  });

  // The point of marking against the run rather than now(): opening last
  // week's report must not bury the run that finished this morning.
  it("does not mark a newer unread run as seen", async () => {
    const { db } = fakeDb({ runs: { finished_at: "2026-07-14T10:00:00.000Z" } });
    const { seenAt } = (await markResultsSeen(db, project(), "old-run")) as {
      seenAt: string;
    };
    const newer = run({ finished_at: "2026-07-20T10:05:00.000Z" });
    const after = project({ results_seen_at: seenAt });
    const { db: db2 } = fakeDb({ runs: newer });
    expect(await getUnseenRun(db2, after)).toMatchObject({ id: "run-1" });
  });

  it("never moves the high-water mark backwards", async () => {
    const { db, updates } = fakeDb({ runs: { finished_at: "2026-07-14T10:00:00.000Z" } });
    const already = project({ results_seen_at: "2026-07-20T10:05:00.000Z" });
    const outcome = await markResultsSeen(db, already, "old-run");
    expect(outcome).toMatchObject({ ok: true, changed: false });
    expect(updates).toHaveLength(0);
  });

  it("dismissing with no run id acknowledges everything so far", async () => {
    const { db, updates } = fakeDb({});
    const outcome = await markResultsSeen(db, project());
    expect(outcome).toMatchObject({ ok: true, changed: true });
    const seenAt = (updates[0] as { results_seen_at: string }).results_seen_at;
    expect(new Date(seenAt).getTime()).toBeGreaterThan(Date.parse(RUN.finished_at!));
  });

  // The id is attacker-controlled input on a route that otherwise says "you
  // have read everything"; an unverifiable run must not clear the nudge.
  it("refuses a run id that isn't this project's", async () => {
    const { db, updates } = fakeDb({ runs: null });
    expect(await markResultsSeen(db, project(), "someone-elses-run")).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(updates).toHaveLength(0);
  });

  it("does not rewrite when the mark already covers that instant in another format", async () => {
    const { db, updates } = fakeDb({ runs: { finished_at: "2026-07-20T10:05:00.000+00:00" } });
    const already = project({ results_seen_at: "2026-07-20T10:05:00.000Z" });
    expect(await markResultsSeen(db, already, "run-1")).toMatchObject({ changed: false });
    expect(updates).toHaveLength(0);
  });

  it("treats an unfinished run as acknowledging what has finished", async () => {
    const { db, updates } = fakeDb({ runs: { finished_at: null } });
    const outcome = await markResultsSeen(db, project(), "run-in-flight");
    expect(outcome).toMatchObject({ ok: true, changed: true });
    expect(updates).toHaveLength(1);
  });
});

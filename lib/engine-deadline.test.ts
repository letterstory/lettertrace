// ---------------------------------------------------------------------------
// The per-run time budget.
//
// Every route that starts a run is killed by the platform at maxDuration, and a
// run has no natural size: prompts x replicates, with no cap on prompts. The
// 09:00 UTC 2026-09-11 GPT-5.6 Luna run planned 208 answers, stored 201, and
// was killed at 797s with the last seven in flight; nothing on the settle path
// ran, so the row read "running" for 23 hours until the daily sweep marked it
// failed. These cases pin the fix: a run stops dispatching new asks before the
// ceiling, keeps what it has, settles itself, and says plainly that it stopped
// short and why.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/llm", () => ({
  runQuery: vi.fn(),
  analyzeResponse: vi.fn(),
  humanError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/data", () => ({
  getDecryptedKey: vi.fn(),
  getConfiguredProviders: vi.fn(),
  getDecryptedRouterKeys: vi.fn(),
}));

import { runQuery, analyzeResponse } from "@/lib/llm";
import { logActivity } from "@/lib/activity";
import {
  resumeRun,
  INVOCATION_CEILING_MS,
  RUN_TIME_BUDGET_MS,
  type PreparedRun,
} from "@/lib/engine";

/** Records what the run wrote, and answers the reads resumeRun makes. */
function makeDb() {
  const runUpdates: Record<string, unknown>[] = [];
  const responses: Record<string, unknown>[] = [];
  let responseId = 0;

  const db = {
    from(table: string) {
      return {
        insert(rows: unknown) {
          if (table === "responses") responses.push(rows as Record<string, unknown>);
          return {
            select: () => ({
              single: async () => ({ data: { id: `resp-${++responseId}` } }),
            }),
            then: (res: (v: unknown) => unknown) => res({ data: null, error: null }),
          };
        },
        update(patch: Record<string, unknown>) {
          if (table === "runs") runUpdates.push(patch);
          return {
            eq: () => ({
              eq: () => ({ select: async () => ({ data: [] }) }),
              then: (res: (v: unknown) => unknown) => res({ data: null, error: null }),
            }),
          };
        },
      };
    },
  };
  return { db: db as never, runUpdates, responses };
}

const project = {
  id: "p1",
  user_id: "u1",
  brand_name: "Acme",
  brand_aliases: [],
  brand_domains: ["acme.com"],
  use_web_search: true,
  replicates: 1,
} as never;

function prepared(jobCount: number, startedMs = Date.now()): PreparedRun {
  return {
    runId: "run-1",
    jobs: Array.from({ length: jobCount }, (_, i) => ({
      id: `prompt-${i}`,
      text: `question ${i}`,
      topic_id: null,
    })) as never,
    competitors: [],
    attribution: {
      userId: "u1",
      projectId: "p1",
      actorType: "user",
      actorId: "u1",
      actorLabel: "You",
      channel: "dashboard",
      category: "run",
      targetType: "run",
    } as never,
    startedMs,
    startedAt: new Date(startedMs).toISOString(),
  };
}

const answer = { text: "an answer with no brand in it", tokens: 1000, sources: [] } as never;

beforeEach(() => {
  vi.mocked(runQuery).mockReset().mockResolvedValue(answer);
  vi.mocked(analyzeResponse).mockReset().mockResolvedValue({ results: [], tokens: 0 } as never);
  vi.mocked(logActivity).mockReset().mockResolvedValue(undefined as never);
});

function run(jobs: number, timeBudgetMs: number | undefined, startedMs?: number) {
  const { db, runUpdates, responses } = makeDb();
  return resumeRun(prepared(jobs, startedMs), {
    supabase: db,
    project,
    provider: "openai",
    model: "gpt-5.6-luna",
    apiKey: "sk-user-own-key",
    budgetMicros: null,
    timeBudgetMs,
  } as never).then((result) => ({ result, runUpdates, responses }));
}

describe("the time budget", () => {
  it("leaves two minutes between the last dispatch and the platform kill", () => {
    // Enough for the slowest engine's p99 answer (56s), its enrichment call
    // and the final writes; a smaller margin re-creates the 09-11 death.
    expect(INVOCATION_CEILING_MS - RUN_TIME_BUDGET_MS).toBe(120 * 1000);
    expect(RUN_TIME_BUDGET_MS).toBeGreaterThan(0);
  });
});

describe("a run that would outlive its invocation", () => {
  it("stops dispatching new asks once the budget is spent", async () => {
    // Each answer takes 60ms against a 40ms budget: the first pool of asks is
    // dispatched at once, and every ask after it finds the clock run out.
    vi.mocked(runQuery).mockImplementation(
      () => new Promise((res) => setTimeout(() => res(answer), 60)),
    );
    const { result } = await run(50, 40);
    expect(vi.mocked(runQuery).mock.calls.length).toBeLessThan(50);
    expect(vi.mocked(runQuery).mock.calls.length).toBeGreaterThan(0);
    expect(result.timeStopped).toBe(true);
  });

  it("keeps every answer that was in flight when the clock ran out", async () => {
    vi.mocked(runQuery).mockImplementation(
      () => new Promise((res) => setTimeout(() => res(answer), 60)),
    );
    const { result, responses } = await run(50, 40);
    // The asks already dispatched finish and are stored: that is the whole
    // point of stopping early rather than being killed mid-answer.
    expect(result.totalResponses).toBe(vi.mocked(runQuery).mock.calls.length);
    expect(responses.length).toBe(result.totalResponses);
    expect(result.status).toBe("completed");
  });

  it("settles its own row as completed, naming the shortfall and the reason", async () => {
    vi.mocked(runQuery).mockImplementation(
      () => new Promise((res) => setTimeout(() => res(answer), 60)),
    );
    const { result, runUpdates } = await run(50, 40);
    const settle = runUpdates.find((u) => "status" in u)!;
    expect(settle.status).toBe("completed");
    expect(settle.completed_count).toBe(result.totalResponses);
    // Before this a killed run's row read "running" until a sweeper marked it
    // failed a day later; the client polling it never saw a terminal state.
    expect(String(settle.error)).toMatch(/time limit/i);
    expect(String(settle.error)).toMatch(new RegExp(`${50 - result.totalResponses}`));
    expect(settle.finished_at).toBeTruthy();
  });

  it("asks nothing when the run is already past its budget before the first dispatch", async () => {
    // A run row created long ago (its invocation has plainly been busy with
    // something else) must not start a 200-ask job it cannot finish.
    const { result } = await run(20, 60 * 1000, Date.now() - 61 * 1000);
    expect(vi.mocked(runQuery)).not.toHaveBeenCalled();
    expect(result.timeStopped).toBe(true);
    // No answers stored is a failed run by the engine's existing rule, and the
    // failure message still says why.
    expect(result.status).toBe("failed");
  });

  it("is not confused with the free-usage ceiling", async () => {
    vi.mocked(runQuery).mockImplementation(
      () => new Promise((res) => setTimeout(() => res(answer), 60)),
    );
    const { result, runUpdates } = await run(50, 40);
    expect(result.budgetStopped).toBeUndefined();
    const settle = runUpdates.find((u) => "status" in u)!;
    expect(String(settle.error)).not.toMatch(/free-usage/i);
  });
});

describe("a run with time to spare", () => {
  it("asks every prompt and reports no shortfall", async () => {
    const { result, runUpdates } = await run(12, undefined);
    expect(vi.mocked(runQuery).mock.calls.length).toBe(12);
    expect(result.timeStopped).toBeUndefined();
    const settle = runUpdates.find((u) => "status" in u)!;
    expect(settle.status).toBe("completed");
    expect(settle.error).toBeNull();
  });
});

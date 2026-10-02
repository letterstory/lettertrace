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

/** Stands in for the deadline error lib/llm throws; the engine matches on the
 *  name, so that is the part the fake has to get right. */
class FakeDeadlineExceededError extends Error {
  constructor() {
    super("The run ran out of time before this answer came back.");
    this.name = "DeadlineExceededError";
  }
}
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
  runTimeBudgetFor,
  askDeadlineFor,
  SETTLE_MARGIN_MS,
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

function run(
  jobs: number,
  timeBudgetMs: number | undefined,
  startedMs?: number,
  askDeadlineMs?: number,
) {
  const { db, runUpdates, responses } = makeDb();
  return resumeRun(prepared(jobs, startedMs), {
    supabase: db,
    project,
    provider: "openai",
    model: "gpt-5.6-luna",
    apiKey: "sk-user-own-key",
    budgetMicros: null,
    timeBudgetMs,
    askDeadlineMs,
  } as never).then((result) => ({ result, runUpdates, responses }));
}

describe("the time budget", () => {
  it("leaves two minutes between the last dispatch and the platform kill", () => {
    // Enough for the slowest engine's p99 answer (56s), its enrichment call
    // and the final writes; a smaller margin re-creates the 09-11 death.
    expect(INVOCATION_CEILING_MS - RUN_TIME_BUDGET_MS).toBe(120 * 1000);
    expect(RUN_TIME_BUDGET_MS).toBeGreaterThan(0);
  });

  // The onboarding sweep and the MCP trigger_run tool run under
  // `maxDuration = 300`, not 800. Handing those a budget derived from the
  // 800s ceiling is what stranded three onboarding sweeps on 2026-09-22: the
  // Gemini Pro leg was still dispatching when the platform killed it, so the
  // run never settled and read "running" until an admin page view found it.
  it("shrinks with the calling route's ceiling", () => {
    expect(runTimeBudgetFor(300 * 1000)).toBe(180 * 1000);
    expect(runTimeBudgetFor(300 * 1000)).toBeLessThan(300 * 1000);
    expect(runTimeBudgetFor(INVOCATION_CEILING_MS)).toBe(RUN_TIME_BUDGET_MS);
  });

  // A ceiling at or below the reserve would otherwise yield a zero or
  // negative budget, i.e. a run that can never dispatch its first ask.
  it("always leaves a short-ceiling caller room to dispatch", () => {
    expect(runTimeBudgetFor(60 * 1000)).toBe(20 * 1000);
    expect(runTimeBudgetFor(120 * 1000)).toBe(40 * 1000);
  });
});

// The budget above only decides whether a NEW ask may start. On its own that
// leaves the original failure intact on a short-ceiling route: a Google ask
// dispatched a moment under the budget can run for another ~330s (four 60s
// attempts plus 90s of backoff), sail past the 300s platform kill, and strand
// the run exactly as before. These cases pin the second half of the fix.
describe("the deadline on an ask already in flight", () => {
  it("lands inside the invocation, leaving room to settle", () => {
    // An onboarding sweep: 300s ceiling, 180s dispatch budget. The last ask
    // may run to 285s, and the run still has 15s to write its own row.
    const started = 1_000_000;
    const deadline = askDeadlineFor(started, runTimeBudgetFor(300 * 1000));
    expect(deadline - started).toBe(285 * 1000);
    expect(deadline).toBeLessThan(started + 300 * 1000);
    expect(started + 300 * 1000 - deadline).toBe(SETTLE_MARGIN_MS);
  });

  it("tracks the run routes' own ceiling unchanged", () => {
    const started = 1_000_000;
    const deadline = askDeadlineFor(started, RUN_TIME_BUDGET_MS);
    expect(started + INVOCATION_CEILING_MS - deadline).toBe(SETTLE_MARGIN_MS);
  });

  it("is handed to every ask the run makes", async () => {
    const started = Date.now();
    await run(3, 60 * 1000, started);
    const call = vi.mocked(runQuery).mock.calls[0][0] as { deadlineMs: number };
    expect(call.deadlineMs).toBe(askDeadlineFor(started, 60 * 1000));
  });

  it("settles the run when a slow ask gives up on the deadline", async () => {
    // The Gemini Pro case: the ask is dispatched inside the budget and is
    // still running when the deadline arrives, so it throws rather than
    // carrying the run into the platform kill.
    const started = Date.now();
    vi.mocked(runQuery)
      .mockResolvedValueOnce(answer)
      .mockRejectedValue(new FakeDeadlineExceededError());
    const { result, runUpdates } = await run(6, 60 * 1000, started, started + 40);

    const settle = runUpdates.find((u) => "status" in u)!;
    expect(settle.status).toBe("completed");
    expect(settle.finished_at).toBeTruthy();
    expect(result.timeStopped).toBe(true);
    // The answer stored before the deadline is kept.
    expect(result.totalResponses).toBe(1);
    expect(String(settle.error)).toMatch(/time limit/i);
    // And the run settled well inside the invocation rather than being killed.
    expect(Date.now() - started).toBeLessThan(60 * 1000);
  });

  it("does not report a slow engine as a broken one", async () => {
    const started = Date.now();
    vi.mocked(runQuery).mockRejectedValue(new FakeDeadlineExceededError());
    const { runUpdates } = await run(4, 60 * 1000, started, started + 10);
    const settle = runUpdates.find((u) => "status" in u)!;
    // Nothing stored, so the run failed — but it failed on the clock, not on
    // a provider error, and its message has to say so.
    expect(settle.status).toBe("failed");
    expect(String(settle.error)).toMatch(/time limit/i);
    expect(String(settle.error)).not.toMatch(/every prompt failed/i);
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

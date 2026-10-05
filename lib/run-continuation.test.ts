// ---------------------------------------------------------------------------
// Continuing a run that ran out of time.
//
// A slow reasoning model answers ~20 a minute, so one invocation's budget tops
// out around 220 answers, and every bigger run used to settle with the tail of
// its portfolio never asked (Letterstory 2026-10-02: 25 of 33 ChatGPT runs).
// These cases pin the fix: a background run on the user's own key continues
// into fresh invocations instead of settling, each leg asks only what is
// missing, the counts on the row are the RUN's, and anything that can't
// continue settles exactly the way a stop always did.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
vi.mock("@/lib/trial", () => ({ resolveRunKeyFor: vi.fn() }));

import { runQuery, analyzeResponse } from "@/lib/llm";
import { logActivity } from "@/lib/activity";
import { resolveRunKeyFor } from "@/lib/trial";
import { resumeRun, MAX_RUN_CONTINUATIONS, type PreparedRun, type RunContinuation } from "@/lib/engine";
import { missingJobs, scheduleRunContinuation, continueRun, CONTINUE_PATH } from "@/lib/run-continuation";

/** Records what the run wrote, and answers the reads resumeRun makes. */
function makeDb() {
  const runUpdates: Record<string, unknown>[] = [];
  const projectUpdates: Record<string, unknown>[] = [];
  let responseId = 0;
  const db = {
    from(table: string) {
      return {
        insert() {
          return {
            select: () => ({ single: async () => ({ data: { id: `resp-${++responseId}` } }) }),
            then: (res: (v: unknown) => unknown) => res({ data: null, error: null }),
          };
        },
        update(patch: Record<string, unknown>) {
          if (table === "runs") runUpdates.push(patch);
          if (table === "projects") projectUpdates.push(patch);
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
  return { db: db as never, runUpdates, projectUpdates };
}

const project = {
  id: "p1",
  user_id: "u1",
  brand_name: "Acme",
  brand_aliases: [],
  brand_domains: ["acme.com"],
  use_web_search: true,
  replicates: 2,
} as never;

const prompt = (i: number) => ({ id: `prompt-${i}`, text: `question ${i}`, topic_id: null });

function prepared(jobCount: number, startedMs = Date.now()): PreparedRun {
  return {
    runId: "run-1",
    jobs: Array.from({ length: jobCount }, (_, i) => prompt(i)) as never,
    competitors: [],
    attribution: {
      userId: "u1",
      projectId: "p1",
      actorType: "system",
      actorId: null,
      actorLabel: "System",
      channel: "system",
      category: "run",
      targetType: "run",
    },
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

/** A leg that is already out of time when it starts, so every job stops unasked. */
async function outOfTimeLeg(jobs: number, continuation?: Partial<RunContinuation>) {
  const { db, runUpdates, projectUpdates } = makeDb();
  const schedule = vi.fn(async () => true);
  const result = await resumeRun(prepared(jobs, Date.now() - 60_000), {
    supabase: db,
    project,
    provider: "openai",
    model: "gpt-5.6-luna",
    apiKey: "sk-user-own-key",
    budgetMicros: null,
    timeBudgetMs: 1,
    ...(continuation
      ? { continuation: { leg: 0, priorStored: 0, planned: jobs, schedule, ...continuation } }
      : {}),
  } as never);
  return { result, runUpdates, projectUpdates, schedule };
}

describe("a run that reaches its time budget with a continuation", () => {
  it("starts the next leg instead of settling, and leaves the row running", async () => {
    const { result, runUpdates, schedule } = await outOfTimeLeg(300, {});
    expect(schedule).toHaveBeenCalledWith(1);
    expect(result.status).toBe("running");
    expect(result.continued).toBe(true);
    // Progress is written, but no terminal status: the next leg owns the row.
    expect(runUpdates.some((u) => "status" in u)).toBe(false);
    expect(runUpdates).toContainEqual({ completed_count: 0 });
  });

  it("settles the way a stop always did when the next leg can't be scheduled", async () => {
    const { result, runUpdates } = await outOfTimeLeg(300, { schedule: vi.fn(async () => false) });
    expect(result.continued).toBeUndefined();
    expect(result.timeStopped).toBe(true);
    const settle = runUpdates.find((u) => "status" in u)!;
    expect(String(settle.error)).toMatch(/time limit/);
  });

  it("settles a throwing scheduler instead of losing the run", async () => {
    const { result, runUpdates } = await outOfTimeLeg(300, {
      schedule: vi.fn(async () => {
        throw new Error("network");
      }),
    });
    expect(result.continued).toBeUndefined();
    expect(runUpdates.some((u) => "status" in u)).toBe(true);
  });

  it("stops continuing after MAX_RUN_CONTINUATIONS legs, and counts the whole run", async () => {
    const { result, runUpdates, schedule } = await outOfTimeLeg(90, {
      leg: MAX_RUN_CONTINUATIONS,
      priorStored: 300,
      planned: 390,
    });
    expect(schedule).not.toHaveBeenCalled();
    const settle = runUpdates.find((u) => "status" in u)!;
    expect(settle.status).toBe("completed");
    expect(settle.completed_count).toBe(300);
    expect(String(settle.error)).toMatch(/Stopped after 300 of 390 answers/);
    expect(result.totalResponses).toBe(300);
  });

  it("never continues a run with no continuation (trial runs, the scheduler, sync runs)", async () => {
    const { result, runUpdates } = await outOfTimeLeg(300);
    expect(result.continued).toBeUndefined();
    expect(runUpdates.some((u) => "status" in u)).toBe(true);
  });
});

describe("a later leg", () => {
  it("writes the RUN's totals: earlier legs' answers plus this leg's", async () => {
    const { db, runUpdates } = makeDb();
    const result = await resumeRun(prepared(100), {
      supabase: db,
      project,
      provider: "openai",
      model: "gpt-5.6-luna",
      apiKey: "sk-user-own-key",
      budgetMicros: null,
      continuation: { leg: 1, priorStored: 200, planned: 300, schedule: vi.fn(async () => true) },
    } as never);
    const settle = runUpdates.find((u) => "status" in u)!;
    expect(settle.status).toBe("completed");
    expect(settle.completed_count).toBe(300);
    expect(settle.error).toBeNull();
    expect(result.totalResponses).toBe(300);
  });

  it("does not fail fast on identical errors once earlier legs stored answers", async () => {
    vi.mocked(runQuery).mockRejectedValue(new Error("400 the same error every time"));
    const { db } = makeDb();
    const result = await resumeRun(prepared(40), {
      supabase: db,
      project,
      provider: "openai",
      model: "gpt-5.6-luna",
      apiKey: "sk-user-own-key",
      budgetMicros: null,
      continuation: { leg: 1, priorStored: 200, planned: 240, schedule: vi.fn(async () => true) },
    } as never);
    expect(vi.mocked(runQuery).mock.calls.length).toBe(40);
    expect(result.failFastStopped).toBeUndefined();
    // The run stored answers, so it completed, short.
    expect(result.status).toBe("completed");
  });
});

describe("missingJobs", () => {
  it("asks each prompt up to the run's replicates, minus what is stored", () => {
    const prompts = [prompt(0), prompt(1), prompt(2)] as never;
    const stored = new Map([
      ["prompt-0", 2],
      ["prompt-1", 1],
    ]);
    expect(missingJobs(prompts, 2, stored).map((p) => p.id)).toEqual(["prompt-1", "prompt-2", "prompt-2"]);
  });

  it("never asks a prompt more than replicates, even with stray extra answers", () => {
    expect(missingJobs([prompt(0)] as never, 2, new Map([["prompt-0", 5]]))).toEqual([]);
  });
});

describe("scheduleRunContinuation", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it("declines without a site URL or CRON_SECRET (self-hosted)", async () => {
    delete process.env.CRON_SECRET;
    process.env.NEXT_PUBLIC_SITE_URL = "https://lettertrace.com";
    expect(await scheduleRunContinuation("run-1", 1)).toBe(false);
  });

  it("posts the leg to its own deployment with the cron secret, and trusts only a 202", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.NEXT_PUBLIC_SITE_URL = "https://lettertrace.com/";
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 202 });
    });
    expect(await scheduleRunContinuation("run-1", 2)).toBe(true);
    expect(calls[0].url).toBe(`https://lettertrace.com${CONTINUE_PATH("run-1")}`);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ leg: 2 });

    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    expect(await scheduleRunContinuation("run-1", 2)).toBe(false);
  });
});

/** A fake table store for continueRun's reads, recording runs updates. */
function continueDb(tables: Record<string, Record<string, unknown>[]>) {
  const runUpdates: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: [string, unknown][] = [];
      const chain = {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return chain;
        },
        range: async () => ({ data: rows.filter((r) => filters.every(([k, v]) => r[k] === v)), error: null }),
        maybeSingle: async () => ({ data: rows.find((r) => filters.every(([k, v]) => r[k] === v)) ?? null }),
        update(patch: Record<string, unknown>) {
          if (table === "runs") runUpdates.push(patch);
          return { eq: () => ({ eq: async () => ({ data: null }) }) };
        },
      };
      return chain;
    },
  };
  return { db: db as never, runUpdates };
}

describe("continueRun", () => {
  const run = {
    id: "run-1",
    project_id: "p1",
    status: "running",
    provider: "openai",
    model: "gpt-5.6-luna",
    prompt_count: 4,
    replicates: 2,
    created_at: "2026-10-02T10:00:00Z",
  };

  it("does nothing for a run that already settled, or an out-of-range leg", async () => {
    const { db, runUpdates } = continueDb({ runs: [{ ...run, status: "completed" }] });
    expect(await continueRun(db, "run-1", 1)).toBe("skipped");
    expect(await continueRun(db, "run-1", MAX_RUN_CONTINUATIONS + 1)).toBe("skipped");
    expect(runUpdates).toEqual([]);
  });

  it("refuses to finish a run on a different credential than it started on", async () => {
    vi.mocked(resolveRunKeyFor).mockResolvedValue({ source: "trial", provider: "openai", model: "gpt-5.6-luna" } as never);
    const { db, runUpdates } = continueDb({
      runs: [run],
      projects: [{ id: "p1", user_id: "u1", use_web_search: true, replicates: 2 }],
      responses: [{ run_id: "run-1", prompt_id: "prompt-0" }],
    });
    expect(await continueRun(db, "run-1", 1)).toBe("settled");
    // Heartbeat first, then a settle that keeps the one stored answer.
    expect(runUpdates[0]).toHaveProperty("started_at");
    const settle = runUpdates.find((u) => "status" in u)!;
    expect(settle.status).toBe("completed");
    expect(settle.completed_count).toBe(1);
    expect(String(settle.error)).toMatch(/could not continue/);
  });

  it("settles a run whose missing answers turn out to be none", async () => {
    vi.mocked(resolveRunKeyFor).mockResolvedValue({
      source: "own",
      apiKey: "k",
      provider: "openai",
      model: "gpt-5.6-luna",
    } as never);
    const { db, runUpdates } = continueDb({
      runs: [run],
      projects: [{ id: "p1", user_id: "u1", use_web_search: true, replicates: 2 }],
      prompts: [{ ...prompt(0), project_id: "p1", is_active: true }],
      responses: [
        { run_id: "run-1", prompt_id: "prompt-0" },
        { run_id: "run-1", prompt_id: "prompt-0" },
      ],
    });
    expect(await continueRun(db, "run-1", 1)).toBe("settled");
    const settle = runUpdates.find((u) => "status" in u)!;
    expect(settle).toMatchObject({ status: "completed", completed_count: 2, error: null });
    expect(runQuery).not.toHaveBeenCalled();
  });
});

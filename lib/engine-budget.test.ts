// ---------------------------------------------------------------------------
// The per-run spend ceiling.
//
// The free tier used to be gated on the NUMBER of runs, which bounds nothing:
// a run is prompts x replicates provider calls and nothing caps prompts, so a
// single free run could be arbitrarily expensive. These cases pin the fix — a
// run stops itself partway when the operator's money runs out, keeps what it
// already paid for, and says plainly that it stopped short.
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
import { resumeRun, type PreparedRun } from "@/lib/engine";
import { spendMicros } from "@/lib/pricing";

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

function prepared(jobCount: number): PreparedRun {
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
    startedMs: Date.now(),
  };
}

/** What one answer costs under the rules the engine prices with. */
const PER_ANSWER = spendMicros({
  provider: "anthropic",
  model: "claude-haiku-4-5",
  tokens: 1000,
  webSearch: true,
});

beforeEach(() => {
  vi.mocked(runQuery)
    .mockReset()
    .mockResolvedValue({ text: "an answer with no brand in it", tokens: 1000, sources: [] } as never);
  vi.mocked(analyzeResponse).mockReset().mockResolvedValue({ results: [], tokens: 0 } as never);
  vi.mocked(logActivity).mockReset().mockResolvedValue(undefined as never);
});

function run(jobs: number, budgetMicros: number | null) {
  const { db, runUpdates, responses } = makeDb();
  return resumeRun(prepared(jobs), {
    supabase: db,
    project,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    apiKey: "sk-ant-operator",
    budgetMicros,
  } as never).then((result) => ({ result, runUpdates, responses }));
}

describe("a run on the operator's money", () => {
  it("stops once the budget is gone instead of asking every prompt", async () => {
    // Budget for ~3 answers, 50 prompts queued. Without the ceiling this run
    // would make 50 paid calls.
    const { result } = await run(50, PER_ANSWER * 3);
    expect(vi.mocked(runQuery).mock.calls.length).toBeLessThan(50);
    expect(result.budgetStopped).toBe(true);
  });

  it("keeps the answers it already paid for", async () => {
    const { result, responses } = await run(50, PER_ANSWER * 3);
    // Discarding them would waste money already spent; a stored answer is real
    // data whatever stopped the run.
    expect(result.totalResponses).toBeGreaterThan(0);
    expect(responses.length).toBe(result.totalResponses);
    expect(result.status).toBe("completed");
  });

  it("reports the shortfall on the run itself, not as a failure", async () => {
    const { result, runUpdates } = await run(50, PER_ANSWER * 3);
    const settle = runUpdates.find((u) => "status" in u)!;
    expect(settle.status).toBe("completed");
    // A run that silently returns 4 of 50 answers looks like the prompts broke.
    expect(String(settle.error)).toMatch(/free-usage limit/i);
    expect(result.spendMicros).toBeGreaterThan(0);
  });

  it("runs everything when the budget is ample", async () => {
    const { result } = await run(5, PER_ANSWER * 100);
    expect(vi.mocked(runQuery).mock.calls.length).toBe(5);
    expect(result.budgetStopped).toBeUndefined();
    const settle = (await run(5, PER_ANSWER * 100)).runUpdates.find((u) => "status" in u)!;
    expect(settle.error).toBeNull();
  });

  it("asks nothing at all when the budget is already spent", async () => {
    const { result } = await run(20, 0);
    expect(vi.mocked(runQuery)).not.toHaveBeenCalled();
    // No answers stored is a failed run by the engine's existing rule; what
    // matters here is that it cost nothing.
    expect(result.spendMicros).toBe(0);
  });
});

describe("a run on the user's own key", () => {
  it("is never cut short", async () => {
    // budgetMicros null means BYOK: rationing here would be us rationing their
    // money, which is not ours to do.
    const { result } = await run(30, null);
    expect(vi.mocked(runQuery).mock.calls.length).toBe(30);
    expect(result.budgetStopped).toBeUndefined();
  });
});

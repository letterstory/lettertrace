// ---------------------------------------------------------------------------
// Failing fast on a broken run.
//
// From 2026-09-23 to 2026-09-26 Concentrate rejected every forced web-search
// Anthropic call, and each affected run still sent every one of its asks:
// ~9,000 calls across 77 runs for zero answers. These cases pin the fix — a
// run whose first wave fails identically stops sending, says so in its own
// row, and a run with ordinary, mixed or recoverable failures is untouched.
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
import { resumeRun, FAIL_FAST_AFTER, type PreparedRun } from "@/lib/engine";

/** Records what the run wrote, and answers the reads resumeRun makes. */
function makeDb() {
  const runUpdates: Record<string, unknown>[] = [];
  let responseId = 0;

  const db = {
    from(table: string) {
      return {
        insert() {
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
  return { db: db as never, runUpdates };
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
    startedAt: new Date().toISOString(),
  };
}

const TOOL_CHOICE_MISMATCH =
  '400 {"error":{"code":"invalid_prompt","message":"tool_choice references function \\"web_search\\" which is not present in tools"}}';
const ANSWER = { text: "an answer with no brand in it", tokens: 1000, sources: [] };

beforeEach(() => {
  vi.mocked(runQuery).mockReset();
  vi.mocked(analyzeResponse).mockReset().mockResolvedValue({ results: [], tokens: 0 } as never);
  vi.mocked(logActivity).mockReset().mockResolvedValue(undefined as never);
});

async function run(jobs: number) {
  const { db, runUpdates } = makeDb();
  const result = await resumeRun(prepared(jobs), {
    supabase: db,
    project,
    provider: "anthropic",
    model: "claude-sonnet-5",
    apiKey: "sk-ant-operator",
    budgetMicros: null,
  } as never);
  return { result, settle: runUpdates.find((u) => "status" in u)! };
}

describe("a run whose first wave fails identically", () => {
  it("stops sending instead of asking every prompt", async () => {
    vi.mocked(runQuery).mockRejectedValue(new Error(TOOL_CHOICE_MISMATCH));
    const { result } = await run(200);
    // The pool keeps a full wave in flight, so at most one more wave goes out
    // after the trip; without the breaker this run would make 200 calls.
    expect(vi.mocked(runQuery).mock.calls.length).toBeLessThan(FAIL_FAST_AFTER * 2);
    expect(result.status).toBe("failed");
    expect(result.failFastStopped).toBe(true);
  });

  it("keeps the provider's error first and says how much was never sent", async () => {
    vi.mocked(runQuery).mockRejectedValue(new Error(TOOL_CHOICE_MISMATCH));
    const { settle } = await run(200);
    const sent = vi.mocked(runQuery).mock.calls.length;
    // The provider's error leads, so anything classifying runs by error text
    // still reads the real cause.
    expect(String(settle.error).startsWith(TOOL_CHOICE_MISMATCH)).toBe(true);
    expect(String(settle.error)).toContain(`the other ${200 - sent} were not sent`);
  });

  it("treats the same error with a different number as the same error", async () => {
    let n = 0;
    vi.mocked(runQuery).mockImplementation(async () => {
      throw new Error(`Rate limited. Retry after ${++n}s.`);
    });
    const { result } = await run(200);
    expect(result.failFastStopped).toBe(true);
  });
});

describe("a run the breaker leaves alone", () => {
  it("keeps going when an answer has already been stored", async () => {
    vi.mocked(runQuery)
      .mockResolvedValueOnce(ANSWER as never)
      .mockRejectedValue(new Error(TOOL_CHOICE_MISMATCH));
    const { result } = await run(40);
    // A run that has answered once is having trouble, not broken.
    expect(vi.mocked(runQuery).mock.calls.length).toBe(40);
    expect(result.failFastStopped).toBeUndefined();
    expect(result.status).toBe("completed");
  });

  it("keeps going when the failures differ", async () => {
    let n = 0;
    vi.mocked(runQuery).mockImplementation(async () => {
      throw new Error(++n % 2 ? "Rate limited by the provider." : "The AI provider had a temporary error.");
    });
    const { result } = await run(40);
    expect(vi.mocked(runQuery).mock.calls.length).toBe(40);
    expect(result.failFastStopped).toBeUndefined();
  });

  it("does not trip on fewer identical failures than the threshold", async () => {
    vi.mocked(runQuery).mockRejectedValue(new Error(TOOL_CHOICE_MISMATCH));
    const { result, settle } = await run(FAIL_FAST_AFTER - 1);
    expect(vi.mocked(runQuery).mock.calls.length).toBe(FAIL_FAST_AFTER - 1);
    expect(result.failFastStopped).toBeUndefined();
    // With nothing stopped, the row carries the provider's error unchanged.
    expect(settle.error).toBe(TOOL_CHOICE_MISMATCH);
  });

  it("does not touch a healthy run", async () => {
    vi.mocked(runQuery).mockResolvedValue(ANSWER as never);
    const { result, settle } = await run(30);
    expect(vi.mocked(runQuery).mock.calls.length).toBe(30);
    expect(result.failFastStopped).toBeUndefined();
    expect(settle.error).toBeNull();
  });
});

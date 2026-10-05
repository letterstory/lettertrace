import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() =>
  vi.fn(async (_id: string, _event: string, _props?: Record<string, unknown>) => {}),
);

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, captureServerEvent: capture };
});
vi.mock("@/lib/llm", () => ({
  runQuery: vi.fn(),
  analyzeResponse: vi.fn(),
  humanError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/ops", () => ({ recordOps: vi.fn(), recordOpsError: vi.fn(), signatureOf: () => "sig" }));
vi.mock("@/lib/otel", () => ({
  recordRun: vi.fn(),
  withSpan: async (_name: string, _attrs: unknown, fn: (span: { setAttributes: () => void }) => Promise<unknown>) =>
    fn({ setAttributes: () => {} }),
}));

import { runQuery, analyzeResponse } from "@/lib/llm";
import { prepareRun, resumeRun, type PreparedRun } from "@/lib/engine";
import { brandShareOfVoice } from "@/lib/posthog-server";

function makeDb() {
  let responseId = 0;
  const db = {
    from(table: string) {
      return {
        insert(rows: unknown) {
          if (table === "runs") {
            return { select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }) };
          }
          if (table === "responses") {
            return {
              select: () => ({
                single: async () => ({ data: { id: `resp-${++responseId}` }, error: null }),
              }),
            };
          }
          return { then: (res: (v: unknown) => unknown) => res({ data: null, error: null }) };
        },
        update() {
          return {
            eq: () => ({
              then: (res: (v: unknown) => unknown) => res({ data: null, error: null }),
            }),
          };
        },
        select() {
          return {
            eq: () => ({
              eq: () => ({
                range: async () => ({ data: [], error: null }),
              }),
            }),
          };
        },
      };
    },
  };
  return db as never;
}

const project = {
  id: "org-1",
  user_id: "owner-1",
  brand_name: "Acme",
  brand_aliases: [],
  brand_domains: ["acme.com"],
  use_web_search: true,
  replicates: 1,
} as never;

function prepared(answers: string[]): PreparedRun {
  return {
    runId: "run-1",
    jobs: answers.map((_, i) => ({
      id: `prompt-${i}`,
      text: `question ${i}`,
      topic_id: null,
    })) as never,
    competitors: [{ id: "c1", name: "Rival", aliases: [] }] as never,
    attribution: {
      userId: "owner-1",
      projectId: "org-1",
      actorType: "user",
      actorId: "teammate-1",
      actorLabel: "Teammate",
      channel: "dashboard",
      category: "run",
      targetType: "run",
    },
    startedMs: Date.now(),
    startedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  capture.mockClear();
  vi.mocked(analyzeResponse).mockReset().mockResolvedValue({ results: [], tokens: 0 } as never);
});

describe("run events", () => {
  it("counts brand mentions the same way a report does, and attributes the click to the teammate", async () => {
    const answers = [
      "Acme leads and Rival follows",
      "nobody relevant",
      "Acme again, with Rival",
      "Rival only",
    ];
    vi.mocked(runQuery).mockReset();
    for (const text of answers) {
      vi.mocked(runQuery).mockResolvedValueOnce({ text, tokens: 10, sources: [] } as never);
    }

    await resumeRun(prepared(answers), {
      supabase: makeDb(),
      project,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      apiKey: "sk-test",
      keySource: "trial",
      context: { channel: "dashboard", actorType: "user", actorId: "teammate-1" },
    });

    const completed = capture.mock.calls.find((c) => c[1] === "run_completed");
    expect(completed?.[0]).toBe("teammate-1");
    const props = completed?.[2] ?? {};
    expect(props.mentions_found).toBe(true);
    expect(props.billing_owner_id).toBe("owner-1");
    expect(props.org_id).toBe("org-1");
    expect(props.is_trial).toBe(true);
    expect(props.engine).toBe("anthropic");
    expect(props.answers).toBe(4);
    // Acme twice, Rival three times. The event must use the report's ratio.
    expect(props.share_of_voice).toBe(brandShareOfVoice(2, 3));
    expect(props.share_of_voice).toBeCloseTo(2 / 5);
    expect(JSON.stringify(props)).not.toMatch(/Acme|Rival|question/);
  });

  it("reports no mentions as a zero, not as an absent property", async () => {
    vi.mocked(runQuery).mockReset().mockResolvedValue({ text: "no names here", tokens: 10, sources: [] } as never);
    const scheduled = prepared(["no names here"]);
    scheduled.attribution = {
      ...scheduled.attribution,
      actorType: "cron",
      actorId: "scheduler",
      actorLabel: "Scheduler",
      channel: "cron",
    };
    await resumeRun(scheduled, {
      supabase: makeDb(),
      project,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      apiKey: "sk-test",
      keySource: "own",
      context: { channel: "cron", actorType: "cron", actorId: "scheduler", trigger: "scheduled" },
    });
    const completed = capture.mock.calls.find((c) => c[1] === "run_completed");
    expect(completed?.[0]).toBe("owner-1");
    expect(completed?.[2]).toMatchObject({
      mentions_found: false,
      share_of_voice: 0,
      is_trial: false,
      trigger: "scheduled",
    });
  });

  it("labels the onboarding sweep on run_triggered, and a click with no label as manual", async () => {
    const page = (rows: unknown[]) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ range: async () => ({ data: rows, error: null }) }),
          range: async () => ({ data: rows, error: null }),
        }),
      }),
    });
    const db = {
      from(table: string) {
        if (table === "prompts") {
          return page([{ id: "p", text: "q", topic_id: null, is_active: true }]);
        }
        if (table === "competitors") return page([]);
        return {
          insert: () => ({
            select: () => ({ single: async () => ({ data: { id: "run-9" }, error: null }) }),
          }),
        };
      },
    };
    await prepareRun({
      supabase: db as never,
      project,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      apiKey: "sk-test",
      keySource: "trial",
      context: { channel: "dashboard", actorType: "user", actorId: "owner-1", trigger: "onboarding" },
    });
    expect(capture).toHaveBeenCalledWith(
      "owner-1",
      "run_triggered",
      expect.objectContaining({ trigger: "onboarding", is_trial: true, engine: "anthropic" }),
    );

    capture.mockClear();
    await prepareRun({
      supabase: db as never,
      project,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      apiKey: "sk-test",
      keySource: "own",
      context: { channel: "dashboard", actorType: "user", actorId: "teammate-1" },
    });
    expect(capture).toHaveBeenCalledWith(
      "teammate-1",
      "run_triggered",
      expect.objectContaining({ trigger: "manual", is_trial: false, billing_owner_id: "owner-1" }),
    );
  });
});

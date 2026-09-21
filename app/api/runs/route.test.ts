import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "user-1",
  ownerId: "user-1",
  keyResult: { source: "own", apiKey: "sk-test", provider: "anthropic", model: "claude-haiku-4-5" } as Record<string, unknown>,
  executeRunImpl: undefined as ((args: unknown) => Promise<unknown>) | undefined,
  runInserts: [] as { report_group_id: string | null | undefined }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: state.userId } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ __billing: true }) }));
vi.mock("@/lib/data", () => ({
  getProject: async () => ({
    id: "project-1",
    user_id: state.ownerId,
    default_provider: "anthropic",
    default_model: "claude-haiku-4-5",
    use_web_search: true,
  }),
}));
vi.mock("@/lib/llm", () => ({ humanError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
vi.mock("@/lib/engine", () => ({
  executeRun: vi.fn(async (args: { reportGroupId?: string | null }) => {
    state.runInserts.push({ report_group_id: args.reportGroupId });
    if (state.executeRunImpl) return state.executeRunImpl(args);
    return { runId: "run-1", status: "completed", totalResponses: 4, tokensUsed: 100, spendMicros: 500 };
  }),
}));
vi.mock("@/lib/trial", () => ({
  resolveRunKey: vi.fn(async () => state.keyResult),
  resolveRunKeyFor: vi.fn(async () => state.keyResult),
  consumeTrialRunFor: vi.fn(async () => true),
  recordTrialUsageFor: vi.fn(),
  recordTrialSpendFor: vi.fn(),
  runBudgetMicros: () => null,
  engineKeyMessage: (key: { source: string }) => `No key saved for this engine (${key.source}). Add one in Settings.`,
}));
vi.mock("@/lib/report-email-delivery", () => ({ sendSingleReportAttempt: vi.fn(async () => "sent") }));

const groups = vi.hoisted(() => ({
  loadGroup: vi.fn(),
  recordGroupSkip: vi.fn(),
  finalizeGroupIfComplete: vi.fn(),
  touchGroup: vi.fn(),
}));
vi.mock("@/lib/report-groups", () => groups);

import { POST } from "./route";
import { sendSingleReportAttempt } from "@/lib/report-email-delivery";

function request(body: unknown): Request {
  return new Request("http://localhost/api/runs", { method: "POST", body: JSON.stringify(body) });
}

const OPEN_GROUP = {
  id: "group-1",
  project_id: "project-1",
  requested_providers: ["anthropic", "openai"],
  skipped: {},
  email_status: "pending" as const,
  last_activity_at: "2026-09-18T00:00:00Z",
  finished_at: null,
  created_at: "2026-09-18T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  state.userId = "user-1";
  state.ownerId = "user-1";
  state.keyResult = { source: "own", apiKey: "sk-test", provider: "anthropic", model: "claude-haiku-4-5" };
  state.executeRunImpl = undefined;
  state.runInserts = [];
  groups.loadGroup.mockResolvedValue(OPEN_GROUP);
  groups.recordGroupSkip.mockResolvedValue(undefined);
  groups.finalizeGroupIfComplete.mockResolvedValue(false);
  groups.touchGroup.mockResolvedValue(undefined);
});

describe("POST /api/runs — report batch validation", () => {
  it("rejects a batch id from another project, before any run is attempted", async () => {
    groups.loadGroup.mockResolvedValue({ ...OPEN_GROUP, project_id: "someone-elses-project" });
    const res = await POST(request({ groupId: "group-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/doesn't belong to this organization/);
    expect(state.runInserts).toEqual([]);
  });

  it("rejects a batch that has already been summarised", async () => {
    groups.loadGroup.mockResolvedValue({ ...OPEN_GROUP, email_status: "sent" });
    const res = await POST(request({ groupId: "group-1" }));
    expect(res.status).toBe(409);
    expect(state.runInserts).toEqual([]);
  });

  it("rejects an engine that was never part of the batch", async () => {
    groups.loadGroup.mockResolvedValue({ ...OPEN_GROUP, requested_providers: ["openai", "google"] });
    const res = await POST(request({ provider: "anthropic", groupId: "group-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/wasn't part of that report batch/);
    expect(state.runInserts).toEqual([]);
  });
});

describe("POST /api/runs — refused before running", () => {
  it("records a skip and finalizes, but sends no single-run email, when the engine has no key", async () => {
    state.keyResult = { source: "none", provider: "anthropic", model: "claude-haiku-4-5" };
    const res = await POST(request({ groupId: "group-1" }));
    expect(res.status).toBe(400);
    expect(groups.recordGroupSkip).toHaveBeenCalledWith(
      expect.anything(), "group-1", "anthropic", expect.stringMatching(/No key saved/),
    );
    expect(groups.finalizeGroupIfComplete).toHaveBeenCalledWith(expect.anything(), "group-1");
    expect(sendSingleReportAttempt).not.toHaveBeenCalled();
    expect(state.runInserts).toEqual([]);
  });

  it("records a skip when the trial allowance is exhausted", async () => {
    state.keyResult = { source: "exhausted", provider: "anthropic", model: "claude-haiku-4-5", limit: 5 };
    const res = await POST(request({ groupId: "group-1" }));
    expect(res.status).toBe(402);
    expect(groups.recordGroupSkip).toHaveBeenCalledWith(
      expect.anything(), "group-1", "anthropic", expect.stringMatching(/free runs are used up/),
    );
    expect(sendSingleReportAttempt).not.toHaveBeenCalled();
  });

  it("sends no email at all for an UNGROUPED refusal (no batch to account it to)", async () => {
    state.keyResult = { source: "none", provider: "anthropic", model: "claude-haiku-4-5" };
    const res = await POST(request({}));
    expect(res.status).toBe(400);
    expect(sendSingleReportAttempt).not.toHaveBeenCalled();
    expect(groups.recordGroupSkip).not.toHaveBeenCalled();
  });
});

describe("POST /api/runs — a run that executes", () => {
  it("passes reportGroupId through to executeRun, then nudges the batch instead of mailing a single-run email", async () => {
    const res = await POST(request({ provider: "anthropic", groupId: "group-1" }));
    expect(res.status).toBe(200);
    expect(state.runInserts).toEqual([{ report_group_id: "group-1" }]);
    expect(groups.touchGroup).toHaveBeenCalledWith(expect.anything(), "group-1");
    expect(groups.finalizeGroupIfComplete).toHaveBeenCalledWith(expect.anything(), "group-1");
    expect(sendSingleReportAttempt).not.toHaveBeenCalled();
  });

  it("still mails a single-run email when there is no batch", async () => {
    const res = await POST(request({}));
    expect(res.status).toBe(200);
    expect(state.runInserts).toEqual([{ report_group_id: null }]);
    expect(sendSingleReportAttempt).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: "project-1" }),
      { provider: "anthropic", model: "claude-haiku-4-5" }, "run-1",
    );
    expect(groups.touchGroup).not.toHaveBeenCalled();
  });

  it("on a throw BEFORE the run row exists, records a skip rather than leaving the batch waiting forever", async () => {
    state.executeRunImpl = async () => { throw new Error("model overloaded"); };
    const res = await POST(request({ provider: "anthropic", groupId: "group-1" }));
    expect(res.status).toBe(500);
    expect(groups.recordGroupSkip).toHaveBeenCalledWith(
      expect.anything(), "group-1", "anthropic", "model overloaded",
    );
    expect(groups.touchGroup).not.toHaveBeenCalled();
  });

  it("on a throw AFTER the run row exists, touches the batch instead of recording a duplicate skip", async () => {
    // executeRun resolves normally — the run row exists and completedRunId is
    // set — but the bookkeeping that follows (touchGroup) throws. The run
    // already accounts for this engine, so the catch must not ALSO record a
    // skip: that would make the batch think two engines finished when one did.
    groups.touchGroup.mockRejectedValueOnce(new Error("db unavailable"));
    const res = await POST(request({ provider: "anthropic", groupId: "group-1" }));
    expect(res.status).toBe(500);
    expect(state.runInserts).toEqual([{ report_group_id: "group-1" }]);
    expect(groups.recordGroupSkip).not.toHaveBeenCalled();
    // The catch retries the same accounting rather than giving up on it.
    expect(groups.touchGroup).toHaveBeenCalledTimes(2);
  });
});

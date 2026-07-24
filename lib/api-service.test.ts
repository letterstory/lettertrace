import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mention, Project, Run } from "@/lib/types";
import {
  getOwnedProject,
  getRunReport,
  latestCompletedRun,
  listRuns,
  projectSummary,
  triggerRunForProject,
} from "@/lib/api-service";
import { resolveRunKey } from "@/lib/trial";
import { executeRun } from "@/lib/engine";

vi.mock("@/lib/trial", () => ({ resolveRunKey: vi.fn() }));
vi.mock("@/lib/engine", () => ({ executeRun: vi.fn() }));

// ------------------------------------------------------------------
// A tiny fake of the supabase query builder: per-table handlers receive the
// recorded query (filters + modifiers) and return the {data, error, count}
// payload. Covers every chain lib/api-service uses.
// ------------------------------------------------------------------

interface RecordedQuery {
  table: string;
  filters: [string, ...unknown[]][];
  modifiers: [string, ...unknown[]][];
}

type Handler = (q: RecordedQuery) => {
  data?: unknown;
  error?: unknown;
  count?: number;
};

function fakeDb(handlers: Record<string, Handler>) {
  const queries: RecordedQuery[] = [];
  const db = {
    queries,
    from(table: string) {
      const q: RecordedQuery = { table, filters: [], modifiers: [] };
      queries.push(q);
      const result = () => ({ data: null, error: null, count: undefined, ...handlers[table]?.(q) });
      const proxy = {
        select: () => proxy,
        eq: (...args: unknown[]) => {
          q.filters.push(["eq", ...args]);
          return proxy;
        },
        order: (...args: unknown[]) => {
          q.modifiers.push(["order", ...args]);
          return proxy;
        },
        limit: (...args: unknown[]) => {
          q.modifiers.push(["limit", ...args]);
          return proxy;
        },
        maybeSingle: async () => result(),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve, reject),
      };
      return proxy;
    },
  };
  return db as typeof db & { from: (t: string) => never };
}

const PROJECT: Project = {
  id: "proj-1",
  user_id: "user-1",
  name: "Credal",
  brand_name: "Credal",
  brand_aliases: [],
  brand_domain: "credal.ai",
  description: null,
  default_provider: "anthropic",
  default_model: "claude-sonnet-4-6",
  schedule: "off",
  use_web_search: true,
  last_run_at: null,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

function makeRun(overrides: Partial<Run>): Run {
  return {
    id: "run-1",
    project_id: "proj-1",
    status: "completed",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    prompt_count: 2,
    completed_count: 2,
    error: null,
    started_at: null,
    finished_at: null,
    created_at: "2026-07-02T00:00:00Z",
    ...overrides,
  };
}

function makeMention(overrides: Partial<Mention>): Mention {
  return {
    id: Math.random().toString(36).slice(2),
    response_id: "resp-1",
    run_id: "run-1",
    project_id: "proj-1",
    topic_id: null,
    entity_type: "brand",
    competitor_id: null,
    entity_name: "Credal",
    mentioned: true,
    mention_count: 1,
    first_position: 0.1,
    sentiment: "positive",
    recommended: false,
    created_at: "2026-07-02T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(resolveRunKey).mockReset();
  vi.mocked(executeRun).mockReset();
});

describe("projectSummary", () => {
  it("exposes only the public fields (no user_id)", () => {
    const summary = projectSummary(PROJECT);
    expect(summary).not.toHaveProperty("user_id");
    expect(summary).toMatchObject({
      id: "proj-1",
      brand_name: "Credal",
      default_provider: "anthropic",
    });
  });
});

describe("getOwnedProject", () => {
  it("scopes the query by both project id and user id", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    const project = await getOwnedProject(db as never, "user-1", "proj-1");
    expect(project).toEqual(PROJECT);
    expect(db.queries[0].filters).toEqual([
      ["eq", "id", "proj-1"],
      ["eq", "user_id", "user-1"],
    ]);
  });

  it("returns null when the project is not the user's", async () => {
    const db = fakeDb({ projects: () => ({ data: null }) });
    expect(await getOwnedProject(db as never, "user-2", "proj-1")).toBeNull();
  });
});

describe("listRuns", () => {
  it("returns null when the project lookup fails ownership", async () => {
    const db = fakeDb({ projects: () => ({ data: null }) });
    expect(await listRuns(db as never, "user-2", "proj-1")).toBeNull();
  });

  it("lists runs newest-first and clamps the limit to 1..100", async () => {
    const runs = [makeRun({ id: "run-2" }), makeRun({ id: "run-1" })];
    const db = fakeDb({
      projects: () => ({ data: PROJECT }),
      runs: () => ({ data: runs }),
    });
    expect(await listRuns(db as never, "user-1", "proj-1", 500)).toEqual(runs);

    const runQuery = db.queries.find((q) => q.table === "runs")!;
    expect(runQuery.modifiers).toContainEqual(["limit", 100]);
    expect(runQuery.modifiers).toContainEqual(["order", "created_at", { ascending: false }]);

    const db2 = fakeDb({
      projects: () => ({ data: PROJECT }),
      runs: () => ({ data: [] }),
    });
    await listRuns(db2 as never, "user-1", "proj-1", -3);
    expect(db2.queries.find((q) => q.table === "runs")!.modifiers).toContainEqual(["limit", 1]);
  });
});

describe("latestCompletedRun", () => {
  it("skips pending/failed runs", async () => {
    const db = fakeDb({
      projects: () => ({ data: PROJECT }),
      runs: () => ({
        data: [
          makeRun({ id: "run-3", status: "running" }),
          makeRun({ id: "run-2", status: "failed" }),
          makeRun({ id: "run-1", status: "completed" }),
        ],
      }),
    });
    const latest = await latestCompletedRun(db as never, "user-1", "proj-1");
    expect(latest?.id).toBe("run-1");
  });
});

describe("getRunReport", () => {
  it("returns null for a run the user doesn't own", async () => {
    const db = fakeDb({
      runs: () => ({ data: makeRun({}) }),
      projects: () => ({ data: null }), // ownership check fails
    });
    expect(await getRunReport(db as never, "user-2", "run-1")).toBeNull();
  });

  it("computes summary and entity stats from mentions", async () => {
    // 2 responses; brand in one (positive), competitor in both.
    const mentions = [
      makeMention({ response_id: "resp-1" }),
      makeMention({
        response_id: "resp-1",
        entity_type: "competitor",
        competitor_id: "comp-1",
        entity_name: "Rival",
        sentiment: "negative",
      }),
      makeMention({
        response_id: "resp-2",
        entity_type: "competitor",
        competitor_id: "comp-1",
        entity_name: "Rival",
        sentiment: "neutral",
        mention_count: 2,
      }),
    ];
    const db = fakeDb({
      runs: () => ({ data: makeRun({}) }),
      projects: () => ({ data: PROJECT }),
      responses: () => ({ count: 2 }),
      mentions: () => ({ data: mentions }),
    });

    const report = await getRunReport(db as never, "user-1", "run-1");
    expect(report).not.toBeNull();
    expect(report!.totalResponses).toBe(2);
    expect(report!.summary.brandMentionRate).toBe(0.5);
    // Brand: 1 of 4 total mention counts; competitor: 3 of 4.
    expect(report!.summary.brandShareOfVoice).toBe(0.25);
    expect(report!.entities[0].type).toBe("brand"); // brand sorts first
    expect(report!.entities[1]).toMatchObject({ name: "Rival", shareOfVoice: 0.75 });
  });
});

describe("triggerRunForProject", () => {
  it("404s for a project the user doesn't own", async () => {
    const db = fakeDb({ projects: () => ({ data: null }) });
    const outcome = await triggerRunForProject(db as never, "user-2", "proj-1");
    expect(outcome).toMatchObject({ ok: false, code: "not_found" });
    expect(executeRun).not.toHaveBeenCalled();
  });

  it.each(["trial", "none", "exhausted"] as const)(
    "refuses to run on key source %s (BYOK-only)",
    async (source) => {
      const db = fakeDb({ projects: () => ({ data: PROJECT }) });
      vi.mocked(resolveRunKey).mockResolvedValue({
        source,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
      const outcome = await triggerRunForProject(db as never, "user-1", "proj-1");
      expect(outcome).toMatchObject({ ok: false, code: "no_key" });
      expect(executeRun).not.toHaveBeenCalled();
    },
  );

  it("executes with the user's own key", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    vi.mocked(resolveRunKey).mockResolvedValue({
      source: "own",
      apiKey: "sk-ant-user-key",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    vi.mocked(executeRun).mockResolvedValue({
      runId: "run-9",
      status: "completed",
      totalResponses: 4,
      tokensUsed: 1234,
    });

    const outcome = await triggerRunForProject(db as never, "user-1", "proj-1");
    expect(outcome).toMatchObject({ ok: true, result: { runId: "run-9" } });
    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        project: PROJECT,
        provider: "anthropic",
        apiKey: "sk-ant-user-key",
      }),
    );
  });
});

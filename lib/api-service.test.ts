import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mention, Project, Run } from "@/lib/types";
import {
  createProject,
  createPrompts,
  getOwnedProject,
  getRunReport,
  getRunResponses,
  latestCompletedRun,
  listProjectPrompts,
  listRuns,
  projectSummary,
  updatePrompt,
  triggerRunForProject,
} from "@/lib/api-service";
import { pickDefaultProvider, resolveRunKeyFor, engineKeyMessage } from "@/lib/trial";
import { executeRun } from "@/lib/engine";

vi.mock("@/lib/trial", () => ({
  pickDefaultProvider: vi.fn(),
  resolveRunKeyFor: vi.fn(),
  engineKeyMessage: vi.fn(),
}));
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
        insert: (values: unknown) => {
          q.modifiers.push(["insert", values]);
          return proxy;
        },
        update: (values: unknown) => {
          q.modifiers.push(["update", values]);
          return proxy;
        },
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
        single: async () => result(),
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
  brand_domains: ["credal.ai"],
  description: null,
  default_provider: "anthropic",
  default_model: "claude-sonnet-4-6",
  results_seen_at: null,
  schedule: "off",
  use_web_search: true,
  replicates: 1,
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
    replicates: 1,
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
  vi.mocked(pickDefaultProvider).mockReset().mockReturnValue("anthropic");
  vi.mocked(resolveRunKeyFor).mockReset();
  vi.mocked(engineKeyMessage)
    .mockReset()
    .mockImplementation((k) => `engine message for ${k.requested.provider}`);
  vi.mocked(executeRun).mockReset();
});

/** The values handed to .insert() on the first matching recorded query. */
function insertedValues(db: { queries: RecordedQuery[] }, table: string): unknown {
  const q = db.queries.find(
    (query) => query.table === table && query.modifiers.some((m) => m[0] === "insert"),
  );
  return q?.modifiers.find((m) => m[0] === "insert")?.[1];
}

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

  // Regression: the prompts and competitors queries once had their results
  // swapped in the destructure — pages[] was always empty and the verdict
  // read no-competitors no matter how many were registered.
  it("routes prompt targets into pages[] and the competitor count into the verdict", async () => {
    const db = fakeDb({
      runs: () => ({ data: makeRun({}) }),
      projects: () => ({ data: PROJECT }),
      responses: () => ({
        count: 2,
        data: [
          { id: "resp-1", topic_id: null, prompt_id: "prompt-1" },
          { id: "resp-2", topic_id: null, prompt_id: "prompt-1" },
        ],
      }),
      mentions: () => ({ data: [makeMention({ response_id: "resp-1" })] }),
      sources: () => ({
        data: [
          { response_id: "resp-1", url: "https://blog.example.com/posts/guide?utm_source=openai", is_owned: true },
        ],
      }),
      prompts: () => ({
        data: [{ id: "prompt-1", target_url: "https://blog.example.com/posts/guide" }],
      }),
      competitors: () => ({ count: 3 }),
    });

    const report = await getRunReport(db as never, "user-1", "run-1");
    expect(report!.pages).toEqual([
      expect.objectContaining({
        url: "https://blog.example.com/posts/guide",
        prompts: 1,
        totalResponses: 2,
        responsesCiting: 1,
        citedRate: 0.5,
      }),
    ]);
    // 3 competitors registered + informative answers → never "no-competitors".
    expect(report!.verdict).not.toBe("no-competitors");
  });
});

describe("triggerRunForProject", () => {
  it("404s for a project the user doesn't own", async () => {
    const db = fakeDb({ projects: () => ({ data: null }) });
    const outcome = await triggerRunForProject(db as never, "user-2", "proj-1");
    expect(outcome).toMatchObject({ ok: false, code: "not_found" });
    expect(executeRun).not.toHaveBeenCalled();
  });

  it.each(["trial", "none", "exhausted", "mismatch"] as const)(
    "refuses to run on key source %s (BYOK-only)",
    async (source) => {
      const db = fakeDb({ projects: () => ({ data: PROJECT }) });
      vi.mocked(resolveRunKeyFor).mockResolvedValue({
        source,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        requested: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });
      const outcome = await triggerRunForProject(db as never, "user-1", "proj-1");
      expect(outcome).toMatchObject({ ok: false, code: "no_key" });
      expect(executeRun).not.toHaveBeenCalled();
    },
  );

  it("executes with the user's own key", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    vi.mocked(resolveRunKeyFor).mockResolvedValue({
      source: "own",
      apiKey: "sk-ant-user-key",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      requested: { provider: "anthropic", model: "claude-sonnet-4-6" },
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

  it("resolves a caller-sent provider/model instead of the project default", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    vi.mocked(resolveRunKeyFor).mockResolvedValue({
      source: "own",
      apiKey: "sk-user-openai-key",
      provider: "openai",
      model: "gpt-4o-mini",
      requested: { provider: "openai", model: "gpt-4o-mini" },
    });
    vi.mocked(executeRun).mockResolvedValue({
      runId: "run-10",
      status: "completed",
      totalResponses: 4,
      tokensUsed: 1234,
    });

    const outcome = await triggerRunForProject(db as never, "user-1", "proj-1", {
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(outcome).toMatchObject({ ok: true, result: { runId: "run-10" } });
    expect(resolveRunKeyFor).toHaveBeenCalledWith(db, "user-1", "openai", "gpt-4o-mini");
    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-user-openai-key",
      }),
    );
  });

  // An override naming only the provider must not carry the PROJECT's model
  // across: "run this on openai" with the project set to claude-sonnet-4-6
  // would otherwise ask OpenAI for a Claude model id. It now resolves to that
  // provider's default explicitly, rather than leaving the resolver to guess.
  it("resolves the new provider's default when the override omits a model", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    vi.mocked(resolveRunKeyFor).mockResolvedValue({
      source: "own",
      apiKey: "sk-user-openai-key",
      provider: "openai",
      model: "gpt-4o",
      requested: { provider: "openai", model: "gpt-4o" },
    });
    vi.mocked(executeRun).mockResolvedValue({
      runId: "run-11",
      status: "completed",
      totalResponses: 1,
      tokensUsed: 10,
    });

    await triggerRunForProject(db as never, "user-1", "proj-1", { provider: "openai" });
    expect(resolveRunKeyFor).toHaveBeenCalledWith(db, "user-1", "openai", "gpt-4o");
  });

  // Same validation on the per-run override: an unusable pair would otherwise
  // be recorded on the run row and then rejected by the provider mid-run.
  it("rejects a per-run override whose model isn't the provider's", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    const outcome = await triggerRunForProject(db as never, "user-1", "proj-1", {
      provider: "openai",
      model: "claude-opus-4-8",
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid_engine" });
    expect(resolveRunKeyFor).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
  });

  it("names the requested provider when an override has no own key", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    vi.mocked(resolveRunKeyFor).mockResolvedValue({
      source: "none",
      provider: "openai",
      model: "gpt-4o",
      requested: { provider: "openai", model: "gpt-4o" },
    });
    const outcome = await triggerRunForProject(db as never, "user-1", "proj-1", {
      provider: "openai",
    });
    expect(outcome).toMatchObject({ ok: false, code: "no_key" });
    expect((outcome as { message: string }).message).toContain("OpenAI");
    expect(executeRun).not.toHaveBeenCalled();
  });

  // The reported bug, at the API surface: a caller asking for GPT-4o with only
  // an Anthropic key on file used to get a Claude run reported as a success.
  it("refuses rather than silently running the engine it has a key for", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    vi.mocked(resolveRunKeyFor).mockResolvedValue({
      source: "mismatch",
      provider: "openai",
      model: "gpt-4o",
      requested: { provider: "openai", model: "gpt-4o" },
      available: ["anthropic"],
    });
    const outcome = await triggerRunForProject(db as never, "user-1", "proj-1", {
      provider: "openai",
    });
    expect(outcome).toMatchObject({ ok: false, code: "no_key" });
    expect((outcome as { message: string }).message).toContain("engine message for openai");
    expect(executeRun).not.toHaveBeenCalled();
  });
});

describe("createProject", () => {
  it("requires a name and a brand name", async () => {
    const db = fakeDb({});
    expect(
      await createProject(db as never, "user-1", { brand_name: "Acme" }),
    ).toMatchObject({ ok: false, code: "invalid" });
    expect(
      await createProject(db as never, "user-1", { name: "Acme", brand_name: "  " }),
    ).toMatchObject({ ok: false, code: "invalid" });
    expect(db.queries).toHaveLength(0);
  });

  it("rejects an unknown default_provider", async () => {
    const db = fakeDb({});
    const outcome = await createProject(db as never, "user-1", {
      name: "Acme",
      brand_name: "Acme",
      default_provider: "mistral",
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid" });
    expect(db.queries).toHaveLength(0);
  });

  // LET-169: the model was accepted as any non-empty string, so a pair like
  // openai + claude-opus-4-8 saved cleanly and then failed at the provider,
  // as an error naming a model the caller never chose.
  it("rejects a model the chosen provider doesn't offer", async () => {
    const db = fakeDb({});
    const outcome = await createProject(db as never, "user-1", {
      name: "Acme",
      brand_name: "Acme",
      default_provider: "openai",
      default_model: "claude-opus-4-8",
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid" });
    expect((outcome as { message: string }).message).toContain("claude-opus-4-8");
    expect(db.queries).toHaveLength(0);
  });

  it("rejects a model that is in no catalog", async () => {
    const db = fakeDb({});
    const outcome = await createProject(db as never, "user-1", {
      name: "Acme",
      brand_name: "Acme",
      default_model: "banana",
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid" });
    expect(db.queries).toHaveLength(0);
  });

  it("honors google as a valid default_provider", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    const outcome = await createProject(db as never, "user-1", {
      name: "Acme",
      brand_name: "Acme",
      default_provider: "google",
    });
    expect(outcome).toMatchObject({ ok: true, project: { id: "proj-1" } });
    expect(insertedValues(db, "projects")).toMatchObject({
      default_provider: "google",
      default_model: "gemini-pro-latest", // defaultModelFor("google")
    });
  });

  it("inserts with the dashboard defaults, tied to the caller", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    const outcome = await createProject(db as never, "user-1", {
      name: "Acme",
      brand_name: "Acme",
    });
    expect(outcome).toMatchObject({ ok: true, project: { id: "proj-1" } });
    expect(insertedValues(db, "projects")).toMatchObject({
      name: "Acme",
      brand_name: "Acme",
      brand_aliases: [],
      brand_domains: [],
      description: null,
      default_provider: "anthropic",
      default_model: "claude-opus-4-8", // defaultModelFor("anthropic")
      schedule: "off", // API callers orchestrate their own cadence
      user_id: "user-1",
    });
  });

  it("honors an explicit provider, model, aliases and web-search flag", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    await createProject(db as never, "user-1", {
      name: "Acme",
      brand_name: "Acme",
      brand_aliases: ["Acme Inc", " acme.io "],
      brand_domains: ["acme.io", " acme-guides.io ", "ACME.io"],
      default_provider: "openai",
      default_model: "gpt-4o-mini",
      use_web_search: false,
    });
    expect(insertedValues(db, "projects")).toMatchObject({
      brand_aliases: ["Acme Inc", "acme.io"],
      // Trimmed and deduped case-insensitively, primary first.
      brand_domains: ["acme.io", "acme-guides.io"],
      default_provider: "openai",
      default_model: "gpt-4o-mini",
      use_web_search: false,
    });
  });
});

describe("listProjectPrompts", () => {
  it("returns null when the project isn't the user's", async () => {
    const db = fakeDb({ projects: () => ({ data: null }) });
    expect(await listProjectPrompts(db as never, "user-2", "proj-1")).toBeNull();
  });

  it("flattens the embedded topic name", async () => {
    const db = fakeDb({
      projects: () => ({ data: PROJECT }),
      prompts: () => ({
        data: [
          {
            id: "prompt-1",
            text: "best crm for startups",
            source: "manual",
            is_active: true,
            target_url: null,
            created_at: "2026-07-02T00:00:00Z",
            topics: { name: "CRM" },
          },
        ],
      }),
    });
    const prompts = await listProjectPrompts(db as never, "user-1", "proj-1");
    expect(prompts).toEqual([
      {
        id: "prompt-1",
        text: "best crm for startups",
        topic: "CRM",
        source: "manual",
        is_active: true,
        target_url: null,
        created_at: "2026-07-02T00:00:00Z",
      },
    ]);
  });
});

describe("createPrompts", () => {
  it("404s for a project the user doesn't own", async () => {
    const db = fakeDb({ projects: () => ({ data: null }) });
    const outcome = await createPrompts(db as never, "user-2", "proj-1", [
      { text: "hi", topic: "CRM" },
    ]);
    expect(outcome).toMatchObject({ ok: false, code: "not_found" });
  });

  it("rejects entries with empty text or topic, naming the indexes", async () => {
    const db = fakeDb({ projects: () => ({ data: PROJECT }) });
    const outcome = await createPrompts(db as never, "user-1", "proj-1", [
      { text: "ok", topic: "CRM" },
      { text: "  ", topic: "CRM" },
      { text: "ok too" },
    ]);
    expect(outcome).toMatchObject({ ok: false, code: "invalid" });
    expect((outcome as { message: string }).message).toContain("1, 2");
  });

  it("get-or-creates topics by name and skips duplicate texts", async () => {
    let promptInsertRows: Record<string, unknown>[] = [];
    const db = fakeDb({
      projects: () => ({ data: PROJECT }),
      topics: (q) => {
        const insert = q.modifiers.find((m) => m[0] === "insert");
        if (!insert) return { data: [{ id: "topic-crm", name: "CRM" }] };
        return {
          data: (insert[1] as { name: string }[]).map((row, i) => ({
            id: `topic-new-${i}`,
            name: row.name,
          })),
        };
      },
      prompts: (q) => {
        const insert = q.modifiers.find((m) => m[0] === "insert");
        if (!insert) return { data: [{ text: "Existing prompt" }] };
        promptInsertRows = insert[1] as Record<string, unknown>[];
        return {
          data: promptInsertRows.map((row, i) => ({
            ...row,
            id: `prompt-${i}`,
            created_at: "2026-07-03T00:00:00Z",
          })),
        };
      },
    });

    const outcome = await createPrompts(db as never, "user-1", "proj-1", [
      { text: "existing PROMPT", topic: "CRM" }, // already in the project
      { text: "best crm for startups", topic: "crm" }, // existing topic, other case
      { text: "how much does acme cost", topic: "Pricing" }, // new topic
      { text: "Best CRM for startups", topic: "CRM" }, // repeat within the batch
    ]);

    expect(outcome).toMatchObject({ ok: true, skipped: 2 });
    const created = (outcome as { created: { text: string; topic: string | null }[] })
      .created;
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ text: "best crm for startups", topic: "CRM" });
    expect(created[1]).toMatchObject({ text: "how much does acme cost", topic: "Pricing" });

    // Only the genuinely new topic name is created.
    expect(insertedValues(db, "topics")).toEqual([
      { project_id: "proj-1", name: "Pricing" },
    ]);
    expect(promptInsertRows).toEqual([
      expect.objectContaining({
        project_id: "proj-1",
        topic_id: "topic-crm",
        source: "manual",
        is_active: true,
      }),
      expect.objectContaining({ topic_id: "topic-new-0" }),
    ]);
  });
});

describe("updatePrompt", () => {
  const PROMPT_ROW = {
    id: "prompt-1",
    project_id: "proj-1",
    text: "best crm for startups",
    source: "manual",
    is_active: true,
    target_url: null,
    created_at: "2026-07-02T00:00:00Z",
    topics: { name: "CRM" },
  };

  it("not_found for an unknown prompt", async () => {
    const db = fakeDb({ prompts: () => ({ data: null }) });
    const outcome = await updatePrompt(db as never, "user-1", "prompt-1", { is_active: false });
    expect(outcome).toMatchObject({ ok: false, code: "not_found" });
  });

  it("not_found when the prompt's project isn't the user's", async () => {
    const db = fakeDb({
      prompts: () => ({ data: PROMPT_ROW }),
      projects: () => ({ data: null }),
    });
    const outcome = await updatePrompt(db as never, "user-2", "prompt-1", { is_active: false });
    expect(outcome).toMatchObject({ ok: false, code: "not_found" });
  });

  it("rejects an empty patch and an unparseable target_url", async () => {
    const db = fakeDb({});
    expect(await updatePrompt(db as never, "user-1", "prompt-1", {})).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(
      await updatePrompt(db as never, "user-1", "prompt-1", { target_url: "not a url" }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });

  it("updates scoped by prompt AND project id", async () => {
    const db = fakeDb({
      prompts: () => ({ data: PROMPT_ROW }),
      projects: () => ({ data: PROJECT }),
    });
    const outcome = await updatePrompt(db as never, "user-1", "prompt-1", { is_active: false });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.prompt).toMatchObject({ id: "prompt-1", topic: "CRM", is_active: false });
    }

    const updateQuery = db.queries.find((q) =>
      q.modifiers.some((m) => m[0] === "update"),
    )!;
    expect(updateQuery.modifiers).toContainEqual(["update", { is_active: false }]);
    expect(updateQuery.filters).toEqual([
      ["eq", "id", "prompt-1"],
      ["eq", "project_id", "proj-1"],
    ]);
  });

  it("sets and clears the target page mapping", async () => {
    const db = fakeDb({
      prompts: () => ({ data: PROMPT_ROW }),
      projects: () => ({ data: PROJECT }),
    });
    const set = await updatePrompt(db as never, "user-1", "prompt-1", {
      target_url: "https://acme.io/blog/best-crm?utm=x",
    });
    expect(set.ok).toBe(true);
    if (set.ok) expect(set.prompt.target_url).toBe("https://acme.io/blog/best-crm?utm=x");

    const cleared = await updatePrompt(db as never, "user-1", "prompt-1", { target_url: null });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.prompt.target_url).toBeNull();
  });
});

describe("getRunResponses", () => {
  it("returns null for a run the user doesn't own", async () => {
    const db = fakeDb({
      runs: () => ({ data: makeRun({}) }),
      projects: () => ({ data: null }),
    });
    expect(await getRunResponses(db as never, "user-2", "run-1")).toBeNull();
  });

  it("groups each response's text with its sources and mentions", async () => {
    // prompt_id is null when the prompt was deleted after the run.
    const responses = [
      {
        id: "resp-1",
        prompt_id: "prompt-1",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        response_text: "Credal is a strong option…",
      },
      {
        id: "resp-2",
        prompt_id: null,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        response_text: "Several tools compete here…",
      },
    ];
    const sources = [
      {
        id: "src-1",
        response_id: "resp-1",
        url: "https://credal.ai/blog/post",
        domain: "credal.ai",
        title: "Post",
        snippet: "…",
        is_owned: true,
        created_at: "2026-07-02T00:00:00Z",
      },
    ];
    const db = fakeDb({
      runs: () => ({ data: makeRun({}) }),
      projects: () => ({ data: PROJECT }),
      responses: () => ({ data: responses }),
      sources: () => ({ data: sources }),
      mentions: () => ({ data: [makeMention({ response_id: "resp-1" })] }),
      prompts: () => ({ data: [{ id: "prompt-1", text: "best crm for startups" }] }),
    });

    const result = await getRunResponses(db as never, "user-1", "run-1");
    expect(result).not.toBeNull();
    expect(result!.run.id).toBe("run-1");
    expect(result!.responses).toHaveLength(2);

    const [first, second] = result!.responses;
    expect(first).toMatchObject({
      id: "resp-1",
      prompt_text: "best crm for startups",
      response_text: "Credal is a strong option…",
    });
    expect(first.sources).toEqual([
      {
        url: "https://credal.ai/blog/post",
        domain: "credal.ai",
        title: "Post",
        snippet: "…",
        is_owned: true,
      },
    ]);
    expect(first.mentions).toEqual([
      {
        entity_type: "brand",
        entity_name: "Credal",
        mention_count: 1,
        first_position: 0.1,
        sentiment: "positive",
        recommended: false,
      },
    ]);
    expect(second).toMatchObject({ prompt_text: null, sources: [], mentions: [] });
  });
});

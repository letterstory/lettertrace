import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/types";

vi.mock("@/lib/trial", () => ({
  resolveRunKeyFor: vi.fn(),
  resolveRunKey: vi.fn(),
  resolveKey: vi.fn(),
  engineKeyMessage: vi.fn((k: { source: string }) => `message for ${k.source}`),
  getTrialUsage: vi.fn(async () => ({ runs: 0, spendMicros: 0 })),
  trialRunLimit: () => 15,
  trialCoveredProviders: vi.fn(() => []),
  pickDefaultProvider: vi.fn(() => "anthropic"),
  runBudgetMicros: (key: { source: string; capMicros?: number; spentMicros?: number }) =>
    key.source === "trial" ? Math.max(0, (key.capMicros ?? 0) - (key.spentMicros ?? 0)) : null,
  consumeTrialRun: vi.fn(),
  recordTrialUsage: vi.fn(),
  recordTrialSpend: vi.fn(),
  consumeTrialRunFor: vi.fn(),
  recordTrialUsageFor: vi.fn(),
  recordTrialSpendFor: vi.fn(),
}));
vi.mock("@/lib/data", () => ({
  getConfiguredProviders: vi.fn(async () => []),
  getRouterKeysPublic: vi.fn(async () => []),
}));
vi.mock("@/lib/engine", () => ({
  executeRun: vi.fn(),
  prepareRun: vi.fn(),
  resumeRun: vi.fn(),
  settleAbandonedRun: vi.fn(),
}));
vi.mock("@/lib/scrape", () => ({ scrapeDomain: vi.fn() }));
vi.mock("@/lib/llm", () => ({
  suggestFromSite: vi.fn(),
  humanError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
// Background work runs to completion inside the test instead of being handed
// to a platform hook.
vi.mock("@/lib/notify", () => ({ fireAndForget: (p: Promise<unknown>) => void p }));
vi.mock("@/lib/ops", () => ({ recordOpsError: vi.fn() }));
vi.mock("@/lib/crypto", () => ({
  generateApiKey: () => "lt_live_plaintext",
  hashApiKey: (s: string) => `hash(${s})`,
  keyHint: () => "lt_live_…text",
}));

const trial = await import("@/lib/trial");
const data = await import("@/lib/data");
const engine = await import("@/lib/engine");
const { scrapeDomain } = await import("@/lib/scrape");
const { suggestFromSite } = await import("@/lib/llm");
const {
  firstSweep,
  persistOnboarding,
  onboardFromUrl,
  brandNameFrom,
  hostOfUrl,
  resolveOnboardingAccount,
  mintApiKey,
  serviceTrialMeter,
  sessionTrialMeter,
} = await import("@/lib/onboard");
type TrialMeter = import("@/lib/onboard").TrialMeter;

// ------------------------------------------------------------------
// A recording fake of the query builder: every call is appended to the
// query's op list; the terminal (single/maybeSingle/await) asks the table's
// handler for the payload.
// ------------------------------------------------------------------
interface Q {
  table: string;
  ops: [string, ...unknown[]][];
}
type Handler = (q: Q) => { data?: unknown; error?: unknown; count?: number | null };

function fakeDb(handlers: Record<string, Handler> = {}) {
  const queries: Q[] = [];
  const db = {
    queries,
    auth: { admin: { createUser: vi.fn() } },
    from(table: string) {
      const q: Q = { table, ops: [] };
      queries.push(q);
      const result = () => ({ data: null, error: null, count: null, ...handlers[table]?.(q) });
      const proxy: Record<string, unknown> = {};
      for (const name of ["select", "insert", "update", "upsert", "eq", "ilike", "order", "limit"]) {
        proxy[name] = (...args: unknown[]) => {
          q.ops.push([name, ...args]);
          return proxy;
        };
      }
      proxy.single = async () => result();
      proxy.maybeSingle = async () => result();
      proxy.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(ok, ko);
      return proxy;
    },
  };
  return db;
}

const inserted = (db: { queries: Q[] }, table: string) =>
  db.queries
    .filter((q) => q.table === table)
    .flatMap((q) => q.ops.filter((o) => o[0] === "insert").map((o) => o[1]));

const PROJECT: Project = {
  id: "proj-1",
  user_id: "owner-1",
  name: "Acme",
  brand_name: "Acme",
  brand_aliases: [],
  brand_domains: ["acme.com"],
  description: null,
  default_provider: "anthropic",
  default_model: "claude-sonnet-4-6",
  results_seen_at: null,
  schedule: "off",
  schedule_interval_days: null,
  use_web_search: true,
  replicates: 1,
  last_run_at: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

const own = (provider: "anthropic" | "openai" | "google" | "perplexity") => ({
  source: "own" as const,
  apiKey: `sk-${provider}-own`,
  provider,
  model: `${provider}-model`,
  requested: { provider, model: `${provider}-model` },
});
const trialKey = (provider: "anthropic" | "openai" | "google" | "perplexity") => ({
  source: "trial" as const,
  apiKey: "sk-operator",
  provider,
  model: `${provider}-cheap`,
  requested: { provider, model: `${provider}-model` },
  remaining: 15,
  limit: 15,
  spentMicros: 1_000_000,
  capMicros: 5_000_000,
});
const none = (provider: "anthropic" | "openai" | "google" | "perplexity") => ({
  source: "none" as const,
  provider,
  model: `${provider}-model`,
  requested: { provider, model: `${provider}-model` },
});

function meter(consumeResults: boolean[] = [true, true, true, true]): TrialMeter & {
  consume: ReturnType<typeof vi.fn>;
  recordUsage: ReturnType<typeof vi.fn>;
  recordSpend: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  return {
    consume: vi.fn(async () => consumeResults[i++] ?? false),
    recordUsage: vi.fn(async () => {}),
    recordSpend: vi.fn(async () => {}),
  };
}

const completed = (runId: string, spendMicros = 0) => ({
  runId,
  status: "completed" as const,
  totalResponses: 2,
  tokensUsed: 100,
  spendMicros,
});

beforeEach(() => {
  vi.mocked(trial.resolveRunKeyFor).mockReset();
  vi.mocked(trial.resolveRunKey).mockReset();
  vi.mocked(trial.resolveKey).mockReset();
  vi.mocked(trial.getTrialUsage).mockReset().mockResolvedValue({ runs: 0, spendMicros: 0 });
  vi.mocked(trial.trialCoveredProviders).mockReset().mockReturnValue([]);
  vi.mocked(trial.pickDefaultProvider).mockReset().mockReturnValue("anthropic");
  vi.mocked(data.getConfiguredProviders).mockReset().mockResolvedValue([]);
  vi.mocked(data.getRouterKeysPublic).mockReset().mockResolvedValue([]);
  vi.mocked(engine.executeRun).mockReset();
  vi.mocked(engine.prepareRun).mockReset();
  vi.mocked(engine.resumeRun).mockReset();
  vi.mocked(scrapeDomain).mockReset();
  vi.mocked(suggestFromSite).mockReset();
});

// ---------------------------------------------------------------------------
describe("firstSweep", () => {
  it("runs every engine the owner's keys cover plus the trial's, one free run each", async () => {
    // Own key for openai; the trial covers anthropic + google. Three runs, two
    // of them on the allowance.
    vi.mocked(trial.trialCoveredProviders).mockReturnValue(["anthropic", "google"]);
    vi.mocked(trial.resolveRunKeyFor).mockImplementation(async (_db, _u, p) =>
      p === "openai" ? own("openai") : trialKey(p),
    );
    vi.mocked(engine.executeRun).mockImplementation(async (params) =>
      completed(`run-${params.provider}`, params.provider === "openai" ? 0 : 300_000),
    );
    const m = meter();

    const outcome = await firstSweep({
      supabase: fakeDb() as never,
      userId: "owner-1",
      project: PROJECT,
      runnable: ["openai"],
      meter: m,
      context: { channel: "api" },
    });

    expect(outcome.ran).toBe(true);
    if (!outcome.ran) return;
    // The project's own engine leads; the rest keep their order.
    expect(outcome.runs.map((r) => [r.provider, r.keySource, r.runId])).toEqual([
      ["anthropic", "trial", "run-anthropic"],
      ["openai", "own", "run-openai"],
      ["google", "trial", "run-google"],
    ]);
    expect(m.consume).toHaveBeenCalledTimes(2);
    // Metered per trial run, not for the own-key one.
    expect(m.recordSpend).toHaveBeenCalledTimes(2);
    expect(m.recordSpend).toHaveBeenCalledWith(300_000);
    expect(m.recordUsage).toHaveBeenCalledWith(100);
    // The remaining spend budget (4.00) is split across the two trial runs.
    const budgets = vi.mocked(engine.executeRun).mock.calls.map((c) => [c[0].provider, c[0].budgetMicros]);
    expect(budgets).toEqual(
      expect.arrayContaining([
        ["anthropic", 2_000_000],
        ["google", 2_000_000],
        ["openai", null],
      ]),
    );
  });

  it("stops granting free runs at exactly the engine where the allowance ran out", async () => {
    vi.mocked(trial.trialCoveredProviders).mockReturnValue(["anthropic", "google", "perplexity"]);
    vi.mocked(trial.resolveRunKeyFor).mockImplementation(async (_db, _u, p) => trialKey(p));
    vi.mocked(engine.executeRun).mockImplementation(async (params) => completed(`run-${params.provider}`));
    // One free run left: the second consume finds nothing.
    const m = meter([true, false, false]);

    const outcome = await firstSweep({
      supabase: fakeDb() as never,
      userId: "owner-1",
      project: PROJECT,
      runnable: [],
      meter: m,
      context: {},
    });

    expect(outcome).toMatchObject({ ran: true });
    if (!outcome.ran) return;
    expect(outcome.runs.map((r) => r.provider)).toEqual(["anthropic"]);
    expect(m.consume).toHaveBeenCalledTimes(3);
    expect(engine.executeRun).toHaveBeenCalledTimes(1);
  });

  it("does not consult the trial once it is inactive", async () => {
    vi.mocked(trial.getTrialUsage).mockResolvedValue({ runs: 15, spendMicros: 0 });
    vi.mocked(trial.trialCoveredProviders).mockReturnValue(["anthropic"]);
    vi.mocked(trial.resolveRunKeyFor).mockImplementation(async (_db, _u, p) => own(p));
    vi.mocked(engine.executeRun).mockResolvedValue(completed("run-openai"));

    const outcome = await firstSweep({
      supabase: fakeDb() as never,
      userId: "owner-1",
      project: PROJECT,
      runnable: ["openai"],
      meter: meter(),
      context: {},
    });
    expect(outcome).toMatchObject({ ran: true, runs: [{ provider: "openai", keySource: "own" }] });
    expect(trial.resolveRunKeyFor).toHaveBeenCalledTimes(1);
  });

  it("explains a missing key with the project engine's own message", async () => {
    vi.mocked(trial.trialCoveredProviders).mockReturnValue([]);
    vi.mocked(trial.resolveRunKey).mockResolvedValue({
      ...none("anthropic"),
      source: "mismatch",
      available: ["openai"],
    });

    const outcome = await firstSweep({
      supabase: fakeDb() as never,
      userId: "owner-1",
      project: PROJECT,
      runnable: [],
      meter: meter(),
      context: {},
    });
    expect(outcome).toEqual({ ran: false, needsKey: "mismatch", keyMessage: "message for mismatch" });
    expect(engine.executeRun).not.toHaveBeenCalled();
  });

  it("reports exhaustion when every fundable engine lost the atomic gate", async () => {
    vi.mocked(trial.trialCoveredProviders).mockReturnValue(["anthropic"]);
    vi.mocked(trial.resolveRunKeyFor).mockImplementation(async (_db, _u, p) => trialKey(p));
    vi.mocked(trial.resolveRunKey).mockResolvedValue(trialKey("anthropic"));

    const outcome = await firstSweep({
      supabase: fakeDb() as never,
      userId: "owner-1",
      project: PROJECT,
      runnable: [],
      meter: meter([false]),
      context: {},
    });
    expect(outcome).toMatchObject({ ran: false, needsKey: "exhausted" });
    expect(engine.executeRun).not.toHaveBeenCalled();
  });

  it("surfaces the failure when no run could start", async () => {
    vi.mocked(trial.resolveRunKeyFor).mockImplementation(async (_db, _u, p) => own(p));
    vi.mocked(engine.executeRun).mockRejectedValue(new Error("provider down"));

    const outcome = await firstSweep({
      supabase: fakeDb() as never,
      userId: "owner-1",
      project: PROJECT,
      runnable: ["anthropic"],
      meter: meter(),
      context: {},
    });
    expect(outcome).toEqual({ ran: false, error: "provider down" });
  });

  // Background: the run rows exist when this returns; the trial is metered
  // when each run settles, inside the chain that outlives the response.
  it("in the background, returns running rows and meters each run as it settles", async () => {
    vi.mocked(trial.trialCoveredProviders).mockReturnValue(["anthropic"]);
    vi.mocked(trial.resolveRunKeyFor).mockImplementation(async (_db, _u, p) => trialKey(p));
    vi.mocked(engine.prepareRun).mockResolvedValue({
      runId: "run-bg",
      jobs: [],
      competitors: [],
      attribution: {} as never,
      startedMs: 0,
      startedAt: "1970-01-01T00:00:00.000Z",
    });
    let finish!: (r: ReturnType<typeof completed>) => void;
    vi.mocked(engine.resumeRun).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const m = meter();

    const outcome = await firstSweep({
      supabase: fakeDb() as never,
      userId: "owner-1",
      project: PROJECT,
      runnable: [],
      meter: m,
      context: {},
      background: true,
    });
    expect(outcome).toMatchObject({
      ran: true,
      runs: [{ runId: "run-bg", status: "running", keySource: "trial" }],
    });
    expect(m.consume).toHaveBeenCalledTimes(1);
    expect(m.recordSpend).not.toHaveBeenCalled();

    finish(completed("run-bg", 123_000));
    await vi.waitFor(() => expect(m.recordSpend).toHaveBeenCalledWith(123_000));
  });
});

// ---------------------------------------------------------------------------
describe("persistOnboarding", () => {
  it("writes competitors before topics, then each topic's prompts", async () => {
    const db = fakeDb({
      topics: (q) => ({ data: { id: `topic-${(q.ops[0][1] as { name: string }).name}` } }),
    });
    const saved = await persistOnboarding(db as never, { id: "proj-1" }, {
      topics: [
        { name: "CDN", prompts: ["best cdn?", "fastest cdn?"] },
        { name: "DNS", prompts: ["best dns?"] },
      ],
      competitors: [{ name: "Fastly", aliases: [], domain: "fastly.com" }],
    });
    expect(saved).toEqual({ topics: 2, prompts: 3, competitors: 1 });
    const tables = db.queries.map((q) => q.table);
    expect(tables.indexOf("competitors")).toBeLessThan(tables.indexOf("topics"));
    expect(inserted(db, "prompts").flat()).toEqual([
      { project_id: "proj-1", topic_id: "topic-CDN", text: "best cdn?", source: "ai", is_active: true },
      { project_id: "proj-1", topic_id: "topic-CDN", text: "fastest cdn?", source: "ai", is_active: true },
      { project_id: "proj-1", topic_id: "topic-DNS", text: "best dns?", source: "ai", is_active: true },
    ]);
  });

  it("does not let a competitor failure cost the topics", async () => {
    const db = fakeDb({
      competitors: () => ({ error: { message: "unique violation" } }),
      topics: () => ({ data: { id: "topic-1" } }),
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const saved = await persistOnboarding(db as never, { id: "proj-1" }, {
      topics: [{ name: "CDN", prompts: ["best cdn?"] }],
      competitors: [{ name: "Fastly", aliases: [], domain: null }],
      promptSource: "manual",
    });
    expect(saved).toEqual({ topics: 1, prompts: 1, competitors: 0 });
    expect(inserted(db, "prompts").flat()[0]).toMatchObject({ source: "manual" });
    err.mockRestore();
  });
});

// ---------------------------------------------------------------------------
describe("the brand behind a URL", () => {
  it.each([
    ["acme.com", "acme.com"],
    ["https://www.acme.com/pricing?x=1", "acme.com"],
    ["WWW.Acme.CO.UK", "acme.co.uk"],
    ["not a url", null],
    ["ftp://acme.com", null],
    ["localhost", null],
  ])("hostOfUrl(%s)", (input, host) => {
    expect(hostOfUrl(input)).toBe(host);
  });

  it("keeps the name the caller sent", () => {
    expect(brandNameFrom({ brandName: " Acme Inc ", title: "Something else", host: "acme.com" })).toBe(
      "Acme Inc",
    );
  });

  it("otherwise derives it the way the wizard does: site name, then title, then domain", () => {
    expect(brandNameFrom({ siteName: "Acme", title: "Payroll | Acme", host: "acme.com" })).toBe("Acme");
    expect(brandNameFrom({ title: null, host: "getacme.io" })).toBe("Getacme");
  });
});

// ---------------------------------------------------------------------------
describe("onboardFromUrl", () => {
  function happyDb() {
    return fakeDb({
      projects: (q) => ({
        data: { ...PROJECT, ...(q.ops.find((o) => o[0] === "insert")?.[1] as object) },
      }),
      topics: (q) => ({ data: { id: `topic-${(q.ops[0][1] as { name: string }).name}` } }),
    });
  }

  it("reads, suggests, saves, and sweeps on the trial — metering the suggestion too", async () => {
    vi.mocked(scrapeDomain).mockResolvedValue({
      ok: true,
      url: "https://acme.com/",
      title: "Acme — payroll",
      siteName: "Acme",
      text: "Acme does payroll for platform teams.",
    });
    vi.mocked(trial.resolveKey).mockResolvedValue(trialKey("anthropic"));
    vi.mocked(suggestFromSite).mockResolvedValue({
      description: "Payroll for platform teams.",
      topics: [{ name: "Payroll", prompts: ["best payroll for startups?", " "] }],
      competitors: [{ name: "Gusto", aliases: [], domain: "gusto.com" }, { name: "Acme", aliases: [], domain: null }],
      tokens: 800,
    });
    vi.mocked(trial.trialCoveredProviders).mockReturnValue(["anthropic"]);
    vi.mocked(trial.resolveRunKeyFor).mockImplementation(async (_db, _u, p) => trialKey(p));
    vi.mocked(engine.executeRun).mockResolvedValue(completed("run-1", 50_000));
    const db = happyDb();
    const m = meter();

    const outcome = await onboardFromUrl({
      supabase: db as never,
      userId: "owner-1",
      meter: m,
      context: { channel: "api" },
      input: { url: "https://www.acme.com/", background: false },
    });

    expect(outcome.site).toMatchObject({ host: "acme.com", siteName: "Acme", scraped: true });
    expect(outcome.suggestion).toMatchObject({ topics: 1, competitors: 2, keySource: "trial", tokens: 800 });
    // The suggestion spent the operator's key: tokens + dollars recorded, no run consumed for it.
    expect(m.recordUsage).toHaveBeenCalledWith(800);
    expect(m.recordSpend.mock.calls[0][0]).toBeGreaterThan(0);
    // The brand itself is never its own competitor; the blank prompt is dropped.
    expect(outcome.competitors.map((c) => c.name)).toEqual(["Gusto"]);
    expect(outcome.topics).toEqual([{ name: "Payroll", prompts: ["best payroll for startups?"] }]);
    // Project: host leads the domains, name derived from the title, the
    // model's description kept, schedule off for a programmatic caller.
    expect(inserted(db, "projects")[0]).toMatchObject({
      user_id: "owner-1",
      brand_name: "Acme",
      name: "Acme",
      brand_domains: ["acme.com"],
      description: "Payroll for platform teams.",
      schedule: "off",
    });
    expect(outcome.saved).toEqual({ topics: 1, prompts: 1, competitors: 1 });
    // Then exactly one free run for the one trial-covered engine.
    expect(m.consume).toHaveBeenCalledTimes(1);
    expect(outcome.sweep).toMatchObject({ ran: true, runs: [{ provider: "anthropic", keySource: "trial" }] });
    expect(outcome.trial).toMatchObject({ limit: 15 });
  });

  it("skips the suggestion when the caller brings topics, and saves them as manual", async () => {
    vi.mocked(scrapeDomain).mockResolvedValue({ ok: false, url: "https://acme.com/", error: "Site returned 503." });
    vi.mocked(trial.resolveRunKeyFor).mockImplementation(async (_db, _u, p) => own(p));
    vi.mocked(data.getConfiguredProviders).mockResolvedValue(["anthropic"]);
    vi.mocked(engine.executeRun).mockResolvedValue(completed("run-1"));
    const db = happyDb();

    const outcome = await onboardFromUrl({
      supabase: db as never,
      userId: "owner-1",
      meter: meter(),
      context: {},
      input: {
        url: "acme.com",
        brandName: "Acme",
        topics: [{ name: "CDN", prompts: ["best cdn?"] }],
        competitors: [{ name: "Fastly" }],
        extraDomains: ["https://blog.acme.com", "acme.com"],
        schedule: "weekly",
        background: false,
      },
    });
    expect(outcome.suggestionSkipped).toBe("topics_given");
    expect(suggestFromSite).not.toHaveBeenCalled();
    expect(outcome.site).toMatchObject({ scraped: false, error: "Site returned 503." });
    expect(inserted(db, "projects")[0]).toMatchObject({
      brand_domains: ["acme.com", "blog.acme.com"],
      schedule: "weekly",
      default_provider: "anthropic",
    });
    expect(inserted(db, "prompts").flat()[0]).toMatchObject({ source: "manual" });
    expect(outcome.sweep).toMatchObject({ ran: true });
  });

  it("stores a valid custom cadence with its interval", async () => {
    vi.mocked(scrapeDomain).mockResolvedValue({
      ok: true,
      url: "https://acme.com/",
      text: "Acme",
    });
    vi.mocked(trial.resolveRunKeyFor).mockImplementation(async (_db, _u, p) => own(p));
    vi.mocked(data.getConfiguredProviders).mockResolvedValue(["anthropic"]);
    vi.mocked(engine.executeRun).mockResolvedValue(completed("run-1"));
    const db = happyDb();

    await onboardFromUrl({
      supabase: db as never,
      userId: "owner-1",
      meter: meter(),
      context: {},
      input: {
        url: "acme.com",
        topics: [{ name: "CDN", prompts: ["best cdn?"] }],
        schedule: "custom",
        scheduleIntervalDays: 14,
      },
    });

    expect(inserted(db, "projects")[0]).toMatchObject({
      schedule: "custom",
      schedule_interval_days: 14,
    });
  });

  it("rejects invalid cadence before reading the site or spending model work", async () => {
    for (const input of [
      { schedule: "hourly" },
      { schedule: "custom" },
      { schedule: "custom", scheduleIntervalDays: 0 },
      { schedule: "custom", scheduleIntervalDays: 1.5 },
      { schedule: "custom", scheduleIntervalDays: "14" },
      { schedule: "custom", scheduleIntervalDays: 91 },
    ]) {
      await expect(
        onboardFromUrl({
          supabase: fakeDb() as never,
          userId: "owner-1",
          meter: meter(),
          context: {},
          input: { url: "acme.com", ...input },
        }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect(scrapeDomain).not.toHaveBeenCalled();
    expect(suggestFromSite).not.toHaveBeenCalled();
  });

  it("does not start a sweep with nothing to ask", async () => {
    vi.mocked(scrapeDomain).mockResolvedValue({ ok: true, url: "https://acme.com/", text: "x" });
    vi.mocked(trial.resolveKey).mockResolvedValue({ ...none("anthropic"), source: "exhausted" });
    const db = happyDb();

    const outcome = await onboardFromUrl({
      supabase: db as never,
      userId: "owner-1",
      meter: meter(),
      context: {},
      input: { url: "acme.com" },
    });
    expect(outcome.suggestionSkipped).toBe("trial_exhausted");
    expect(outcome.sweep).toBeNull();
    expect(outcome.sweepSkipped).toBe("no_prompts");
    expect(engine.executeRun).not.toHaveBeenCalled();
  });

  it("refuses a URL it cannot make a host of", async () => {
    await expect(
      onboardFromUrl({
        supabase: fakeDb() as never,
        userId: "owner-1",
        meter: meter(),
        context: {},
        input: { url: "nope" },
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(scrapeDomain).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("the account an onboarded organization belongs to", () => {
  it("adopts an existing account by email", async () => {
    const db = fakeDb({ profiles: () => ({ data: { id: "user-9", email: "jo@acme.com" } }) });
    const account = await resolveOnboardingAccount(db as never, " Jo@Acme.com ");
    expect(account).toEqual({ userId: "user-9", email: "jo@acme.com", created: false });
    expect(db.auth.admin.createUser).not.toHaveBeenCalled();
    expect(db.queries[0].ops).toContainEqual(["eq", "email", "jo@acme.com"]);
  });

  it("creates the account when none exists, confirmed, with a profile row", async () => {
    const db = fakeDb({ profiles: (q) => (q.ops[0][0] === "select" ? { data: null } : {}) });
    db.auth.admin.createUser.mockResolvedValue({ data: { user: { id: "user-new" } }, error: null });
    const account = await resolveOnboardingAccount(db as never, "new@acme.com");
    expect(account).toEqual({ userId: "user-new", email: "new@acme.com", created: true });
    expect(db.auth.admin.createUser).toHaveBeenCalledWith({ email: "new@acme.com", email_confirm: true });
    const upsert = db.queries.find((q) => q.table === "profiles" && q.ops[0][0] === "upsert");
    expect(upsert?.ops[0]).toEqual(["upsert", { id: "user-new", email: "new@acme.com" }, { onConflict: "id", ignoreDuplicates: true }]);
  });

  it("rejects a malformed address before touching auth", async () => {
    const db = fakeDb();
    await expect(resolveOnboardingAccount(db as never, "not-an-email")).rejects.toMatchObject({ code: "invalid" });
    expect(db.queries).toHaveLength(0);
  });
});

describe("mintApiKey", () => {
  it("mints a hashed key and returns the plaintext once", async () => {
    const db = fakeDb({
      api_keys: (q) =>
        q.ops[0][0] === "select"
          ? { count: 2 }
          : { data: { id: "key-1", name: "Onboarding (acme.com)", key_hint: "lt_live_…text" } },
    });
    const minted = await mintApiKey(db as never, "user-9", "Onboarding (acme.com)");
    expect(minted).toEqual({
      ok: true,
      id: "key-1",
      name: "Onboarding (acme.com)",
      hint: "lt_live_…text",
      key: "lt_live_plaintext",
    });
    expect(inserted(db, "api_keys")[0]).toEqual({
      user_id: "user-9",
      name: "Onboarding (acme.com)",
      key_hash: "hash(lt_live_plaintext)",
      key_hint: "lt_live_…text",
    });
  });

  it("respects the same ceiling as Settings", async () => {
    const db = fakeDb({ api_keys: () => ({ count: 10 }) });
    const minted = await mintApiKey(db as never, "user-9", "x");
    expect(minted).toMatchObject({ ok: false, error: expect.stringMatching(/10 API keys/) });
    expect(inserted(db, "api_keys")).toHaveLength(0);
  });
});

describe("the two meters", () => {
  it("the session meter uses the self-scoped RPCs", async () => {
    const db = {} as never;
    const m = sessionTrialMeter(db);
    await m.consume();
    await m.recordUsage(5);
    await m.recordSpend(7);
    expect(trial.consumeTrialRun).toHaveBeenCalledWith(db);
    expect(trial.recordTrialUsage).toHaveBeenCalledWith(db, 5);
    expect(trial.recordTrialSpend).toHaveBeenCalledWith(db, 7);
  });

  it("the service meter addresses the owner by id", async () => {
    const db = {} as never;
    const m = serviceTrialMeter(db, "owner-1");
    await m.consume();
    await m.recordUsage(5);
    await m.recordSpend(7);
    expect(trial.consumeTrialRunFor).toHaveBeenCalledWith(db, "owner-1");
    expect(trial.recordTrialUsageFor).toHaveBeenCalledWith(db, "owner-1", 5);
    expect(trial.recordTrialSpendFor).toHaveBeenCalledWith(db, "owner-1", 7);
  });
});

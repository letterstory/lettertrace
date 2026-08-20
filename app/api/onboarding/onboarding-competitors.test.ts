import { describe, it, expect, vi, beforeEach } from "vitest";

// Unlike onboarding-route.test.ts — which stops at validation and mocks the
// database as a tripwire — this file lets the request through to a recording
// fake, because the bug being covered is a write that never happened.

const inserts: { table: string; values: unknown }[] = [];

const PROJECT = {
  id: "proj-1",
  user_id: "user-1",
  brand_name: "Acme",
  brand_domains: ["acme.com"],
  default_provider: "anthropic",
  default_model: "claude-sonnet-4-6",
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "a@b.co" } } }) },
    from: (table: string) => ({
      insert(values: unknown) {
        inserts.push({ table, values });
        const row = table === "projects" ? PROJECT : { id: `${table}-row` };
        return {
          select: () => ({ single: async () => ({ data: row, error: null }) }),
          // Batch inserts are awaited directly, with no .select() after them.
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
        };
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

vi.mock("@/lib/data", () => ({
  setActiveProject: vi.fn(),
  getProjects: vi.fn(async () => []),
  getConfiguredProviders: vi.fn(async () => []),
  getRouterKeysPublic: vi.fn(async () => []),
}));
vi.mock("@/lib/llm", () => ({ humanError: (e: unknown) => String(e) }));
vi.mock("@/lib/activity", () => ({ logDashboard: vi.fn() }));
vi.mock("@/lib/trial", () => ({
  pickDefaultProvider: vi.fn(() => "anthropic"),
  // No key: the route returns before executing a run, which is all we need.
  resolveRunKey: vi.fn(async () => ({
    source: "none",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    requested: { provider: "anthropic", model: "claude-sonnet-4-6" },
  })),
  engineKeyMessage: () => "add a key",
  recordTrialUsage: vi.fn(),
  recordTrialSpend: vi.fn(),
  consumeTrialRun: vi.fn(),
  resolveRunKeyFor: vi.fn(async () => ({
    source: "none",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    requested: { provider: "anthropic", model: "claude-sonnet-4-6" },
  })),
  runBudgetMicros: () => null,
  // No trial in these tests: zero usage, but zero covered engines too.
  getTrialUsage: vi.fn(async () => ({ runs: 0, spendMicros: 0 })),
  trialRunLimit: () => 15,
  trialCoveredProviders: () => [],
}));
vi.mock("@/lib/engine", () => ({ executeRun: vi.fn() }));

const { getConfiguredProviders, getRouterKeysPublic } = await import("@/lib/data");
const { pickDefaultProvider } = await import("@/lib/trial");
const { POST } = await import("@/app/api/onboarding/complete/route");

function req(body: unknown) {
  return new Request("http://localhost/api/onboarding/complete", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const BASE = {
  brand_name: "Acme",
  name: "Acme",
  brand_domains: ["acme.com"],
  topics: [{ name: "CDN", prompts: ["best cdn?"] }],
};

const competitorInserts = () =>
  inserts.filter((i) => i.table === "competitors").flatMap((i) => i.values as never[]);

beforeEach(() => {
  inserts.length = 0;
  vi.clearAllMocks();
});

describe("POST /api/onboarding/complete — competitors", () => {
  // The reported bug: onboarding collected nothing and saved nothing, so the
  // Competitors page was empty the moment setup finished.
  it("saves the competitors sent with onboarding", async () => {
    const res = await POST(
      req({
        ...BASE,
        competitors: [
          { name: "Asana", aliases: ["asana.com"], domain: "Asana.com" },
          { name: "Notion", aliases: [], domain: null },
        ],
      }),
    );
    expect(res.status).toBe(200);

    expect(competitorInserts()).toEqual([
      { project_id: "proj-1", name: "Asana", aliases: ["asana.com"], domain: "asana.com" },
      { project_id: "proj-1", name: "Notion", aliases: [], domain: null },
    ]);
  });

  // executeRun reads competitors to detect rival mentions, so they have to
  // exist before the first run or that run scores the brand alone.
  it("writes competitors before the topics the first run asks", async () => {
    await POST(req({ ...BASE, competitors: [{ name: "Asana" }] }));
    const tables = inserts.map((i) => i.table);
    expect(tables.indexOf("competitors")).toBeLessThan(tables.indexOf("topics"));
  });

  it("writes nothing when none are sent", async () => {
    const res = await POST(req(BASE));
    expect(res.status).toBe(200);
    expect(inserts.some((i) => i.table === "competitors")).toBe(false);
  });

  it("drops blank rows rather than failing the whole setup", async () => {
    await POST(req({ ...BASE, competitors: [{ name: "  " }, { name: "Asana" }] }));
    expect(competitorInserts().map((c: { name: string }) => c.name)).toEqual(["Asana"]);
  });

  // Both of these would hit the (project_id, name) unique index and abort the
  // batch, losing every competitor including the good ones.
  it("collapses duplicates that differ only by case", async () => {
    await POST(req({ ...BASE, competitors: [{ name: "Asana" }, { name: "asana" }] }));
    expect(competitorInserts()).toHaveLength(1);
  });

  it("refuses to track the brand as its own competitor", async () => {
    await POST(
      req({
        ...BASE,
        brand_aliases: ["Acme Corp"],
        competitors: [{ name: "Acme" }, { name: "acme corp" }, { name: "Asana" }],
      }),
    );
    expect(competitorInserts().map((c: { name: string }) => c.name)).toEqual(["Asana"]);
  });

  it("accepts aliases sent as a comma-separated string", async () => {
    await POST(req({ ...BASE, competitors: [{ name: "Monday", aliases: "monday.com, Monday" }] }));
    expect(competitorInserts()[0]).toMatchObject({ aliases: ["monday.com", "Monday"] });
  });

  it("ignores a competitors field that isn't a list", async () => {
    const res = await POST(req({ ...BASE, competitors: "Asana" }));
    expect(res.status).toBe(200);
    expect(inserts.some((i) => i.table === "competitors")).toBe(false);
  });
});

// LET-176, the same blindness one surface over: this route also PICKS an answer
// engine, and it picked it from direct keys alone.
describe("POST /api/onboarding/complete — the engine a new org starts on", () => {
  const projectInsert = () =>
    inserts.find((i) => i.table === "projects")?.values as { default_provider: string };

  it("starts on an engine a saved router covers, not the env default", async () => {
    // The reported setup: no provider keys, one gateway. Defaulting to the
    // operator's trial provider here created an org whose first run was refused
    // for a key the user had deliberately replaced with a router.
    vi.mocked(pickDefaultProvider).mockReturnValueOnce("google");
    vi.mocked(getRouterKeysPublic).mockResolvedValueOnce([
      { router: "openrouter", search_verified: ["anthropic"] },
    ] as never);

    await POST(req(BASE));
    expect(projectInsert().default_provider).toBe("anthropic");
  });

  it("still prefers a direct key over a router", async () => {
    vi.mocked(pickDefaultProvider).mockReturnValueOnce("google");
    vi.mocked(getConfiguredProviders).mockResolvedValueOnce(["openai"] as never);
    vi.mocked(getRouterKeysPublic).mockResolvedValueOnce([
      { router: "concentrate", search_verified: ["anthropic", "openai"] },
    ] as never);

    await POST(req(BASE));
    expect(projectInsert().default_provider).toBe("openai");
  });

  it("falls back to the env default when nothing covers anything", async () => {
    vi.mocked(pickDefaultProvider).mockReturnValueOnce("google");
    await POST(req(BASE));
    expect(projectInsert().default_provider).toBe("google");
  });
});

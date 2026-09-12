import { describe, it, expect, vi, beforeEach } from "vitest";

// Same recording-fake pattern as onboarding-competitors.test.ts: these cases
// need to see what actually reaches the projects insert, which the throwing
// mock in onboarding-route.test.ts deliberately can't provide (400s there
// return before ever calling .from()). Rejection cases stay in that file;
// only "does the resolved value reach the insert" cases live here.

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
  getTrialUsage: vi.fn(async () => ({ runs: 0, spendMicros: 0 })),
  trialRunLimit: () => 15,
  trialCoveredProviders: () => [],
}));
vi.mock("@/lib/engine", () => ({ executeRun: vi.fn() }));

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

const projectInsert = () =>
  inserts.find((i) => i.table === "projects")?.values as {
    schedule: string;
    schedule_interval_days: number | null;
  };

beforeEach(() => {
  inserts.length = 0;
  vi.clearAllMocks();
});

describe("POST /api/onboarding/complete — cadence reaches the project insert", () => {
  it("stores a named schedule with no interval", async () => {
    for (const schedule of ["daily", "weekly"]) {
      inserts.length = 0;
      const res = await POST(req({ ...BASE, schedule }));
      expect(res.status).toBe(200);
      expect(projectInsert()).toMatchObject({ schedule, schedule_interval_days: null });
    }
  });

  // The toggle off is a schedule of its own, not a missing field — an
  // unscheduled project still has to be created.
  it("stores 'off' when the toggle is switched off", async () => {
    const res = await POST(req({ ...BASE, schedule: "off", intervalDays: null }));
    expect(res.status).toBe(200);
    expect(projectInsert()).toMatchObject({ schedule: "off", schedule_interval_days: null });
  });

  it("stores a custom schedule together with its interval", async () => {
    const res = await POST(req({ ...BASE, schedule: "custom", intervalDays: 14 }));
    expect(res.status).toBe(200);
    expect(projectInsert()).toMatchObject({
      schedule: "custom",
      schedule_interval_days: 14,
    });
  });

  // The onboarding CTA always sends a schedule, but any older client doesn't —
  // absent must still land on the schedule this route used to hard-code rather
  // than reject the whole signup.
  it("defaults to daily when no schedule is sent", async () => {
    const res = await POST(req(BASE));
    expect(res.status).toBe(200);
    expect(projectInsert()).toMatchObject({
      schedule: "daily",
      schedule_interval_days: null,
    });
  });
});

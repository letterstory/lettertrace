import { describe, it, expect, vi, beforeEach } from "vitest";

// The first measurement is a sweep across every engine the account can fund,
// and one engine can store nothing (a spent provider quota is the usual cause)
// while the others answer in full. This route used to keep only the engines
// that came back and drop the rest on the floor, so setup finished with no way
// for the caller to say which column of the new project was empty, or why.

const PROJECT = {
  id: "proj-1",
  user_id: "user-1",
  brand_name: "Acme",
  brand_domains: ["acme.com"],
  default_provider: "google",
  default_model: "gemini-pro-latest",
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "a@b.co" } } }) },
    from: (table: string) => ({
      insert() {
        const row = table === "projects" ? PROJECT : { id: `${table}-row` };
        return {
          select: () => ({ single: async () => ({ data: row, error: null }) }),
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
vi.mock("@/lib/llm", () => ({ humanError: (e: unknown) => `human: ${String(e)}` }));
vi.mock("@/lib/activity", () => ({ logDashboard: vi.fn() }));
vi.mock("@/lib/trial", () => ({
  pickDefaultProvider: () => "google",
  resolveRunKey: vi.fn(),
  engineKeyMessage: () => "add a key",
  recordTrialUsage: vi.fn(),
  recordTrialSpend: vi.fn(),
  consumeTrialRun: vi.fn(async () => true),
  runBudgetMicros: () => null,
  getTrialUsage: vi.fn(async () => ({ runs: 0, spendMicros: 0 })),
  trialRunLimit: () => 15,
  // The sweep: both engines funded by the trial allowance.
  trialCoveredProviders: () => ["google", "openai"],
  resolveRunKeyFor: vi.fn(async (_s: unknown, _u: string, provider: string, model: string) => ({
    source: "trial",
    provider,
    model,
    apiKey: "k",
    route: "direct",
    requested: { provider, model },
  })),
}));
vi.mock("@/lib/engine", () => ({ executeRun: vi.fn() }));

const { executeRun } = await import("@/lib/engine");
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

const QUOTA = "Google rejected the request: this key's quota is used up.";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/onboarding/complete — engines that answered nothing", () => {
  it("reports the empty engine and its reason alongside the one that answered", async () => {
    vi.mocked(executeRun).mockImplementation((async ({ provider }: { provider: string }) =>
      provider === "google"
        ? {
            runId: "run-google",
            status: "failed",
            totalResponses: 0,
            tokensUsed: 0,
            spendMicros: 0,
            error: QUOTA,
          }
        : {
            runId: "run-openai",
            status: "completed",
            totalResponses: 22,
            tokensUsed: 10,
            spendMicros: 5,
          }) as never);

    const res = await POST(req(BASE));
    const body = (await res.json()) as {
      ran: boolean;
      runs: { provider: string; status: string; error: string | null }[];
    };

    expect(res.status).toBe(200);
    expect(body.ran).toBe(true);
    const google = body.runs.find((r) => r.provider === "google");
    expect(google?.status).toBe("failed");
    expect(google?.error).toBe(QUOTA);
    expect(body.runs.find((r) => r.provider === "openai")?.status).toBe("completed");
  });

  it("keeps an engine that threw before it could write a run", async () => {
    vi.mocked(executeRun).mockImplementation((async ({ provider }: { provider: string }) => {
      if (provider === "google") throw new Error("quota");
      return {
        runId: "run-openai",
        status: "completed",
        totalResponses: 22,
        tokensUsed: 10,
        spendMicros: 5,
      };
    }) as never);

    const res = await POST(req(BASE));
    const body = (await res.json()) as {
      ran: boolean;
      runId: string;
      runs: { provider: string; status: string; error: string | null }[];
    };

    expect(body.ran).toBe(true);
    // The response still points at a run that exists, not at the engine that threw.
    expect(body.runId).toBe("run-openai");
    expect(body.runs).toHaveLength(2);
    expect(body.runs.find((r) => r.provider === "google")).toMatchObject({
      status: "failed",
      error: "human: Error: quota",
    });
  });
});

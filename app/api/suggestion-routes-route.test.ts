import { describe, it, expect, vi, beforeEach } from "vitest";

// The three sibling suggestion routes share the onboarding suggest route's
// bug: each resolved a key through resolveKey — which, for the Concentrate-
// funded free tier, is a ROUTER key plus a `route` saying which gateway to
// call — and then handed the model call the key alone. A router key sent
// straight to the provider is an invalid key, so every trial user's
// re-analyze, competitor suggestion and question generation failed while
// anyone holding their own key was fine. These pin that the route travels.

const PROJECT = {
  id: "proj-1",
  user_id: "user-1",
  name: "Acme",
  brand_name: "Acme",
  brand_aliases: [],
  brand_domains: ["acme.com"],
  description: "Payments for the internet",
  default_provider: "anthropic",
  default_model: "claude-sonnet-4-6",
};

const ROUTED_TRIAL_KEY = {
  source: "trial",
  apiKey: "sk-cn-operator",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  route: { router: "concentrate", baseUrl: null },
};

// A query builder that answers every table read with an empty list (no tracked
// topics or competitors) except the one row the topics route looks up, and
// records inserts so generated prompts come back as if saved.
const TOPIC = { id: "topic-1", project_id: "proj-1", name: "Payments", description: null };
function fakeSupabase() {
  const build = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "insert"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: table === "topics" ? TOPIC : null });
    b.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: table === "prompts" ? [{ id: "p1" }] : [], error: null }).then(ok);
    return b;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "a@b.com" } } }) },
    from: (table: string) => build(table),
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: () => fakeSupabase() }));
vi.mock("@/lib/data", () => ({ getProject: vi.fn(async () => PROJECT) }));
vi.mock("@/lib/scrape", () => ({
  scrapeDomain: vi.fn(async () => ({ ok: true, text: "Acme builds payment infrastructure." })),
}));
const resolveKey = vi.fn();
vi.mock("@/lib/trial", () => ({
  resolveKey: (...a: unknown[]) => resolveKey(...a),
  recordTrialUsage: vi.fn(),
  recordTrialSpend: vi.fn(),
}));
vi.mock("@/lib/pricing", () => ({ spendMicros: () => 0 }));
vi.mock("@/lib/activity", () => ({ logDashboard: vi.fn() }));
const suggestFromSite = vi.fn();
const suggestCompetitors = vi.fn();
const generateVariations = vi.fn();
vi.mock("@/lib/llm", () => ({
  suggestFromSite: (o: unknown) => suggestFromSite(o),
  suggestCompetitors: (o: unknown) => suggestCompetitors(o),
  generateVariations: (o: unknown) => generateVariations(o),
  humanError: (e: unknown) => String(e),
}));

const reanalyze = await import("@/app/api/project/reanalyze/route");
const competitors = await import("@/app/api/competitors/suggest/route");
const generate = await import("@/app/api/topics/[id]/generate/route");

const req = (path: string, body: unknown = {}) =>
  new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) });

const routed = expect.objectContaining({
  apiKey: "sk-cn-operator",
  model: "claude-haiku-4-5",
  route: { router: "concentrate", baseUrl: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveKey.mockResolvedValue(ROUTED_TRIAL_KEY);
  suggestFromSite.mockResolvedValue({ description: "d", topics: [{ name: "Fraud", prompts: ["q"] }], competitors: [], tokens: 10 });
  suggestCompetitors.mockResolvedValue({ suggestions: [{ name: "Adyen", aliases: [], domain: "adyen.com" }], tokens: 10 });
  generateVariations.mockResolvedValue({ variations: [{ text: "best payments api?", specificity: "general" }], tokens: 10 });
});

describe("suggestion routes hand the resolved route to the model call", () => {
  it("POST /api/project/reanalyze", async () => {
    const res = await reanalyze.POST(req("/api/project/reanalyze"));
    expect(res.status).toBe(200);
    expect(suggestFromSite).toHaveBeenCalledWith(routed);
  });

  it("POST /api/competitors/suggest", async () => {
    const res = await competitors.POST(req("/api/competitors/suggest"));
    expect(res.status).toBe(200);
    expect(suggestCompetitors).toHaveBeenCalledWith(routed);
  });

  it("POST /api/topics/:id/generate", async () => {
    const res = await generate.POST(req("/api/topics/topic-1/generate", { count: 3 }), {
      params: { id: "topic-1" },
    });
    expect(res.status).toBe(200);
    expect(generateVariations).toHaveBeenCalledWith(routed);
  });

  it("passes no route for a direct key", async () => {
    resolveKey.mockResolvedValue({ source: "own", apiKey: "sk-ant", provider: "anthropic", model: "claude-sonnet-4-6" });
    await competitors.POST(req("/api/competitors/suggest"));
    expect((suggestCompetitors.mock.calls[0][0] as { route?: unknown }).route).toBeUndefined();
  });
});

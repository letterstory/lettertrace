import { describe, it, expect, vi, beforeEach } from "vitest";

// The route pulls in the Supabase server client (next/headers) and the trial
// layer; we only care about the request validation that runs before any of it.
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => {
      throw new Error("validation should reject before touching the database");
    },
  }),
}));
// lib/data uses React's cache(), which only exists in a server-component
// runtime — same treatment the v1 route tests give it.
vi.mock("@/lib/data", () => ({
  setActiveProject: vi.fn(),
  getProjects: vi.fn(async () => []),
  getConfiguredProviders: vi.fn(async () => []),
}));
vi.mock("@/lib/llm", () => ({ humanError: (e: unknown) => String(e) }));
vi.mock("@/lib/trial", () => ({
  pickDefaultProvider: () => "anthropic",
  resolveRunKey: vi.fn(),
  recordTrialUsage: vi.fn(),
  consumeTrialRun: vi.fn(),
}));
vi.mock("@/lib/engine", () => ({ executeRun: vi.fn() }));

const { getConfiguredProviders } = await import("@/lib/data");
const { POST } = await import("@/app/api/onboarding/complete/route");

function req(body: unknown) {
  return new Request("http://localhost/api/onboarding/complete", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const BASE = { brand_name: "Acme", name: "Acme", brand_domains: ["acme.com"] };

beforeEach(() => vi.clearAllMocks());

describe("POST /api/onboarding/complete — topic validation", () => {
  // The reported bug: both of these used to be silently dropped, the request
  // succeeded, and the user's remaining topics were quietly not saved.
  it("rejects a topic with questions but no name", async () => {
    const res = await POST(
      req({ ...BASE, topics: [{ name: "", prompts: ["what is an ai native erp?"] }] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/needs a name/);
    expect(body.incompleteTopics).toEqual([0]);
  });

  it("rejects a topic with a name but no questions", async () => {
    const res = await POST(req({ ...BASE, topics: [{ name: "tbd", prompts: [] }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/needs at least one question/);
  });

  it("rejects a topic whose only question is blank", async () => {
    const res = await POST(req({ ...BASE, topics: [{ name: "CDN", prompts: ["   "] }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/needs at least one question/);
  });

  it("does not let one good topic mask a bad one", async () => {
    const res = await POST(
      req({
        ...BASE,
        topics: [
          { name: "CDN", prompts: ["best cdn?"] },
          { name: "", prompts: ["what is an ai native erp?"] },
          { name: "tbd", prompts: [] },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).incompleteTopics).toEqual([1, 2]);
  });

  // Explicitly allowed: an unused blank question row alongside a real one.
  // Reaching the database mock (which throws by design) is the proof that
  // validation let this through rather than rejecting it.
  it("accepts a topic with a filled question plus an empty input", async () => {
    await expect(
      POST(req({ ...BASE, topics: [{ name: "CDN", prompts: ["best cdn?", "  "] }] })),
    ).rejects.toThrow("validation should reject before touching the database");
  });

  it("still requires a brand name", async () => {
    const res = await POST(req({ topics: [{ name: "CDN", prompts: ["best cdn?"] }] }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/onboarding/complete, creating more organizations", () => {
  const good = { ...BASE, topics: [{ name: "CDN", prompts: ["best cdn?"] }] };

  // A second org used to be refused without the user's own key. The free-run
  // allowance is counted per ACCOUNT (consume_trial_run), not per org, so extra
  // orgs can't spend more of it — the gate only stopped people setting up the
  // brands they wanted to monitor before deciding to bring a key.
  // Reaching the database mock, which throws by design, proves it got through.
  it("lets a keyless account create a second org", async () => {
    vi.mocked(getConfiguredProviders).mockResolvedValue([]);
    await expect(POST(req(good))).rejects.toThrow(/before touching the database/);
  });

  it("lets an account with a key create another org", async () => {
    vi.mocked(getConfiguredProviders).mockResolvedValue(["anthropic"]);
    await expect(POST(req(good))).rejects.toThrow(/before touching the database/);
  });

  it("still allows the very first org, key or not", async () => {
    vi.mocked(getConfiguredProviders).mockResolvedValue([]);
    await expect(POST(req(good))).rejects.toThrow(/before touching the database/);
  });

  // Topic validation is the only thing that should reject the request now.
  it("still validates topics for a keyless account", async () => {
    vi.mocked(getConfiguredProviders).mockResolvedValue([]);
    const res = await POST(req({ ...BASE, topics: [{ name: "", prompts: [] }] }));
    expect(res.status).toBe(400);
  });
});

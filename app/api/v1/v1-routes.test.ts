import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateApiKey } from "@/lib/api-auth";
import { getProjects } from "@/lib/data";
import {
  createProject,
  createPrompts,
  getProjectHistory,
  getRunReport,
  getRunResponses,
  listProjectPrompts,
  listRuns,
  setPromptActive,
  triggerRunForProject,
} from "@/lib/api-service";
import {
  GET as getProjectsRoute,
  POST as postProjectRoute,
} from "@/app/api/v1/projects/route";
import {
  GET as getRunsRoute,
  POST as postRunRoute,
} from "@/app/api/v1/projects/[id]/runs/route";
import {
  GET as getPromptsRoute,
  POST as postPromptsRoute,
} from "@/app/api/v1/projects/[id]/prompts/route";
import { PATCH as patchPromptRoute } from "@/app/api/v1/prompts/[id]/route";
import { GET as getReportRoute } from "@/app/api/v1/runs/[id]/route";
import { GET as getHistoryRoute } from "@/app/api/v1/projects/[id]/history/route";
import { GET as getResponsesRoute } from "@/app/api/v1/runs/[id]/responses/route";

vi.mock("@/lib/api-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-auth")>()),
  authenticateApiKey: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getProjects: vi.fn() }));
vi.mock("@/lib/api-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-service")>()),
  createProject: vi.fn(),
  createPrompts: vi.fn(),
  listProjectPrompts: vi.fn(),
  listRuns: vi.fn(),
  getProjectHistory: vi.fn(),
  getRunReport: vi.fn(),
  getRunResponses: vi.fn(),
  setPromptActive: vi.fn(),
  triggerRunForProject: vi.fn(),
}));

const AUTH_CTX = {
  supabase: {} as never,
  userId: "user-1",
  keyId: "key-1",
  tokenType: "api_key" as const,
  scopes: ["projects:read", "projects:write", "runs:read", "runs:trigger"],
  clientId: null,
  expiresAt: null,
  aud: null,
};

// Run attribution the routes derive from AUTH_CTX (a classic key, REST surface)
// and forward to triggerRunForProject so the run shows up in the activity feed.
const RUN_CTX = {
  actorType: "api_key",
  actorId: "key-1",
  actorLabel: "API key",
  channel: "api",
};

function req(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, {
    headers: { authorization: "Bearer lt_live_test" },
    ...init,
  });
}

beforeEach(() => {
  vi.mocked(authenticateApiKey).mockReset().mockResolvedValue(AUTH_CTX);
  vi.mocked(getProjects).mockReset();
  vi.mocked(createProject).mockReset();
  vi.mocked(createPrompts).mockReset();
  vi.mocked(listProjectPrompts).mockReset();
  vi.mocked(listRuns).mockReset();
  vi.mocked(getProjectHistory).mockReset();
  vi.mocked(getRunReport).mockReset();
  vi.mocked(getRunResponses).mockReset();
  vi.mocked(setPromptActive).mockReset();
  vi.mocked(triggerRunForProject).mockReset();
});

describe("GET /api/v1/projects", () => {
  it("401s without a valid key", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    const res = await getProjectsRoute(new Request("http://localhost/api/v1/projects"));
    expect(res.status).toBe(401);
  });

  it("returns the caller's projects, trimmed", async () => {
    vi.mocked(getProjects).mockResolvedValue([
      { id: "p1", user_id: "user-1", name: "Credal", brand_name: "Credal" } as never,
    ]);
    const res = await getProjectsRoute(req("/api/v1/projects"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).not.toHaveProperty("user_id");
    expect(getProjects).toHaveBeenCalledWith(AUTH_CTX.supabase, "user-1");
  });
});

describe("POST /api/v1/projects", () => {
  it("400s without a JSON body", async () => {
    const res = await postProjectRoute(req("/api/v1/projects", { method: "POST" }));
    expect(res.status).toBe(400);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("400s when the op rejects the input", async () => {
    vi.mocked(createProject).mockResolvedValue({
      ok: false,
      code: "invalid",
      message: "A brand name is required.",
    });
    const res = await postProjectRoute(
      req("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Acme" }) }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("A brand name is required.");
  });

  it("201s with the trimmed project summary", async () => {
    vi.mocked(createProject).mockResolvedValue({
      ok: true,
      project: { id: "p1", user_id: "user-1", name: "Acme", brand_name: "Acme" } as never,
    });
    const res = await postProjectRoute(
      req("/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Acme", brand_name: "Acme" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project).toMatchObject({ id: "p1", name: "Acme" });
    expect(body.project).not.toHaveProperty("user_id");
    expect(createProject).toHaveBeenCalledWith(AUTH_CTX.supabase, "user-1", {
      name: "Acme",
      brand_name: "Acme",
    });
  });
});

describe("GET /api/v1/projects/:id/prompts", () => {
  it("404s for a project that isn't the caller's", async () => {
    vi.mocked(listProjectPrompts).mockResolvedValue(null);
    const res = await getPromptsRoute(req("/api/v1/projects/p1/prompts"), {
      params: { id: "p1" },
    });
    expect(res.status).toBe(404);
  });

  it("returns the prompts with topic names", async () => {
    vi.mocked(listProjectPrompts).mockResolvedValue([
      {
        id: "prompt-1",
        text: "best crm",
        topic: "CRM",
        source: "manual",
        is_active: true,
        created_at: "2026-07-02T00:00:00Z",
      },
    ]);
    const res = await getPromptsRoute(req("/api/v1/projects/p1/prompts"), {
      params: { id: "p1" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).prompts[0].topic).toBe("CRM");
  });
});

describe("POST /api/v1/projects/:id/prompts", () => {
  it("maps not_found/invalid to 404/400", async () => {
    vi.mocked(createPrompts).mockResolvedValue({
      ok: false,
      code: "not_found",
      message: "Project not found.",
    });
    let res = await postPromptsRoute(
      req("/api/v1/projects/p1/prompts", {
        method: "POST",
        body: JSON.stringify({ prompts: [{ text: "x", topic: "T" }] }),
      }),
      { params: { id: "p1" } },
    );
    expect(res.status).toBe(404);

    vi.mocked(createPrompts).mockResolvedValue({
      ok: false,
      code: "invalid",
      message: "bad entry",
    });
    res = await postPromptsRoute(
      req("/api/v1/projects/p1/prompts", {
        method: "POST",
        body: JSON.stringify({ prompts: [{ text: "" }] }),
      }),
      { params: { id: "p1" } },
    );
    expect(res.status).toBe(400);
  });

  it("201s with the created prompts and skip count", async () => {
    vi.mocked(createPrompts).mockResolvedValue({
      ok: true,
      created: [
        {
          id: "prompt-1",
          text: "best crm",
          topic: "CRM",
          source: "manual",
          is_active: true,
          created_at: "2026-07-02T00:00:00Z",
        },
      ],
      skipped: 1,
    });
    const res = await postPromptsRoute(
      req("/api/v1/projects/p1/prompts", {
        method: "POST",
        body: JSON.stringify({ prompts: [{ text: "best crm", topic: "CRM" }] }),
      }),
      { params: { id: "p1" } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toHaveLength(1);
    expect(body.skipped).toBe(1);
    expect(createPrompts).toHaveBeenCalledWith(AUTH_CTX.supabase, "user-1", "p1", [
      { text: "best crm", topic: "CRM" },
    ]);
  });
});

describe("PATCH /api/v1/prompts/:id", () => {
  it("400s when is_active isn't a boolean", async () => {
    const res = await patchPromptRoute(
      req("/api/v1/prompts/prompt-1", {
        method: "PATCH",
        body: JSON.stringify({ is_active: "yes" }),
      }),
      { params: { id: "prompt-1" } },
    );
    expect(res.status).toBe(400);
    expect(setPromptActive).not.toHaveBeenCalled();
  });

  it("404s for a prompt that isn't the caller's", async () => {
    vi.mocked(setPromptActive).mockResolvedValue(null);
    const res = await patchPromptRoute(
      req("/api/v1/prompts/prompt-1", {
        method: "PATCH",
        body: JSON.stringify({ is_active: false }),
      }),
      { params: { id: "prompt-1" } },
    );
    expect(res.status).toBe(404);
  });

  it("returns the updated prompt", async () => {
    vi.mocked(setPromptActive).mockResolvedValue({
      id: "prompt-1",
      text: "best crm",
      topic: "CRM",
      source: "manual",
      is_active: false,
      created_at: "2026-07-02T00:00:00Z",
    });
    const res = await patchPromptRoute(
      req("/api/v1/prompts/prompt-1", {
        method: "PATCH",
        body: JSON.stringify({ is_active: false }),
      }),
      { params: { id: "prompt-1" } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).prompt.is_active).toBe(false);
    expect(setPromptActive).toHaveBeenCalledWith(
      AUTH_CTX.supabase,
      "user-1",
      "prompt-1",
      false,
    );
  });
});

describe("GET /api/v1/projects/:id/runs", () => {
  it("404s for a project that isn't the caller's", async () => {
    vi.mocked(listRuns).mockResolvedValue(null);
    const res = await getRunsRoute(req("/api/v1/projects/p1/runs"), {
      params: { id: "p1" },
    });
    expect(res.status).toBe(404);
  });

  it("passes the ?limit param through", async () => {
    vi.mocked(listRuns).mockResolvedValue([]);
    const res = await getRunsRoute(req("/api/v1/projects/p1/runs?limit=5"), {
      params: { id: "p1" },
    });
    expect(res.status).toBe(200);
    expect(listRuns).toHaveBeenCalledWith(AUTH_CTX.supabase, "user-1", "p1", 5);
  });
});

describe("POST /api/v1/projects/:id/runs", () => {
  it("402s when the account has no key of its own", async () => {
    vi.mocked(triggerRunForProject).mockResolvedValue({
      ok: false,
      code: "no_key",
      message: "needs a key",
    });
    const res = await postRunRoute(
      req("/api/v1/projects/p1/runs", { method: "POST" }),
      { params: { id: "p1" } },
    );
    expect(res.status).toBe(402);
  });

  it("returns the run result on success", async () => {
    vi.mocked(triggerRunForProject).mockResolvedValue({
      ok: true,
      result: { runId: "r1", status: "completed", totalResponses: 3, tokensUsed: 10 },
    });
    const res = await postRunRoute(
      req("/api/v1/projects/p1/runs", { method: "POST" }),
      { params: { id: "p1" } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).runId).toBe("r1");
    // No body -> no overrides, but the run is still attributed to this caller
    // (channel api / classic key) so it lands in the activity feed.
    expect(triggerRunForProject).toHaveBeenCalledWith(
      AUTH_CTX.supabase,
      "user-1",
      "p1",
      { context: RUN_CTX },
    );
  });

  it("400s on an unknown provider override", async () => {
    const res = await postRunRoute(
      req("/api/v1/projects/p1/runs", {
        method: "POST",
        body: JSON.stringify({ provider: "mistral" }),
      }),
      { params: { id: "p1" } },
    );
    expect(res.status).toBe(400);
    expect(triggerRunForProject).not.toHaveBeenCalled();
  });

  it("passes a google provider override through", async () => {
    vi.mocked(triggerRunForProject).mockResolvedValue({
      ok: true,
      result: { runId: "r3", status: "completed", totalResponses: 3, tokensUsed: 10 },
    });
    const res = await postRunRoute(
      req("/api/v1/projects/p1/runs", {
        method: "POST",
        body: JSON.stringify({ provider: "google", model: "google-ai-overviews" }),
      }),
      { params: { id: "p1" } },
    );
    expect(res.status).toBe(200);
    // Overrides ride alongside the caller attribution master's activity log adds.
    expect(triggerRunForProject).toHaveBeenCalledWith(AUTH_CTX.supabase, "user-1", "p1", {
      provider: "google",
      model: "google-ai-overviews",
      context: RUN_CTX,
    });
  });

  it("passes a provider/model override through", async () => {
    vi.mocked(triggerRunForProject).mockResolvedValue({
      ok: true,
      result: { runId: "r2", status: "completed", totalResponses: 3, tokensUsed: 10 },
    });
    const res = await postRunRoute(
      req("/api/v1/projects/p1/runs", {
        method: "POST",
        body: JSON.stringify({ provider: "openai", model: "gpt-4o-mini" }),
      }),
      { params: { id: "p1" } },
    );
    expect(res.status).toBe(200);
    expect(triggerRunForProject).toHaveBeenCalledWith(AUTH_CTX.supabase, "user-1", "p1", {
      provider: "openai",
      model: "gpt-4o-mini",
      context: RUN_CTX,
    });
  });
});

describe("GET /api/v1/runs/:id", () => {
  it("404s for an unknown or unowned run", async () => {
    vi.mocked(getRunReport).mockResolvedValue(null);
    const res = await getReportRoute(req("/api/v1/runs/r1"), { params: { id: "r1" } });
    expect(res.status).toBe(404);
  });

  it("returns the report", async () => {
    vi.mocked(getRunReport).mockResolvedValue({
      run: { id: "r1" } as never,
      totalResponses: 2,
      summary: {
        brandMentionRate: 0.5,
        brandMentionRateInterval: { low: 0.09, high: 0.91 },
        brandResponsesMentioned: 1,
        totalResponses: 2,
        brandShareOfVoice: 0.25,
        brandSentimentScore: 1,
        brandAvgProminence: 0.9,
      },
      entities: [],
      citations: {
        responsesWithOwnedSource: 1,
        totalResponses: 2,
        ownedCitationRate: 0.5,
        ownedCitationRateInterval: { low: 0.09, high: 0.91 },
        distinctOwnedUrls: 1,
        totalSources: 3,
      },
      quality: {
        totalResponses: 2,
        responsesNamingSomeone: 2,
        responsesNamingNobody: 0,
        informativeRate: 1,
      },
      topics: [],
    });
    const res = await getReportRoute(req("/api/v1/runs/r1"), { params: { id: "r1" } });
    expect(res.status).toBe(200);
    expect((await res.json()).summary.brandShareOfVoice).toBe(0.25);
  });
});

describe("GET /api/v1/runs/:id/responses", () => {
  it("404s for an unknown or unowned run", async () => {
    vi.mocked(getRunResponses).mockResolvedValue(null);
    const res = await getResponsesRoute(req("/api/v1/runs/r1/responses"), {
      params: { id: "r1" },
    });
    expect(res.status).toBe(404);
  });

  it("returns the raw artifacts", async () => {
    vi.mocked(getRunResponses).mockResolvedValue({
      run: { id: "r1" } as never,
      responses: [
        {
          id: "resp-1",
          prompt_id: "prompt-1",
          prompt_text: "best crm",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          response_text: "Credal is…",
          sources: [
            {
              url: "https://credal.ai/blog",
              domain: "credal.ai",
              title: null,
              snippet: null,
              is_owned: true,
            },
          ],
          mentions: [],
        },
      ],
    });
    const res = await getResponsesRoute(req("/api/v1/runs/r1/responses"), {
      params: { id: "r1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.responses[0].sources[0].url).toBe("https://credal.ai/blog");
    expect(getRunResponses).toHaveBeenCalledWith(AUTH_CTX.supabase, "user-1", "r1");
  });
});

describe("GET /api/v1/projects/:id/history", () => {
  const point = (over: Record<string, unknown> = {}) => ({
    runId: "r1",
    createdAt: "2026-07-01T00:00:00Z",
    provider: "anthropic" as const,
    model: "claude-opus-4-8",
    totalResponses: 10,
    brandResponsesMentioned: 0,
    brandMentionRate: 0,
    brandMentionRateInterval: { low: 0, high: 0.28 },
    ownedCitationRate: 0,
    informativeRate: 0.9,
    ...over,
  });

  it("401s without a valid key", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    const res = await getHistoryRoute(req("/api/v1/projects/p1/history"), {
      params: { id: "p1" },
    });
    expect(res.status).toBe(401);
    expect(getProjectHistory).not.toHaveBeenCalled();
  });

  it("404s for a project that isn't the caller's", async () => {
    vi.mocked(getProjectHistory).mockResolvedValue(null);
    const res = await getHistoryRoute(req("/api/v1/projects/p1/history"), {
      params: { id: "p1" },
    });
    expect(res.status).toBe(404);
  });

  it("400s on a nonsense limit rather than silently defaulting", async () => {
    const res = await getHistoryRoute(req("/api/v1/projects/p1/history?limit=-3"), {
      params: { id: "p1" },
    });
    expect(res.status).toBe(400);
    expect(getProjectHistory).not.toHaveBeenCalled();
  });

  it("reports never-mentioned as a real state, not an empty one", async () => {
    vi.mocked(getProjectHistory).mockResolvedValue({
      projectId: "p1",
      brandName: "Acme",
      points: [point(), point({ runId: "r2" })],
      firstMentionAt: null,
      everMentioned: false,
    });
    const res = await getHistoryRoute(req("/api/v1/projects/p1/history"), {
      params: { id: "p1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.everMentioned).toBe(false);
    expect(body.firstMentionAt).toBeNull();
    expect(body.points).toHaveLength(2);
    // The interval is what makes a zero readable — it must survive the wire.
    expect(body.points[0].brandMentionRateInterval.high).toBeCloseTo(0.28);
  });

  it("surfaces when the first mention landed", async () => {
    vi.mocked(getProjectHistory).mockResolvedValue({
      projectId: "p1",
      brandName: "Acme",
      points: [
        point(),
        point({ runId: "r2", createdAt: "2026-07-08T00:00:00Z", brandResponsesMentioned: 2, brandMentionRate: 0.2 }),
      ],
      firstMentionAt: "2026-07-08T00:00:00Z",
      everMentioned: true,
    });
    const res = await getHistoryRoute(req("/api/v1/projects/p1/history?limit=5"), {
      params: { id: "p1" },
    });
    const body = await res.json();
    expect(body.everMentioned).toBe(true);
    expect(body.firstMentionAt).toBe("2026-07-08T00:00:00Z");
    expect(getProjectHistory).toHaveBeenCalledWith(AUTH_CTX.supabase, "user-1", "p1", 5);
  });
});

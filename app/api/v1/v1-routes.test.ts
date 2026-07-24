import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateApiKey } from "@/lib/api-auth";
import { getProjects } from "@/lib/data";
import {
  getRunReport,
  listRuns,
  triggerRunForProject,
} from "@/lib/api-service";
import { GET as getProjectsRoute } from "@/app/api/v1/projects/route";
import {
  GET as getRunsRoute,
  POST as postRunRoute,
} from "@/app/api/v1/projects/[id]/runs/route";
import { GET as getReportRoute } from "@/app/api/v1/runs/[id]/route";

vi.mock("@/lib/api-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-auth")>()),
  authenticateApiKey: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getProjects: vi.fn() }));
vi.mock("@/lib/api-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-service")>()),
  listRuns: vi.fn(),
  getRunReport: vi.fn(),
  triggerRunForProject: vi.fn(),
}));

const AUTH_CTX = { supabase: {} as never, userId: "user-1", keyId: "key-1" };

function req(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, {
    headers: { authorization: "Bearer lt_live_test" },
    ...init,
  });
}

beforeEach(() => {
  vi.mocked(authenticateApiKey).mockReset().mockResolvedValue(AUTH_CTX);
  vi.mocked(getProjects).mockReset();
  vi.mocked(listRuns).mockReset();
  vi.mocked(getRunReport).mockReset();
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
        brandShareOfVoice: 0.25,
        brandSentimentScore: 1,
        brandAvgProminence: 0.9,
      },
      entities: [],
    });
    const res = await getReportRoute(req("/api/v1/runs/r1"), { params: { id: "r1" } });
    expect(res.status).toBe(200);
    expect((await res.json()).summary.brandShareOfVoice).toBe(0.25);
  });
});

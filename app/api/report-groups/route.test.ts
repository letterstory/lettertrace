import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  activePrompts: 3 as number | null,
  /** Per-provider key source the run resolver will report. */
  sources: {} as Record<string, string>,
  inserted: [] as { project_id: string; requested_providers: string[] }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "owner-1" } } }) },
    from: () => ({
      select: () => {
        const chain = {
          eq: () => chain,
          then: (resolve: (value: unknown) => void) =>
            resolve({ count: state.activePrompts, error: null }),
        };
        return chain;
      },
    }),
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({
      insert: (row: { project_id: string; requested_providers: string[] }) => {
        state.inserted.push(row);
        return {
          select: () => ({ single: async () => ({ data: { id: "group-1" }, error: null }) }),
        };
      },
    }),
  }),
}));
vi.mock("@/lib/data", () => ({
  getProject: async () => ({
    id: "project-1", user_id: "owner-1", use_web_search: true,
  }),
}));
vi.mock("@/lib/trial", () => ({
  resolveRunKeyFor: async (_db: unknown, _user: string, provider: string) => ({
    source: state.sources[provider] ?? "own",
    apiKey: (state.sources[provider] ?? "own") === "none" ? null : "sk-test",
    provider,
    model: "m",
  }),
  engineKeyMessage: (key: { source: string }) =>
    `No key saved for this engine (${key.source}). Add one in Settings.`,
}));

import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/report-groups", {
    method: "POST", body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.activePrompts = 3;
  state.sources = {};
  state.inserted.length = 0;
});

describe("opening a report batch", () => {
  it("opens one for the requested engines", async () => {
    const res = await POST(request({ providers: ["anthropic", "openai"] }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ groupId: "group-1" });
    expect(state.inserted).toEqual([
      { project_id: "project-1", requested_providers: ["anthropic", "openai"] },
    ]);
  });

  it("rejects fewer than two engines, duplicates, and unknown ids", async () => {
    for (const providers of [["anthropic"], ["anthropic", "anthropic"], ["anthropic", "grok"], "all"]) {
      expect((await POST(request({ providers }))).status).toBe(400);
    }
    expect(state.inserted).toEqual([]);
  });

  it("refuses a batch with no active prompts", async () => {
    state.activePrompts = 0;
    expect((await POST(request({ providers: ["anthropic", "openai"] }))).status).toBe(400);
    expect(state.inserted).toEqual([]);
  });

  // Opening a batch that cannot produce a single report finished instantly with
  // nothing in it, and the only account of why was an email that is off by
  // default. Say it in the response, where the person who clicked is looking.
  it("refuses, with the fix, when no requested engine can be funded", async () => {
    state.sources = { anthropic: "none", openai: "exhausted" };
    const res = await POST(request({ providers: ["anthropic", "openai"] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Add one in Settings/);
    expect(state.inserted).toEqual([]);
  });

  // One fundable engine is a batch worth running: per-engine refusals are
  // recorded by /api/runs as the loop reaches them, and reported in the email.
  it("opens the batch when at least one engine can run", async () => {
    state.sources = { anthropic: "own", openai: "none" };
    expect((await POST(request({ providers: ["anthropic", "openai"] }))).status).toBe(201);
    expect(state.inserted).toHaveLength(1);
  });
});

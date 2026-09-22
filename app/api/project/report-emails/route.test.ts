import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userId: "owner-1", ownerId: "owner-1", updates: [] as boolean[] }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: state.userId } } }) },
    from: () => ({
      update: (fields: { report_emails_enabled: boolean }) => {
        state.updates.push(fields.report_emails_enabled);
        const chain = {
          eq: () => chain,
          select: () => chain,
          single: async () => ({ data: fields, error: null }),
        };
        return chain;
      },
    }),
  }),
}));
vi.mock("@/lib/data", () => ({
  getProject: async () => ({ id: "project-1", user_id: state.ownerId }),
}));

import { PATCH } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/project/report-emails", {
    method: "PATCH", body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.userId = "owner-1";
  state.ownerId = "owner-1";
  state.updates.length = 0;
});

describe("report email preference", () => {
  it("lets the owner opt in and back out", async () => {
    expect((await PATCH(request({ enabled: true }))).status).toBe(200);
    expect((await PATCH(request({ enabled: false }))).status).toBe(200);
    expect(state.updates).toEqual([true, false]);
  });

  it("rejects a teammate and does not write", async () => {
    state.userId = "member-1";
    expect((await PATCH(request({ enabled: true }))).status).toBe(403);
    expect(state.updates).toEqual([]);
  });

  it("rejects non-boolean input", async () => {
    expect((await PATCH(request({ enabled: "true" }))).status).toBe(400);
    expect(state.updates).toEqual([]);
  });
});

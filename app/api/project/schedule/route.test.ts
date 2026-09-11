import { describe, it, expect, vi, beforeEach } from "vitest";

const updateSpy = vi.fn();
let updateResult: { data: unknown; error: unknown } = { data: null, error: null };

// The route pulls in the Supabase server client (next/headers); we build just
// enough of the chain PATCH actually calls: from().update().eq().eq().select().single().
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => ({
      update: (fields: unknown) => {
        updateSpy(fields);
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: async () => updateResult,
              }),
            }),
          }),
        };
      },
    }),
  }),
}));
// getProject uses React's cache(), which only exists in a server-component
// runtime — same treatment the onboarding route tests give lib/data.
vi.mock("@/lib/data", () => ({
  getProject: vi.fn(async () => ({ id: "proj-1", user_id: "user-1" })),
}));
vi.mock("@/lib/llm", () => ({ humanError: (e: unknown) => String(e) }));
vi.mock("@/lib/activity", () => ({ logDashboard: vi.fn() }));

const { PATCH } = await import("./route");

function req(body: unknown) {
  return new Request("http://localhost/api/project/schedule", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  updateResult = { data: { id: "proj-1", schedule: "daily" }, error: null };
});

describe("PATCH /api/project/schedule — validation", () => {
  it("rejects an unrecognised schedule, naming the accepted values", async () => {
    const res = await PATCH(req({ schedule: "hourly" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("schedule must be one of off, daily, weekly, custom");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rejects 'custom' with no intervalDays", async () => {
    const res = await PATCH(req({ schedule: "custom" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/intervalDays must be a whole number of days between 1 and 90/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rejects 'custom' with an out-of-range intervalDays", async () => {
    for (const bad of [0, -3, 91, 1.5]) {
      updateSpy.mockClear();
      const res = await PATCH(req({ schedule: "custom", intervalDays: bad }));
      expect(res.status).toBe(400);
      expect(updateSpy).not.toHaveBeenCalled();
    }
  });

  it("accepts 'custom' with an in-range whole number and stores it", async () => {
    const res = await PATCH(req({ schedule: "custom", intervalDays: 14 }));
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: "custom", schedule_interval_days: 14 }),
    );
  });

  // A stale interval left over from a previous 'custom' selection must not
  // resurface silently if the schedule is later switched away from 'custom'.
  it("nulls schedule_interval_days for every schedule but 'custom'", async () => {
    for (const schedule of ["off", "daily", "weekly"]) {
      updateSpy.mockClear();
      const res = await PATCH(req({ schedule, intervalDays: 30 }));
      expect(res.status).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ schedule, schedule_interval_days: null }),
      );
    }
  });

  it("rejects a non-string schedule and invalid JSON the same way as before", async () => {
    expect((await PATCH(req({ schedule: 3 }))).status).toBe(400);
    const badJson = new Request("http://localhost/api/project/schedule", {
      method: "PATCH",
      body: "{not json",
    });
    expect((await PATCH(badJson)).status).toBe(400);
  });
});

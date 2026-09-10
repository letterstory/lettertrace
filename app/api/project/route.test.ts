import { beforeEach, describe, expect, it, vi } from "vitest";

const insertSpy = vi.fn();
const updateSpy = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => ({
      insert: (fields: Record<string, unknown>) => {
        insertSpy(fields);
        return {
          select: () => ({
            single: async () => ({ data: { id: "project-1", ...fields }, error: null }),
          }),
        };
      },
      update: (fields: Record<string, unknown>) => {
        updateSpy(fields);
        return {
          eq: () => ({
            select: () => ({
              single: async () => ({ data: { id: "project-1", ...fields }, error: null }),
            }),
          }),
        };
      },
    }),
  }),
}));
vi.mock("@/lib/data", () => ({
  getProject: vi.fn(async () => null),
  setActiveProject: vi.fn(),
}));
vi.mock("@/lib/models", () => ({
  isProvider: () => false,
  resolveEngine: () => ({ ok: true, provider: "anthropic", model: "model-1" }),
}));
vi.mock("@/lib/trial", () => ({ pickDefaultProvider: () => "anthropic" }));
vi.mock("@/lib/llm", () => ({ humanError: (error: unknown) => String(error) }));
vi.mock("@/lib/activity", () => ({ logDashboard: vi.fn() }));

const { POST } = await import("./route");

function req(body: Record<string, unknown>) {
  return new Request("http://localhost/api/project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Acme", brand_name: "Acme", ...body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/project — custom cadence validation", () => {
  it("rejects every malformed custom interval instead of coercing or defaulting", async () => {
    for (const intervalDays of [undefined, null, "14", "", 0, 0.9, 1.5, 91]) {
      const res = await POST(req({ schedule: "custom", intervalDays }));
      expect(res.status).toBe(400);
    }
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("stores a valid custom interval", async () => {
    const res = await POST(req({ schedule: "custom", intervalDays: 14 }));
    expect(res.status).toBe(200);
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: "custom", schedule_interval_days: 14 }),
    );
  });

  it("nulls the interval for named and disabled schedules", async () => {
    for (const schedule of ["off", "daily", "weekly"]) {
      insertSpy.mockClear();
      const res = await POST(req({ schedule, intervalDays: 30 }));
      expect(res.status).toBe(200);
      expect(insertSpy).toHaveBeenCalledWith(
        expect.objectContaining({ schedule, schedule_interval_days: null }),
      );
    }
  });

  it("omits cadence from a new project's insert when the body doesn't send it", async () => {
    // Settings no longer offers a schedule control, so its save omits the
    // field entirely; the new row falls through to the database's own
    // default ('off') rather than this route re-asserting one.
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    const fields = insertSpy.mock.calls[0][0];
    expect(fields).not.toHaveProperty("schedule");
    expect(fields).not.toHaveProperty("schedule_interval_days");
  });

  it("leaves an existing project's cadence untouched when the body doesn't send it", async () => {
    // A body without `schedule` (e.g. a Settings save) must not silently
    // reset a project already on a custom cadence back to 'off'.
    const data = await import("@/lib/data");
    vi.mocked(data.getProject).mockResolvedValueOnce({
      id: "project-1",
      default_provider: "anthropic",
    } as never);

    const res = await POST(req({}));
    expect(res.status).toBe(200);
    const fields = updateSpy.mock.calls[0][0];
    expect(fields).not.toHaveProperty("schedule");
    expect(fields).not.toHaveProperty("schedule_interval_days");
  });
});

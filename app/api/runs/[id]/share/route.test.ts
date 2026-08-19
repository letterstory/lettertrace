import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/share-links", () => ({ createShareLink: vi.fn() }));
vi.mock("@/lib/activity", () => ({ logDashboard: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { createShareLink } = await import("@/lib/share-links");
const { POST } = await import("@/app/api/runs/[id]/share/route");

function fakeSessionClient(user: { id: string } | null) {
  return { auth: { getUser: async () => ({ data: { user } }) } };
}

function req() {
  return new Request("http://localhost/api/runs/run-1/share", { method: "POST" });
}

beforeEach(() => {
  vi.mocked(createClient).mockReset();
  vi.mocked(createShareLink).mockReset();
});

describe("POST /api/runs/[id]/share", () => {
  it("401s without a session, and never calls createShareLink", async () => {
    vi.mocked(createClient).mockReturnValue(fakeSessionClient(null) as never);

    const res = await POST(req(), { params: { id: "run-1" } });

    expect(res.status).toBe(401);
    expect(createShareLink).not.toHaveBeenCalled();
  });

  it("404s when the run isn't found or isn't the caller's", async () => {
    vi.mocked(createClient).mockReturnValue(fakeSessionClient({ id: "user-1" }) as never);
    vi.mocked(createShareLink).mockResolvedValue({ ok: false, code: "not_found" });

    const res = await POST(req(), { params: { id: "run-1" } });

    expect(res.status).toBe(404);
  });

  it("returns exactly { token, expiresAt } on success, nothing else", async () => {
    vi.mocked(createClient).mockReturnValue(fakeSessionClient({ id: "user-1" }) as never);
    vi.mocked(createShareLink).mockResolvedValue({
      ok: true,
      token: "lt_share_abc123",
      expiresAt: "2026-08-26T00:00:00.000Z",
    });

    const res = await POST(req(), { params: { id: "run-1" } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ token: "lt_share_abc123", expiresAt: "2026-08-26T00:00:00.000Z" });
  });

  it("calls createShareLink with the session client, the user id, and the path id", async () => {
    const supabase = fakeSessionClient({ id: "user-1" });
    vi.mocked(createClient).mockReturnValue(supabase as never);
    vi.mocked(createShareLink).mockResolvedValue({
      ok: true,
      token: "lt_share_abc123",
      expiresAt: "2026-08-26T00:00:00.000Z",
    });

    await POST(req(), { params: { id: "run-1" } });

    expect(createShareLink).toHaveBeenCalledWith(supabase, "user-1", "run-1");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/notify", () => ({ sendAdminAlert: vi.fn() }));

const SECRET = "cron-secret";

function req(auth = `Bearer ${SECRET}`) {
  return new Request("https://lettertrace.com/api/cron/letterprove-health", {
    headers: { authorization: auth },
  });
}

/** 200 for the script, and whatever is given for the config probe. */
function respondWith(statuses: Record<string, number>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const match = Object.keys(statuses).find((k) => url.includes(k));
    return new Response("", { status: match ? statuses[match] : 200 });
  });
}

describe("GET /api/cron/letterprove-health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    process.env.NEXT_PUBLIC_LETTERPROVE_KEY = "lp_live_test";
    delete process.env.NEXT_PUBLIC_LETTERPROVE_ORIGIN;
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_LETTERPROVE_KEY;
    vi.restoreAllMocks();
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await GET(req("Bearer wrong"));
    expect(res.status).toBe(401);
  });

  // A deployment that doesn't report — a self-hoster, a preview — has nothing
  // to check and nobody to bother.
  it("does nothing when no key is configured", async () => {
    delete process.env.NEXT_PUBLIC_LETTERPROVE_KEY;
    const { sendAdminAlert } = await import("@/lib/notify");
    const body = await (await GET(req())).json();
    expect(body.status).toBe("not-configured");
    expect(sendAdminAlert).not.toHaveBeenCalled();
  });

  it("stays quiet while both endpoints are reachable", async () => {
    respondWith({});
    const { sendAdminAlert } = await import("@/lib/notify");
    const body = await (await GET(req())).json();
    expect(body.status).toBe("healthy");
    expect(sendAdminAlert).not.toHaveBeenCalled();
  });

  // The actual 2026-08-14 failure: the script URL started 404ing after
  // Letterprove moved domains.
  it("alerts when the script 404s, naming the URL that failed", async () => {
    respondWith({ "attest.js": 404 });
    const { sendAdminAlert } = await import("@/lib/notify");

    const body = await (await GET(req())).json();
    expect(body.status).toBe("unhealthy");
    expect(sendAdminAlert).toHaveBeenCalledTimes(1);

    const alert = vi.mocked(sendAdminAlert).mock.calls[0][0];
    expect(alert.body).toContain("attest.js");
    expect(alert.body).toContain("404");
    expect(alert.body).toContain("app.letterprove.com");
  });

  it("alerts when the collector rejects our key", async () => {
    respondWith({ "/api/v1/config": 404 });
    const { sendAdminAlert } = await import("@/lib/notify");
    const body = await (await GET(req())).json();
    expect(body.status).toBe("unhealthy");
    expect(vi.mocked(sendAdminAlert).mock.calls[0][0].body).toContain("config");
  });

  // A redirect is not a pass. attest.js derives its collector origin from its
  // own src, so a script served from somewhere else reports somewhere else.
  it("treats a redirect as a failure rather than following it", async () => {
    respondWith({ "attest.js": 307 });
    const body = await (await GET(req())).json();
    expect(body.status).toBe("unhealthy");
  });

  it("alerts when the host is unreachable entirely", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENOTFOUND"));
    const { sendAdminAlert } = await import("@/lib/notify");
    const body = await (await GET(req())).json();
    expect(body.status).toBe("unhealthy");
    expect(vi.mocked(sendAdminAlert).mock.calls[0][0].body).toContain("ENOTFOUND");
  });

  // 200 even when unhealthy: the cron ran and reported correctly. Conflating
  // "the integration is down" with "the check itself broke" is how a monitor
  // starts getting ignored.
  it("returns 200 for a successful check that found a problem", async () => {
    respondWith({ "attest.js": 500 });
    expect((await GET(req())).status).toBe(200);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sweep = vi.hoisted(() => vi.fn(async () => 2));
vi.mock("@/lib/report-groups", () => ({ sweepAbandonedGroups: sweep }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({}) }));

import { GET, POST } from "./route";

const SECRET = "cron-secret";

function req(auth?: string) {
  return new Request("https://lettertrace.com/api/cron/report-groups", {
    headers: auth === undefined ? {} : { authorization: auth },
  });
}

beforeEach(() => {
  sweep.mockClear();
  sweep.mockResolvedValue(2);
  process.env.CRON_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("the report group sweep", () => {
  it("closes out abandoned batches for an authorized tick", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closed: 2 });
  });

  it("accepts a manual POST on the same terms", async () => {
    expect((await POST(req(`Bearer ${SECRET}`))).status).toBe(200);
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("refuses a wrong secret, a missing header, and a bare secret", async () => {
    for (const auth of [`Bearer wrong-secret`, undefined, SECRET]) {
      expect((await GET(req(auth))).status).toBe(401);
    }
    expect(sweep).not.toHaveBeenCalled();
  });

  // No CRON_SECRET must never mean "everyone is authorized" — an unconfigured
  // deployment would otherwise expose the sweep to anyone who found the path.
  it("refuses everyone when no secret is configured", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req("Bearer "))).status).toBe(401);
    expect(sweep).not.toHaveBeenCalled();
  });

  // The tick is a background job: it reports a failure rather than throwing
  // into the platform's retry, and says where to look.
  it("reports a sweep failure as a 500 without leaking the cause", async () => {
    sweep.mockRejectedValue(new Error("pg: connection refused at 10.0.0.1"));
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.1");
  });
});

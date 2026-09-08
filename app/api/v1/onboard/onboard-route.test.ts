import { beforeEach, describe, expect, it, vi } from "vitest";
import { FULL_SCOPES } from "@/lib/api-auth";

// The route is the seam between bearer auth, the operator gate, and the
// onboarding engine (lib/onboard, tested on its own). These tests pin what the
// route decides: who may transfer, what is passed through, and what comes back.

const fakeSupabase = { from: vi.fn() };
const seatUpsert = vi.fn(async () => ({ error: null }));
/** Default tables: the caller's profile row (for the email gate) and the seat upsert. */
function stubTables(profileEmail: string | null = null) {
  fakeSupabase.from.mockImplementation((table: string) =>
    table === "project_members"
      ? { upsert: seatUpsert }
      : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profileEmail ? { email: profileEmail } : null }) }) }) },
  );
}
const ctx = {
  supabase: fakeSupabase,
  userId: "caller-1",
  keyId: "key-1",
  tokenType: "api_key" as const,
  scopes: [...FULL_SCOPES] as string[],
  clientId: null,
  expiresAt: null,
  aud: null,
};

vi.mock("@/lib/api-guards", () => ({ requireApiAuth: vi.fn(async () => ctx) }));
vi.mock("@/lib/admin", () => ({
  adminGate: vi.fn(() => "none"),
  isAdminUserId: vi.fn(() => false),
  isAdminEmail: vi.fn(() => false),
}));
vi.mock("@/lib/api-service", () => ({
  projectSummary: (p: unknown) => p,
  toAliases: (v: unknown) => (Array.isArray(v) ? v.map(String) : []),
  toDomains: (v: unknown) => (Array.isArray(v) ? v.map(String) : []),
}));
vi.mock("@/lib/activity", () => ({
  apiActor: () => ({ actorType: "api_key", actorId: "key-1", actorLabel: "API key", channel: "api" }),
  logActivity: vi.fn(),
  logApiRequest: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({ humanError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
// Fully replaced rather than spread from the original: the engine drags in
// lib/data (React's cache(), server-runtime only) and the whole run stack,
// none of which this seam needs. The error class is redefined here so the
// route's instanceof check meets the same class the tests throw.
vi.mock("@/lib/onboard", () => ({
  OnboardError: class OnboardError extends Error {
    constructor(
      public code: "invalid",
      message: string,
    ) {
      super(message);
    }
  },
  onboardFromUrl: vi.fn(),
  resolveOnboardingAccount: vi.fn(),
  mintApiKey: vi.fn(),
  serviceTrialMeter: vi.fn((_db: unknown, userId: string) => ({ for: userId })),
}));

const admin = await import("@/lib/admin");
const guards = await import("@/lib/api-guards");
const onboard = await import("@/lib/onboard");
const activity = await import("@/lib/activity");
const { POST } = await import("@/app/api/v1/onboard/route");

function req(body: unknown) {
  return new Request("http://localhost/api/v1/onboard", {
    method: "POST",
    headers: { authorization: "Bearer lt_live_x", "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const PROJECT = { id: "proj-1", name: "Acme", user_id: "caller-1" };
const TRIAL = { used: 1, limit: 15, remaining: 14, spendMicros: 0, capMicros: 5_000_000, active: true };

function outcome(over: Partial<Awaited<ReturnType<typeof onboard.onboardFromUrl>>> = {}) {
  return {
    project: PROJECT as never,
    site: { host: "acme.com", url: "https://acme.com/", title: "Acme", siteName: "Acme", scraped: true },
    suggestion: { description: "d", topics: 2, competitors: 1, keySource: "trial" as const, tokens: 10 },
    saved: { topics: 2, prompts: 6, competitors: 1 },
    topics: [],
    competitors: [],
    sweep: {
      ran: true as const,
      runs: [
        { provider: "anthropic" as const, model: "m", runId: "run-1", status: "running" as const, keySource: "trial" as const, route: null },
      ],
    },
    trial: TRIAL,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(guards.requireApiAuth).mockReset().mockResolvedValue(ctx as never);
  vi.mocked(admin.adminGate).mockReset().mockReturnValue("none");
  vi.mocked(admin.isAdminUserId).mockReset().mockReturnValue(false);
  vi.mocked(admin.isAdminEmail).mockReset().mockReturnValue(false);
  vi.mocked(onboard.onboardFromUrl).mockReset().mockResolvedValue(outcome());
  vi.mocked(onboard.resolveOnboardingAccount).mockReset();
  vi.mocked(onboard.mintApiKey).mockReset();
  vi.mocked(activity.logActivity).mockReset();
  vi.mocked(activity.logApiRequest).mockReset();
  fakeSupabase.from.mockReset();
  seatUpsert.mockClear();
  stubTables();
  ctx.scopes = [...FULL_SCOPES];
});

describe("POST /api/v1/onboard — validation", () => {
  it("requires a url", async () => {
    const res = await POST(req({ brand_name: "Acme" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/url is required/);
    expect(onboard.onboardFromUrl).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    expect((await POST(req("{not json"))).status).toBe(400);
  });

  it("rejects an unknown schedule", async () => {
    const res = await POST(req({ url: "acme.com", schedule: "hourly" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown schedule/);
  });

  it("rejects a sent topic with no prompts", async () => {
    const res = await POST(req({ url: "acme.com", topics: [{ name: "CDN", prompts: [] }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/needs at least one prompt/);
  });

  // The sweep is a run: a token without runs:trigger may set the organization
  // up but not spend anything starting it.
  it("needs runs:trigger to start the sweep, unless run is false", async () => {
    ctx.scopes = ["projects:write"];
    const refused = await POST(req({ url: "acme.com" }));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("WWW-Authenticate")).toMatch(/runs:trigger/);

    vi.mocked(onboard.onboardFromUrl).mockResolvedValue(outcome({ sweep: null, sweepSkipped: "not_requested" }));
    const ok = await POST(req({ url: "acme.com", run: false }));
    expect(ok.status).toBe(201);
    expect(vi.mocked(onboard.onboardFromUrl).mock.calls[0][0].input.run).toBe(false);
  });
});

describe("POST /api/v1/onboard — into the caller's own account", () => {
  it("passes the body through and answers 202 while runs are in flight", async () => {
    const res = await POST(
      req({
        url: "https://www.acme.com",
        brand_name: "Acme",
        name: "Acme Inc",
        description: "payroll",
        brand_aliases: ["Acme Corp"],
        brand_domains: ["blog.acme.com"],
        competitors: [{ name: "Gusto" }],
        schedule: "daily",
      }),
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({
      project: PROJECT,
      ran: true,
      runs: [{ runId: "run-1", keySource: "trial" }],
      trial: TRIAL,
      site: { siteName: "Acme" },
    });
    expect(body.account).toBeUndefined();
    expect(body.api_key).toBeUndefined();

    const call = vi.mocked(onboard.onboardFromUrl).mock.calls[0][0];
    expect(call.userId).toBe("caller-1");
    expect(call.meter).toEqual({ for: "caller-1" });
    expect(call.input).toMatchObject({
      url: "https://www.acme.com",
      brandName: "Acme",
      name: "Acme Inc",
      description: "payroll",
      brandAliases: ["Acme Corp"],
      extraDomains: ["blog.acme.com"],
      competitors: [{ name: "Gusto" }],
      schedule: "daily",
      run: true,
      background: true,
      topics: null,
    });
    // The owner's feed gets the setup; nothing is minted for one's own account.
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "caller-1", action: "onboarding.completed" }),
    );
    expect(onboard.mintApiKey).not.toHaveBeenCalled();
  });

  it("answers 201 with the sweep settled, and relays a key refusal", async () => {
    vi.mocked(onboard.onboardFromUrl).mockResolvedValue(
      outcome({ sweep: { ran: false, needsKey: "mismatch", keyMessage: "switch engines" } }),
    );
    const res = await POST(req({ url: "acme.com", background: false }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ran: false, needsKey: "mismatch", keyMessage: "switch engines", runs: [] });
  });

  it("maps an invalid URL to 400 and everything else to 500", async () => {
    vi.mocked(onboard.onboardFromUrl).mockRejectedValueOnce(new onboard.OnboardError("invalid", "bad url"));
    expect((await POST(req({ url: "nope" }))).status).toBe(400);
    vi.mocked(onboard.onboardFromUrl).mockRejectedValueOnce(new Error("db down"));
    expect((await POST(req({ url: "acme.com" }))).status).toBe(500);
  });
});

describe("POST /api/v1/onboard — the transfer (email)", () => {
  it("refuses a non-operator, without touching any account", async () => {
    const res = await POST(req({ url: "acme.com", email: "jo@acme.com" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/operator/);
    expect(onboard.resolveOnboardingAccount).not.toHaveBeenCalled();
    expect(onboard.onboardFromUrl).not.toHaveBeenCalled();
  });

  it("refuses when no operator is configured at all", async () => {
    vi.mocked(admin.adminGate).mockReturnValue("none");
    vi.mocked(admin.isAdminUserId).mockReturnValue(true);
    expect((await POST(req({ url: "acme.com", email: "jo@acme.com" }))).status).toBe(403);
  });

  it("onboards into the named account on the operator's say-so, and mints its key", async () => {
    vi.mocked(admin.adminGate).mockReturnValue("user-id");
    vi.mocked(admin.isAdminUserId).mockImplementation((id) => id === "caller-1");
    vi.mocked(onboard.resolveOnboardingAccount).mockResolvedValue({ userId: "client-7", email: "jo@acme.com", created: true });
    vi.mocked(onboard.mintApiKey).mockResolvedValue({ ok: true, id: "k1", name: "Onboarding (acme.com)", hint: "lt_live_…abcd", key: "lt_live_secret" });

    const res = await POST(req({ url: "acme.com", email: "Jo@acme.com" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.account).toEqual({ user_id: "client-7", email: "jo@acme.com", created: true });
    // The operator keeps a seat: a member of the client's organization, so its
    // own key can keep driving the project while the owner is billed.
    expect(body.seated).toBe(true);
    expect(seatUpsert).toHaveBeenCalledWith(
      { project_id: "proj-1", user_id: "caller-1", invited_by: "caller-1" },
      { onConflict: "project_id,user_id", ignoreDuplicates: true },
    );
    expect(body.api_key).toEqual({ id: "k1", name: "Onboarding (acme.com)", hint: "lt_live_…abcd", key: "lt_live_secret" });

    // The CLIENT owns the organization and pays with the client's trial.
    const call = vi.mocked(onboard.onboardFromUrl).mock.calls[0][0];
    expect(call.userId).toBe("client-7");
    expect(call.meter).toEqual({ for: "client-7" });
    expect(onboard.mintApiKey).toHaveBeenCalledWith(fakeSupabase, "client-7", "Onboarding (acme.com)");
    // Two feeds: the owner's setup event, and the operator's request.
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "client-7",
        metadata: expect.objectContaining({ transferred_to: "jo@acme.com", account_created: true }),
      }),
    );
    expect(activity.logApiRequest).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      "v1",
      expect.objectContaining({ action: "api.onboard", statusCode: 202 }),
    );
  });

  it("gates by email when ids are not configured", async () => {
    vi.mocked(admin.adminGate).mockReturnValue("email");
    vi.mocked(admin.isAdminEmail).mockImplementation((e) => e === "ops@letterstory.com");
    stubTables("ops@letterstory.com");
    vi.mocked(onboard.resolveOnboardingAccount).mockResolvedValue({ userId: "client-7", email: "jo@acme.com", created: false });
    vi.mocked(onboard.mintApiKey).mockResolvedValue({ ok: false, error: "This account already has 10 API keys. Remove one first." });

    const res = await POST(req({ url: "acme.com", email: "jo@acme.com" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.account.created).toBe(false);
    expect(body.api_key).toBeUndefined();
    expect(body.api_key_error).toMatch(/10 API keys/);
  });

  it("declines the seat on seat: false", async () => {
    vi.mocked(admin.adminGate).mockReturnValue("user-id");
    vi.mocked(admin.isAdminUserId).mockReturnValue(true);
    vi.mocked(onboard.resolveOnboardingAccount).mockResolvedValue({ userId: "client-7", email: "jo@acme.com", created: false });
    vi.mocked(onboard.mintApiKey).mockResolvedValue({ ok: true, id: "k1", name: "n", hint: "h", key: "k" });
    const res = await POST(req({ url: "acme.com", email: "jo@acme.com", seat: false }));
    expect((await res.json()).seated).toBe(false);
    expect(seatUpsert).not.toHaveBeenCalled();
  });

  it("names the key when asked, and skips it on key: false", async () => {
    vi.mocked(admin.adminGate).mockReturnValue("user-id");
    vi.mocked(admin.isAdminUserId).mockReturnValue(true);
    vi.mocked(onboard.resolveOnboardingAccount).mockResolvedValue({ userId: "client-7", email: "jo@acme.com", created: false });
    vi.mocked(onboard.mintApiKey).mockResolvedValue({ ok: true, id: "k1", name: "Letterbrace", hint: "h", key: "k" });

    await POST(req({ url: "acme.com", email: "jo@acme.com", key: { name: "Letterbrace" } }));
    expect(onboard.mintApiKey).toHaveBeenCalledWith(fakeSupabase, "client-7", "Letterbrace");

    vi.mocked(onboard.mintApiKey).mockClear();
    const res = await POST(req({ url: "acme.com", email: "jo@acme.com", key: false }));
    expect((await res.json()).api_key).toBeUndefined();
    expect(onboard.mintApiKey).not.toHaveBeenCalled();
  });

  it("turns a bad email into 400 before onboarding anything", async () => {
    vi.mocked(admin.adminGate).mockReturnValue("user-id");
    vi.mocked(admin.isAdminUserId).mockReturnValue(true);
    vi.mocked(onboard.resolveOnboardingAccount).mockRejectedValue(new onboard.OnboardError("invalid", "bad email"));
    const res = await POST(req({ url: "acme.com", email: "nope" }));
    expect(res.status).toBe(400);
    expect(onboard.onboardFromUrl).not.toHaveBeenCalled();
  });
});

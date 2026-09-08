import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Screen 1 asks for a URL and nothing else, so this route now has two jobs:
// derive the brand's identity from the page, and suggest what to monitor. The
// first must survive the second failing — that split is what these pin.
//
// lib/brand-name is deliberately NOT mocked: the derived name is the behaviour
// under test.

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "a@b.com" } } }) },
  }),
}));

const scrapeDomain = vi.fn();
vi.mock("@/lib/scrape", () => ({ scrapeDomain: (d: string) => scrapeDomain(d) }));

const suggestFromSite = vi.fn();
vi.mock("@/lib/llm", () => ({
  suggestFromSite: (o: unknown) => suggestFromSite(o),
  humanError: (e: unknown) => String(e),
}));

const resolveKey = vi.fn();
vi.mock("@/lib/trial", () => ({
  resolveKey: (...a: unknown[]) => resolveKey(...a),
  pickDefaultProvider: () => "anthropic",
  recordTrialUsage: vi.fn(),
  recordTrialSpend: vi.fn(),
}));
vi.mock("@/lib/pricing", () => ({ spendMicros: () => 0 }));
const logDashboard = vi.fn();
vi.mock("@/lib/activity", () => ({ logDashboard: (...a: unknown[]) => logDashboard(...a) }));

const { POST } = await import("@/app/api/onboarding/suggest/route");

function req(body: unknown) {
  return new Request("http://localhost/api/onboarding/suggest", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const GOOD_SCRAPE = {
  ok: true,
  url: "https://acme.com/",
  title: "Acme | Payments",
  siteName: "Acme",
  description: "Payments for the internet",
  imageUrl: "https://acme.com/card.png",
  text: "Acme builds payment infrastructure.",
};

const OWN_KEY = {
  source: "own",
  apiKey: "sk-test",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

beforeEach(() => {
  vi.clearAllMocks();
  scrapeDomain.mockResolvedValue(GOOD_SCRAPE);
  resolveKey.mockResolvedValue(OWN_KEY);
  suggestFromSite.mockResolvedValue({
    description: "Payment infrastructure for online businesses.",
    topics: [{ name: "payment processing", prompts: ["best payment processor?"] }],
    competitors: [{ name: "Adyen", aliases: [], domain: "adyen.com" }],
    tokens: 100,
  });
});

describe("POST /api/onboarding/suggest — input", () => {
  // The URL is now the only field on screen 1, so it is the only requirement.
  it("requires a domain and reads nothing without one", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(scrapeDomain).not.toHaveBeenCalled();
  });

  // It used to 400 without brandName, because screen 1 asked for one.
  it("no longer requires a brand name", async () => {
    const res = await POST(req({ domain: "acme.com" }));
    expect(res.status).toBe(200);
    expect((await res.json()).brandName).toBe("Acme");
  });

  it("keeps a brand name the caller supplies", async () => {
    const res = await POST(req({ domain: "acme.com", brandName: "Acme Payments" }));
    expect((await res.json()).brandName).toBe("Acme Payments");
  });
});

describe("POST /api/onboarding/suggest — identity", () => {
  it("returns the name, description and icon the site declares", async () => {
    const body = await (await POST(req({ domain: "acme.com" }))).json();
    expect(body).toMatchObject({
      scraped: true,
      brandName: "Acme",
      imageUrl: "https://acme.com/card.png",
      // The model read the whole page; the meta description is usually ad copy.
      description: "Payment infrastructure for online businesses.",
    });
    expect(body.topics).toHaveLength(1);
    expect(body.competitors).toHaveLength(1);
  });

  it("falls back to the meta description when the model returns none", async () => {
    suggestFromSite.mockResolvedValue({
      description: "",
      topics: [{ name: "t", prompts: ["q"] }],
      competitors: [],
      tokens: 1,
    });
    const body = await (await POST(req({ domain: "acme.com" }))).json();
    expect(body.description).toBe("Payments for the internet");
  });

  it("derives a name from the domain for a site that declares none", async () => {
    scrapeDomain.mockResolvedValue({ ...GOOD_SCRAPE, siteName: undefined, title: undefined });
    const body = await (await POST(req({ domain: "www.acme-labs.co.uk" }))).json();
    expect(body.brandName).toBe("Acme Labs");
  });
});

describe("POST /api/onboarding/suggest — degrading", () => {
  // The whole point of reading the site before checking the key: identity comes
  // from the page's own metadata and needs no model. A keyless signup used to
  // get three empty fields back for a URL we had already read successfully, so
  // the URL bought them nothing.
  it.each([
    ["no key at all", { source: "none", provider: "anthropic", model: "m" }, "no_key"],
    [
      "an exhausted trial",
      { source: "exhausted", provider: "anthropic", model: "m" },
      "trial_exhausted",
    ],
  ])("still returns identity with %s", async (_label, key, reason) => {
    resolveKey.mockResolvedValue(key);
    const body = await (await POST(req({ domain: "acme.com" }))).json();
    expect(body.reason).toBe(reason);
    expect(body.brandName).toBe("Acme");
    expect(body.imageUrl).toBe("https://acme.com/card.png");
    expect(body.description).toBe("Payments for the internet");
    expect(body.topics).toEqual([]);
    expect(suggestFromSite).not.toHaveBeenCalled();
  });

  it("still returns identity when the model call throws", async () => {
    suggestFromSite.mockRejectedValue(new Error("upstream 500"));
    const body = await (await POST(req({ domain: "acme.com" }))).json();
    expect(body.reason).toBe("ai_failed");
    expect(body.brandName).toBe("Acme");
    expect(body.topics).toEqual([]);
  });
});

describe("POST /api/onboarding/suggest — an unreadable site", () => {
  // The wizard advances on `brandName`, so leaving it empty here is what keeps
  // the user on screen 1 with the reason instead of on an empty editor.
  it("returns the site's own failure and no brand name", async () => {
    scrapeDomain.mockResolvedValue({ ok: false, error: "Site returned 404." });
    const res = await POST(req({ domain: "acme.com/nope" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reason).toBe("scrape_failed");
    expect(body.error).toBe("Site returned 404.");
    expect(body.brandName).toBe("");
  });

  // A site we could not read is a URL problem. Reporting "no key" would point
  // the user at Settings for something Settings cannot fix.
  it("reports the site, not the key, when both are a problem", async () => {
    scrapeDomain.mockResolvedValue({ ok: false, error: "Couldn't reach the site." });
    resolveKey.mockResolvedValue({ source: "none", provider: "anthropic", model: "m" });
    const body = await (await POST(req({ domain: "acme.com" }))).json();
    expect(body.reason).toBe("scrape_failed");
    expect(resolveKey).not.toHaveBeenCalled();
  });

  it("treats a scrape that succeeded with no text as unreadable", async () => {
    scrapeDomain.mockResolvedValue({ ok: true, title: "Acme", text: "" });
    expect((await (await POST(req({ domain: "acme.com" }))).json()).reason).toBe("scrape_failed");
  });
});

describe("POST /api/onboarding/suggest — a model that outruns the route", () => {
  afterEach(() => vi.useRealTimers());

  // googleFetch may spend ~330s on one call because its retry constants are
  // sized for the run route's 300s, while this route has 60s. Measured
  // 2026-09-04: a stripe.com suggest call took 136919ms during a Gemini
  // congestion spike, which production kills at 60s — returning nothing, not
  // even the identity the scrape had already produced in ~1s.
  it("gives up on the model and still returns the identity", async () => {
    vi.useFakeTimers();
    // Never settles: stands in for a call still retrying past the deadline.
    suggestFromSite.mockReturnValue(new Promise(() => {}));

    const pending = POST(req({ domain: "acme.com" }));
    await vi.advanceTimersByTimeAsync(35_000);
    const body = await (await pending).json();

    expect(body.reason).toBe("ai_timeout");
    expect(body.brandName).toBe("Acme");
    expect(body.imageUrl).toBe("https://acme.com/card.png");
    expect(body.description).toBe("Payments for the internet");
    expect(body.topics).toEqual([]);
    expect(body.competitors).toEqual([]);
  });

  // The deadline must not fire on a call that answered in time, or every
  // successful suggestion would be thrown away.
  it("keeps a suggestion that lands inside the deadline", async () => {
    vi.useFakeTimers();
    suggestFromSite.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                description: "Payment infrastructure.",
                topics: [{ name: "payments", prompts: ["best processor?"] }],
                competitors: [],
                tokens: 10,
              }),
            5_000,
          ),
        ),
    );

    const pending = POST(req({ domain: "acme.com" }));
    await vi.advanceTimersByTimeAsync(5_000);
    const body = await (await pending).json();

    expect(body.reason).toBeUndefined();
    expect(body.topics).toHaveLength(1);
  });
});

// The free tier in production is funded through a Concentrate ROUTER key.
// resolveKey returns that key together with `route` (which gateway to call);
// this route used to drop the route and send the router key straight to
// Anthropic, which refused it as an invalid key — every trial user's
// onboarding then arrived with the identity filled in and no topics, and the
// feed showed nothing at all, since only successes were logged.
describe("POST /api/onboarding/suggest — router-funded trial", () => {
  const ROUTED_TRIAL_KEY = {
    source: "trial",
    apiKey: "sk-cn-operator",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    route: { router: "concentrate", baseUrl: null },
  };

  it("hands the resolved route to the model call, not just the key", async () => {
    resolveKey.mockResolvedValue(ROUTED_TRIAL_KEY);
    const res = await POST(req({ domain: "acme.com" }));
    expect((await res.json()).topics).toHaveLength(1);
    expect(suggestFromSite).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-cn-operator",
        model: "claude-haiku-4-5",
        route: { router: "concentrate", baseUrl: null },
      }),
    );
  });

  it("still passes no route for a direct key", async () => {
    await POST(req({ domain: "acme.com" }));
    const call = suggestFromSite.mock.calls[0][0] as { route?: unknown };
    expect(call.route).toBeUndefined();
  });
});

describe("POST /api/onboarding/suggest — failures leave a trace", () => {
  it("logs a model failure with the error text, and still answers 200 with the identity", async () => {
    suggestFromSite.mockRejectedValue(new Error("Invalid API key."));
    const res = await POST(req({ domain: "acme.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reason: "ai_failed", brandName: "Acme", topics: [] });
    expect(logDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      expect.anything(),
      expect.objectContaining({
        action: "onboarding.suggest_failed",
        status: "failure",
        metadata: expect.objectContaining({ reason: "ai_failed", error: "Error: Invalid API key.", domain: "acme.com" }),
      }),
    );
  });

  it("logs a spent trial and a missing key by their reason", async () => {
    resolveKey.mockResolvedValue({ source: "exhausted", provider: "anthropic", model: "m" });
    await POST(req({ domain: "acme.com" }));
    expect(logDashboard).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ metadata: expect.objectContaining({ reason: "trial_exhausted" }) }),
    );
    resolveKey.mockResolvedValue({ source: "none", provider: "anthropic", model: "m" });
    await POST(req({ domain: "acme.com" }));
    expect(logDashboard).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ metadata: expect.objectContaining({ reason: "no_key" }) }),
    );
  });

  it("logs an unreadable site with the scraper's own error", async () => {
    scrapeDomain.mockResolvedValue({ ok: false, error: "Site returned 503." });
    await POST(req({ domain: "acme.com" }));
    expect(logDashboard).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ metadata: expect.objectContaining({ reason: "scrape_failed", error: "Site returned 503." }) }),
    );
  });

  it("never lets a logging failure change the response", async () => {
    suggestFromSite.mockRejectedValue(new Error("boom"));
    logDashboard.mockRejectedValue(new Error("activity table down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req({ domain: "acme.com" }));
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("ai_failed");
    err.mockRestore();
  });
});

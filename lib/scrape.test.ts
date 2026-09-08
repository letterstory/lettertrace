import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({ default: { lookup: (...a: unknown[]) => lookup(...a) } }));

const firecrawlEnabled = vi.fn();
const firecrawlScrape = vi.fn();
vi.mock("@/lib/firecrawl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/firecrawl")>()),
  firecrawlEnabled: () => firecrawlEnabled(),
  firecrawlScrape: (url: string) => firecrawlScrape(url),
}));

import { scrapeDomain } from "@/lib/scrape";

const BLOCKED = "For security we can't fetch that host. Add your topics manually instead.";

function html(body: string, head = "") {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    text: async () => `<html><head>${head}</head><body>${body}</body></html>`,
  } as unknown as Response;
}

const PARAGRAPH =
  "<p>Acme builds payment infrastructure for the internet, used by millions of businesses.</p>";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  firecrawlEnabled.mockReturnValue(false);
  firecrawlScrape.mockReset();
  // Public by default; individual tests point DNS inward.
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("scrapeDomain: choosing a reader", () => {
  it("uses Firecrawl and never touches the built-in reader when it succeeds", async () => {
    firecrawlEnabled.mockReturnValue(true);
    firecrawlScrape.mockResolvedValue({
      ok: true,
      url: "https://acme.com/",
      title: "Acme",
      siteName: "Acme",
      description: "Payments",
      imageUrl: "https://acme.com/card.png",
      text: "a".repeat(200),
    });

    const res = await scrapeDomain("acme.com");
    expect(res.ok).toBe(true);
    expect(res.siteName).toBe("Acme");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The point of the fallback: a Firecrawl outage, an expired key or an
  // exhausted balance must not take onboarding down with it.
  it("falls back to the built-in reader when Firecrawl fails", async () => {
    firecrawlEnabled.mockReturnValue(true);
    firecrawlScrape.mockResolvedValue({ ok: false, error: "Firecrawl is out of credits." });
    fetchMock.mockResolvedValue(html(PARAGRAPH, "<title>Acme</title>"));

    const res = await scrapeDomain("acme.com");
    expect(res.ok).toBe(true);
    expect(res.title).toBe("Acme");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A user can only act on a message about their own site. Surfacing
  // "Firecrawl is out of credits" to them would name our problem, not theirs.
  it("surfaces the site's failure, not the vendor's, when both readers fail", async () => {
    firecrawlEnabled.mockReturnValue(true);
    firecrawlScrape.mockResolvedValue({ ok: false, error: "Firecrawl is out of credits." });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => "",
    } as unknown as Response);

    const res = await scrapeDomain("acme.com");
    expect(res.error).toBe("Site returned 404.");
  });

  it("never calls Firecrawl when it isn't configured", async () => {
    fetchMock.mockResolvedValue(html(PARAGRAPH));
    await scrapeDomain("acme.com");
    expect(firecrawlScrape).not.toHaveBeenCalled();
  });
});

describe("scrapeDomain: SSRF guards", () => {
  // Firecrawl fetches from its own network, where our guards don't apply. An
  // internal address has to be refused before we ask a third party to reach it.
  it("blocks an internal host before handing the URL to Firecrawl", async () => {
    firecrawlEnabled.mockReturnValue(true);
    const res = await scrapeDomain("10.0.0.5");
    expect(res.error).toBe(BLOCKED);
    expect(firecrawlScrape).not.toHaveBeenCalled();
  });

  // Two gates refuse these, and which one fires depends only on whether the
  // host has a dot: normalizeUrl drops dotless non-IP names ("localhost") as
  // malformed, assertSafe drops the rest as internal. Both are refusals with
  // no request made, which is the property that matters.
  it.each([
    ["localhost", "localhost"],
    ["a .localhost subdomain", "api.localhost"],
    ["loopback v4", "127.0.0.1"],
    ["cloud metadata", "169.254.169.254"],
    ["private v4", "10.0.0.5"],
    ["CGNAT", "100.64.0.1"],
    ["a .internal name", "vault.internal"],
    ["a .local name", "printer.local"],
    ["GCP metadata by name", "metadata.google.internal"],
    ["loopback v6", "[::1]"],
  ])("never requests %s", async (_label, host) => {
    const res = await scrapeDomain(host);
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a .localhost subdomain", "api.localhost"],
    ["loopback v4", "127.0.0.1"],
    ["cloud metadata", "169.254.169.254"],
    ["a .internal name", "vault.internal"],
    ["GCP metadata by name", "metadata.google.internal"],
  ])("names %s as a blocked host rather than a typo", async (_label, host) => {
    expect((await scrapeDomain(host)).error).toBe(BLOCKED);
  });

  // The hostname is public; only DNS says otherwise. Checking the name alone
  // is what a rebinding attack relies on.
  it("refuses a public hostname whose DNS points inward", async () => {
    lookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    const res = await scrapeDomain("evil.example.com");
    expect(res.error).toBe(BLOCKED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when only one of several A records is internal", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect((await scrapeDomain("evil.example.com")).error).toBe(BLOCKED);
  });

  // Every hop is re-validated: a public URL that 302s inward is the same
  // exposure as typing the internal address directly.
  it("refuses a redirect that lands on an internal host", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: new Headers({ location: "http://127.0.0.1/admin" }),
      text: async () => "",
    } as unknown as Response);

    const res = await scrapeDomain("acme.com");
    expect(res.error).toBe(BLOCKED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than following a redirect loop forever", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 302,
      headers: new Headers({ location: "https://acme.com/again" }),
      text: async () => "",
    } as unknown as Response);

    const res = await scrapeDomain("acme.com");
    expect(res.ok).toBe(false);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe("scrapeDomain: input handling", () => {
  it("assumes https for a bare domain", async () => {
    fetchMock.mockResolvedValue(html(PARAGRAPH));
    await scrapeDomain("acme.com");
    expect(fetchMock.mock.calls[0][0]).toBe("https://acme.com/");
  });

  it.each([["", "  "], ["no dot", "acme"], ["wrong scheme", "ftp://acme.com"]])(
    "rejects %s",
    async (_label, input) => {
      const res = await scrapeDomain(input);
      expect(res.ok).toBe(false);
      expect(res.error).toBe("That doesn't look like a valid domain.");
    },
  );
});

describe("scrapeDomain: parsing", () => {
  it("pulls out the identity a site declares about itself", async () => {
    fetchMock.mockResolvedValue(
      html(
        PARAGRAPH,
        `<title>Acme — Payments</title>
         <meta name="description" content="Payments for the internet">
         <meta property="og:site_name" content="Acme">
         <meta property="og:image" content="/card.png">`,
      ),
    );

    const res = await scrapeDomain("acme.com");
    expect(res.title).toBe("Acme — Payments");
    expect(res.siteName).toBe("Acme");
    expect(res.description).toBe("Payments for the internet");
    // Relative in the markup; a broken image once rendered on our origin.
    expect(res.imageUrl).toBe("https://acme.com/card.png");
  });

  it("reads a meta tag whose content attribute comes first", async () => {
    fetchMock.mockResolvedValue(
      html(PARAGRAPH, `<meta content="Acme" property="og:site_name">`),
    );
    expect((await scrapeDomain("acme.com")).siteName).toBe("Acme");
  });

  it("falls back to the favicon link when there is no social card", async () => {
    fetchMock.mockResolvedValue(
      html(PARAGRAPH, `<link rel="shortcut icon" href="https://cdn.acme.com/f.ico">`),
    );
    expect((await scrapeDomain("acme.com")).imageUrl).toBe("https://cdn.acme.com/f.ico");
  });

  it("strips script and style content out of the text", async () => {
    fetchMock.mockResolvedValue(
      html(`<script>var secret = "tracking";</script><style>.a{color:red}</style>${PARAGRAPH}`),
    );
    const res = await scrapeDomain("acme.com");
    expect(res.text).not.toContain("tracking");
    expect(res.text).not.toContain("color:red");
    expect(res.text).toContain("payment infrastructure");
  });

  it("refuses a page that isn't HTML", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      text: async () => "%PDF",
    } as unknown as Response);
    expect((await scrapeDomain("acme.com")).error).toBe("That URL isn't an HTML page.");
  });

  // A near-empty page scans as a successful read and produces invented topics.
  it("refuses a 200 carrying almost no text", async () => {
    fetchMock.mockResolvedValue(html("<p>Hi.</p>"));
    expect((await scrapeDomain("acme.com")).error).toBe(
      "Couldn't read enough content from the site.",
    );
  });

  it("reports an unreachable site rather than throwing", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await scrapeDomain("acme.com")).error).toBe("Couldn't reach the site.");
  });
});

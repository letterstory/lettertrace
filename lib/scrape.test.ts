import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every host in these tests resolves to a public address, so the SSRF guard
// lets it through; the guard's own blocking is exercised with a literal
// loopback hostname below, which never reaches DNS.
vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) },
}));
vi.mock("@/lib/firecrawl", () => ({
  isFirecrawlConfigured: vi.fn(() => false),
  firecrawlScrape: vi.fn(),
}));

const { isFirecrawlConfigured, firecrawlScrape } = await import("@/lib/firecrawl");
const { scrapeDomain } = await import("@/lib/scrape");

const LONG = "Acme builds payroll software for platform teams. ".repeat(10);
const HTML = `<html><head><title>Acme &amp; Co</title><meta name="description" content="Payroll for platform teams"></head><body><h1>Acme</h1><p>${LONG}</p></body></html>`;

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(
    new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }),
  );
  vi.mocked(isFirecrawlConfigured).mockReset().mockReturnValue(false);
  vi.mocked(firecrawlScrape).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("scrapeDomain — reader order", () => {
  it("reads with the plain fetch when Firecrawl is not configured", async () => {
    const result = await scrapeDomain("acme.com");
    expect(result).toMatchObject({ ok: true, url: "https://acme.com/", reader: "fetch" });
    expect(result.title).toBe("Acme & Co");
    expect(result.text).toMatch(/^Payroll for platform teams\n\n/);
    expect(firecrawlScrape).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prefers Firecrawl when configured, and never touches the plain fetch", async () => {
    vi.mocked(isFirecrawlConfigured).mockReturnValue(true);
    vi.mocked(firecrawlScrape).mockResolvedValue({
      markdown: `# Acme\n\n${LONG}`,
      title: "Acme",
      description: "Payroll for platform teams",
    });

    const result = await scrapeDomain("https://www.acme.com/");
    expect(result).toMatchObject({ ok: true, reader: "firecrawl", title: "Acme" });
    expect(result.text).toBe(`Payroll for platform teams\n\n# Acme\n\n${LONG}`.slice(0, 6000));
    expect(firecrawlScrape).toHaveBeenCalledWith("https://www.acme.com/");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the plain fetch when Firecrawl fails", async () => {
    vi.mocked(isFirecrawlConfigured).mockReturnValue(true);
    vi.mocked(firecrawlScrape).mockRejectedValue(new Error("Firecrawl scrape failed (402)"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await scrapeDomain("acme.com");
    expect(result).toMatchObject({ ok: true, reader: "fetch" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/firecrawl failed.*falling back/));
    warn.mockRestore();
  });

  // A render that came back as a shell is not a read: the plain scraper gets
  // its turn rather than the model being handed forty characters of nav.
  it("falls back when Firecrawl returns too little to suggest from", async () => {
    vi.mocked(isFirecrawlConfigured).mockReturnValue(true);
    vi.mocked(firecrawlScrape).mockResolvedValue({ markdown: "Home Login", title: "Acme", description: null });

    const result = await scrapeDomain("acme.com");
    expect(result).toMatchObject({ ok: true, reader: "fetch" });
  });

  it("reports the plain scraper's failure when both readers come up empty", async () => {
    vi.mocked(isFirecrawlConfigured).mockReturnValue(true);
    vi.mocked(firecrawlScrape).mockResolvedValue({ markdown: "", title: null, description: null });
    fetchMock.mockResolvedValue(new Response("nope", { status: 503 }));

    const result = await scrapeDomain("acme.com");
    expect(result).toMatchObject({ ok: false, error: "Site returned 503." });
  });
});

describe("scrapeDomain — SSRF guard applies to both readers", () => {
  it("refuses an internal host before it can reach Firecrawl", async () => {
    vi.mocked(isFirecrawlConfigured).mockReturnValue(true);

    const result = await scrapeDomain("http://app.localhost:3000");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/can't fetch that host/);
    expect(firecrawlScrape).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a private address with the plain reader too", async () => {
    const result = await scrapeDomain("http://169.254.169.254/latest/meta-data");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects something that isn't a domain at all", async () => {
    const result = await scrapeDomain("not a url");
    expect(result).toEqual({ ok: false, error: "That doesn't look like a valid domain." });
  });
});

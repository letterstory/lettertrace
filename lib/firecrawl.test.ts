import { afterEach, describe, expect, it, vi } from "vitest";
import { firecrawlScrape, isFirecrawlConfigured, firecrawlBaseUrl } from "@/lib/firecrawl";

afterEach(() => vi.unstubAllEnvs());

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("firecrawl", () => {
  it("is inert without a key", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    expect(isFirecrawlConfigured()).toBe(false);
    await expect(firecrawlScrape("https://acme.com")).rejects.toThrow(/not configured/);
  });

  it("uses the public API by default and an override when set", () => {
    vi.stubEnv("FIRECRAWL_BASE_URL", "");
    expect(firecrawlBaseUrl()).toBe("https://api.firecrawl.dev");
    vi.stubEnv("FIRECRAWL_BASE_URL", "https://fc.internal.example/");
    expect(firecrawlBaseUrl()).toBe("https://fc.internal.example");
  });

  it("scrapes one URL as markdown, JS-rendered, main content only", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    vi.stubEnv("FIRECRAWL_BASE_URL", "");
    const fetchImpl = fetchReturning(200, {
      success: true,
      data: {
        markdown: "  # Acme\n\nPayroll for platform teams.  ",
        metadata: { title: " Acme — payroll ", description: " Payroll, done. " },
      },
    });

    const page = await firecrawlScrape("https://acme.com", { fetchImpl, timeoutMs: 20_000 });
    expect(page).toEqual({
      markdown: "# Acme\n\nPayroll for platform teams.",
      title: "Acme — payroll",
      description: "Payroll, done.",
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fc-test");
    expect(JSON.parse(init.body as string)).toEqual({
      url: "https://acme.com",
      formats: ["markdown"],
      onlyMainContent: true,
      // Firecrawl's own budget sits under ours, so its timeout arrives as a
      // clean envelope rather than as our abort.
      timeout: 15_000,
    });
  });

  it("falls back to the og description when the meta one is missing", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    const fetchImpl = fetchReturning(200, {
      success: true,
      data: { markdown: "hello", metadata: { ogDescription: "From OG" } },
    });
    const page = await firecrawlScrape("https://acme.com", { fetchImpl });
    expect(page.description).toBe("From OG");
    expect(page.title).toBeNull();
  });

  it("throws on an error envelope, with Firecrawl's reason", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    const fetchImpl = fetchReturning(402, { success: false, error: "Insufficient credits" });
    await expect(firecrawlScrape("https://acme.com", { fetchImpl })).rejects.toThrow(
      /402.*Insufficient credits/,
    );
  });

  it("throws on a non-JSON failure without masking the status", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    const fetchImpl = vi.fn(
      async () => new Response("<html>bad gateway</html>", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(firecrawlScrape("https://acme.com", { fetchImpl })).rejects.toThrow(/502/);
  });
});

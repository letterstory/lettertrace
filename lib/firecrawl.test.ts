import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firecrawlEnabled, firecrawlScrape, TOO_LITTLE_CONTENT } from "@/lib/firecrawl";

// Enough characters to clear MIN_CONTENT_CHARS without saying anything.
const BODY = "Acme builds payment infrastructure for the internet and more.";

function okResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

function statusResponse(status: number) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

function success(overrides: Record<string, unknown> = {}) {
  return okResponse({
    success: true,
    data: {
      markdown: BODY,
      metadata: {
        title: "Acme",
        description: "Payments for the internet",
        ogSiteName: "Acme",
        ogImage: "https://acme.com/card.png",
        sourceURL: "https://acme.com/",
        statusCode: 200,
        ...(overrides.metadata as Record<string, unknown> | undefined),
      },
      ...(overrides.data as Record<string, unknown> | undefined),
    },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.FIRECRAWL_API_KEY = "fc-test-key";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  delete process.env.FIRECRAWL_API_KEY;
  vi.unstubAllGlobals();
});

describe("firecrawlEnabled", () => {
  // A blank line in a .env file is a variable someone chose not to set. Reading
  // "" as configured would send every scrape to Firecrawl with an empty bearer
  // token and 401 the whole onboarding flow instead of using the built-in reader.
  it("reads unset, empty and whitespace-only as not configured", () => {
    delete process.env.FIRECRAWL_API_KEY;
    expect(firecrawlEnabled()).toBe(false);
    process.env.FIRECRAWL_API_KEY = "";
    expect(firecrawlEnabled()).toBe(false);
    process.env.FIRECRAWL_API_KEY = "   ";
    expect(firecrawlEnabled()).toBe(false);
    process.env.FIRECRAWL_API_KEY = "fc-1";
    expect(firecrawlEnabled()).toBe(true);
  });
});

describe("firecrawlScrape request", () => {
  it("posts the url to the scrape endpoint with the key as a bearer token", async () => {
    fetchMock.mockResolvedValue(success());
    await firecrawlScrape("https://acme.com/");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer fc-test-key");
    expect(JSON.parse(init.body)).toEqual({
      url: "https://acme.com/",
      formats: ["markdown"],
      onlyMainContent: true,
    });
  });

  it("refuses to call out at all when no key is configured", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const res = await firecrawlScrape("https://acme.com/");
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("firecrawlScrape parsing", () => {
  it("maps markdown and metadata onto the shared scrape shape", async () => {
    fetchMock.mockResolvedValue(success());
    const res = await firecrawlScrape("https://acme.com/");
    expect(res).toMatchObject({
      ok: true,
      url: "https://acme.com/",
      title: "Acme",
      siteName: "Acme",
      description: "Payments for the internet",
      imageUrl: "https://acme.com/card.png",
      text: BODY,
    });
  });

  it("falls back through the metadata a site actually declares", async () => {
    fetchMock.mockResolvedValue(
      success({
        metadata: {
          title: undefined,
          ogTitle: "Acme Inc",
          ogSiteName: undefined,
          description: undefined,
          ogDescription: "Payments",
          ogImage: undefined,
          favicon: "https://acme.com/favicon.ico",
        },
      }),
    );
    const res = await firecrawlScrape("https://acme.com/");
    expect(res.title).toBe("Acme Inc");
    expect(res.siteName).toBeUndefined();
    expect(res.description).toBe("Payments");
    expect(res.imageUrl).toBe("https://acme.com/favicon.ico");
  });

  it("treats blank metadata strings as absent, not as values", async () => {
    fetchMock.mockResolvedValue(
      success({ metadata: { title: "   ", ogTitle: "Acme", ogImage: "" } }),
    );
    const res = await firecrawlScrape("https://acme.com/");
    expect(res.title).toBe("Acme");
    expect(res.imageUrl).toBeUndefined();
  });
});

describe("firecrawlScrape guards", () => {
  // A 200 from Firecrawl only means Firecrawl worked. Without this the
  // boilerplate on a 404 page gets scraped and handed to the model as if it
  // described the brand, and onboarding suggests topics for "Page not found".
  it("reports the site's own status when the page 4xx'd", async () => {
    fetchMock.mockResolvedValue(success({ metadata: { statusCode: 404 } }));
    const res = await firecrawlScrape("https://acme.com/nope");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Site returned 404.");
  });

  // A cookie wall or a bare SPA shell returns 200 with a handful of words. That
  // scans as a successful read and produces invented topics.
  it.each([
    ["missing markdown", {}],
    ["empty markdown", { markdown: "" }],
    ["whitespace only", { markdown: "   \n\t  " }],
    ["under the floor", { markdown: "Acme. Hello there, welcome." }],
  ])("refuses a 200 with %s", async (_label, data) => {
    fetchMock.mockResolvedValue(success({ data: { markdown: undefined, ...data } }));
    const res = await firecrawlScrape("https://acme.com/");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(TOO_LITTLE_CONTENT);
  });

  it("refuses a body that says success: false", async () => {
    fetchMock.mockResolvedValue(okResponse({ success: false, error: "Site unreachable" }));
    const res = await firecrawlScrape("https://acme.com/");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Site unreachable");
  });

  it("survives a response that isn't JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    const res = await firecrawlScrape("https://acme.com/");
    expect(res.ok).toBe(false);
  });
});

describe("firecrawlScrape errors name the fix", () => {
  // These reach the operator's logs, not the end user. "HTTP 402" is a puzzle;
  // "out of credits, top up or unset the key" is an instruction.
  it.each([
    [401, /FIRECRAWL_API_KEY/],
    [403, /FIRECRAWL_API_KEY/],
    [402, /credits/i],
    [429, /rate limit/i],
    [500, /500/],
  ])("explains a %i", async (status, expected) => {
    fetchMock.mockResolvedValue(statusResponse(status));
    const res = await firecrawlScrape("https://acme.com/");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(expected);
  });

  it("reports a timeout as the site being slow", async () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    fetchMock.mockRejectedValue(err);
    const res = await firecrawlScrape("https://acme.com/");
    expect(res.error).toBe("The site took too long to respond.");
  });

  // Never throws: lib/scrape.ts falls back on `ok: false`, and a throw here
  // would take the whole read down instead of reaching the built-in reader.
  it("returns a result rather than throwing when the network fails", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(firecrawlScrape("https://acme.com/")).resolves.toMatchObject({ ok: false });
  });
});

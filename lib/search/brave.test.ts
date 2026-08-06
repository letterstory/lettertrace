import { describe, it, expect, vi, afterEach } from "vitest";
import { braveProvider } from "@/lib/search/brave";
import { SearchRateLimitError } from "@/lib/search/types";

function mockFetch(status: number, body: unknown = {}) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fn);
  return fn as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => vi.unstubAllGlobals());

describe("braveProvider.search", () => {
  it("normalizes results with 1-based ranks and trims empty fields", async () => {
    mockFetch(200, {
      web: {
        results: [
          { url: "https://reddit.com/r/seo/1", title: "Thread", description: "snippet" },
          { url: "https://reddit.com/r/seo/2", title: "", description: "  " },
          { title: "no url — dropped" },
        ],
      },
    });
    const results = await braveProvider.search("key", "site:reddit.com acme");
    expect(results).toEqual([
      { url: "https://reddit.com/r/seo/1", title: "Thread", snippet: "snippet", rank: 1 },
      { url: "https://reddit.com/r/seo/2", title: null, snippet: null, rank: 2 },
    ]);
  });

  it("returns empty for a payload with no web results", async () => {
    mockFetch(200, {});
    expect(await braveProvider.search("key", "q")).toEqual([]);
  });

  it("passes the freshness window through as Brave's code", async () => {
    const fn = mockFetch(200, {});
    await braveProvider.search("key", "q", { freshness: "week" });
    expect(String(fn.mock.calls[0][0])).toContain("freshness=pw");
    await braveProvider.search("key", "q", { freshness: "year" });
    expect(String(fn.mock.calls[1][0])).toContain("freshness=py");
  });

  it("clamps count to Brave's page-size ceiling instead of 422ing", async () => {
    const fn = mockFetch(200, {});
    await braveProvider.search("key", "q", { count: 50 });
    expect(String(fn.mock.calls[0][0])).toContain("count=20");
  });

  it("throws the distinct rate-limit error on 429", async () => {
    mockFetch(429);
    await expect(braveProvider.search("key", "q")).rejects.toBeInstanceOf(SearchRateLimitError);
  });

  it("throws a key error on 401", async () => {
    mockFetch(401);
    await expect(braveProvider.search("key", "q")).rejects.toThrow(/rejected the API key/);
  });
});

describe("braveProvider.verifyKey", () => {
  it("accepts a key the API accepts", async () => {
    mockFetch(200, {});
    expect(await braveProvider.verifyKey("key")).toEqual({ ok: true });
  });

  it("rejects a key the API rejects", async () => {
    mockFetch(401);
    const out = await braveProvider.verifyKey("bad");
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/rejected/);
  });

  // An invalid key can't be rate-limited; refusing to store it on a 429
  // would blame the user's key for our probe timing.
  it("treats a 429 during verification as a valid key", async () => {
    mockFetch(429);
    expect(await braveProvider.verifyKey("key")).toEqual({ ok: true });
  });

  it("reports unreachable rather than rejecting the key on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNRESET"))));
    const out = await braveProvider.verifyKey("key");
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/reach/i);
  });
});

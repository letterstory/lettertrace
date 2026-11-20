import { describe, it, expect, vi, afterEach } from "vitest";
import { keenableProvider } from "@/lib/search/keenable";
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

describe("keenableProvider.search", () => {
  it("normalizes results with 1-based ranks and prefers description over snippet", async () => {
    mockFetch(200, {
      results: [
        { url: "https://reddit.com/r/seo/1", title: "Thread", description: "short", snippet: "long" },
        { url: "https://reddit.com/r/seo/2", title: "", snippet: "  fallback  " },
        { title: "no url — dropped" },
      ],
    });
    const results = await keenableProvider.search("", "site:reddit.com acme");
    expect(results).toEqual([
      { url: "https://reddit.com/r/seo/1", title: "Thread", snippet: "short", rank: 1 },
      { url: "https://reddit.com/r/seo/2", title: null, snippet: "fallback", rank: 2 },
    ]);
  });

  it("uses the public endpoint without a key and the keyed endpoint with one", async () => {
    const fn = mockFetch(200, { results: [] });
    await keenableProvider.search("", "q");
    expect(fn.mock.calls[0][0]).toBe("https://api.keenable.ai/v1/search/public");
    expect(fn.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { "X-Keenable-Title": "Lettertrace" },
    });
    expect(fn.mock.calls[0][1].headers["X-API-Key"]).toBeUndefined();

    await keenableProvider.search("secret-key", "q");
    expect(fn.mock.calls[1][0]).toBe("https://api.keenable.ai/v1/search");
    expect(fn.mock.calls[1][1].headers["X-API-Key"]).toBe("secret-key");
  });

  it("returns empty for a payload with no results", async () => {
    mockFetch(200, {});
    expect(await keenableProvider.search("", "q")).toEqual([]);
  });

  it("passes the freshness window through as published_after", async () => {
    const fn = mockFetch(200, {});
    await keenableProvider.search("", "q", { freshness: "week" });
    expect(JSON.parse(fn.mock.calls[0][1].body)).toMatchObject({ published_after: "7d" });
    await keenableProvider.search("", "q", { freshness: "year" });
    expect(JSON.parse(fn.mock.calls[1][1].body)).toMatchObject({ published_after: "1y" });
  });

  it("clamps count to Keenable's page-size ceiling", async () => {
    const fn = mockFetch(200, {});
    await keenableProvider.search("", "q", { count: 80 });
    expect(JSON.parse(fn.mock.calls[0][1].body).max_results).toBe(50);
  });

  it("throws the distinct rate-limit error on 429", async () => {
    mockFetch(429);
    await expect(keenableProvider.search("", "q")).rejects.toBeInstanceOf(SearchRateLimitError);
  });

  it("throws a key error on 401 when a key was sent", async () => {
    mockFetch(401);
    await expect(keenableProvider.search("bad", "q")).rejects.toThrow(/rejected the API key/);
  });
});

describe("keenableProvider.verifyKey", () => {
  it("accepts a key the API accepts", async () => {
    mockFetch(200, {});
    expect(await keenableProvider.verifyKey("key")).toEqual({ ok: true });
  });

  it("rejects a key the API rejects", async () => {
    mockFetch(401);
    const out = await keenableProvider.verifyKey("bad");
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/rejected/);
  });

  it("treats a 429 during verification as a valid key", async () => {
    mockFetch(429);
    expect(await keenableProvider.verifyKey("key")).toEqual({ ok: true });
  });

  it("reports unreachable rather than rejecting the key on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNRESET"))));
    const out = await keenableProvider.verifyKey("key");
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/reach/i);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runQuery,
  verifyKey,
  generateVariations,
  analyzeResponse,
  suggestCompetitors,
  humanError,
  stripReasoning,
  perplexitySources,
  PerplexityAPIError,
} from "./index";
import { PROVIDERS } from "@/lib/models";

// ------------------------------------------------------------------
// Perplexity (Sonar) adapter. Mocked fetch throughout — the subject is the
// request we build and the responses we survive, not Perplexity's behaviour.
//
// Two things make this adapter different from the others and drive most of
// what's asserted here:
//   1. It always searches. There is no ungrounded mode to fall back to, so the
//      sources are part of every answer rather than an opt-in.
//   2. sonar-reasoning-pro streams its chain of thought inline, in <think>
//      tags, ahead of the answer. Stored unstripped, that text gets scanned for
//      brand mentions — and a model musing about a competitor would be counted
//      as a mention the answer never made.
// ------------------------------------------------------------------

const KEY = "pplx-test-key";
const API_URL = "https://api.perplexity.ai/v1/sonar";

function ok(
  content: string,
  extra: {
    search_results?: { title?: string; url?: string; snippet?: string }[];
    citations?: string[];
    usage?: Record<string, number>;
    finish_reason?: string;
  } = {},
) {
  return {
    id: "x",
    model: "sonar-pro",
    choices: [
      { message: { role: "assistant", content }, finish_reason: extra.finish_reason ?? "stop" },
    ],
    ...(extra.search_results ? { search_results: extra.search_results } : {}),
    ...(extra.citations ? { citations: extra.citations } : {}),
    usage: extra.usage ?? { total_tokens: 42 },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Queue of responses; the last one repeats once exhausted. */
function mockFetch(...responses: Response[]) {
  let i = 0;
  fetchMock = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);
  vi.stubGlobal("fetch", fetchMock);
}

function sentBody(call = 0): Record<string, any> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

function sentHeaders(call = 0): Record<string, string> {
  return fetchMock.mock.calls[call][1].headers as Record<string, string>;
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --- Request construction -------------------------------------------------

describe("perplexity runQuery — request shape", () => {
  it("posts to the canonical /v1/sonar endpoint with a bearer key", async () => {
    mockFetch(jsonResponse(ok("hi")));
    await runQuery({ provider: "perplexity", model: "sonar-pro", apiKey: KEY, prompt: "q" });
    expect(fetchMock.mock.calls[0][0]).toBe(API_URL);
    expect(sentHeaders().authorization).toBe(`Bearer ${KEY}`);
  });

  it("sends the prompt as a user message with the chosen model", async () => {
    mockFetch(jsonResponse(ok("hi")));
    await runQuery({ provider: "perplexity", model: "sonar-pro", apiKey: KEY, prompt: "best cdn?" });
    const body = sentBody();
    expect(body.model).toBe("sonar-pro");
    expect(body.messages).toEqual([{ role: "user", content: "best cdn?" }]);
  });

  // The decision this locks in: Perplexity is a search engine, so an ungrounded
  // Sonar answer doesn't correspond to anything a real user ever sees. The
  // project's web-search toggle deliberately does not reach it.
  it("always searches, even when the project has web search off", async () => {
    mockFetch(jsonResponse(ok("hi")));
    await runQuery({
      provider: "perplexity",
      model: "sonar-pro",
      apiKey: KEY,
      prompt: "q",
      webSearch: false,
    });
    expect(sentBody().disable_search).toBeUndefined();
  });

  // The mirror of the above: utility calls reason over text we supply. Letting
  // them search is pure cost, and a search result could contaminate a judgment
  // that is supposed to be about the text we passed in.
  it("disables search on utility calls", async () => {
    mockFetch(jsonResponse(ok('["a","b"]')));
    await generateVariations({
      provider: "perplexity",
      model: "sonar",
      apiKey: KEY,
      topicName: "cdn",
      count: 2,
    });
    expect(sentBody().disable_search).toBe(true);
  });

  // Measured: Perplexity 400s on anything below 16 with "max_tokens must be at
  // least 16". verifyKey's probe budget was copied from the Google adapter (8),
  // which made a perfectly valid key report as invalid — the failure mode this
  // whole codebase tries hardest to avoid.
  it("never requests fewer than the 16 tokens Perplexity requires", async () => {
    mockFetch(jsonResponse(ok("pong")));
    await verifyKey("perplexity", KEY);
    expect(sentBody().max_tokens).toBeGreaterThanOrEqual(16);
  });

  it("bounds each attempt with an abort signal so a call can't hang", async () => {
    mockFetch(jsonResponse(ok("hi")));
    await runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

// --- Reasoning-model chain of thought -------------------------------------

describe("chain-of-thought stripping", () => {
  it("removes a <think> block and keeps the answer", () => {
    expect(stripReasoning("<think>maybe Cloudflare?</think>\n\nFastly is best.")).toBe(
      "Fastly is best.",
    );
  });

  it("is case-insensitive and handles multiple blocks", () => {
    expect(stripReasoning("<THINK>a</THINK>X<think>b</think>Y")).toBe("XY");
  });

  it("leaves an ordinary answer untouched", () => {
    expect(stripReasoning("Cloudflare and Fastly.")).toBe("Cloudflare and Fastly.");
  });

  // The measurement bug this prevents: deliberation naming a brand the answer
  // never recommends would be stored as the response and counted as a mention.
  it("strips reasoning before the answer is returned from runQuery", async () => {
    mockFetch(jsonResponse(ok("<think>The user may mean Akamai.</think>Fastly leads.")));
    const res = await runQuery({
      provider: "perplexity",
      model: "sonar-reasoning-pro",
      apiKey: KEY,
      prompt: "q",
    });
    expect(res.text).toBe("Fastly leads.");
    expect(res.text).not.toMatch(/Akamai/);
  });
});

// --- Sources --------------------------------------------------------------

describe("perplexity sources", () => {
  it("prefers search_results, keeping title and snippet", () => {
    const sources = perplexitySources({
      search_results: [
        { title: "Best CDNs", url: "https://example.com/a", snippet: "..." },
        { title: "More", url: "https://www.Cloudflare.com/b", snippet: null as never },
      ],
    } as never);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ domain: "example.com", title: "Best CDNs" });
    // www. stripped and lowercased, so is_owned matching works on the domain.
    expect(sources[1].domain).toBe("cloudflare.com");
  });

  it("falls back to bare citations when search_results is absent", () => {
    const sources = perplexitySources({ citations: ["https://example.com/x"] } as never);
    expect(sources).toEqual([
      { url: "https://example.com/x", domain: "example.com", title: null, snippet: null },
    ]);
  });

  it("ignores citations when search_results already carried sources", () => {
    const sources = perplexitySources({
      search_results: [{ url: "https://a.com/1" }],
      citations: ["https://b.com/2"],
    } as never);
    expect(sources.map((s) => s.domain)).toEqual(["a.com"]);
  });

  it("drops unsafe and duplicate URLs", () => {
    const sources = perplexitySources({
      search_results: [
        { url: "javascript:alert(1)" },
        { url: "https://a.com/1" },
        { url: "https://a.com/1" },
        { url: "not a url" },
      ],
    } as never);
    expect(sources.map((s) => s.url)).toEqual(["https://a.com/1"]);
  });

  it("attaches sources to a monitored answer", async () => {
    mockFetch(
      jsonResponse(
        ok("Fastly and Cloudflare.", {
          search_results: [{ title: "t", url: "https://cloudflare.com/x", snippet: "s" }],
        }),
      ),
    );
    const res = await runQuery({ provider: "perplexity", model: "sonar-pro", apiKey: KEY, prompt: "q" });
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0].domain).toBe("cloudflare.com");
  });
});

// --- Token accounting -----------------------------------------------------

describe("perplexity token accounting", () => {
  it("uses total_tokens when present", async () => {
    mockFetch(jsonResponse(ok("hi", { usage: { total_tokens: 123 } })));
    const res = await runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" });
    expect(res.tokens).toBe(123);
  });

  // citation_tokens and reasoning_tokens are billed but are NOT part of
  // completion_tokens, so a fallback that omits them under-meters the trial.
  it("adds citation and reasoning tokens in the fallback", async () => {
    mockFetch(
      jsonResponse(
        ok("hi", {
          usage: { prompt_tokens: 10, completion_tokens: 20, citation_tokens: 30, reasoning_tokens: 40 },
        }),
      ),
    );
    const res = await runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" });
    expect(res.tokens).toBe(100);
  });
});

// --- 200-but-unusable -----------------------------------------------------

describe("perplexity 200-but-unusable responses", () => {
  // Every one of these is silent: the call succeeds, the stored response is
  // empty, and the run reports "brand not mentioned" for a question that was
  // never answered. Failing the call lets the engine record the real reason.
  it("fails a 200 with no choices", async () => {
    mockFetch(jsonResponse({ id: "x", usage: { total_tokens: 9 } }));
    await expect(
      runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" }),
    ).rejects.toThrow(/no choices/i);
  });

  it("fails a 200 whose answer is empty", async () => {
    mockFetch(jsonResponse(ok("   ")));
    await expect(
      runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" }),
    ).rejects.toThrow(/empty answer/i);
  });

  it("fails when a reasoning model spent the whole budget thinking", async () => {
    mockFetch(jsonResponse(ok("<think>still deliberating…</think>")));
    await expect(
      runQuery({ provider: "perplexity", model: "sonar-reasoning-pro", apiKey: KEY, prompt: "q" }),
    ).rejects.toThrow(/empty answer/i);
  });

  it("does not retry an unusable 200 — the tokens are already spent", async () => {
    mockFetch(jsonResponse(ok("")));
    await expect(
      runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// --- HTTP errors and retries ---------------------------------------------

describe("perplexity HTTP errors", () => {
  it("surfaces a bad key immediately, without retrying", async () => {
    mockFetch(jsonResponse({ error: { message: "Unauthorized" } }, 401));
    await expect(
      runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers when a transient 503 is followed by a success", async () => {
    vi.useFakeTimers();
    mockFetch(jsonResponse({ error: { message: "busy" } }, 503), jsonResponse(ok("hi")));
    const p = runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ text: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Same lesson as the Gemini 429: a rate-limit window doesn't care about our
  // exponential backoff, so retrying inside it burns every attempt in seconds.
  it("waits as long as Retry-After asks, not the exponential backoff", async () => {
    vi.useFakeTimers();
    mockFetch(
      jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "12" }),
      jsonResponse(ok("hi")),
    );
    const p = runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the 400ms backoff would have fired by now
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(p).resolves.toMatchObject({ text: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up rather than blocking on a window it can't wait out", async () => {
    vi.useFakeTimers();
    mockFetch(jsonResponse({ error: { message: "daily cap" } }, 429, { "retry-after": "3600" }));
    const p = runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" });
    const rejected = expect(p).rejects.toThrow(/daily cap/);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an HTTP-date Retry-After", async () => {
    vi.useFakeTimers();
    const when = new Date(Date.now() + 10_000).toUTCString();
    mockFetch(jsonResponse({ error: { message: "wait" } }, 429, { "retry-after": when }), jsonResponse(ok("hi")));
    const p = runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(p).resolves.toMatchObject({ text: "hi" });
  });

  it("retries a dropped connection", async () => {
    vi.useFakeTimers();
    let calls = 0;
    fetchMock = vi.fn(async () => {
      if (++calls === 1) throw new TypeError("fetch failed");
      return jsonResponse(ok("hi"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = runQuery({ provider: "perplexity", model: "sonar", apiKey: KEY, prompt: "q" });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ text: "hi" });
    expect(calls).toBe(2);
  });
});

// --- verifyKey ------------------------------------------------------------

describe('verifyKey("perplexity")', () => {
  it("probes with a model the catalog actually offers", async () => {
    mockFetch(jsonResponse(ok("pong")));
    const res = await verifyKey("perplexity", KEY);
    expect(res.ok).toBe(true);
    expect(PROVIDERS.perplexity.models.map((m) => m.id)).toContain(sentBody().model);
  });

  it("does not search while verifying — a probe should cost nothing extra", async () => {
    mockFetch(jsonResponse(ok("pong")));
    await verifyKey("perplexity", KEY);
    expect(sentBody().disable_search).toBe(true);
  });

  it("reports a bad key as an invalid key, not a raw provider string", async () => {
    mockFetch(jsonResponse({ error: { message: "invalid api key provided" } }, 401));
    await expect(verifyKey("perplexity", "pplx-nope")).resolves.toEqual({
      ok: false,
      error: "Invalid API key.",
    });
  });
});

// --- utility calls --------------------------------------------------------

describe("perplexity JSON utility calls", () => {
  it("parses variations out of a fenced JSON reply", async () => {
    mockFetch(jsonResponse(ok('```json\n["a","b","c"]\n```')));
    const res = await generateVariations({
      provider: "perplexity",
      model: "sonar",
      apiKey: KEY,
      topicName: "cdn",
      count: 3,
    });
    expect(res.variations).toEqual(["a", "b", "c"]);
  });

  it("classifies sentiment and attributes rows to the right entity", async () => {
    mockFetch(
      jsonResponse(
        ok(
          '{"results":[{"key":"brand","sentiment":"positive","recommended":true},{"key":"c1","sentiment":"negative","recommended":false}]}',
        ),
      ),
    );
    const res = await analyzeResponse({
      provider: "perplexity",
      model: "sonar",
      apiKey: KEY,
      question: "q",
      responseText: "a",
      entities: [
        { key: "brand", name: "Cloudflare" },
        { key: "c1", name: "Akamai" },
      ],
    });
    expect(res.results).toEqual([
      { key: "brand", sentiment: "positive", recommended: true },
      { key: "c1", sentiment: "negative", recommended: false },
    ]);
  });

  // Enrichment must never fail a run: a broken classification degrades to
  // neutral rather than throwing away an answer we already paid for.
  it("degrades to neutral rather than failing the run", async () => {
    mockFetch(jsonResponse({ error: { message: "boom" } }, 401));
    const res = await analyzeResponse({
      provider: "perplexity",
      model: "sonar",
      apiKey: KEY,
      question: "q",
      responseText: "a",
      entities: [{ key: "brand", name: "Cloudflare" }],
    });
    expect(res.results).toEqual([{ key: "brand", sentiment: "neutral", recommended: false }]);
  });

  it("suggests competitors", async () => {
    mockFetch(jsonResponse(ok('{"competitors":[{"name":"Fastly","domain":"https://Fastly.com/x"}]}')));
    const res = await suggestCompetitors({
      provider: "perplexity",
      model: "sonar",
      apiKey: KEY,
      brandName: "Cloudflare",
      topics: ["CDN"],
      existing: [],
      count: 1,
    });
    // domain is normalised: scheme stripped, lowercased, path dropped.
    expect(res.suggestions[0]).toMatchObject({ name: "Fastly", domain: "fastly.com" });
  });
});

// --- humanError -----------------------------------------------------------

describe("humanError for perplexity", () => {
  it("maps auth failures to an invalid key", () => {
    expect(humanError(new PerplexityAPIError(401, "nope"))).toBe("Invalid API key.");
    expect(humanError(new PerplexityAPIError(403, "nope"))).toBe("Invalid API key.");
  });

  it("names credit exhaustion distinctly from a rate limit", () => {
    expect(humanError(new PerplexityAPIError(402, "no funds"))).toMatch(/out of credit/i);
  });

  // "Rate limited" reads as "we went too fast" and invites a pointless retry;
  // on Perplexity a 429 is usually the key's usage tier.
  it("explains a 429 as a tier problem and includes the advised wait", () => {
    const msg = humanError(new PerplexityAPIError(429, "slow down", 38));
    expect(msg).toMatch(/rate limit/i);
    expect(msg).toMatch(/usage tier/i);
    expect(msg).toMatch(/wait 38s/);
  });

  it("maps server errors to a retryable message", () => {
    expect(humanError(new PerplexityAPIError(503, "boom"))).toBe(
      "The AI provider had a temporary error. Please try again.",
    );
  });
});

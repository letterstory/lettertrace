import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runQuery,
  verifyKey,
  generateVariations,
  analyzeResponse,
  suggestFromSite,
  suggestCompetitors,
  humanError,
  GoogleAPIError,
} from "./index";
import { GOOGLE_AI_OVERVIEWS_MODEL, PROVIDERS } from "@/lib/models";

// ------------------------------------------------------------------
// Google (Gemini) adapter. Everything here runs against a mocked fetch — the
// point is the request we build and the responses we survive, not Google's
// behaviour. Live behaviour is probed separately, out of the test suite.
//
// The bugs this is guarding against are all of one kind: a call that looks like
// it worked and measures nothing. A retired model id, a grounding tool that
// never fires, a 200 with no answer in it — none of these throw on their own.
// ------------------------------------------------------------------

const KEY = "AIzaTestKey";

/** A minimal successful generateContent body. */
function ok(
  text: string,
  extra: {
    finishReason?: string;
    groundingChunks?: { web?: { uri?: string; title?: string } }[];
    usage?: Record<string, number>;
    parts?: { text?: string; thought?: boolean }[];
  } = {},
) {
  return {
    candidates: [
      {
        content: { parts: extra.parts ?? [{ text }] },
        finishReason: extra.finishReason ?? "STOP",
        ...(extra.groundingChunks
          ? { groundingMetadata: { groundingChunks: extra.groundingChunks } }
          : {}),
      },
    ],
    usageMetadata: extra.usage ?? { totalTokenCount: 42 },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Queue of responses; the last one repeats once exhausted. */
function mockFetch(...responses: Response[]) {
  let i = 0;
  fetchMock = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);
  vi.stubGlobal("fetch", fetchMock);
}

/** The parsed JSON body of the nth fetch call (default: the first). */
function sentBody(call = 0): Record<string, any> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

function sentUrl(call = 0): string {
  return fetchMock.mock.calls[call][0] as string;
}

/** The model id that actually went on the wire. */
function wireModel(call = 0): string {
  return sentUrl(call).match(/\/models\/([^:]+):/)![1];
}

const GOOGLE_MODEL_IDS = PROVIDERS.google.models.map((m) => m.id);
const REAL_GOOGLE_MODEL_IDS = GOOGLE_MODEL_IDS.filter((id) => id !== GOOGLE_AI_OVERVIEWS_MODEL);

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --- Request construction -------------------------------------------------

describe("google runQuery — request shape", () => {
  it("calls generateContent for the selected model with the key in the header", async () => {
    mockFetch(jsonResponse(ok("hi")));
    await runQuery({ provider: "google", model: "gemini-pro-latest", apiKey: KEY, prompt: "q" });

    expect(sentUrl()).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent",
    );
    expect(fetchMock.mock.calls[0][1].headers["x-goog-api-key"]).toBe(KEY);
    expect(sentBody().contents).toEqual([{ role: "user", parts: [{ text: "q" }] }]);
  });

  it("does not ground, and sends no system prompt, when web search is off", async () => {
    mockFetch(jsonResponse(ok("hi")));
    const res = await runQuery({
      provider: "google",
      model: "gemini-flash-latest",
      apiKey: KEY,
      prompt: "q",
      webSearch: false,
    });

    expect(sentBody().tools).toBeUndefined();
    expect(sentBody().systemInstruction).toBeUndefined();
    expect(res.sources).toEqual([]);
  });

  it("offers the search tool AND instructs the model to use it when web search is on", async () => {
    mockFetch(jsonResponse(ok("hi")));
    await runQuery({
      provider: "google",
      model: "gemini-flash-latest",
      apiKey: KEY,
      prompt: "q",
      webSearch: true,
    });

    // Both halves matter: offering google_search alone measured 0/2 grounded
    // answers, because Gemini exposes no tool_choice equivalent to force it.
    expect(sentBody().tools).toEqual([{ google_search: {} }]);
    expect(sentBody().systemInstruction.parts[0].text).toMatch(/ALWAYS search the web/);
  });

  it("gives the output budget thinking headroom, well above the answer length", async () => {
    mockFetch(jsonResponse(ok("hi")));
    await runQuery({ provider: "google", model: "gemini-pro-latest", apiKey: KEY, prompt: "q" });

    // Thinking tokens come out of maxOutputTokens and cannot be disabled, so a
    // budget sized to the answer alone gets spent on thoughts (finishReason
    // MAX_TOKENS) and the answer is truncated.
    expect(sentBody().generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(4096);
  });

  it("never sends thinkingConfig — every catalog model rejects thinkingBudget: 0", async () => {
    mockFetch(jsonResponse(ok("hi")));
    await runQuery({ provider: "google", model: "gemini-flash-latest", apiKey: KEY, prompt: "q" });
    expect(sentBody().generationConfig.thinkingConfig).toBeUndefined();
  });
});

describe("google AI Overviews pseudo-model", () => {
  it("never puts the pseudo-model id on the wire, and backs it with a catalog model", async () => {
    mockFetch(jsonResponse(ok("overview")));
    await runQuery({
      provider: "google",
      model: GOOGLE_AI_OVERVIEWS_MODEL,
      apiKey: KEY,
      prompt: "q",
    });

    expect(wireModel()).not.toBe(GOOGLE_AI_OVERVIEWS_MODEL);
    // The backing model must be one we actually offer, or it rots out of sync
    // with the catalog the same way the pinned 2.5 ids did.
    expect(REAL_GOOGLE_MODEL_IDS).toContain(wireModel());
  });

  it("always grounds, even when the project has web search turned off", async () => {
    mockFetch(jsonResponse(ok("overview", { groundingChunks: [] })));
    await runQuery({
      provider: "google",
      model: GOOGLE_AI_OVERVIEWS_MODEL,
      apiKey: KEY,
      prompt: "q",
      webSearch: false,
    });

    // An "AI Overview" that answered from memory would be a different product.
    expect(sentBody().tools).toEqual([{ google_search: {} }]);
    expect(sentBody().systemInstruction.parts[0].text).toMatch(/AI Overview/);
    expect(sentBody().systemInstruction.parts[0].text).toMatch(/ALWAYS search the web/);
  });

  it("resolves the pseudo-model on utility calls too, so setup works on an Overviews project", async () => {
    mockFetch(jsonResponse(ok('{"description":"d","topics":[{"name":"t","prompts":["p"]}]}')));
    await suggestFromSite({
      provider: "google",
      model: GOOGLE_AI_OVERVIEWS_MODEL,
      apiKey: KEY,
      brandName: "Acme",
      siteText: "text",
    });

    expect(REAL_GOOGLE_MODEL_IDS).toContain(wireModel());
  });
});

describe("google JSON utility calls", () => {
  it("asks for a JSON response and never combines it with the search tool", async () => {
    mockFetch(jsonResponse(ok('["a","b"]')));
    const res = await generateVariations({
      provider: "google",
      model: "gemini-flash-latest",
      apiKey: KEY,
      topicName: "CDNs",
      count: 2,
    });

    expect(sentBody().generationConfig.responseMimeType).toBe("application/json");
    // Gemini answers a JSON+grounding request with 200 and no candidates at all.
    expect(sentBody().tools).toBeUndefined();
    expect(res.variations).toEqual(["a", "b"]);
  });

  it("parses a JSON object wrapper as well as a bare array", async () => {
    mockFetch(jsonResponse(ok('{"questions":["a","b","c"]}')));
    const res = await generateVariations({
      provider: "google",
      model: "gemini-flash-latest",
      apiKey: KEY,
      topicName: "CDNs",
      count: 3,
    });
    expect(res.variations).toEqual(["a", "b", "c"]);
  });

  it("parses competitor suggestions", async () => {
    mockFetch(
      jsonResponse(
        ok('{"competitors":[{"name":"Fastly","domain":"https://fastly.com/x","aliases":["F"],"reason":"r"}]}'),
      ),
    );
    const res = await suggestCompetitors({
      provider: "google",
      model: "gemini-flash-latest",
      apiKey: KEY,
      brandName: "Acme",
      topics: [],
      existing: [],
      count: 5,
    });
    expect(res.suggestions).toEqual([
      { name: "Fastly", domain: "fastly.com", aliases: ["F"], reason: "r" },
    ]);
  });

  it("classifies on the cheap analysis model, not the project's answer model", async () => {
    mockFetch(jsonResponse(ok('{"results":[{"key":"brand","sentiment":"positive","recommended":true}]}')));
    const res = await analyzeResponse({
      provider: "google",
      model: "gemini-pro-latest",
      apiKey: KEY,
      question: "q",
      responseText: "Acme is great",
      entities: [{ key: "brand", name: "Acme" }],
    });

    expect(wireModel()).toBe("gemini-flash-lite-latest");
    expect(wireModel()).not.toBe("gemini-pro-latest");
    expect(res.results).toEqual([{ key: "brand", sentiment: "positive", recommended: true }]);
  });

  it("honours ANALYSIS_GOOGLE_MODEL", async () => {
    vi.stubEnv("ANALYSIS_GOOGLE_MODEL", "gemini-flash-latest");
    mockFetch(jsonResponse(ok('{"results":[]}')));
    await analyzeResponse({
      provider: "google",
      model: "gemini-pro-latest",
      apiKey: KEY,
      question: "q",
      responseText: "t",
      entities: [{ key: "brand", name: "Acme" }],
    });
    expect(wireModel()).toBe("gemini-flash-latest");
  });
});

// --- Response parsing -----------------------------------------------------

describe("google response parsing", () => {
  it("joins text parts and drops thought parts", async () => {
    mockFetch(
      jsonResponse(
        ok("", {
          parts: [
            { text: "thinking out loud", thought: true },
            { text: "Real " },
            { text: "answer." },
          ],
        }),
      ),
    );
    const res = await runQuery({
      provider: "google",
      model: "gemini-pro-latest",
      apiKey: KEY,
      prompt: "q",
    });
    expect(res.text).toBe("Real answer.");
  });

  it("prefers totalTokenCount for usage", async () => {
    mockFetch(
      jsonResponse(
        ok("hi", { usage: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 99 } }),
      ),
    );
    const res = await runQuery({
      provider: "google",
      model: "gemini-pro-latest",
      apiKey: KEY,
      prompt: "q",
    });
    expect(res.tokens).toBe(99);
  });

  it("counts thinking tokens in the fallback when totalTokenCount is missing", async () => {
    mockFetch(
      jsonResponse(
        ok("hi", { usage: { promptTokenCount: 2, candidatesTokenCount: 14, thoughtsTokenCount: 193 } }),
      ),
    );
    const res = await runQuery({
      provider: "google",
      model: "gemini-pro-latest",
      apiKey: KEY,
      prompt: "q",
    });
    // Thinking is billed but is not part of candidatesTokenCount; leaving it out
    // under-counts trial spend several-fold.
    expect(res.tokens).toBe(209);
  });

  it("returns grounded sources with the domain taken from the chunk title", async () => {
    mockFetch(
      jsonResponse(
        ok("answer", {
          groundingChunks: [
            {
              web: {
                uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC",
                title: "fastly.com",
              },
            },
          ],
        }),
      ),
    );
    const res = await runQuery({
      provider: "google",
      model: "gemini-flash-latest",
      apiKey: KEY,
      prompt: "q",
      webSearch: true,
    });

    expect(res.sources).toHaveLength(1);
    expect(res.sources[0].domain).toBe("fastly.com");
    expect(res.sources[0].url).toContain("vertexaisearch.cloud.google.com");
  });

  it("ignores grounding chunks entirely when grounding wasn't requested", async () => {
    mockFetch(
      jsonResponse(
        ok("answer", {
          groundingChunks: [{ web: { uri: "https://example.com", title: "example.com" } }],
        }),
      ),
    );
    const res = await runQuery({
      provider: "google",
      model: "gemini-flash-latest",
      apiKey: KEY,
      prompt: "q",
      webSearch: false,
    });
    expect(res.sources).toEqual([]);
  });
});

// --- Unusable 200s --------------------------------------------------------

describe("google 200-but-unusable responses", () => {
  it("fails when the response carries no candidates", async () => {
    // Exactly what Google returns for a JSON + grounding request: 200, a bill,
    // and no `candidates` key.
    mockFetch(jsonResponse({ usageMetadata: { totalTokenCount: 1988 } }));
    await expect(
      runQuery({ provider: "google", model: "gemini-flash-latest", apiKey: KEY, prompt: "q" }),
    ).rejects.toThrow(/no candidates/i);
  });

  it("fails on MAX_TOKENS rather than storing the truncated fragment", async () => {
    mockFetch(
      jsonResponse(
        ok("", { finishReason: "MAX_TOKENS", parts: [{ text: "…OR pick **Edgio** for" }] }),
      ),
    );
    await expect(
      runQuery({ provider: "google", model: "gemini-flash-latest", apiKey: KEY, prompt: "q" }),
    ).rejects.toThrow(/MAX_TOKENS/);
  });

  it("fails on an empty answer and names the finish reason", async () => {
    mockFetch(jsonResponse(ok("", { finishReason: "SAFETY", parts: [] })));
    await expect(
      runQuery({ provider: "google", model: "gemini-flash-latest", apiKey: KEY, prompt: "q" }),
    ).rejects.toThrow(/SAFETY/);
  });

  it("does not retry an unusable 200 — the tokens are already spent", async () => {
    mockFetch(jsonResponse(ok("", { finishReason: "MAX_TOKENS", parts: [{ text: "x" }] })));
    await expect(
      runQuery({ provider: "google", model: "gemini-flash-latest", apiKey: KEY, prompt: "q" }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// --- HTTP errors and retries ---------------------------------------------

const keyError = {
  error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" },
};

describe("google HTTP errors", () => {
  it("surfaces a bad key immediately, without retrying", async () => {
    mockFetch(jsonResponse(keyError, 400));
    await expect(
      runQuery({ provider: "google", model: "gemini-pro-latest", apiKey: KEY, prompt: "q" }),
    ).rejects.toBeInstanceOf(GoogleAPIError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries the google.rpc status onto the error", async () => {
    mockFetch(jsonResponse(keyError, 400));
    const err = (await runQuery({
      provider: "google",
      model: "gemini-pro-latest",
      apiKey: KEY,
      prompt: "q",
    }).catch((e) => e)) as GoogleAPIError;
    expect(err.status).toBe(400);
    expect(err.googleStatus).toBe("INVALID_ARGUMENT");
  });

  it("does not retry a retired model id (404)", async () => {
    mockFetch(
      jsonResponse(
        { error: { code: 404, message: "This model is no longer available to new users.", status: "NOT_FOUND" } },
        404,
      ),
    );
    await expect(
      runQuery({ provider: "google", model: "gemini-2.5-pro", apiKey: KEY, prompt: "q" }),
    ).rejects.toThrow(/no longer available/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers when a transient 503 is followed by a success", async () => {
    vi.useFakeTimers();
    mockFetch(jsonResponse({ error: { code: 503, status: "UNAVAILABLE" } }, 503), jsonResponse(ok("hi")));
    const p = runQuery({ provider: "google", model: "gemini-pro-latest", apiKey: KEY, prompt: "q" });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ text: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 up to the attempt ceiling, then gives up", async () => {
    vi.useFakeTimers();
    mockFetch(jsonResponse({ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }, 429));
    const p = runQuery({ provider: "google", model: "gemini-pro-latest", apiKey: KEY, prompt: "q" });
    // Attach the rejection handler before advancing timers, or the retries
    // exhaust and reject while nothing is listening.
    const rejected = expect(p).rejects.toThrow(/Quota exceeded/);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // The failure Casey hit on the first real production run: a single-prompt run
  // burned all four attempts in about three seconds because the backoff ignored
  // the quota window Google had just told us about, then reported "rate
  // limited" as though nothing could be done.
  it("waits as long as a 429's RetryInfo asks, not the exponential backoff", async () => {
    vi.useFakeTimers();
    mockFetch(
      jsonResponse(
        {
          error: {
            code: 429,
            message: "Quota exceeded",
            status: "RESOURCE_EXHAUSTED",
            details: [
              { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" },
            ],
          },
        },
        429,
      ),
      jsonResponse(ok("hi")),
    );
    const p = runQuery({ provider: "google", model: "gemini-pro-latest", apiKey: KEY, prompt: "q" });

    // The old 400ms backoff would have fired the retry by now — and hit the
    // same spent quota window, which is exactly the bug.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(11_000);
    await expect(p).resolves.toMatchObject({ text: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up rather than blocking on a quota window it can't wait out", async () => {
    vi.useFakeTimers();
    mockFetch(
      jsonResponse(
        {
          error: {
            code: 429,
            message: "Quota exceeded",
            status: "RESOURCE_EXHAUSTED",
            // A per-day quota. Waiting is not an option; failing fast with a
            // message that says so is.
            details: [
              { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3600s" },
            ],
          },
        },
        429,
      ),
    );
    const p = runQuery({ provider: "google", model: "gemini-pro-latest", apiKey: KEY, prompt: "q" });
    const rejected = expect(p).rejects.toThrow(/Quota exceeded/);
    await vi.runAllTimersAsync();
    await rejected;
    // One attempt, no retry: the advised wait exceeded what we will block for.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a dropped connection", async () => {
    vi.useFakeTimers();
    let calls = 0;
    fetchMock = vi.fn(async () => {
      if (++calls === 1) throw new TypeError("fetch failed");
      return jsonResponse(ok("hi"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = runQuery({ provider: "google", model: "gemini-pro-latest", apiKey: KEY, prompt: "q" });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ text: "hi" });
    expect(calls).toBe(2);
  });

  it("bounds each attempt with an abort signal so a call can't hang", async () => {
    mockFetch(jsonResponse(ok("hi")));
    await runQuery({ provider: "google", model: "gemini-pro-latest", apiKey: KEY, prompt: "q" });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

// --- verifyKey ------------------------------------------------------------

describe('verifyKey("google")', () => {
  it("probes with a model the catalog actually offers", async () => {
    mockFetch(jsonResponse(ok("pong")));
    const res = await verifyKey("google", KEY);

    expect(res.ok).toBe(true);
    // A probe model outside the catalog rots independently of the picker — the
    // exact way the pinned 2.5 ids started 404ing for new keys.
    expect(REAL_GOOGLE_MODEL_IDS).toContain(wireModel());
  });

  it("reports a bad key as an invalid key, not as a 400", async () => {
    mockFetch(jsonResponse(keyError, 400));
    const res = await verifyKey("google", "AIzaBogus");
    // Google returns an invalid key as 400 INVALID_ARGUMENT, never 401.
    expect(res).toEqual({ ok: false, error: "Invalid API key." });
  });

  it("reports a model the key can't reach", async () => {
    mockFetch(jsonResponse({ error: { code: 404, status: "NOT_FOUND" } }, 404));
    const res = await verifyKey("google", KEY);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/isn't available for this key/);
  });
});

// --- Best-effort paths ----------------------------------------------------

describe("google failures that must not break a run", () => {
  it("falls back to neutral sentiment when the analysis call fails", async () => {
    mockFetch(jsonResponse(keyError, 400));
    const res = await analyzeResponse({
      provider: "google",
      model: "gemini-pro-latest",
      apiKey: KEY,
      question: "q",
      responseText: "t",
      entities: [{ key: "brand", name: "Acme" }],
    });
    expect(res.results).toEqual([{ key: "brand", sentiment: "neutral", recommended: false }]);
    expect(res.tokens).toBe(0);
  });

  it("returns no suggestions rather than throwing on unparseable JSON", async () => {
    mockFetch(jsonResponse(ok("not json at all")));
    const res = await suggestFromSite({
      provider: "google",
      model: "gemini-flash-latest",
      apiKey: KEY,
      brandName: "Acme",
      siteText: "text",
    });
    expect(res.topics).toEqual([]);
  });
});

// --- humanError -----------------------------------------------------------

describe("humanError for google", () => {
  it("maps an invalid key delivered as a 400", () => {
    expect(
      humanError(new GoogleAPIError(400, "API key not valid. Please pass a valid API key.", "INVALID_ARGUMENT")),
    ).toBe("Invalid API key.");
  });

  // "Rate limited by the provider" reads as "we went too fast" and invites a
  // pointless immediate retry. A Gemini 429 is a spent quota on the key.
  it("explains a 429 as a quota problem, not a speed problem", () => {
    const msg = humanError(new GoogleAPIError(429, "Quota exceeded", "RESOURCE_EXHAUSTED"));
    expect(msg).toMatch(/quota/i);
    expect(msg).toMatch(/Google AI Studio/);
    expect(msg).not.toBe("Rate limited by the provider.");
  });

  it("includes the wait Google asked for when it gave one", () => {
    const msg = humanError(
      new GoogleAPIError(429, "Quota exceeded", "RESOURCE_EXHAUSTED", 38),
    );
    expect(msg).toMatch(/wait 38s/);
  });

  it("maps access, retired models and server errors", () => {
    expect(humanError(new GoogleAPIError(403, "no access"))).toBe(
      "This key lacks access to the requested model.",
    );
    expect(humanError(new GoogleAPIError(404, "gone"))).toBe(
      "The requested model isn't available for this key.",
    );
    expect(humanError(new GoogleAPIError(503, "boom"))).toBe(
      "The AI provider had a temporary error. Please try again.",
    );
  });

  it("keeps an unrecognised google message rather than inventing one", () => {
    expect(humanError(new GoogleAPIError(400, "Request contains an invalid argument."))).toBe(
      "Request contains an invalid argument.",
    );
  });

  it("maps the per-attempt abort timeout instead of leaking DOM boilerplate", () => {
    // AbortSignal.timeout rejects with this; it is an Error, but its message is
    // not one of the transient patterns.
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(humanError(err)).toBe("The AI provider took too long to respond. Please try again.");
  });

  it("passes an unusable-200 message straight through to the user", () => {
    expect(humanError(new Error("Gemini returned no answer (the response contained no candidates)."))).toMatch(
      /no candidates/,
    );
  });
});

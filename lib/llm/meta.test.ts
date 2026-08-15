import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runQuery,
  verifyKey,
  generateVariations,
  analyzeResponse,
  humanError,
  metaSources,
  MetaAPIError,
} from "./index";
import { PROVIDERS, PROVIDER_LIST, analysisModelFor, defaultModelFor } from "@/lib/models";

// ------------------------------------------------------------------
// Meta (Muse Spark, via the Meta Model API) adapter. Mocked fetch throughout.
//
// Not the retired Llama API -- a different, currently-active product Meta
// launched after that one's 2026-07-06 sunset. Two things drive most of what's
// asserted here:
//   1. reasoning_effort is set on EVERY call, never left to Meta's own default
//      ("still being finalized" per Meta's own docs). This is the DeepSeek
//      lesson applied proactively: reasoning tokens share the same budget as
//      the visible answer, the exact failure that turned an 8-token DeepSeek
//      ping into an empty response. Pinning this here is what stops a future
//      edit from removing the parameter and reintroducing that failure live.
//   2. No tool_choice/forcing parameter is documented for web_search at all
//      (unlike Grok, where xai-proto at least implied one existed before it
//      was measured). Until the Tier-0 probe runs, the adapter must OFFER the
//      tool and not claim to force it -- these tests pin that honest state,
//      not a guess at what the probe will eventually find.
// ------------------------------------------------------------------

const KEY = "LLM|test|key";
const CHAT_URL = "https://api.meta.ai/v1/chat/completions";
const RESPONSES_URL = "https://api.meta.ai/v1/responses";

function chatOk(content: string, usage?: Record<string, number>) {
  return {
    id: "x",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: usage ?? { total_tokens: 42 },
  };
}

function respOk(
  text: string,
  extra: {
    annotations?: { type?: string; url?: string; title?: string }[];
    usage?: Record<string, number>;
  } = {},
) {
  return {
    id: "r",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text,
            ...(extra.annotations ? { annotations: extra.annotations } : {}),
          },
        ],
      },
    ],
    usage: extra.usage ?? { total_tokens: 99 },
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

function sentUrl(call = 0): string {
  return fetchMock.mock.calls[call][0] as string;
}
function sentBody(call = 0): Record<string, any> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

const answer = (over: Record<string, unknown> = {}) =>
  ({ provider: "meta" as const, model: "muse-spark-1.2", apiKey: KEY, prompt: "q", ...over });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// --- the monitored answer path -------------------------------------------

describe("meta runQuery", () => {
  it("answers on the Responses API with a bearer key", async () => {
    mockFetch(jsonResponse(respOk("hello")));
    const res = await runQuery(answer());
    expect(sentUrl()).toBe(RESPONSES_URL);
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(res.text).toBe("hello");
  });

  it("sets reasoning.effort on every answer call, never leaves it unset", async () => {
    // Meta's own docs say the default "is still being finalized" -- an
    // admitted unknown. This is the exact class of bug already hit live in
    // DeepSeek (default reasoning ate an 8-token budget); this test exists so
    // removing the parameter here fails CI before it fails live a second time.
    //
    // Nested, not the flat `reasoning_effort` chat-completions uses -- the
    // Responses API rejects the flat field outright with HTTP 400 (measured
    // live 2026-08-15). Getting this shape wrong doesn't degrade an answer,
    // it 400s every single monitored Meta run.
    mockFetch(jsonResponse(respOk("hi")));
    await runQuery(answer());
    expect(sentBody().reasoning).toEqual({ effort: "low" });
    expect(sentBody().reasoning_effort).toBeUndefined();
  });

  it("offers web_search when the project asks for grounding", async () => {
    mockFetch(jsonResponse(respOk("grounded")));
    await runQuery(answer({ webSearch: true }));
    expect(sentBody().tools).toEqual([{ type: "web_search" }]);
  });

  // Live-measured 2026-08-15 via the pilot harness against a real open-ended
  // question ("What is the best CDN for speeding up a global website?"):
  // Muse Spark ran a search plus THREE full open_page fetches before writing
  // any answer text, spending the entire 1200-token shared budget on tool
  // orchestration and returning incomplete_details:{reason:"max_output_tokens"}
  // with no message at all -- every such prompt refused rather than
  // measuring anything, a much bigger version of the reasoning-token bug
  // above. search_context_size:"low" did not reduce the page-open count
  // (tested, no effect); a bigger ceiling was the only lever that worked.
  it("gives a grounded call a bigger token ceiling than the shared answer budget", async () => {
    mockFetch(jsonResponse(respOk("grounded")));
    await runQuery(answer({ webSearch: true }));
    expect(sentBody().max_output_tokens).toBe(4000);
  });

  it("keeps the shared answer budget for an ungrounded call", async () => {
    mockFetch(jsonResponse(respOk("from memory")));
    await runQuery(answer({ webSearch: false }));
    expect(sentBody().max_output_tokens).toBe(1200);
  });

  // The honest pre-probe state: no documented forcing parameter exists, so
  // none is sent. This must FAIL once a real forcing shape is wired in after
  // the Tier-0 probe -- that failure is the reminder to update this test
  // alongside the code, not a regression.
  it("does not claim to force search — no forcing shape is confirmed yet", async () => {
    mockFetch(jsonResponse(respOk("grounded")));
    await runQuery(answer({ webSearch: true }));
    expect(sentBody().tool_choice).toBeUndefined();
  });

  // Live-measured 2026-08-15: a real 2-search grounded call returned output
  // = [reasoning, message(phase:"commentary", "I'll locate the top global
  // CDN providers for you."), web_search_call, reasoning, web_search_call,
  // reasoning, message(the real answer)]. The original metaText concatenated
  // every message's text regardless of phase, so a stored answer read
  // "I'll locate the top global CDN providers for you.\nTop 5 global CDN
  // providers are Akamai, Cloudflare..." -- the commentary sentence would
  // have skewed mention-detection's first-occurrence prominence and printed
  // as part of the measured answer on every grounded run.
  it("drops the search-turn commentary message, keeps only the real answer", async () => {
    mockFetch(
      jsonResponse({
        output: [
          { type: "reasoning" },
          {
            type: "message",
            phase: "commentary",
            content: [{ type: "output_text", text: "I'll locate the top global CDN providers for you." }],
          },
          { type: "web_search_call" },
          { type: "reasoning" },
          {
            type: "message",
            content: [{ type: "output_text", text: "Akamai, Cloudflare, AWS, Fastly, Google" }],
          },
        ],
        usage: { total_tokens: 500 },
      }),
    );
    const res = await runQuery(answer({ webSearch: true }));
    expect(res.text).toBe("Akamai, Cloudflare, AWS, Fastly, Google");
    expect(res.text).not.toContain("I'll locate");
  });

  it("asks for no tools at all when web search is off", async () => {
    mockFetch(jsonResponse(respOk("from memory")));
    const res = await runQuery(answer({ webSearch: false }));
    expect(sentBody().tools).toBeUndefined();
    expect(res.sources).toEqual([]);
  });

  it("does not attribute sources to an ungrounded answer", async () => {
    mockFetch(
      jsonResponse(
        respOk("x", { annotations: [{ type: "url_citation", url: "https://example.com/a" }] }),
      ),
    );
    const res = await runQuery(answer({ webSearch: false }));
    expect(res.sources).toEqual([]);
  });
});

// --- sources --------------------------------------------------------------

describe("metaSources", () => {
  // Unlike xAI, Meta's docs describe annotations[].title as a real page
  // title, not a citation-number label -- so unlike xaiSources, the title is
  // KEPT here rather than dropped. Confirm this holds against a live citation
  // before trusting it fully; xAI's equivalent field looked just as ordinary
  // in its own docs and turned out not to be.
  it("keeps the title, unlike xAI's citation-label quirk", () => {
    const got = metaSources({
      output: [
        {
          content: [
            {
              annotations: [
                { type: "url_citation", url: "https://fastly.com/cdn", title: "Fastly CDN" },
              ],
            },
          ],
        },
      ],
    });
    expect(got).toEqual([
      { url: "https://fastly.com/cdn", domain: "fastly.com", title: "Fastly CDN", snippet: null },
    ]);
  });

  it("ignores annotation kinds that are not web sources", () => {
    const got = metaSources({
      output: [
        {
          content: [
            {
              annotations: [
                { type: "file_citation", url: "https://not-a-web-source.com/x" },
                { type: "url_citation", url: "https://real.com/y" },
              ],
            },
          ],
        },
      ],
    });
    expect(got.map((s) => s.domain)).toEqual(["real.com"]);
  });

  it("drops unsafe URL schemes", () => {
    const got = metaSources({
      output: [
        {
          content: [
            {
              annotations: [
                { type: "url_citation", url: "javascript:alert(1)" },
                { type: "url_citation", url: "https://ok.com/a" },
              ],
            },
          ],
        },
      ],
    });
    expect(got.map((s) => s.domain)).toEqual(["ok.com"]);
  });

  it("dedupes repeated URLs", () => {
    const got = metaSources({
      output: [
        {
          content: [
            {
              annotations: [
                { type: "url_citation", url: "https://same.com/a" },
                { type: "url_citation", url: "https://same.com/a" },
              ],
            },
          ],
        },
      ],
    });
    expect(got).toHaveLength(1);
  });

  it("returns nothing rather than throwing on an empty reply", () => {
    expect(metaSources({})).toEqual([]);
  });
});

// --- token accounting -----------------------------------------------------

describe("meta token accounting", () => {
  it("uses total_tokens when present", async () => {
    mockFetch(jsonResponse(respOk("hi", { usage: { total_tokens: 1234 } })));
    expect((await runQuery(answer())).tokens).toBe(1234);
  });

  it("sums input and output when there is no total", async () => {
    mockFetch(jsonResponse(respOk("hi", { usage: { input_tokens: 100, output_tokens: 25 } })));
    expect((await runQuery(answer())).tokens).toBe(125);
  });

  it("reports zero rather than NaN when usage is absent", async () => {
    mockFetch(jsonResponse({ output: [{ type: "message", content: [{ text: "hi" }] }] }));
    expect((await runQuery(answer())).tokens).toBe(0);
  });
});

// --- 200-but-unusable -------------------------------------------------------

describe("meta unusable 200s", () => {
  it("fails an answer with no text", async () => {
    mockFetch(jsonResponse({ output: [], usage: { total_tokens: 3 } }));
    await expect(runQuery(answer())).rejects.toThrow(/empty answer/i);
  });

  it("fails a utility call with no choices", async () => {
    mockFetch(jsonResponse({ usage: { total_tokens: 3 } }));
    await expect(
      generateVariations({
        provider: "meta",
        model: "muse-spark-1.2",
        apiKey: KEY,
        topicName: "cdn",
        count: 3,
      }),
    ).rejects.toThrow(/no choices/i);
  });

  it("fails a utility call whose content is empty", async () => {
    mockFetch(jsonResponse(chatOk("")));
    await expect(
      generateVariations({
        provider: "meta",
        model: "muse-spark-1.2",
        apiKey: KEY,
        topicName: "cdn",
        count: 3,
      }),
    ).rejects.toThrow(/empty answer/i);
  });

  it("does not retry an unusable 200 — the tokens are already spent", async () => {
    mockFetch(jsonResponse({ output: [] }));
    await expect(runQuery(answer())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// --- utility calls ----------------------------------------------------------

describe("meta utility calls", () => {
  it("sends utility work to Meta's chat-completions host, never OpenAI's", async () => {
    mockFetch(jsonResponse(chatOk('{"questions":["a","b"]}')));
    await generateVariations({
      provider: "meta",
      model: "muse-spark-1.2",
      apiKey: KEY,
      topicName: "cdn",
      count: 2,
    });
    expect(sentUrl()).toBe(CHAT_URL);
    expect(sentUrl()).not.toContain("openai.com");
  });

  it("sets reasoning_effort:\"minimal\" on every utility call", async () => {
    mockFetch(jsonResponse(chatOk('{"questions":["a"]}')));
    await generateVariations({
      provider: "meta",
      model: "muse-spark-1.2",
      apiKey: KEY,
      topicName: "cdn",
      count: 1,
    });
    expect(sentBody().reasoning_effort).toBe("minimal");
  });

  it("asks for a JSON object, the way the OpenAI-shaped surfaces do", async () => {
    mockFetch(jsonResponse(chatOk('{"questions":["a"]}')));
    await generateVariations({
      provider: "meta",
      model: "muse-spark-1.2",
      apiKey: KEY,
      topicName: "cdn",
      count: 1,
    });
    expect(sentBody().response_format).toEqual({ type: "json_object" });
  });

  it("classifies on analysisModelFor's model", async () => {
    mockFetch(
      jsonResponse(chatOk('{"results":[{"key":"brand","sentiment":"positive","recommended":true}]}')),
    );
    await analyzeResponse({
      provider: "meta",
      model: "muse-spark-1.2",
      apiKey: KEY,
      question: "q",
      responseText: "Acme is great",
      entities: [{ key: "brand", name: "Acme" }],
    });
    expect(sentBody().model).toBe(analysisModelFor("meta"));
  });

  it("never asks a utility call to search", async () => {
    mockFetch(jsonResponse(chatOk('{"questions":["a"]}')));
    await generateVariations({
      provider: "meta",
      model: "muse-spark-1.2",
      apiKey: KEY,
      topicName: "cdn",
      count: 1,
    });
    expect(sentBody().tools).toBeUndefined();
    expect(sentUrl()).not.toContain("/responses");
  });
});

// --- HTTP errors and retries ------------------------------------------------

describe("meta HTTP errors", () => {
  it("surfaces a bad key immediately, without retrying", async () => {
    mockFetch(jsonResponse({ error: { message: "Unauthorized" } }, 401));
    await expect(runQuery(answer())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 400", async () => {
    mockFetch(jsonResponse({ error: { message: "bad model" } }, 400));
    await expect(runQuery(answer())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 and succeeds", async () => {
    vi.useFakeTimers();
    mockFetch(jsonResponse({ error: { message: "upstream" } }, 503), jsonResponse(respOk("ok")));
    const p = runQuery(answer());
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ text: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a dropped connection", async () => {
    vi.useFakeTimers();
    let calls = 0;
    fetchMock = vi.fn(async () => {
      if (++calls === 1) throw new TypeError("fetch failed");
      return jsonResponse(respOk("ok"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = runQuery(answer());
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ text: "ok" });
    expect(calls).toBe(2);
  });

  it("waits as long as Retry-After asks, not the exponential backoff", async () => {
    vi.useFakeTimers();
    mockFetch(
      jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "12" }),
      jsonResponse(respOk("ok")),
    );
    const p = runQuery(answer());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(p).resolves.toMatchObject({ text: "ok" });
  });

  it("accepts an HTTP-date Retry-After", async () => {
    vi.useFakeTimers();
    const when = new Date(Date.now() + 10_000).toUTCString();
    mockFetch(
      jsonResponse({ error: { message: "wait" } }, 429, { "retry-after": when }),
      jsonResponse(respOk("ok")),
    );
    const p = runQuery(answer());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(p).resolves.toMatchObject({ text: "ok" });
  });

  it("gives up rather than sleeping past the single-wait ceiling", async () => {
    vi.useFakeTimers();
    mockFetch(jsonResponse({ error: { message: "daily cap" } }, 429, { "retry-after": "3600" }));
    const p = runQuery(answer());
    const rejected = expect(p).rejects.toThrow(/daily cap/);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the per-call sleep budget is spent", async () => {
    vi.useFakeTimers();
    mockFetch(jsonResponse({ error: { message: "busy" } }, 429, { "retry-after": "40" }));
    const p = runQuery(answer());
    const rejected = expect(p).rejects.toThrow(/busy/);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads the error message Meta sent", async () => {
    mockFetch(jsonResponse({ error: { message: "model muse-spark-9 does not exist" } }, 404));
    await expect(runQuery(answer())).rejects.toThrow(/muse-spark-9/);
  });
});

// --- verifyKey ---------------------------------------------------------------

describe("meta verifyKey", () => {
  it("accepts a working key", async () => {
    mockFetch(jsonResponse(chatOk("pong")));
    await expect(verifyKey("meta", KEY)).resolves.toEqual({ ok: true });
  });

  it("probes with reasoning_effort minimal — the same guard that protects every utility call", async () => {
    mockFetch(jsonResponse(chatOk("pong")));
    await verifyKey("meta", KEY);
    expect(sentBody().reasoning_effort).toBe("minimal");
  });

  it("reports a bad key as invalid rather than as an outage", async () => {
    mockFetch(jsonResponse({ error: { message: "Unauthorized" } }, 401));
    await expect(verifyKey("meta", KEY)).resolves.toMatchObject({
      ok: false,
      error: "Invalid API key.",
    });
  });
});

// --- humanError ---------------------------------------------------------------

describe("meta humanError", () => {
  it("maps auth failures", () => {
    expect(humanError(new MetaAPIError(401, "nope"))).toBe("Invalid API key.");
    expect(humanError(new MetaAPIError(403, "nope"))).toBe("Invalid API key.");
  });

  it("explains a 429 instead of saying 'rate limited'", () => {
    const msg = humanError(new MetaAPIError(429, "slow down", 30));
    expect(msg).toMatch(/rate limit/i);
    expect(msg).toContain("30s");
  });

  it("maps server errors to a retryable message", () => {
    expect(humanError(new MetaAPIError(503, "boom"))).toMatch(/temporary/i);
  });

  it("maps an unknown model to something actionable", () => {
    expect(humanError(new MetaAPIError(404, "no such model"))).toMatch(/isn't available/i);
  });
});

// --- catalog guards -----------------------------------------------------------

describe("meta catalog", () => {
  it("offers Meta under the vendor id, labelled by product", () => {
    expect(PROVIDERS.meta.label).toContain("Meta");
    expect(PROVIDERS.meta.keyPrefix).toBe("LLM|");
  });

  it("defaults to the current flagship", () => {
    expect(defaultModelFor("meta")).toBe("muse-spark-1.2");
  });

  // The one deliberate exception in the catalog: Meta ships no separate cheap
  // tier, so analysisModelFor returns the SAME id as the default. Every other
  // provider's classification model differs from its default; this asserts
  // the exception is intentional, not a gap that crept in unnoticed.
  it("uses the same model for classification, unlike every other provider — documented exception", () => {
    expect(analysisModelFor("meta")).toBe(defaultModelFor("meta"));
    for (const info of PROVIDER_LIST) {
      if (info.id === "meta") continue;
      expect(analysisModelFor(info.id)).not.toBe(defaultModelFor(info.id));
    }
  });

  it("honours the analysis-model env override", () => {
    vi.stubEnv("ANALYSIS_META_MODEL", " muse-spark-1.1 ");
    expect(analysisModelFor("meta")).toBe("muse-spark-1.1"); // trimmed
  });

  // Neither is offered: 1.1 is the prior generation at identical pricing (no
  // reason to default anyone onto it), and -contributor opts your traffic
  // into improving Meta's own products, which nobody asked for.
  it("keeps the prior generation and the contributor variant out of the catalog", () => {
    const ids = PROVIDERS.meta.models.map((m) => m.id);
    expect(ids).not.toContain("muse-spark-1.1");
    expect(ids.some((id) => id.includes("contributor"))).toBe(false);
  });
});

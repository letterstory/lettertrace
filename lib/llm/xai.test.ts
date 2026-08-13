import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runQuery,
  verifyKey,
  generateVariations,
  analyzeResponse,
  humanError,
  xaiSources,
  XaiAPIError,
} from "./index";
import { PROVIDERS, analysisModelFor } from "@/lib/models";

// ------------------------------------------------------------------
// xAI (Grok) adapter. Mocked fetch throughout — the subject is the request we
// build and the responses we survive, not xAI's behaviour.
//
// Three things drive most of what's asserted here:
//   1. Two surfaces under one host. Utility work goes to /chat/completions,
//      monitored answers to /responses, and sending either to the other's
//      endpoint would fail in a way no type catches.
//   2. `annotations[].title` is the citation LABEL ("1", "2"), not a page
//      title. Passed through, every source would be titled "1".
//   3. The utility dispatch used to have a `default:` branch that sent anything
//      unrecognised to api.openai.com — so an xAI key would have been posted to
//      OpenAI. There is a test below that pins the host for exactly that reason.
// ------------------------------------------------------------------

const KEY = "xai-test-key";
const CHAT_URL = "https://api.x.ai/v1/chat/completions";
const RESPONSES_URL = "https://api.x.ai/v1/responses";

/** A /chat/completions 200. */
function chatOk(content: string, usage?: Record<string, number>) {
  return {
    id: "x",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: usage ?? { total_tokens: 42 },
  };
}

/** A /responses 200. */
function respOk(
  text: string,
  extra: {
    annotations?: { type?: string; url?: string; title?: string }[];
    citations?: string[];
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
    ...(extra.citations ? { citations: extra.citations } : {}),
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
function sentHeaders(call = 0): Record<string, string> {
  return fetchMock.mock.calls[call][1].headers as Record<string, string>;
}

const answer = (over: Record<string, unknown> = {}) =>
  ({ provider: "xai" as const, model: "grok-4.6", apiKey: KEY, prompt: "q", ...over });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// --- the monitored answer path -------------------------------------------

describe("xai runQuery", () => {
  it("answers on the Responses API with a bearer key", async () => {
    mockFetch(jsonResponse(respOk("hello")));
    const res = await runQuery(answer());
    expect(sentUrl()).toBe(RESPONSES_URL);
    expect(sentHeaders().authorization).toBe(`Bearer ${KEY}`);
    expect(res.text).toBe("hello");
  });

  it("forces the browse when the project asks for web search", async () => {
    mockFetch(jsonResponse(respOk("grounded")));
    await runQuery(answer({ webSearch: true }));
    const body = sentBody();
    expect(body.tools).toEqual([{ type: "web_search" }]);
    // Offered is not forced — the whole reason the other engines carry a
    // tool_choice. Left to choose, a model answers from memory and cites
    // nothing, and its mention rate stops being comparable with theirs.
    //
    // The exact shape is load-bearing and was measured, not assumed: xAI
    // answers 422 "did not match any variant of untagged enum ModelToolChoice"
    // to {type:"web_search"}, {function_name:...} and the OpenAI function form.
    // Only "required" and the named-tool form below are accepted. See the
    // comment on XAI_FORCE_SEARCH for the probe that established that.
    expect(body.tool_choice).toEqual({ type: "tool", name: "web_search" });
  });

  // A regression guard with a specific failure in mind: reverting to any of the
  // three shapes xAI rejects would 422 every grounded run, and a mocked suite
  // would not notice because the mock answers 200 regardless.
  it("never sends a tool_choice shape xAI rejects", async () => {
    mockFetch(jsonResponse(respOk("grounded")));
    await runQuery(answer({ webSearch: true }));
    const tc = sentBody().tool_choice;
    expect(tc).not.toEqual({ type: "web_search" });
    expect(tc).not.toHaveProperty("function_name");
    expect(tc).not.toHaveProperty("function");
  });

  it("asks for no tools at all when web search is off", async () => {
    mockFetch(jsonResponse(respOk("from memory")));
    const res = await runQuery(answer({ webSearch: false }));
    expect(sentBody().tools).toBeUndefined();
    expect(sentBody().tool_choice).toBeUndefined();
    // and reports no sources even if the reply somehow carried some
    expect(res.sources).toEqual([]);
  });

  it("does not attribute sources to an ungrounded answer", async () => {
    // A reply carrying citations on a run that never asked to browse must not
    // have them recorded: they would read as evidence the answer was grounded.
    mockFetch(
      jsonResponse(respOk("x", { citations: ["https://example.com/a"] })),
    );
    const res = await runQuery(answer({ webSearch: false }));
    expect(res.sources).toEqual([]);
  });

  it("concatenates text across output items", async () => {
    mockFetch(
      jsonResponse({
        output: [
          { type: "message", content: [{ type: "output_text", text: "one" }] },
          { type: "message", content: [{ type: "output_text", text: "two" }] },
        ],
        usage: { total_tokens: 5 },
      }),
    );
    const res = await runQuery(answer());
    expect(res.text).toBe("one\ntwo");
  });
});

// --- sources --------------------------------------------------------------

describe("xaiSources", () => {
  // xAI puts the citation's LABEL in `title` — "1", "2" — not the page title.
  // Storing that would show every source titled "1" in the UI, so titles are
  // dropped rather than faked. The URL is what carries meaning.
  it("never stores the citation label as a title", () => {
    const got = xaiSources({
      output: [
        {
          content: [
            {
              annotations: [
                { type: "url_citation", url: "https://fastly.com/cdn", title: "1" },
                { type: "url_citation", url: "https://akamai.com/x", title: "2" },
              ],
            },
          ],
        },
      ],
    });
    expect(got.map((s) => s.title)).toEqual([null, null]);
    expect(got.map((s) => s.domain)).toEqual(["fastly.com", "akamai.com"]);
  });

  it("prefers inline citations over the all-sources list", () => {
    // xAI's own docs say not every URL in `citations` is referenced in the
    // answer, so it is the weaker signal and only a fallback.
    const got = xaiSources({
      output: [
        { content: [{ annotations: [{ type: "url_citation", url: "https://cited.com/a" }] }] },
      ],
      citations: ["https://touched-but-not-cited.com/b"],
    });
    expect(got.map((s) => s.domain)).toEqual(["cited.com"]);
  });

  it("falls back to the all-sources list when nothing was cited inline", () => {
    const got = xaiSources({
      output: [{ content: [{ type: "output_text", text: "no annotations here" }] }],
      citations: ["https://only.com/a", "https://only.com/b"],
    });
    expect(got).toHaveLength(2);
  });

  it("ignores annotation kinds that are not web sources", () => {
    const got = xaiSources({
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
    const got = xaiSources({
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
    const got = xaiSources({
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
    expect(xaiSources({})).toEqual([]);
  });
});

// --- token accounting -----------------------------------------------------

describe("xai token accounting", () => {
  it("uses total_tokens when present", async () => {
    mockFetch(jsonResponse(respOk("hi", { usage: { total_tokens: 1234 } })));
    expect((await runQuery(answer())).tokens).toBe(1234);
  });

  it("sums input and output when there is no total", async () => {
    mockFetch(
      jsonResponse(respOk("hi", { usage: { input_tokens: 100, output_tokens: 25 } })),
    );
    expect((await runQuery(answer())).tokens).toBe(125);
  });

  it("reports zero rather than NaN when usage is absent", async () => {
    mockFetch(jsonResponse({ output: [{ content: [{ text: "hi" }] }] }));
    expect((await runQuery(answer())).tokens).toBe(0);
  });
});

// --- 200-but-unusable -----------------------------------------------------
//
// The dangerous class: the call succeeds, the stored answer is empty, and the
// run reports "brand not mentioned" for a question that was never answered.

describe("xai unusable 200s", () => {
  it("fails an answer with no text", async () => {
    mockFetch(jsonResponse({ output: [], usage: { total_tokens: 3 } }));
    await expect(runQuery(answer())).rejects.toThrow(/empty answer/i);
  });

  it("fails a utility call with no choices", async () => {
    mockFetch(jsonResponse({ usage: { total_tokens: 3 } }));
    await expect(
      generateVariations({
        provider: "xai",
        model: "grok-4.6",
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
        provider: "xai",
        model: "grok-4.6",
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

// --- utility calls --------------------------------------------------------

describe("xai utility calls", () => {
  // The regression this pins: utilityChat's dispatch had a `default:` branch
  // that sent every unlisted provider to openaiChat — so an xAI key would have
  // been posted to api.openai.com. A leaked credential and a wrong answer, with
  // nothing failing to say so.
  it("sends utility work to xAI, never to OpenAI", async () => {
    mockFetch(jsonResponse(chatOk('{"questions":["a","b"]}')));
    await generateVariations({
      provider: "xai",
      model: "grok-4.6",
      apiKey: KEY,
      topicName: "cdn",
      count: 2,
    });
    expect(sentUrl()).toBe(CHAT_URL);
    expect(sentUrl()).not.toContain("openai.com");
  });

  it("asks for a JSON object, the way the OpenAI-shaped surfaces do", async () => {
    mockFetch(jsonResponse(chatOk('{"questions":["a"]}')));
    await generateVariations({
      provider: "xai",
      model: "grok-4.6",
      apiKey: KEY,
      topicName: "cdn",
      count: 1,
    });
    expect(sentBody().response_format).toEqual({ type: "json_object" });
    expect(sentBody().messages[0].role).toBe("system");
  });

  it("classifies on the cheap model, not the answer model", async () => {
    mockFetch(
      jsonResponse(chatOk('{"results":[{"key":"brand","sentiment":"positive","recommended":true}]}')),
    );
    await analyzeResponse({
      provider: "xai",
      model: "grok-4.6",
      apiKey: KEY,
      question: "q",
      responseText: "Acme is great",
      entities: [{ key: "brand", name: "Acme" }],
    });
    expect(sentBody().model).toBe(analysisModelFor("xai"));
    expect(sentBody().model).not.toBe("grok-4.6");
  });

  it("never asks a utility call to search", async () => {
    // Utility calls reason over text WE supply. Searching there is pure cost,
    // and a search result could contaminate a judgment about that text.
    mockFetch(jsonResponse(chatOk('{"questions":["a"]}')));
    await generateVariations({
      provider: "xai",
      model: "grok-4.6",
      apiKey: KEY,
      topicName: "cdn",
      count: 1,
    });
    expect(sentBody().tools).toBeUndefined();
    expect(sentUrl()).not.toContain("/responses");
  });
});

// --- HTTP errors and retries ---------------------------------------------

describe("xai HTTP errors", () => {
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

  // A rate limit's window does not care about our exponential backoff.
  // Retrying inside it burns every attempt in a couple of seconds and then
  // reports "rate limited" as if nothing could be done.
  it("waits as long as Retry-After asks, not the exponential backoff", async () => {
    vi.useFakeTimers();
    mockFetch(
      jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "12" }),
      jsonResponse(respOk("ok")),
    );
    const p = runQuery(answer());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still waiting, not backed off
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
    // A wait this long means the quota window has hours left; blocking the
    // request for it is worse than failing with a message that says so.
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
    // 40s + 40s fits the 90s budget; a third would exceed it.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads the error message xAI sent", async () => {
    mockFetch(jsonResponse({ error: { message: "model grok-9 does not exist" } }, 404));
    await expect(runQuery(answer())).rejects.toThrow(/grok-9/);
  });
});

// --- verifyKey ------------------------------------------------------------

describe("xai verifyKey", () => {
  it("accepts a working key", async () => {
    mockFetch(jsonResponse(chatOk("pong")));
    await expect(verifyKey("xai", KEY)).resolves.toEqual({ ok: true });
  });

  it("probes on the cheap model, not the flagship", async () => {
    mockFetch(jsonResponse(chatOk("pong")));
    await verifyKey("xai", KEY);
    expect(sentBody().model).toBe("grok-4.3");
  });

  // The bug this pins, from the Perplexity adapter: an 8-token probe budget
  // copied from another provider hit a vendor floor of 16, so a VALID key was
  // reported invalid. Every real call worked — only verification failed.
  // Clamped inside the adapter so no caller can reintroduce a smaller one.
  it("never sends a probe budget below the vendor floor", async () => {
    mockFetch(jsonResponse(chatOk("pong")));
    await verifyKey("xai", KEY);
    expect(sentBody().max_tokens).toBeGreaterThanOrEqual(16);
  });

  it("reports a bad key as invalid rather than as an outage", async () => {
    mockFetch(jsonResponse({ error: { message: "Unauthorized" } }, 401));
    await expect(verifyKey("xai", KEY)).resolves.toMatchObject({
      ok: false,
      error: "Invalid API key.",
    });
  });
});

// --- humanError -----------------------------------------------------------

describe("xai humanError", () => {
  it("maps auth failures", () => {
    expect(humanError(new XaiAPIError(401, "nope"))).toBe("Invalid API key.");
    expect(humanError(new XaiAPIError(403, "nope"))).toBe("Invalid API key.");
  });

  // xAI bills from a prepaid balance, so a perfectly good key stops working
  // when the credit runs out. "Provider error (402)" would send someone
  // looking for a bug in the key itself.
  it("says a spent balance is a spent balance", () => {
    expect(humanError(new XaiAPIError(402, "insufficient"))).toMatch(/credit/i);
  });

  it("explains a 429 instead of saying 'rate limited'", () => {
    const msg = humanError(new XaiAPIError(429, "slow down", 30));
    expect(msg).toMatch(/rate limit/i);
    expect(msg).toContain("30s");
    expect(msg).toMatch(/console/i); // names where to look
  });

  it("maps server errors to a retryable message", () => {
    expect(humanError(new XaiAPIError(503, "boom"))).toMatch(/temporary/i);
  });

  it("maps an unknown model to something actionable", () => {
    expect(humanError(new XaiAPIError(404, "no such model"))).toMatch(/isn't available/i);
  });
});

// --- catalog guards -------------------------------------------------------

describe("xai catalog", () => {
  it("offers Grok under the vendor id, not the model line", () => {
    expect(PROVIDERS.xai.label).toContain("Grok");
    expect(PROVIDERS.xai.keyPrefix).toBe("xai-");
  });

  it("classifies on a model that is not the answer model", () => {
    expect(analysisModelFor("xai")).toBe("grok-4.3");
    expect(analysisModelFor("xai")).not.toBe(PROVIDERS.xai.models[0].id);
  });

  it("honours the analysis-model env override", () => {
    vi.stubEnv("ANALYSIS_XAI_MODEL", " grok-4.6 ");
    expect(analysisModelFor("xai")).toBe("grok-4.6"); // trimmed
  });

  // Untested surfaces stay out of the picker. Whether the multi-agent variant
  // can finish inside a run's budget has never been measured, and offering an
  // unmeasured model is how sonar-deep-research would have shipped.
  it("keeps the specialised grok variants out of the catalog", () => {
    const ids = PROVIDERS.xai.models.map((m) => m.id);
    expect(ids.some((id) => id.includes("multi-agent"))).toBe(false);
    expect(ids.some((id) => id.includes("build"))).toBe(false);
  });
});

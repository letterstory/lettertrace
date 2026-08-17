import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runQuery,
  verifyKey,
  generateVariations,
  analyzeResponse,
  humanError,
  DeepseekAPIError,
} from "./index";
import {
  PROVIDERS,
  PROVIDER_LIST,
  analysisModelFor,
  defaultModelFor,
  providerCanMeasure,
  providerRefusalMessage,
} from "@/lib/models";

// ------------------------------------------------------------------
// DeepSeek adapter. Mocked fetch throughout.
//
// The subject here is narrower than the other adapters and mostly about what
// DeepSeek must NOT do. It is the only engine in the catalog whose API cannot
// browse, so the tests that matter are the ones proving a grounded project can
// never be served by it and that an ungrounded answer never acquires sources
// it didn't earn.
//
// The transport is raw fetch rather than the OpenAI SDK with a base URL, even
// though DeepSeek is OpenAI-compatible enough for the latter to work. The
// deciding reason is visible right here: the SDK resolves its own fetch, so an
// SDK-backed adapter cannot be asserted at the wire level by this harness — a
// wrong host or a stray search parameter would pass silently.
// ------------------------------------------------------------------

const KEY = "sk-deepseek-test-key";

function chatOk(content: string, usage?: Record<string, number>) {
  return {
    id: "x",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: usage ?? { total_tokens: 42 },
  };
}

function reply(body: unknown, status = 200, headers: Record<string, string> = {}) {
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
  return String(fetchMock.mock.calls[call][0]);
}
function sentBody(call = 0): Record<string, any> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

const answer = (over: Record<string, unknown> = {}) =>
  ({ provider: "deepseek" as const, model: "deepseek-v4-pro", apiKey: KEY, prompt: "q", ...over });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// --- the answer path ------------------------------------------------------

describe("deepseek runQuery", () => {
  it("talks to DeepSeek's host, not OpenAI's", async () => {
    mockFetch(reply(chatOk("hello")));
    const res = await runQuery(answer());
    expect(sentUrl()).toContain("api.deepseek.com");
    expect(sentUrl()).not.toContain("openai.com");
    expect(res.text).toBe("hello");
  });

  // DeepSeek V4 has thinking mode ON by default (effort "high" per its docs),
  // and reasoning shares the SAME max_tokens as the visible answer -- the same
  // failure shape as Gemini's thinking tokens. Confirmed live 2026-08-14: a
  // real verifyKey ping (8 tokens) came back "empty answer (finish_reason:
  // length)" -- the whole budget was spent on hidden reasoning before any
  // visible text. A mocked suite cannot catch a live vendor default; this
  // pins the fix (thinking explicitly disabled) so it can't regress silently.
  it("disables thinking mode, so a small token budget can't be silently eaten by reasoning", async () => {
    mockFetch(reply(chatOk("hello")));
    await runQuery(answer());
    expect(sentBody().thinking).toEqual({ type: "disabled" });
  });

  it("never asks for tools or search, whatever the project setting says", async () => {
    // webSearch:true cannot legitimately reach this function — resolveRunKeyFor
    // refuses it first — but if it ever did, the request still must not claim
    // to be grounded. Asserted for both settings so the answer is the same one.
    for (const webSearch of [false, true]) {
      mockFetch(reply(chatOk("from memory")));
      await runQuery(answer({ webSearch }));
      const body = sentBody();
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.web_search_options).toBeUndefined();
    }
  });

  it("returns no sources, because it never looked anything up", async () => {
    mockFetch(reply(chatOk("Acme and Globex are the main ones.")));
    const res = await runQuery(answer({ webSearch: true }));
    // Recording a citation here would be inventing one.
    expect(res.sources).toEqual([]);
  });

  it("reports token usage", async () => {
    mockFetch(reply(chatOk("hi", { total_tokens: 321 })));
    expect((await runQuery(answer())).tokens).toBe(321);
  });

  // A 200 whose content is empty would be stored and then scanned for zero
  // mentions, reading downstream as "the brand wasn't named" rather than "we
  // never got an answer".
  it("fails an empty answer instead of storing it", async () => {
    mockFetch(reply(chatOk("")));
    await expect(runQuery(answer())).rejects.toThrow(/empty answer/i);
  });
});

// --- utility calls --------------------------------------------------------

describe("deepseek utility calls", () => {
  it("sends utility work to DeepSeek, never to OpenAI", async () => {
    mockFetch(reply(chatOk('{"questions":["a","b"]}')));
    await generateVariations({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: KEY,
      topicName: "cdn",
      count: 2,
    });
    expect(sentUrl()).toContain("api.deepseek.com");
    expect(sentUrl()).not.toContain("openai.com");
  });

  it("asks for a JSON object, the way the OpenAI-shaped surfaces do", async () => {
    mockFetch(reply(chatOk('{"questions":["a"]}')));
    await generateVariations({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: KEY,
      topicName: "cdn",
      count: 1,
    });
    expect(sentBody().response_format).toEqual({ type: "json_object" });
  });

  it("classifies on the cheap model, not the answer model", async () => {
    mockFetch(
      reply(chatOk('{"results":[{"key":"brand","sentiment":"positive","recommended":true}]}')),
    );
    await analyzeResponse({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: KEY,
      question: "q",
      responseText: "Acme is great",
      entities: [{ key: "brand", name: "Acme" }],
    });
    expect(sentBody().model).toBe("deepseek-v4-flash");
    expect(sentBody().model).not.toBe("deepseek-v4-pro");
  });
});

// --- verifyKey ------------------------------------------------------------

describe("deepseek verifyKey", () => {
  it("accepts a working key", async () => {
    mockFetch(reply(chatOk("pong")));
    await expect(verifyKey("deepseek", KEY)).resolves.toEqual({ ok: true });
  });

  it("probes on the cheap model", async () => {
    mockFetch(reply(chatOk("pong")));
    await verifyKey("deepseek", KEY);
    expect(sentBody().model).toBe("deepseek-v4-flash");
  });

  it("reports a bad key as invalid", async () => {
    mockFetch(reply({ error: { message: "Authentication Fails" } }, 401));
    await expect(verifyKey("deepseek", KEY)).resolves.toMatchObject({
      ok: false,
      error: "Invalid API key.",
    });
  });
});

// --- HTTP errors and retries ---------------------------------------------

describe("deepseek HTTP errors", () => {
  it("surfaces a bad key immediately, without retrying", async () => {
    mockFetch(reply({ error: { message: "Authentication Fails" } }, 401));
    await expect(runQuery(answer())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 and succeeds", async () => {
    vi.useFakeTimers();
    mockFetch(reply({ error: { message: "overloaded" } }, 503), reply(chatOk("ok")));
    const p = runQuery(answer());
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ text: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits as long as Retry-After asks, not the exponential backoff", async () => {
    vi.useFakeTimers();
    mockFetch(
      reply({ error: { message: "slow down" } }, 429, { "retry-after": "12" }),
      reply(chatOk("ok")),
    );
    const p = runQuery(answer());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(p).resolves.toMatchObject({ text: "ok" });
  });

  it("gives up rather than sleeping past the single-wait ceiling", async () => {
    vi.useFakeTimers();
    mockFetch(reply({ error: { message: "daily cap" } }, 429, { "retry-after": "3600" }));
    const p = runQuery(answer());
    const rejected = expect(p).rejects.toThrow(/daily cap/);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // DeepSeek runs on a prepaid balance, so a perfectly valid key stops working
  // when it empties. "Provider error (402)" would send someone hunting for a
  // bad key instead of topping up.
  it("says a spent balance is a spent balance", () => {
    expect(humanError(new DeepseekAPIError(402, "Insufficient Balance"))).toMatch(/balance/i);
  });

  it("explains a 429 instead of saying 'rate limited'", () => {
    const msg = humanError(new DeepseekAPIError(429, "too many", 30));
    expect(msg).toMatch(/rate limit/i);
    expect(msg).toContain("30s");
  });

  it("maps auth and server errors", () => {
    expect(humanError(new DeepseekAPIError(401, "nope"))).toBe("Invalid API key.");
    expect(humanError(new DeepseekAPIError(503, "boom"))).toMatch(/temporary/i);
  });
});

// --- the grounding gate ---------------------------------------------------
//
// The reason ProviderSearch exists. These are the tests that stop a memory
// answer being charted as a search-grounded measurement.

describe("provider grounding capability", () => {
  it("refuses DeepSeek for a project that wants live-web answers", () => {
    expect(providerCanMeasure("deepseek", { webSearch: true })).toBe(false);
  });

  it("allows DeepSeek when the project asked for no grounding", () => {
    expect(providerCanMeasure("deepseek", { webSearch: false })).toBe(true);
  });

  it("lets every browsing engine serve a grounded project", () => {
    for (const info of PROVIDER_LIST) {
      if (info.search === "none") continue;
      expect(providerCanMeasure(info.id, { webSearch: true })).toBe(true);
    }
  });

  // The field documents behaviour the adapters already had; if one of these
  // drifts, the catalog is lying about what a run measures.
  it("describes each engine's real grounding behaviour", () => {
    expect(PROVIDERS.perplexity.search).toBe("always"); // perplexityRunQuery has no ungrounded branch
    expect(PROVIDERS.deepseek.search).toBe("none");
    expect(PROVIDERS.anthropic.search).toBe("optional");
    expect(PROVIDERS.openai.search).toBe("optional");
    expect(PROVIDERS.google.search).toBe("optional");
  });

  it("names both fixes in the refusal, and never suggests retrying", () => {
    const msg = providerRefusalMessage("deepseek");
    expect(msg).toMatch(/turn off web search/i);
    expect(msg).toMatch(/switch your answer engine/i);
    expect(msg).not.toMatch(/try again/i);
    // Never offers an engine that can't ground either.
    expect(msg).not.toMatch(/DeepSeek(,| or)/);
  });
});

// --- catalog guards -------------------------------------------------------

describe("deepseek catalog", () => {
  it("defaults to Pro and classifies on Flash", () => {
    expect(defaultModelFor("deepseek")).toBe("deepseek-v4-pro");
    expect(analysisModelFor("deepseek")).toBe("deepseek-v4-flash");
    expect(analysisModelFor("deepseek")).not.toBe(defaultModelFor("deepseek"));
  });

  it("honours the analysis-model env override", () => {
    vi.stubEnv("ANALYSIS_DEEPSEEK_MODEL", " deepseek-v4-pro ");
    expect(analysisModelFor("deepseek")).toBe("deepseek-v4-pro"); // trimmed
  });

  // deepseek-chat and deepseek-reasoner were transitional aliases with an
  // announced retirement date. Pinning an alias that the vendor moves or
  // retires is what left every pinned Gemini id answering 404 on fresh keys.
  it("keeps the retired transitional aliases out of the catalog", () => {
    const ids = PROVIDERS.deepseek.models.map((m) => m.id);
    expect(ids).not.toContain("deepseek-chat");
    expect(ids).not.toContain("deepseek-reasoner");
    for (const id of ids) expect(id).toMatch(/^deepseek-v\d/);
  });
});

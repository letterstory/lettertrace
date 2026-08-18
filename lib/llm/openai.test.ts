import { describe, it, expect, vi } from "vitest";

// ------------------------------------------------------------------
// OpenAI adapter. Everything here runs against a mocked fetch — the point is
// the request we build and the responses we survive, not OpenAI's behaviour.
// Live behaviour is probed separately (scripts/probe-openai-models.ts).
//
// The bugs this is guarding against are the ones the 2026-08-18 gpt-5.6 probes
// surfaced: a chat call carrying a max-tokens field the model family rejects,
// a grounded answer that comes back incomplete or empty and would be stored as
// a measurement, and an expensive deterministic failure being retried and
// re-billed as if it were transient.
// ------------------------------------------------------------------

// The SDK-backed chat path captures globalThis.fetch once, at module load
// (CLIENT_OPTS), so the mock has to be a stable delegator installed BEFORE the
// adapter is imported; each test then swaps what it delegates to.
let currentFetch: (url: unknown, init?: unknown) => Promise<Response> = async () => {
  throw new Error("test made an unmocked network call");
};
vi.stubGlobal("fetch", (url: unknown, init?: unknown) => currentFetch(url, init));

const { runQuery, humanError } = await import("./index");

const KEY = "sk-test-key";

/** Queue of {status, body} responses; the last repeats once exhausted. A fresh
 *  Response is constructed per call — bodies can only be read once. */
let calls: { url: string; body: Record<string, any> }[] = [];
function mockFetch(...responses: { status?: number; body: unknown }[]) {
  calls = [];
  let i = 0;
  currentFetch = async (url, init) => {
    const req = init as { body?: string } | undefined;
    calls.push({ url: String(url), body: req?.body ? JSON.parse(req.body) : {} });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** A successful Responses-API body, shaped the way the 5.6 models answer:
 *  web_search_call and reasoning items (no content) ahead of the message. */
function responsesOk(
  text: string,
  annotations: { url?: string; title?: string }[] = [],
  extra: Record<string, unknown> = {},
) {
  return {
    status: "completed",
    output: [
      { type: "web_search_call", status: "completed", action: { type: "search" } },
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text, annotations }] },
    ],
    usage: { total_tokens: 42 },
    ...extra,
  };
}

function chatOk(text: string, totalTokens = 21) {
  return {
    choices: [{ message: { role: "assistant", content: text } }],
    usage: { total_tokens: totalTokens },
  };
}

// --- Grounded path (Responses API) — request shape --------------------------

describe("openai runQuery with web search — request shape", () => {
  it("posts to the Responses API with the browse forced", async () => {
    mockFetch({ body: responsesOk("answer") });
    await runQuery({ provider: "openai", model: "gpt-5.6-sol", apiKey: KEY, prompt: "q", webSearch: true });

    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].body.model).toBe("gpt-5.6-sol");
    expect(calls[0].body.tools).toEqual([{ type: "web_search_preview" }]);
    expect(calls[0].body.tool_choice).toEqual({ type: "web_search_preview" });
    expect(calls[0].body.input).toBe("q");
    expect(calls[0].body.max_output_tokens).toBeGreaterThan(0);
  });

  it("routes through Concentrate's Responses mirror with the router slug, body otherwise identical", async () => {
    mockFetch({ body: responsesOk("answer") });
    await runQuery({
      provider: "openai",
      model: "gpt-5.6-sol",
      apiKey: KEY,
      route: { router: "concentrate", baseUrl: null },
      prompt: "q",
      webSearch: true,
    });

    expect(calls[0].url).toBe("https://api.concentrate.ai/v1/responses");
    expect(calls[0].body.model).toBe("openai/gpt-5.6-sol");
    expect(calls[0].body.tool_choice).toEqual({ type: "web_search_preview" });
  });
});

// --- Grounded path — response parsing ---------------------------------------

describe("openai runQuery with web search — parsing", () => {
  it("collects text and cited sources across output items, skipping tool/reasoning items", async () => {
    mockFetch({
      body: responsesOk("the answer", [
        { url: "https://www.example.com/a", title: "A" },
        { url: "https://example.com/a", title: "dupe of A" },
        { url: "https://other.org/b", title: "B" },
        { url: "javascript:alert(1)", title: "unsafe" },
      ]),
    });
    const res = await runQuery({ provider: "openai", model: "gpt-4o", apiKey: KEY, prompt: "q", webSearch: true });

    expect(res.text).toBe("the answer");
    expect(res.tokens).toBe(42);
    // www stripped for the domain, per-URL dedupe keeps both distinct URLs of
    // example.com, the javascript: citation is dropped entirely.
    expect(res.sources.map((s) => s.url)).toEqual([
      "https://www.example.com/a",
      "https://example.com/a",
      "https://other.org/b",
    ]);
    expect(res.sources[0].domain).toBe("example.com");
  });

  it("returns zero sources for a searched-but-uncited answer rather than failing it", async () => {
    // Measured on gpt-5.6-luna: a forced browse can complete its searches and
    // still attach no url_citation annotations. The answer is still grounded;
    // there is nothing to fall back to (web_search_call carries only queries).
    mockFetch({ body: responsesOk("uncited but real answer") });
    const res = await runQuery({ provider: "openai", model: "gpt-5.6-luna", apiKey: KEY, prompt: "q", webSearch: true });

    expect(res.text).toBe("uncited but real answer");
    expect(res.sources).toEqual([]);
  });

  it("sums input+output tokens when total_tokens is absent", async () => {
    const body = responsesOk("answer");
    body.usage = { input_tokens: 30, output_tokens: 12 } as never;
    mockFetch({ body });
    const res = await runQuery({ provider: "openai", model: "gpt-4o", apiKey: KEY, prompt: "q", webSearch: true });

    expect(res.tokens).toBe(42);
  });
});

// --- Grounded path — the answers that must fail loudly ----------------------

describe("openai runQuery with web search — unmeasurable answers", () => {
  it("fails an incomplete answer instead of storing the fragment, without retrying", async () => {
    // Reasoning draws from max_output_tokens on the 5.6 models, so a spent
    // budget ends the response with status "incomplete" and fragment text.
    mockFetch({
      body: responsesOk("truncated fragm", [], {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    });
    await expect(
      runQuery({ provider: "openai", model: "gpt-5.6-sol", apiKey: KEY, prompt: "q", webSearch: true }),
    ).rejects.toThrow(/stopped before finishing.*max_output_tokens/);
    // Deterministic and already billed (30-60k tokens on 5.6) — one attempt only.
    expect(calls).toHaveLength(1);
  });

  it("fails an empty answer instead of storing it, without retrying", async () => {
    mockFetch({ body: responsesOk("") });
    await expect(
      runQuery({ provider: "openai", model: "gpt-4o", apiKey: KEY, prompt: "q", webSearch: true }),
    ).rejects.toThrow(/empty answer/);
    expect(calls).toHaveLength(1);
  });
});

// --- Grounded path — transport ----------------------------------------------

describe("openai runQuery with web search — transport", () => {
  it("retries a 5xx and succeeds on the next attempt", async () => {
    mockFetch({ status: 502, body: { error: { message: "bad gateway" } } }, { body: responsesOk("answer") });
    const res = await runQuery({ provider: "openai", model: "gpt-4o", apiKey: KEY, prompt: "q", webSearch: true });

    expect(res.text).toBe("answer");
    expect(calls).toHaveLength(2);
  });

  it("surfaces a 401 immediately as an invalid key", async () => {
    mockFetch({ status: 401, body: { error: { message: "bad key" } } });
    const err = await runQuery({
      provider: "openai",
      model: "gpt-4o",
      apiKey: KEY,
      prompt: "q",
      webSearch: true,
    }).catch((e) => e);

    expect(humanError(err)).toBe("Invalid API key.");
    expect(calls).toHaveLength(1);
  });
});

// --- Ungrounded path (chat completions) -------------------------------------

describe("openai runQuery without web search — chat completions", () => {
  it("sends max_completion_tokens, never max_tokens", async () => {
    // The gpt-5.6 family rejects max_tokens with a hard 400 ("Use
    // 'max_completion_tokens' instead"), so the old field made every
    // ungrounded 5.6 run fail. Probed accepted on gpt-4o/-mini and both 5.6
    // models, direct and through Concentrate.
    mockFetch({ body: chatOk("Paris") });
    const res = await runQuery({ provider: "openai", model: "gpt-5.6-sol", apiKey: KEY, prompt: "q", webSearch: false });

    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].body.model).toBe("gpt-5.6-sol");
    expect(calls[0].body.max_completion_tokens).toBeGreaterThan(0);
    expect(calls[0].body).not.toHaveProperty("max_tokens");
    expect(res.text).toBe("Paris");
    expect(res.tokens).toBe(21);
    expect(res.sources).toEqual([]);
  });
});

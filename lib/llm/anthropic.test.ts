import { describe, it, expect, vi } from "vitest";

// ------------------------------------------------------------------
// Anthropic adapter. Everything here runs against a mocked fetch — the
// Anthropic SDK client is built with `fetch: globalThis.fetch` (CLIENT_OPTS),
// same as the OpenAI adapter, so this is the exact request/response boundary
// a live call crosses.
//
// The bug this guards against: since 2026-09-23, every forced-web-search
// Anthropic call routed through Concentrate 400s with
// `tool_choice references function "web_search" which is not present in
// tools` — the gateway drops the tool definition it forwards but still
// relays our tool_choice. It is deterministic (the identical body 400s every
// time), so a run that asked for a grounded answer lost the ask outright
// instead of getting an ungrounded one. See isToolChoiceMismatch.
// ------------------------------------------------------------------

let currentFetch: (url: unknown, init?: unknown) => Promise<Response> = async () => {
  throw new Error("test made an unmocked network call");
};
vi.stubGlobal("fetch", (url: unknown, init?: unknown) => currentFetch(url, init));

const { runQuery, humanError } = await import("./index");

const KEY = "sk-ant-test-key";

/** Queue of {status, body} responses; the last repeats once exhausted. */
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

function textOk(text: string, citations: { url: string; title?: string }[] = []) {
  return {
    content: [
      {
        type: "text",
        text,
        citations: citations.map((c) => ({ url: c.url, title: c.title ?? null })),
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

// Concentrate's actual shape: an Anthropic-style error envelope, wrapped in
// the SDK's own `${status} ${body}` message. Matches the raw payload recorded
// live on attrs.ops.message.
const TOOL_CHOICE_MISMATCH = {
  status: 400,
  body: {
    error: {
      code: "invalid_prompt",
      message: 'tool_choice references function "web_search" which is not present in tools',
    },
  },
};

describe("anthropic runQuery with web search — tool_choice mismatch fallback", () => {
  it("retries once without a forced tool_choice and answers instead of failing the ask", async () => {
    mockFetch(TOOL_CHOICE_MISMATCH, { body: textOk("an answer without a mandated search") });

    const res = await runQuery({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: KEY,
      route: { router: "concentrate", baseUrl: null },
      prompt: "q",
      webSearch: true,
    });

    expect(res.text).toBe("an answer without a mandated search");
    expect(res.fallback).toBe("tool_choice_mismatch");
    // Exactly two attempts: the forced call that 400s, and one unforced retry
    // — never an open-ended loop.
    expect(calls).toHaveLength(2);
    expect(calls[0].body.tool_choice).toEqual({ type: "tool", name: "web_search" });
    // Still offers the tool on retry — only the forcing is dropped.
    expect(calls[1].body.tools).toEqual(calls[0].body.tools);
    expect(calls[1].body.tool_choice).toBeUndefined();
  });

  it("does not retry a plain 400 that isn't the tool_choice shape", async () => {
    mockFetch({ status: 400, body: { error: { code: "invalid_request_error", message: "bad request" } } });

    const err = await runQuery({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: KEY,
      route: { router: "concentrate", baseUrl: null },
      prompt: "q",
      webSearch: true,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
  });

  it("does not retry when the mismatch happens on a direct (unrouted) call either", async () => {
    // The incident is Concentrate-only in practice, but the fallback reacts to
    // the error shape, not the route — so it also covers a direct call if
    // Anthropic itself ever produced this shape.
    mockFetch(TOOL_CHOICE_MISMATCH, { body: textOk("answered direct") });

    const res = await runQuery({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: KEY,
      prompt: "q",
      webSearch: true,
    });

    expect(res.text).toBe("answered direct");
    expect(res.fallback).toBe("tool_choice_mismatch");
    expect(calls).toHaveLength(2);
  });

  it("surfaces a 401 immediately as an invalid key, without retrying", async () => {
    mockFetch({ status: 401, body: { error: { type: "authentication_error", message: "bad key" } } });

    const err = await runQuery({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: KEY,
      route: { router: "concentrate", baseUrl: null },
      prompt: "q",
      webSearch: true,
    }).catch((e) => e);

    expect(humanError(err)).toBe("Invalid API key.");
    expect(calls).toHaveLength(1);
  });

  it("a normal grounded answer carries no fallback marker", async () => {
    mockFetch({ body: textOk("normal answer", [{ url: "https://example.com", title: "Example" }]) });

    const res = await runQuery({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: KEY,
      route: { router: "concentrate", baseUrl: null },
      prompt: "q",
      webSearch: true,
    });

    expect(res.fallback).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

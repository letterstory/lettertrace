import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SpendBuffer,
  perplexityEstimateUsd,
  readSpend,
  recordLlmCall,
  spendBuffer,
  spendEvent,
  spendScopeFor,
  spendSink,
  withSpendScope,
  type SpendScope,
} from "./spend";
import { runQuery } from "./llm";

// ------------------------------------------------------------------
// What lettertrace records on the letterstory spend ledger: only calls on
// Letter's own keys (the free tier, our own accounts), with the cost the
// reply carried, sent in batches that never stand in an answer's way.
// ------------------------------------------------------------------

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const OPS = "11111111-2222-4333-8444-555555555555";
const concentrate = { router: "concentrate" as const, baseUrl: null };

describe("spendScopeFor: whose money it is", () => {
  it("the free tier through Concentrate is trial-probe on Lettertrace Free Tier", () => {
    expect(
      spendScopeFor({ keySource: "trial", userId: "u", provider: "openai", route: concentrate, projectId: "p1", runId: "r1" }, env({})),
    ).toEqual({ operation: "trial-probe", keyLabel: "Lettertrace Free Tier", projectId: "p1", runId: "r1" });
  });

  it("the free tier on a direct trial key names that key", () => {
    expect(spendScopeFor({ keySource: "trial", userId: "u", provider: "perplexity" }, env({}))?.keyLabel).toBe(
      "TRIAL_PERPLEXITY_API_KEY",
    );
  });

  it("one of our accounts is probe on Lettertrace Probes; a utility call is suggest", () => {
    const e = env({ LETTERSTORY_SPEND_USER_IDS: ` ${OPS.toUpperCase()} , other` });
    expect(spendScopeFor({ keySource: "own", userId: OPS, provider: "anthropic", route: concentrate }, e)).toMatchObject({
      operation: "probe",
      keyLabel: "Lettertrace Probes",
    });
    expect(spendScopeFor({ keySource: "own", userId: OPS, provider: "anthropic", route: concentrate, kind: "suggest" }, e)?.operation).toBe(
      "suggest",
    );
  });

  it("a customer's own key is none of our spend", () => {
    expect(spendScopeFor({ keySource: "own", userId: "customer", provider: "openai", route: concentrate }, env({}))).toBeNull();
    expect(spendScopeFor({ keySource: null, userId: null, provider: "openai" }, env({ LETTERSTORY_SPEND_USER_IDS: OPS }))).toBeNull();
  });
});

describe("readSpend", () => {
  it("takes Concentrate's cost and splits the cached share out of OpenAI-shaped input", () => {
    expect(
      readSpend({
        usage: { input_tokens: 1200, output_tokens: 300, input_tokens_details: { cached_tokens: 200 } },
        cost: { total: 9.9e-5, byok: true, breakdown: {} },
      }),
    ).toEqual({ cost: 9.9e-5, byok: true, input: 1000, output: 300, cacheRead: 200, cacheCreation: 0, searchContext: null });
  });

  it("reads Anthropic's cache fields as they are", () => {
    expect(readSpend({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 7 } })).toMatchObject({
      input: 10,
      cacheRead: 90,
      cacheCreation: 7,
      cost: null,
    });
  });

  it("counts Gemini's thoughts and Perplexity's citation/reasoning tokens as output, and Perplexity's own cost", () => {
    expect(readSpend({ usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 30 } })).toMatchObject({
      input: 40,
      output: 40,
    });
    expect(
      readSpend({
        usage: { prompt_tokens: 20, completion_tokens: 100, citation_tokens: 50, search_context_size: "medium", cost: { total_cost: 0.0123 } },
      }),
    ).toMatchObject({ input: 20, output: 150, cost: 0.0123, searchContext: "medium" });
  });
});

describe("spendEvent", () => {
  const scope: SpendScope = { operation: "probe", keyLabel: "Lettertrace Probes", projectId: "p1", runId: "r1" };
  const now = new Date("2026-10-09T12:00:00Z");

  it("a routed call takes its provider from the slug and files the gateway's cost as reported", () => {
    expect(spendEvent({ cost: { total: 0.004, byok: false }, usage: { prompt_tokens: 5, completion_tokens: 6 } }, { provider: "google", model: "google/gemini-3-pro", routed: true }, scope, { now, id: "e1" })).toEqual({
      event_id: "e1",
      occurred_at: "2026-10-09T12:00:00.000Z",
      source: "lettertrace",
      key_label: "Lettertrace Probes",
      operation: "probe",
      provider: "google",
      model: "google/gemini-3-pro",
      route: "concentrate",
      input_tokens: 5,
      output_tokens: 6,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0.004,
      byok: false,
      run_id: "r1",
      project_id: "p1",
    });
  });

  it("Perplexity with no cost on the reply is priced from its published rates, marked estimated", () => {
    const e = spendEvent({ usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }, { provider: "perplexity", model: "sonar-pro", routed: false, searched: true }, scope, { id: "e2" });
    expect(e.basis).toBe("estimated");
    expect(e.cost_usd).toBeCloseTo(3 + 6 / 1000, 6);
    expect(e.route).toBe("direct");
    expect(perplexityEstimateUsd("sonar", { input: 0, output: 0, searched: false, searchContext: null })).toBe(0);
    expect(perplexityEstimateUsd("sonar", { input: 0, output: 0, searched: true, searchContext: "high" })).toBeCloseTo(0.012, 6);
  });

  it("a direct call with no cost (a trial OpenAI key) sends its tokens and leaves the price to the ledger", () => {
    const e = spendEvent({ usage: { prompt_tokens: 5, completion_tokens: 6 } }, { provider: "openai", model: "gpt-5.6-luna", routed: false }, scope, { id: "e3" });
    expect(e.cost_usd).toBeNull();
    expect(e.basis).toBeUndefined();
  });
});

describe("spendSink", () => {
  it("needs both the URL and the key; takes a base URL or the full path", () => {
    expect(spendSink(env({}))).toBeNull();
    expect(spendSink(env({ LETTERSTORY_SPEND_INGEST_URL: "https://app.example/", LETTERSTORY_SPEND_INGEST_KEY: "k" }))).toEqual({
      url: "https://app.example/api/superadmin/spend/usage",
      key: "k",
    });
  });
});

function fakeFetch(statuses: number[]) {
  const calls: { headers: Record<string, string>; events: { event_id: string }[] }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: init.headers as Record<string, string>, events: JSON.parse(String(init.body)).events });
    const status = statuses.length ? statuses.shift()! : 200;
    if (status === 0) throw new Error("ECONNREFUSED");
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const sink = () => ({ url: "https://app.example/api/superadmin/spend/usage", key: "staff-key" });
const ev = (i: number) =>
  spendEvent({ cost: { total: 0.001 } }, { provider: "openai", model: "m", routed: true }, { operation: "probe", keyLabel: "k" }, { id: `e${i}` });

describe("SpendBuffer", () => {
  it("splits a flush to the per-request cap and sends the staff key", async () => {
    const { f, calls } = fakeFetch([]);
    const buf = new SpendBuffer({ sink, fetch: f, maxPerRequest: 2, sleep: async () => {}, log: () => {} });
    for (let i = 0; i < 5; i++) buf.push(ev(i));
    await buf.flush();
    expect(calls.map((c) => c.events.length)).toEqual([2, 2, 1]);
    expect(calls[0].headers["x-staff-api-key"]).toBe("staff-key");
    expect(buf.size).toBe(0);
  });

  it("retries a 5xx or network error with the same ids, then drops with a log line", async () => {
    const logs: string[] = [];
    const ok = fakeFetch([500, 0, 200]);
    const buf = new SpendBuffer({ sink, fetch: ok.f, sleep: async () => {}, log: (m) => logs.push(m) });
    buf.push(ev(1));
    await buf.flush();
    expect(ok.calls.map((c) => c.events[0].event_id)).toEqual(["e1", "e1", "e1"]);
    expect(logs).toEqual([]);

    const down = fakeFetch([0, 0, 0]);
    const buf2 = new SpendBuffer({ sink, fetch: down.f, sleep: async () => {}, log: (m) => logs.push(m) });
    buf2.push(ev(2));
    await buf2.flush();
    expect(down.calls).toHaveLength(3);
    expect(logs[0]).toMatch(/dropped 1 event/);
  });

  it("does not retry a 4xx, and is bounded with the oldest dropped first", async () => {
    const logs: string[] = [];
    const refused = fakeFetch([403]);
    const buf = new SpendBuffer({ sink, fetch: refused.f, maxBuffered: 2, sleep: async () => {}, log: (m) => logs.push(m) });
    buf.push(ev(1));
    buf.push(ev(2));
    buf.push(ev(3));
    expect(buf.size).toBe(2);
    await buf.flush();
    expect(refused.calls).toHaveLength(1);
    expect(refused.calls[0].events.map((e) => e.event_id)).toEqual(["e2", "e3"]);
    expect(logs.some((l) => /refused a batch \(403\)/.test(l))).toBe(true);
  });
});

describe("recordLlmCall through lib/llm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("records a Perplexity answer on our key, and nothing for a customer's", async () => {
    vi.stubEnv("LETTERSTORY_SPEND_INGEST_URL", "https://app.example");
    vi.stubEnv("LETTERSTORY_SPEND_INGEST_KEY", "staff-key");
    const sent: { events: Record<string, unknown>[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).includes("/api/superadmin/spend/usage")) {
          sent.push(JSON.parse(String(init.body)));
          return new Response("{}", { status: 200 });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "An answer." }, finish_reason: "stop" }],
            search_results: [],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: { total_cost: 0.0061 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    // A customer's own key: no scope, nothing recorded.
    await runQuery({ provider: "perplexity", model: "sonar", apiKey: "pplx", prompt: "q" });
    expect(spendBuffer.size).toBe(0);

    const scope = spendScopeFor({ keySource: "trial", userId: "u", provider: "perplexity", projectId: "p9", runId: "r9" })!;
    await withSpendScope(scope, () => runQuery({ provider: "perplexity", model: "sonar", apiKey: "pplx", prompt: "q" }));
    expect(spendBuffer.size).toBe(1);
    await spendBuffer.flush();
    const events = sent.flatMap((b) => b.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "lettertrace",
      operation: "trial-probe",
      key_label: "TRIAL_PERPLEXITY_API_KEY",
      provider: "perplexity",
      model: "sonar",
      route: "direct",
      cost_usd: 0.0061,
      run_id: "r9",
      project_id: "p9",
    });
  });

  it("never throws, even on a payload it cannot read", () => {
    expect(() =>
      withSpendScope({ operation: "probe", keyLabel: "k" }, async () => recordLlmCall(undefined, { provider: "openai", model: "m", routed: true })),
    ).not.toThrow();
  });
});

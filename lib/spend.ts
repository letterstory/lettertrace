import { AsyncLocalStorage } from "node:async_hooks";
import type { Provider, RouteInfo } from "@/lib/types";

// ==================================================================
// What every model call on LETTER'S OWN keys really cost, sent to the
// letterstory app's spend ledger (spending.letter.dev).
//
// Lettertrace is bring-your-own-key: a customer's calls run on the customer's
// credential and are none of our spend. Two kinds of call are ours, and only
// those are recorded:
//   - the free tier: the operator's shared trial keys (TRIAL_CONCENTRATE_API_KEY,
//     or a per-provider TRIAL_*_API_KEY where Concentrate can't serve the engine),
//     filed as `trial-probe` on "Lettertrace Free Tier";
//   - Letter's own accounts (the ops account the Letterstory app probes through,
//     whose stored Concentrate key is "Lettertrace Probes"), named by user id in
//     LETTERSTORY_SPEND_USER_IDS, filed as `probe`.
// Who pays is decided once, where the run (or the utility call) resolves its key,
// by opening a scope with `withSpendScope`; lib/llm reads the scope on every reply
// and records nothing outside one.
//
// THE NUMBER. Concentrate puts the real price on every response (`cost.total`,
// BYOK and web search included) and has no usage API, so the reply is the only
// source. Perplexity is called directly: its `usage.cost.total_cost` when it
// reports one (billed), otherwise its published per-token + per-request prices
// applied here (estimated). A direct trial call to another provider sends its
// tokens with no cost; the ledger prices those at list.
//
// NEVER IN THE WAY. Recording is synchronous and allocation-only. The send runs
// after the response through waitUntil (Vercel keeps the function alive for it),
// in batches, three attempts, then a log line and the batch dropped. Unconfigured
// (no LETTERSTORY_SPEND_INGEST_URL / _KEY) it is a no-op.
// ==================================================================

export interface SpendScope {
  /** probe | trial-probe | suggest | trial-suggest */
  operation: string;
  keyLabel: string;
  projectId?: string | null;
  runId?: string | null;
  /** The letterstory org, when known; the app resolves it from the project otherwise. */
  orgId?: string | null;
}

const scopes = new AsyncLocalStorage<SpendScope>();

/** Run `fn` with every model reply inside it recorded under `scope`; null records nothing. */
export function withSpendScope<T>(scope: SpendScope | null, fn: () => Promise<T>): Promise<T> {
  return scope ? scopes.run(scope, fn) : fn();
}

export function currentSpendScope(): SpendScope | undefined {
  return scopes.getStore();
}

/** Letter's own lettertrace accounts (env LETTERSTORY_SPEND_USER_IDS, comma-separated user ids). */
export function spendUserIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.LETTERSTORY_SPEND_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
}

const TRIAL_KEY_ENV: Record<Provider, string> = {
  anthropic: "TRIAL_ANTHROPIC_API_KEY",
  openai: "TRIAL_OPENAI_API_KEY",
  google: "TRIAL_GOOGLE_API_KEY",
  perplexity: "TRIAL_PERPLEXITY_API_KEY",
};

/**
 * The scope for a call whose key has been resolved, or null when the money is
 * not ours. `kind` is what the call is: a run's asks (`probe`) or a utility
 * call (`suggest`); the free tier prefixes it with `trial-`.
 */
export function spendScopeFor(
  input: {
    keySource: string | null | undefined;
    userId: string | null | undefined;
    provider: Provider;
    route?: RouteInfo | null;
    projectId?: string | null;
    runId?: string | null;
    kind?: "probe" | "suggest";
  },
  env: NodeJS.ProcessEnv = process.env,
): SpendScope | null {
  const kind = input.kind ?? "probe";
  const routed = input.route?.router === "concentrate";
  const base = { projectId: input.projectId ?? null, runId: input.runId ?? null };
  if (input.keySource === "trial") {
    return {
      ...base,
      operation: `trial-${kind}`,
      keyLabel: routed
        ? env.SPEND_KEY_LABEL_TRIAL?.trim() || "Lettertrace Free Tier"
        : TRIAL_KEY_ENV[input.provider] ?? "Lettertrace trial key",
    };
  }
  const user = input.userId?.trim().toLowerCase();
  if (user && spendUserIds(env).includes(user)) {
    return {
      ...base,
      operation: kind,
      keyLabel: routed
        ? env.SPEND_KEY_LABEL_PROBES?.trim() || "Lettertrace Probes"
        : `Lettertrace ops ${input.provider} key`,
    };
  }
  return null;
}

// ------------------------------------------------------------------
// One reply → one event
// ------------------------------------------------------------------

/** The event the app's ingest takes (letterstory src/lib/validations/spend.ts spendUsageEventSchema). */
export interface SpendEvent {
  event_id: string;
  occurred_at: string;
  source: "lettertrace";
  key_label: string;
  operation: string;
  provider: string;
  model: string;
  route: "concentrate" | "direct";
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number | null;
  basis?: "billed" | "estimated";
  byok: boolean | null;
  org_id?: string;
  run_id?: string;
  project_id?: string;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Tokens and cost off a reply in any of the shapes lettertrace reads: Concentrate's
 * `cost`; Anthropic's usage (input excludes cache), OpenAI chat/Responses usage
 * (input includes the cached share, split out here), Gemini's usageMetadata, and
 * Perplexity's usage with its own `cost.total_cost`.
 */
export function readSpend(payload: unknown): {
  cost: number | null;
  byok: boolean | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  searchContext: string | null;
} {
  const p = obj(payload);
  const c = obj(p.cost);
  const u = obj(p.usage);
  const g = obj(p.usageMetadata);
  const details = obj(u.input_tokens_details ?? u.prompt_tokens_details);
  const anthropicShape = u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined;
  const cacheRead = count(u.cache_read_input_tokens) || count(details.cached_tokens) || count(g.cachedContentTokenCount);
  const rawInput = count(u.input_tokens) || count(u.prompt_tokens) || count(g.promptTokenCount);
  const input = anthropicShape ? rawInput : Math.max(0, rawInput - cacheRead);
  const output =
    (count(u.output_tokens) || count(u.completion_tokens)) +
    count(u.citation_tokens) +
    count(u.reasoning_tokens) +
    count(g.candidatesTokenCount) +
    count(g.thoughtsTokenCount);
  const pplxCost = obj(u.cost).total_cost;
  const gatewayCost = c.total;
  const cost =
    typeof gatewayCost === "number" && Number.isFinite(gatewayCost) && gatewayCost >= 0
      ? gatewayCost
      : typeof pplxCost === "number" && Number.isFinite(pplxCost) && pplxCost >= 0
        ? pplxCost
        : null;
  return {
    cost,
    byok: typeof c.byok === "boolean" ? c.byok : null,
    input,
    output,
    cacheRead,
    cacheCreation: count(u.cache_creation_input_tokens),
    searchContext: typeof u.search_context_size === "string" ? u.search_context_size : null,
  };
}

/**
 * Perplexity's published Sonar API prices (docs.perplexity.ai/getting-started/pricing,
 * as of 2026): USD per 1M input / output tokens, plus a per-request fee per 1,000
 * requests by search context size. Only used when a reply carries no cost of its own;
 * the event is then filed `estimated`. A model not listed is priced as sonar-pro (the
 * dearer common row), so an unknown one is never free.
 */
const PERPLEXITY_PRICES: Record<string, { input: number; output: number; perK: Record<string, number> }> = {
  sonar: { input: 1, output: 1, perK: { low: 5, medium: 8, high: 12 } },
  "sonar-pro": { input: 3, output: 15, perK: { low: 6, medium: 10, high: 14 } },
  "sonar-reasoning": { input: 1, output: 5, perK: { low: 5, medium: 8, high: 12 } },
  "sonar-reasoning-pro": { input: 2, output: 8, perK: { low: 6, medium: 10, high: 14 } },
  "sonar-deep-research": { input: 2, output: 8, perK: { low: 5, medium: 5, high: 5 } },
};

export function perplexityEstimateUsd(
  model: string,
  t: { input: number; output: number; searched: boolean; searchContext: string | null },
): number {
  const key = model.trim().toLowerCase().replace(/^perplexity\//, "");
  const price = PERPLEXITY_PRICES[key] ?? PERPLEXITY_PRICES["sonar-pro"];
  const perRequest = t.searched ? (price.perK[t.searchContext ?? "low"] ?? price.perK.low) / 1000 : 0;
  return (t.input * price.input + t.output * price.output) / 1_000_000 + perRequest;
}

export interface CallInfo {
  provider: Provider | string;
  /** The model or the router's slug ("google/gemini-3-pro"). */
  model: string;
  routed: boolean;
  /** Perplexity searches unless told not to; used only to estimate its request fee. */
  searched?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The event for one reply under `scope`. */
export function spendEvent(
  payload: unknown,
  call: CallInfo,
  scope: SpendScope,
  opts: { now?: Date; id?: string } = {},
): SpendEvent {
  const s = readSpend(payload);
  const slash = call.model.indexOf("/");
  const provider = call.routed && slash > 0 ? call.model.slice(0, slash) : String(call.provider);
  let cost = s.cost;
  let basis: "billed" | "estimated" | undefined;
  if (cost === null && provider === "perplexity") {
    cost = perplexityEstimateUsd(call.model, {
      input: s.input,
      output: s.output,
      searched: call.searched ?? true,
      searchContext: s.searchContext,
    });
    basis = "estimated";
  }
  return {
    event_id: opts.id ?? `lettertrace:${globalThis.crypto.randomUUID()}`,
    occurred_at: (opts.now ?? new Date()).toISOString(),
    source: "lettertrace",
    key_label: scope.keyLabel,
    operation: scope.operation,
    provider,
    model: call.model.slice(0, 160),
    route: call.routed ? "concentrate" : "direct",
    input_tokens: s.input,
    output_tokens: s.output,
    cache_read_tokens: s.cacheRead,
    cache_creation_tokens: s.cacheCreation,
    cost_usd: cost === null ? null : Math.round(cost * 1e10) / 1e10,
    ...(basis ? { basis } : {}),
    byok: s.byok,
    ...(scope.orgId && UUID.test(scope.orgId) ? { org_id: scope.orgId } : {}),
    ...(scope.runId ? { run_id: scope.runId } : {}),
    ...(scope.projectId ? { project_id: scope.projectId } : {}),
  };
}

// ------------------------------------------------------------------
// The buffer and the flush
// ------------------------------------------------------------------

export interface SpendSink {
  url: string;
  key: string;
}

export function spendSink(env: NodeJS.ProcessEnv = process.env): SpendSink | null {
  const raw = env.LETTERSTORY_SPEND_INGEST_URL?.trim();
  const key = env.LETTERSTORY_SPEND_INGEST_KEY?.trim();
  if (!raw || !key) return null;
  const base = raw.replace(/\/+$/, "");
  const url = base.endsWith("/api/superadmin/spend/usage") ? base : `${base}/api/superadmin/spend/usage`;
  return { url, key };
}

export interface SpendBufferOptions {
  sink: () => SpendSink | null;
  fetch?: typeof fetch;
  maxPerRequest?: number;
  maxBuffered?: number;
  attempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export class SpendBuffer {
  private events: SpendEvent[] = [];
  private inflight: Promise<void> | null = null;
  private dropped = 0;
  private readonly o: Required<Omit<SpendBufferOptions, "fetch">> & { fetch?: typeof fetch };

  constructor(options: SpendBufferOptions) {
    this.o = {
      maxPerRequest: 500,
      maxBuffered: 5_000,
      attempts: 3,
      timeoutMs: 8_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (m) => console.warn(m),
      ...options,
    };
  }

  get size(): number {
    return this.events.length;
  }

  push(event: SpendEvent): void {
    this.events.push(event);
    if (this.events.length > this.o.maxBuffered) {
      const over = this.events.length - this.o.maxBuffered;
      this.events.splice(0, over);
      const before = this.dropped;
      this.dropped += over;
      if (before === 0 || Math.floor(before / 1000) !== Math.floor(this.dropped / 1000)) {
        this.o.log(`[spend] buffer full: dropped ${this.dropped} event(s) so far (the ledger is unreachable)`);
      }
    }
  }

  /** Send everything waiting. Never rejects. */
  flush(): Promise<void> {
    if (this.inflight) return this.inflight.then(() => (this.events.length ? this.flush() : undefined));
    if (!this.events.length) return Promise.resolve();
    this.inflight = this.drain().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async drain(): Promise<void> {
    while (this.events.length) {
      const sink = this.o.sink();
      if (!sink) {
        this.events = [];
        return;
      }
      const batch = this.events.splice(0, this.o.maxPerRequest);
      if (!(await this.send(sink, batch))) {
        this.o.log(`[spend] ledger unreachable after ${this.o.attempts} attempts: dropped ${batch.length} event(s)`);
      }
    }
  }

  private async send(sink: SpendSink, events: SpendEvent[]): Promise<boolean> {
    const f = this.o.fetch ?? globalThis.fetch;
    for (let attempt = 1; attempt <= this.o.attempts; attempt++) {
      try {
        const res = await f(sink.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-staff-api-key": sink.key },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        if (res.ok) return true;
        if (res.status !== 429 && res.status < 500) {
          const detail = await res.text().catch(() => "");
          this.o.log(`[spend] ledger refused a batch (${res.status}): ${detail.slice(0, 300)}`);
          return true;
        }
      } catch {
        // network error or timeout: retried below
      }
      if (attempt < this.o.attempts) await this.o.sleep(500 * 2 ** (attempt - 1));
    }
    return false;
  }
}

export const spendBuffer = new SpendBuffer({ sink: () => spendSink() });

/** Keep the function alive for `work` after the response where the runtime allows it. */
function inBackground(work: Promise<unknown>): void {
  const swallowed = work.catch((e) => {
    console.error(`[spend] background flush failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  try {
    const { waitUntil } = require("@vercel/functions") as { waitUntil: (p: Promise<unknown>) => void };
    waitUntil(swallowed);
  } catch {
    void swallowed;
  }
}

let scheduled: Promise<void> | null = null;
/** Send soon: a short debounce collects a run's concurrent asks into one batch. */
function scheduleFlush(delayMs = 1_500): void {
  if (scheduled) return;
  scheduled = new Promise<void>((r) => setTimeout(r, delayMs)).then(() => {
    scheduled = null;
    return spendBuffer.flush();
  });
  inBackground(scheduled);
}

/**
 * Record one model reply. Called by lib/llm on every reply it parses. A no-op
 * outside a spend scope (a customer's own key) or when the ledger is not
 * configured. Never throws.
 */
export function recordLlmCall(payload: unknown, call: CallInfo): void {
  try {
    const scope = scopes.getStore();
    if (!scope || !spendSink()) return;
    spendBuffer.push(spendEvent(payload, call, scope));
    scheduleFlush();
  } catch {
    // Recording must never break an answer.
  }
}

/** Send what is waiting now, after the response (the end of a run leg). */
export function flushSpendInBackground(): void {
  if (spendBuffer.size) inBackground(spendBuffer.flush());
}

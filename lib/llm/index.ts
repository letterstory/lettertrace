import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Provider, RouteInfo, RouterId, Sentiment, Specificity } from "@/lib/types";
import {
  AI_OVERVIEWS_BACKING_MODEL,
  GOOGLE_AI_OVERVIEWS_MODEL,
  PROVIDERS,
  analysisModelFor,
} from "@/lib/models";
import {
  ROUTERS,
  routerSlug,
  routerSupport,
  type RouteShape,
  type SearchSupport,
} from "@/lib/routers";
import { normalizeCompetitorList } from "@/lib/competitors";
import { recordProviderCall, withSpan } from "@/lib/otel";

// ------------------------------------------------------------------
// Provider adapters. Every call here uses the *user's own* API key (BYOK).
// Two shapes of call:
//   1. runQuery: ask the model a question like a real user would, and
//      capture the natural assistant answer (the thing we scan for mentions).
//   2. utility calls: generateVariations / analyzeResponse, structured JSON
//      tasks Lettertrace runs on the user's behalf.
// ------------------------------------------------------------------

const ANSWER_MAX_TOKENS = 1200;
const UTILITY_MAX_TOKENS = 1500;
// OpenAI's Responses grounded path needs its own, much larger output budget.
// max_output_tokens there caps reasoning + search + answer TOGETHER, and the
// gpt-5.6 (reasoning) models spend thousands of tokens thinking and searching
// before writing anything — at ANSWER_MAX_TOKENS (1200) they exhaust the budget
// mid-reasoning and return status "incomplete" on real (non-trivial) prompts,
// which fails the run. Verified: 1200 fails 4/4 real prompts; 4000-8000 all
// complete and ground richly (8-12 inline citations + dozens of searched
// sources). Non-reasoning gpt-4o is unaffected (it completes well under 1200),
// and the model stops when done, so the higher cap is headroom, not a floor.
const OPENAI_SEARCH_MAX_OUTPUT_TOKENS = 8000;

// Both SDKs at these versions (@anthropic-ai/sdk 0.30, openai 4.x) default to
// node-fetch, which throws "Premature close" reading some providers' response
// bodies — most consistently the Concentrate gateway's GROUNDED Claude/Gemini
// replies (large, multi-round web-search answers). Concentrate delivers and
// BILLS them with a 200; node-fetch just can't read them to completion, while
// curl and Node's built-in undici fetch read the identical bytes fine. Retries
// don't help: it's ~100% for those routes, not transient, so every attempt
// fails AND re-bills (maxRetries × the answer cost, for zero stored data).
// Routing the SDKs through undici (globalThis.fetch) tolerates the framing and
// fixes it. Keep the raised retry count + explicit timeout for genuine drops.
const CLIENT_OPTS = { maxRetries: 4, timeout: 60_000, fetch: globalThis.fetch } as const;

interface BaseCall {
  provider: Provider;
  model: string;
  apiKey: string;
  /**
   * Set when the key is an LLM router credential rather than a direct provider
   * key. `provider`/`model` still say which engine is being measured — the route
   * only changes who we hand the request to on the way there.
   */
  route?: RouteInfo | null;
}

// Every low-level call reports its total token usage so the trial layer can
// meter it. `tokens` is input + output tokens for the call.
export interface ChatResult {
  text: string;
  tokens: number;
}

// A web source the model cited while answering (native provider web search).
export interface CitedSource {
  url: string;
  domain: string;
  title: string | null;
  snippet: string | null;
}

export interface QueryResult extends ChatResult {
  sources: CitedSource[];
}

// How many web searches a single monitored query may run.
const WEB_SEARCH_MAX_USES = 5;

// Parse a citation URL, keeping only safe http(s) links (guards against a
// model citing a javascript:/data: URL that would later render as an href).
// Returns the cleaned url + its registrable host, or null to drop the source.
export function safeSource(url: string, title: string | null, snippet: string | null): CitedSource | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return {
    url,
    domain: parsed.hostname.replace(/^www\./i, "").toLowerCase(),
    title,
    snippet,
  };
}

// Collapse cited sources to one row per URL, keeping the first title/snippet.
export function dedupeSources(raw: CitedSource[]): CitedSource[] {
  const seen = new Map<string, CitedSource>();
  for (const s of raw) {
    if (!s.url) continue;
    const existing = seen.get(s.url);
    if (!existing) seen.set(s.url, s);
    else if (!existing.snippet && s.snippet) existing.snippet = s.snippet;
  }
  return Array.from(seen.values());
}

// --- Routing through an LLM gateway ---------------------------------------

/**
 * A router call, fully resolved: which wire format, which base URL, which model
 * slug, and what extra body the router needs. Computed once per call so the
 * adapters below stay unaware of routers beyond "talk to this URL instead".
 */
interface RoutePlan {
  router: RouterId;
  shape: RouteShape;
  slug: string;
  baseUrl: string;
  search: SearchSupport;
  /** Which header carries the key on the Anthropic surface — see the registry. */
  anthropicAuth: "x-api-key" | "bearer";
  extraBody: Record<string, unknown>;
}

/**
 * Raised when a route is asked for something the router cannot serve.
 *
 * Reaching this is a bug in the gating above (lib/trial resolves the credential
 * and refuses the combination before a run starts), so it is deliberately loud
 * rather than a silent fallback to a direct call — falling back would spend the
 * user's key on a request they didn't authorize, and falling back to a *different
 * engine* is the exact class of bug resolveRunKeyFor exists to prevent.
 */
export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

function planRoute(
  route: RouteInfo,
  provider: Provider,
  model: string,
  opts: { webSearch: boolean },
): RoutePlan {
  const info = ROUTERS[route.router];
  const support = routerSupport(route.router, provider);
  const slug = routerSlug(route.router, provider, model);
  if (!support || !slug) {
    throw new RouteError(
      `${info.label} can't serve ${PROVIDERS[provider].label} (${model}).`,
    );
  }

  // A self-hosted base URL replaces the registry's for either shape: the user
  // deployed one gateway, and it answers on the paths its upstream defines.
  const base = route.baseUrl?.trim() || null;
  let baseUrl: string;
  if (support.shape === "anthropic") {
    const anthropicBase = base ?? info.anthropicBaseUrl;
    if (!anthropicBase) {
      throw new RouteError(`${info.label} has no Anthropic-compatible endpoint.`);
    }
    baseUrl = anthropicBase;
  } else {
    baseUrl = base ?? info.openaiBaseUrl;
  }

  return {
    router: route.router,
    shape: support.shape,
    slug,
    baseUrl,
    search: support.search,
    anthropicAuth: info.anthropicAuth,
    extraBody: info.extraBody?.(provider, { webSearch: opts.webSearch }) ?? {},
  };
}

/**
 * Anthropic client options for a call, direct or routed.
 *
 * The SDK sends exactly one auth header — `x-api-key` when apiKey is set,
 * `Authorization: Bearer` when only authToken is — so a router that wants the
 * bearer form has to be given the key as authToken with apiKey explicitly null.
 * Passing both would silently send only the first.
 */
function anthropicOpts(apiKey: string, plan?: RoutePlan) {
  if (!plan) return { apiKey, ...CLIENT_OPTS };
  return plan.anthropicAuth === "bearer"
    ? { apiKey: null, authToken: apiKey, baseURL: plan.baseUrl, ...CLIENT_OPTS }
    : { apiKey, baseURL: plan.baseUrl, ...CLIENT_OPTS };
}

// --- Low-level chat helpers -----------------------------------------------
//
// Each takes an optional `plan`. With one, the call goes to the router's base
// URL with the router's model slug and extra body; without one it is the direct
// provider call it has always been. Keeping this a parameter rather than a
// separate gateway module is what guarantees a routed call and a direct call
// can't drift apart in the parts that decide what gets measured.

async function anthropicChat(
  apiKey: string,
  model: string,
  system: string | undefined,
  user: string,
  maxTokens: number,
  plan?: RoutePlan,
): Promise<ChatResult> {
  const client = new Anthropic(anthropicOpts(apiKey, plan));
  // Built as a plain object and cast once, the same way anthropicWebSearch casts
  // for the server-side web_search tool, so a routed call can carry fields the
  // SDK's param types don't know about.
  const params = {
    model: plan ? plan.slug : model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: user }],
    ...(plan?.extraBody ?? {}),
  };
  const msg = await client.messages.create(
    params as unknown as Anthropic.MessageCreateParamsNonStreaming,
  );
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const tokens = (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0);
  return { text, tokens };
}

async function openaiChat(
  apiKey: string,
  model: string,
  system: string | undefined,
  user: string,
  maxTokens: number,
  json = false,
  plan?: RoutePlan,
): Promise<ChatResult> {
  const client = new OpenAI({
    apiKey,
    ...CLIENT_OPTS,
    ...(plan ? { baseURL: plan.baseUrl } : {}),
  });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  const params = {
    model: plan ? plan.slug : model,
    // Not max_tokens: the gpt-5.6 family rejects it outright ("Unsupported
    // parameter: 'max_tokens' ... Use 'max_completion_tokens' instead"), so the
    // old field made every ungrounded 5.6 call a hard 400. Probed 2026-08-18:
    // max_completion_tokens is accepted by gpt-4o, gpt-4o-mini and both 5.6
    // models directly, and by Concentrate's chat surface for openai AND google
    // slugs. (OpenRouter/Merge not re-probed; both mirror OpenAI's surface.)
    max_completion_tokens: maxTokens,
    messages,
    ...(json ? { response_format: { type: "json_object" } } : {}),
    ...(plan?.extraBody ?? {}),
  };
  const res = await client.chat.completions.create(
    params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  );
  return {
    text: (res.choices[0]?.message?.content ?? "").trim(),
    tokens: res.usage?.total_tokens ?? 0,
  };
}

// Pull the first JSON value out of a model reply (handles ```json fences etc.).
function extractJson<T>(raw: string): T {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const firstBrace = text.search(/[[{]/);
  if (firstBrace > 0) text = text.slice(firstBrace);
  const lastBrace = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  if (lastBrace >= 0) text = text.slice(0, lastBrace + 1);
  return JSON.parse(text) as T;
}

// --- Utility-call dispatch ------------------------------------------------

/**
 * Which wire format a utility call will actually take.
 *
 * Utility work (prompt suggestion, competitor judging, sentiment) branches on
 * the *shape* rather than the provider, because a routed Claude call and a direct
 * Claude call want the same system prompt while a routed call through an
 * OpenAI-compatible endpoint wants OpenAI's JSON-object phrasing. Deriving the
 * shape once keeps those two decisions — how to ask, and where to send it — from
 * being made on different criteria.
 */
// Wider than RouteShape: a DIRECT OpenAI utility call is chat-completions
// shaped, which no route uses now that the only shipped router mirrors the
// Responses API. Both still want OpenAI's JSON-object phrasing.
type CallShape = RouteShape | "openai-chat" | "google" | "perplexity";

const DIRECT_SHAPE: Record<Provider, CallShape> = {
  anthropic: "anthropic",
  openai: "openai-chat",
  google: "google",
  perplexity: "perplexity",
};

function callShape(opts: BaseCall, model: string): CallShape {
  if (!opts.route) return DIRECT_SHAPE[opts.provider];
  return planRoute(opts.route, opts.provider, model, { webSearch: false }).shape;
}

/**
 * One structured-JSON utility call, direct or routed.
 *
 * This replaces the four copies of the same provider ternary ladder that used to
 * sit in generateVariations / analyzeResponse / suggestFromSite /
 * suggestCompetitors. They had already drifted once — a provider added to the
 * catalog has to be remembered in each — and adding a router branch to all four
 * would have doubled that surface.
 */
async function utilityChat(
  opts: BaseCall,
  model: string,
  system: string | undefined,
  user: string,
  maxTokens: number,
  json = false,
): Promise<ChatResult> {
  if (opts.route) {
    const plan = planRoute(opts.route, opts.provider, model, { webSearch: false });
    return plan.shape === "anthropic"
      ? anthropicChat(opts.apiKey, model, system, user, maxTokens, plan)
      : openaiChat(opts.apiKey, model, system, user, maxTokens, json, plan);
  }
  switch (opts.provider) {
    case "anthropic":
      return anthropicChat(opts.apiKey, model, system, user, maxTokens);
    case "google":
      return googleChat(opts.apiKey, model, system, user, maxTokens, json);
    case "perplexity":
      return perplexityChat(opts.apiKey, model, system, user, maxTokens);
    default:
      return openaiChat(opts.apiKey, model, system, user, maxTokens, json);
  }
}

// --- Public API -----------------------------------------------------------

/** Verify a BYOK key with a tiny probe call. */
export async function verifyKey(
  provider: Provider,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (provider === "anthropic") {
      await anthropicChat(apiKey, "claude-haiku-4-5", undefined, "ping", 4);
    } else if (provider === "google") {
      await googleChat(apiKey, "gemini-flash-lite-latest", undefined, "ping", 8);
    } else if (provider === "perplexity") {
      await perplexityChat(apiKey, "sonar", undefined, "ping", 8);
    } else {
      await openaiChat(apiKey, "gpt-4o-mini", undefined, "ping", 4);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: humanError(err) };
  }
}

/**
 * Output-token ceiling for the reachability ping.
 *
 * Deliberately not the 4 the direct verifyKey uses. Gateways impose their own
 * floors: Concentrate rejects an OpenAI request under 16 output tokens outright
 * — with a 402 whose text blames "the remaining balance", which is doubly
 * misleading — so an 8-token ping reported a perfectly good credential as
 * unreachable and refused to let it serve GPT. Measured: 8 fails, 16 and 64
 * succeed on the same key. Perplexity has the same floor (see
 * PERPLEXITY_MIN_MAX_TOKENS), so this is a class of behaviour, not one vendor's
 * quirk.
 */
const PING_MAX_TOKENS = 16;

/** One provider's result from checking a router credential. */
export interface RouterProviderCheck {
  provider: Provider;
  /** Did a minimal call through the router actually reach this engine? */
  reachable: boolean;
  /** How search is expressed for this pair — see lib/routers. */
  search: SearchSupport;
  /**
   * Did a forced native search come back with real sources? Null when the
   * question doesn't apply: 'none' (nothing to ask for) or 'plugin' (the
   * router's own flag, verified by the router, not compellable by us).
   */
  searchWorks: boolean | null;
  error?: string;
}

export interface RouterVerification {
  /** True when the key reached at least one engine. */
  ok: boolean;
  error?: string;
  reachable: Provider[];
  /** Providers cleared to serve monitored web-search runs on this key. */
  searchVerified: Provider[];
  checks: RouterProviderCheck[];
}

/**
 * A router credential's real capabilities, measured rather than assumed.
 *
 * Two questions per provider, and the second is the one that matters. Reaching
 * a model through a gateway is easy and proves little; what Lettertrace depends
 * on is that the provider's own web search survives the trip, because every
 * monitored answer is supposed to be grounded in the live web. A gateway that
 * normalizes requests can accept `web_search` and return a fluent, sourceless
 * answer, and that answer would be stored and charted exactly like a grounded
 * one. So for every pair where we send the provider's own search params, we send
 * them for real and require sources to come back.
 *
 * Costs the user a couple of small calls plus one real web search per
 * passthrough provider, on their own key, at save time — cheap next to
 * discovering weeks later that a trend line was measuring recall.
 */
export async function verifyRouterKey(
  router: RouterId,
  apiKey: string,
  baseUrl?: string | null,
): Promise<RouterVerification> {
  const route: RouteInfo = { router, baseUrl: baseUrl ?? null };
  const providers = Object.keys(ROUTERS[router].providers) as Provider[];

  const checks = await Promise.all(
    providers.map(async (provider): Promise<RouterProviderCheck> => {
      const support = routerSupport(router, provider);
      const search = support?.search ?? "none";
      // The cheap model, as elsewhere: this is a reachability check, not a
      // capability demo, and the user is paying for it.
      const model = analysisModelFor(provider);
      const base: RouterProviderCheck = {
        provider,
        reachable: false,
        search,
        searchWorks: search === "passthrough" ? false : null,
      };

      try {
        await utilityChat({ provider, model, apiKey, route }, model, undefined, "ping", PING_MAX_TOKENS);
      } catch (err) {
        return { ...base, error: humanError(err) };
      }

      if (search !== "passthrough") return { ...base, reachable: true };

      try {
        const probe = await probeRouterSearch(route, provider, model, apiKey);
        return { ...base, reachable: true, searchWorks: probe.sources > 0 };
      } catch (err) {
        // Reached the model but the search request failed — the credential is
        // usable, the grounding isn't. Recorded as such rather than failing the
        // whole save, so a user can still route ungrounded projects through it.
        return { ...base, reachable: true, searchWorks: false, error: humanError(err) };
      }
    }),
  );

  const reachable = checks.filter((c) => c.reachable).map((c) => c.provider);
  const searchVerified = checks.filter((c) => c.searchWorks === true).map((c) => c.provider);
  const firstError = checks.find((c) => !c.reachable && c.error)?.error;

  return {
    ok: reachable.length > 0,
    ...(reachable.length === 0
      ? { error: firstError || `${ROUTERS[router].label} didn't accept this key.` }
      : {}),
    reachable,
    searchVerified,
    checks,
  };
}

/**
 * Send a router the provider's own forced-search request and count the sources
 * that come back. Exported for the probe script (scripts/probe-router.ts), which
 * is how a new router's support entry gets filled in.
 */
export async function probeRouterSearch(
  route: RouteInfo,
  provider: Provider,
  model: string,
  apiKey: string,
): Promise<{ sources: number; text: string }> {
  // A question that cannot be answered from training data, so a sourceless reply
  // is unambiguous evidence the browse didn't happen rather than evidence that
  // the model already knew.
  const prompt =
    "Search the web and tell me one news headline published in the last 48 hours. Cite the source URL.";
  const res = await runQuery({ provider, model, apiKey, route, prompt, webSearch: true });
  return { sources: res.sources.length, text: res.text };
}

/**
 * Ask the model a monitored question and return its natural answer, token
 * usage, and (when `webSearch` is on) the web sources it cited. Web search uses
 * each provider's NATIVE browsing via the user's own key — no third-party
 * search service — so it stays fully self-hostable.
 */
export async function runQuery(
  opts: BaseCall & { prompt: string; webSearch?: boolean },
): Promise<QueryResult> {
  // Attributes describe the CALL, never its content: which engine, which
  // model, which route, and whether grounding was asked for. No prompt, no
  // answer, no brand, no domain — see lib/otel/index.ts.
  const attrs = {
    "llm.provider": opts.provider,
    "llm.model": opts.model,
    "llm.web_search": opts.webSearch ?? false,
    "llm.route": opts.route?.router ?? "direct",
  };
  const startedMs = Date.now();
  return withSpan("llm.query", attrs, async (span) => {
    let tokens = 0;
    let outcome = "error";
    try {
      const result = await runQueryUnmeasured(opts);
      tokens = result.tokens;
      outcome = "success";
      span.setAttributes({ "llm.tokens": result.tokens, "llm.sources": result.sources.length });
      return result;
    } finally {
      // A failed call still costs time and is the thing worth alerting on, so
      // it is recorded with the same attributes plus its outcome — an engine
      // that has stopped answering shows up as a rate, not as an absence.
      recordProviderCall(Date.now() - startedMs, tokens, { ...attrs, "llm.outcome": outcome });
    }
  });
}

async function runQueryUnmeasured(
  opts: BaseCall & { prompt: string; webSearch?: boolean },
): Promise<QueryResult> {
  const webSearch = opts.webSearch ?? false;

  // A routed answer (anthropic / openai / gemini through the router) — the
  // registry serves no others, and lib/trial refuses the combination before a
  // run starts — so this sits above the Google/Perplexity direct branches.
  if (opts.route) {
    const plan = planRoute(opts.route, opts.provider, opts.model, { webSearch });
    if (plan.shape === "anthropic") {
      return webSearch
        ? anthropicWebSearch(opts.apiKey, opts.model, opts.prompt, plan)
        : anthropicChat(opts.apiKey, opts.model, undefined, opts.prompt, ANSWER_MAX_TOKENS, plan)
            .then((res) => ({ ...res, sources: [] }));
    }
    // The Responses API path with a forced web-search tool: OpenAI, and Gemini
    // via Concentrate (openaiWebSearch picks the right tool per slug). Same
    // forced measurement in both cases.
    if (plan.shape === "openai-responses" && webSearch) {
      return openaiWebSearch(opts.apiKey, opts.model, opts.prompt, plan);
    }
    // Otherwise chat-completions: nothing was asked to be grounded, so there is
    // no forcing to preserve and the simpler endpoint is the right one.
    return gatewayQuery(opts.apiKey, opts.prompt, plan, webSearch);
  }

  // Google's answer path handles its own grounding (and forces it for the AI
  // Overviews engine), so route it before the shared web-search branch.
  if (opts.provider === "google") {
    return googleRunQuery(opts.apiKey, opts.model, opts.prompt, webSearch);
  }
  // Perplexity always searches, so it ignores the project toggle entirely.
  if (opts.provider === "perplexity") {
    return perplexityRunQuery(opts.apiKey, opts.model, opts.prompt);
  }
  if (!webSearch) {
    const res =
      opts.provider === "anthropic"
        ? await anthropicChat(opts.apiKey, opts.model, undefined, opts.prompt, ANSWER_MAX_TOKENS)
        : await openaiChat(opts.apiKey, opts.model, undefined, opts.prompt, ANSWER_MAX_TOKENS);
    return { ...res, sources: [] };
  }
  return opts.provider === "anthropic"
    ? anthropicWebSearch(opts.apiKey, opts.model, opts.prompt)
    : openaiWebSearch(opts.apiKey, opts.model, opts.prompt);
}

/**
 * An answer through a router's OpenAI-compatible endpoint.
 *
 * The router standardizes cited sources into `message.annotations` as
 * `url_citation` entries, so unlike the direct OpenAI path (which reads the
 * Responses API's own annotation shape) there is one shape to parse regardless
 * of which upstream answered. Sources still come from the provider's native
 * browsing — the router's `engine: "native"` pin, set in the registry, is what
 * keeps a third-party search service out of the measurement.
 */
async function gatewayQuery(
  apiKey: string,
  prompt: string,
  plan: RoutePlan,
  webSearch: boolean,
): Promise<QueryResult> {
  if (webSearch && plan.search === "none") {
    // Defensive: the gating in lib/trial should have refused this. Answering
    // anyway would store a memory answer as a search-grounded measurement.
    throw new RouteError(
      `${ROUTERS[plan.router].label} can't request native web search for this engine.`,
    );
  }
  const client = new OpenAI({ apiKey, baseURL: plan.baseUrl, ...CLIENT_OPTS });
  const params = {
    model: plan.slug,
    // Same field as openaiChat, for the same reason: a routed gpt-5.6 call
    // with max_tokens is a hard 400, and Concentrate accepts the newer field
    // for every slug family probed (2026-08-18, openai + google).
    max_completion_tokens: ANSWER_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
    ...plan.extraBody,
  };
  const res = (await client.chat.completions.create(
    params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  )) as unknown as {
    choices?: {
      message?: {
        content?: string | null;
        annotations?: {
          type?: string;
          url_citation?: { url?: string; title?: string; content?: string };
        }[];
      };
    }[];
    usage?: { total_tokens?: number };
  };

  const message = res.choices?.[0]?.message;
  return {
    text: (message?.content ?? "").trim(),
    tokens: res.usage?.total_tokens ?? 0,
    sources: gatewaySources(message?.annotations),
  };
}

/** A gateway's `url_citation` annotations, as cited sources. Exported for tests. */
export function gatewaySources(
  annotations:
    | { type?: string; url_citation?: { url?: string; title?: string; content?: string } }[]
    | undefined,
): CitedSource[] {
  const raw: CitedSource[] = [];
  for (const a of annotations ?? []) {
    // Routers may add annotation kinds (file citations, moderation notes). Only
    // url_citation is a web source; anything else is not a search result and
    // must not be counted as one. An annotation with no type is accepted, since
    // url_citation is the only kind that carries a url_citation payload.
    if (a.type && a.type !== "url_citation") continue;
    const cite = a.url_citation;
    const s = cite?.url ? safeSource(cite.url, cite.title ?? null, cite.content ?? null) : null;
    if (!s) continue;
    // Gemini grounded through a gateway cites Google's redirect host, not the
    // real domain (the domain rides in the title) — the same shape the direct
    // Google path resolves in googleGroundingSources. Take the domain from the
    // title; if it isn't a hostname, drop the row rather than attribute the
    // citation to Google's redirect host (which can never match a brand and would
    // skew the cited-domain leaderboard). Non-Google citations are untouched.
    if (s.domain === GOOGLE_REDIRECT_HOST) {
      const domain = domainFromTitle(s.title);
      if (!domain) continue;
      raw.push({ ...s, domain });
    } else {
      raw.push(s);
    }
  }
  return dedupeSources(raw);
}

// --- Native web-search query paths ---------------------------------------

async function anthropicWebSearch(
  apiKey: string,
  model: string,
  prompt: string,
  plan?: RoutePlan,
): Promise<QueryResult> {
  const client = new Anthropic(anthropicOpts(apiKey, plan));
  // web_search is a server-side tool not in older SDK typings; cast the params.
  //
  // Keep the 20250305 tool version. The newer web_search_20260209 runs dynamic
  // filtering through code execution and returns results in a shape this parser
  // doesn't read: measured against the same prompt it produced 0 inline
  // citations (vs 11) for 2.6x the tokens, falling back to the "retrieved but
  // not cited" path below. Upgrading needs the citation parsing reworked first.
  //
  // Through a router this body is unchanged, which is the point: the gateway's
  // Anthropic skin gets exactly the request Anthropic itself gets, so the forced
  // browse and the inline citations either arrive intact or the probe catches
  // that they didn't. Nothing here is rewritten into a normalized shape.
  const params = {
    model: plan ? plan.slug : model,
    max_tokens: ANSWER_MAX_TOKENS,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES }],
    // Force the browse, matching the OpenAI path. Left to choose, the model
    // answers well-known questions from memory and cites nothing — in a live
    // pilot it searched on only 4 of 10 prompts where OpenAI searched on 10,
    // which made the two providers' mention rates measure different things.
    // use_web_search is opt-in per project, so when it's on the user has asked
    // us to check the live web. Costs roughly 4x the tokens of a memory answer.
    tool_choice: { type: "tool", name: "web_search" },
    messages: [{ role: "user", content: prompt }],
    ...(plan?.extraBody ?? {}),
  };
  const msg = await client.messages.create(
    params as unknown as Anthropic.MessageCreateParamsNonStreaming,
  );

  // The web_search block/citation shapes aren't in older SDK types; read them
  // structurally.
  type Cite = { url?: string; title?: string; cited_text?: string };
  type Block = {
    type?: string;
    text?: string;
    citations?: Cite[];
    content?: { url?: string; title?: string }[];
  };
  let text = "";
  const cited: CitedSource[] = [];
  const retrieved: CitedSource[] = [];
  const blocks = (msg.content ?? []) as unknown as Block[];
  for (const block of blocks) {
    if (block.type === "text") {
      text += (text ? "\n" : "") + (block.text ?? "");
      // Sources the answer actually cited — the primary signal.
      for (const c of block.citations ?? []) {
        const s = c.url ? safeSource(c.url, c.title ?? null, c.cited_text ?? null) : null;
        if (s) cited.push(s);
      }
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      // Retrieved but maybe not cited — used only as a fallback below.
      for (const r of block.content) {
        const s = r.url ? safeSource(r.url, r.title ?? null, null) : null;
        if (s) retrieved.push(s);
      }
    }
  }

  // Prefer inline citations (what the answer used); fall back to retrieved
  // results only when the model searched but cited nothing inline.
  const sources = dedupeSources(cited.length > 0 ? cited : retrieved);
  const tokens = (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0);
  return { text: text.trim(), tokens, sources };
}

// OpenAI native web search via the Responses API. Uses raw fetch so it doesn't
// depend on a newer SDK; retries a couple of transient failures. The browse is
// forced via tool_choice (see below) — verified live for gpt-4o / gpt-4o-mini,
// and on 2026-08-18 for gpt-5.6-sol and gpt-5.6-luna, both direct and through
// Concentrate's Responses mirror (see scripts/probe-openai-models.ts).
//
// Two things the 5.6 probes established that gpt-4o never showed:
// - The 5.6 models run several search rounds plus reasoning per answer —
//   30-60k total tokens per grounded query where gpt-4o spends ~500. That is
//   a COST property, not a failure; it just makes trial metering and pricing
//   assumptions written for gpt-4o an order of magnitude off.
// - Inline citations are less reliable: a 5.6 answer completes a forced browse
//   (web_search_call present) yet attaches zero url_citation annotations ~30%
//   of the time. Requesting `include: web_search_call.action.sources` exposes
//   the URLs the browse actually visited, so we fall back to those — mirroring
//   the Anthropic path's retrieved-but-not-cited results. That turns a
//   searched-but-uncited answer from a false "ungrounded" (a real, billed
//   browse discarded) into the grounded measurement it is.
async function openaiWebSearch(
  apiKey: string,
  model: string,
  prompt: string,
  plan?: RoutePlan,
): Promise<QueryResult> {
  // Serves two surfaces through the same Responses API + forced web search:
  // direct/routed OpenAI, and Gemini via Concentrate (its google/* slug). A
  // routed measurement is the same request as a direct one, forcing included.
  const url = plan ? `${plan.baseUrl}/responses` : "https://api.openai.com/v1/responses";

  // OpenAI's Responses search tool is `web_search_preview`. Concentrate's
  // unified tool — what Gemini needs — is `web_search`, forced with tool_choice
  // "required". Gemini's other path (chat-completions `web_search_options`) only
  // HINTS, so it grounded at random (~1/4); on this forced tool it grounds 12/12.
  const isGemini = plan?.slug?.startsWith("google/") ?? false;
  const searchTool = isGemini ? { type: "web_search" } : { type: "web_search_preview" };
  const searchToolChoice: unknown = isGemini ? "required" : { type: "web_search_preview" };
  // tool_choice "required" hard-forces OpenAI, but Concentrate maps our
  // web_search tool to Gemini's {googleSearch:{}}, which is model-decides — so
  // "required" doesn't strictly force a Gemini search (per Concentrate). It
  // searches consistently in practice, but we add the same ALWAYS_SEARCH
  // instruction lettertrace uses on the DIRECT Gemini path as belt-and-
  // suspenders, keeping native Google grounding. OpenAI needs none — it's
  // hard-forced. (Not Exa: that's a third-party engine, non-representative.)
  //
  // The AI-Overviews surface routes here too (its google/* backing slug makes
  // isGemini true), but it is not a plain Gemini answer: it needs the overview
  // persona the direct path applies via AI_OVERVIEW_SYSTEM. That prompt already
  // ends with ALWAYS_SEARCH, so it carries the search push as well — send it in
  // full instead of the bare nudge, keeping the routed overview identical in
  // voice and grounding to the direct one. Detected from the requested model,
  // which stays `google-ai-overviews` (the surface) even though the slug is the
  // backing Gemini model.
  const isOverview = model === GOOGLE_AI_OVERVIEWS_MODEL;
  const geminiSearchInstruction = isOverview
    ? AI_OVERVIEW_SYSTEM
    : isGemini
      ? ALWAYS_SEARCH.replace(/^-\s*/, "")
      : undefined;

  interface ResponsesBody {
    status?: string;
    incomplete_details?: { reason?: string };
    output?: {
      type?: string;
      action?: { sources?: { url?: string; title?: string }[] };
      content?: { type?: string; text?: string; annotations?: { url?: string; title?: string }[] }[];
    }[];
    usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number };
  }

  // The transport retries; the parsing below does not. An answer that came back
  // incomplete or empty is a deliverable the model produced and billed — on the
  // 5.6 models a single grounded answer runs 30-60k tokens, so retrying a
  // deterministic failure re-bills it for zero stored data (the same trap the
  // node-fetch note on CLIENT_OPTS describes).
  let j: ResponsesBody | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3 && !j; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: plan ? plan.slug : model,
          tools: [searchTool],
          // Force the browse; left to choose, the model answers from memory and
          // cites nothing. Verified through Concentrate for both OpenAI and
          // Gemini: forced returns sources even for a memory-answerable question.
          tool_choice: searchToolChoice,
          // Gemini-only: the ALWAYS_SEARCH nudge (see geminiSearchInstruction),
          // since tool_choice doesn't hard-force Gemini's native search.
          ...(geminiSearchInstruction ? { instructions: geminiSearchInstruction } : {}),
          // Ask the Responses API to attach the searched result URLs to the
          // web_search_call item. The 5.6 models search every time (the browse
          // is forced) but attach inline url_citation annotations only ~70% of
          // the time; without this include there is nothing to fall back to, so
          // ~30% of grounded answers record ZERO sources and fail as
          // "ungrounded" — a real, billed browse discarded. Verified via
          // scripts/probe-router.ts + the Concentrate response shape.
          include: ["web_search_call.action.sources"],
          input: prompt,
          // Big budget: reasoning + search + answer share this cap, and gpt-5.6
          // returns "incomplete" at ANSWER_MAX_TOKENS (see the constant's note).
          max_output_tokens: OPENAI_SEARCH_MAX_OUTPUT_TOKENS,
          ...plan?.extraBody,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new OpenAI.APIError(res.status, body, undefined, undefined);
        // Retry transient server errors; surface auth/quota immediately.
        if (res.status >= 500) { lastErr = err; continue; }
        throw err;
      }
      j = (await res.json()) as ResponsesBody;
    } catch (err) {
      lastErr = err;
      if (err instanceof OpenAI.APIError && err.status && err.status < 500) throw err;
    }
  }
  if (!j) throw lastErr ?? new Error("OpenAI web search failed.");

  let text = "";
  const cited: CitedSource[] = [];
  const searched: CitedSource[] = [];
  for (const item of j.output ?? []) {
    // action.sources (present thanks to the `include` above) are the URLs the
    // forced browse actually visited — the fallback for a searched-but-uncited
    // answer, mirroring the Anthropic path's retrieved-but-not-cited results.
    if (item.type === "web_search_call") {
      for (const s of item.action?.sources ?? []) {
        const src = s?.url ? safeSource(s.url, s.title ?? null, null) : null;
        if (src) searched.push(src);
      }
    }
    for (const c of item.content ?? []) {
      if (typeof c.text === "string") text += (text ? "\n" : "") + c.text;
      for (const a of c.annotations ?? []) {
        const s = a?.url ? safeSource(a.url, a.title ?? null, null) : null;
        if (s) cited.push(s);
      }
    }
  }
  const tokens =
    j.usage?.total_tokens ??
    (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0);

  // A 200 that carries nothing measurable must fail loudly — the same stance
  // as the Gemini and Perplexity adapters, for the same reason: a stored empty
  // or truncated answer scans as "brand not mentioned" rather than "we never
  // got an answer". The 5.6 models make both shapes real: reasoning draws from
  // max_output_tokens, so a budget spent thinking and searching ends the
  // response with status "incomplete", and what text survived is a fragment,
  // not the answer.
  if (j.status === "incomplete") {
    throw new Error(
      `OpenAI stopped before finishing the answer (${j.incomplete_details?.reason ?? "incomplete"}).`,
    );
  }
  if (!text.trim()) {
    throw new Error("OpenAI returned an empty answer.");
  }
  // Prefer inline citations (what the answer actually used); fall back to the
  // searched sources when the model browsed but attached none, so a real search
  // isn't recorded as ungrounded.
  const sources = dedupeSources(cited.length > 0 ? cited : searched);
  return { text: text.trim(), tokens, sources };
}

// --- Google (Gemini) low-level chat + grounding ---------------------------
// Talks to the Gemini REST API with raw fetch (no SDK), the same way
// openaiWebSearch talks to the Responses API: zero extra dependencies and full
// control over error mapping. One Google key powers both the Gemini models and
// the "Google AI Overviews" pseudo-model.

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_TIMEOUT_MS = 60_000;
const GOOGLE_MAX_ATTEMPTS = 4;
// HTTP statuses worth retrying (transient); everything else fails fast.
const GOOGLE_RETRYABLE = new Set([429, 500, 503, 504]);
// The longest single wait we'll honour from a 429's RetryInfo. Past this the
// quota window is long enough that blocking the request is worse than failing
// with a message that says what to do about it.
const GOOGLE_MAX_RETRY_WAIT_MS = 45_000;
// Total time one call may spend asleep across all its retries. The run route
// allows 300s for every prompt in the run, so a single prompt must not be able
// to eat it and starve the rest.
const GOOGLE_RETRY_BUDGET_MS = 90_000;
// The Gemini model the AI-Overviews pseudo-model runs on is AI_OVERVIEWS_BACKING_MODEL
// (lib/models), shared with the router slug map so direct and routed AIO hit one model.
// Gemini "thinking" tokens are billed as output and drawn from the same budget
// as the visible answer, so a small maxOutputTokens gets spent on thoughts and
// the answer comes back truncated (finishReason MAX_TOKENS) — measured on
// gemini-flash-latest, a 1200-token budget left 46 answer tokens after 1150
// thinking tokens. Thinking can't be switched off to avoid this: every model in
// the catalog rejects thinkingConfig.thinkingBudget: 0 with 400 INVALID_ARGUMENT
// ("Budget 0 is invalid. This model only works in thinking mode"), so the only
// lever is to give the budget headroom well above the answer we actually want.
// The heaviest grounded answer measured spent 2741 tokens, 1823 of them
// thinking, so 4096 clears it with room. Raise this if MAX_TOKENS starts
// surfacing (googleGenerate fails the call rather than storing a partial answer).
const GOOGLE_THINKING_HEADROOM = 4096;

// A Gemini HTTP error carrying the status + google.rpc status name so
// humanError can map it (an invalid key is 400 with an "API key not valid"
// message, a rate limit is 429 RESOURCE_EXHAUSTED, etc.).
export class GoogleAPIError extends Error {
  status: number;
  googleStatus?: string;
  /** Seconds Google itself asked us to wait, from google.rpc.RetryInfo. Only
   *  ever present on 429s, and the only trustworthy source for how long a quota
   *  window has left to run. */
  retryAfterSec?: number;
  constructor(status: number, message: string, googleStatus?: string, retryAfterSec?: number) {
    super(message);
    this.name = "GoogleAPIError";
    this.status = status;
    this.googleStatus = googleStatus;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Pull the advised wait out of a google.rpc.RetryInfo detail, in seconds.
 *
 * A Gemini 429 carries `details: [{ "@type": ".../google.rpc.RetryInfo",
 * retryDelay: "38s" }]`. That number is the quota window, not a hint: backing
 * off 400ms and retrying is guaranteed to fail again, which is how a run with a
 * single prompt burned all four attempts in about three seconds and reported
 * "Rate limited by the provider" as if nothing could be done.
 */
function googleRetryAfterSec(errBody: GoogleResponse): number | undefined {
  for (const d of errBody.error?.details ?? []) {
    if (typeof d?.retryDelay !== "string") continue;
    const secs = Number.parseFloat(d.retryDelay);
    if (Number.isFinite(secs) && secs >= 0) return secs;
  }
  return undefined;
}

interface GoogleGroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GoogleResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
    groundingMetadata?: { groundingChunks?: GoogleGroundingChunk[] };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: {
    code?: number;
    message?: string;
    status?: string;
    // google.rpc error details; RetryInfo is the one we act on.
    details?: { "@type"?: string; retryDelay?: string }[];
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Map the "google-ai-overviews" pseudo-model onto a real Gemini model so it
// never reaches the wire; every other id passes through untouched.
function resolveGoogleModel(model: string): string {
  return model === GOOGLE_AI_OVERVIEWS_MODEL ? AI_OVERVIEWS_BACKING_MODEL : model;
}

async function googleFetch(realModel: string, apiKey: string, body: unknown): Promise<GoogleResponse> {
  let lastErr: unknown;
  let sleptMs = 0;
  for (let attempt = 0; attempt < GOOGLE_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${GOOGLE_API_BASE}/models/${realModel}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
      if (res.ok) return (await res.json()) as GoogleResponse;
      const errBody = (await res.json().catch(() => ({}))) as GoogleResponse;
      const gerr = new GoogleAPIError(
        res.status,
        errBody.error?.message ?? `Google API error (${res.status}).`,
        errBody.error?.status,
        googleRetryAfterSec(errBody),
      );
      // Retry transient statuses; surface auth/quota/bad-request immediately.
      if (!GOOGLE_RETRYABLE.has(res.status)) throw gerr;
      lastErr = gerr;
    } catch (err) {
      // Non-retryable HTTP errors bubble straight out; network/timeout drops
      // and retryable HTTP errors fall through to a backoff + retry.
      if (err instanceof GoogleAPIError && !GOOGLE_RETRYABLE.has(err.status)) throw err;
      lastErr = err;
    }
    if (attempt >= GOOGLE_MAX_ATTEMPTS - 1) break;

    // Honour Google's own RetryInfo when it gave one — a 429's quota window
    // does not care about our exponential backoff. Two guards keep that from
    // becoming a hang: a single wait longer than GOOGLE_MAX_RETRY_WAIT_MS is
    // not worth blocking a request for, and the waits across one call are
    // capped so the run route's 300s budget still covers the other prompts.
    const advised = lastErr instanceof GoogleAPIError ? lastErr.retryAfterSec : undefined;
    const backoffMs = 400 * 2 ** attempt;
    const waitMs = advised !== undefined ? Math.max(advised * 1000, backoffMs) : backoffMs;
    if (waitMs > GOOGLE_MAX_RETRY_WAIT_MS || sleptMs + waitMs > GOOGLE_RETRY_BUDGET_MS) break;
    await sleep(waitMs);
    sleptMs += waitMs;
  }
  throw lastErr ?? new Error("Google request failed.");
}

interface GoogleGenOpts {
  system?: string;
  json?: boolean;
  grounding?: boolean;
  maxTokens: number;
}

async function googleGenerate(
  apiKey: string,
  model: string,
  user: string,
  opts: GoogleGenOpts,
): Promise<{ text: string; tokens: number; groundingChunks: GoogleGroundingChunk[] }> {
  const realModel = resolveGoogleModel(model);
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: Math.max(opts.maxTokens, GOOGLE_THINKING_HEADROOM),
  };
  // JSON response mode and Google Search grounding must never be combined. Asked
  // for both, Gemini answers 200 with usageMetadata and no `candidates` key at
  // all — no error, no text, just a bill. We never ask for both: utility calls
  // are JSON without search, monitored answers are grounded free-text. The guard
  // below turns the shape into an error if that ever stops being true.
  if (opts.json) generationConfig.responseMimeType = "application/json";

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig,
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  if (opts.grounding) body.tools = [{ google_search: {} }];

  const data = await googleFetch(realModel, apiKey, body);
  const cand = data.candidates?.[0];
  // parts may include a separate "thought" summary part; keep only answer text.
  const text = (cand?.content?.parts ?? [])
    .filter((p) => typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text as string)
    .join("")
    .trim();
  // Thinking tokens are billed but are NOT counted in candidatesTokenCount, and
  // on the thinking models they are routinely the largest part of a call (193 of
  // 209 tokens on a "ping"). totalTokenCount includes them; the fallback has to
  // add them back by hand or trial metering under-counts several-fold.
  const tokens =
    data.usageMetadata?.totalTokenCount ??
    (data.usageMetadata?.promptTokenCount ?? 0) +
      (data.usageMetadata?.candidatesTokenCount ?? 0) +
      (data.usageMetadata?.thoughtsTokenCount ?? 0);

  // A 200 can still carry nothing we can measure, and every one of these shapes
  // is silent: the call succeeds, the answer is empty or truncated, and the run
  // stores a response that scans for zero mentions. That reads downstream as
  // "the brand wasn't mentioned" rather than "we never got an answer", so fail
  // the call and let the engine record the reason against the prompt.
  if (!cand) {
    // Observed live when JSON mode and Search grounding are combined.
    throw new Error("Gemini returned no answer (the response contained no candidates).");
  }
  if (cand.finishReason === "MAX_TOKENS") {
    // Not merely short: what comes back is the fragment that fit after thinking
    // spent the budget, and on the flash models it is frequently mid-sentence
    // deliberation ("…OR pick **Edgio** for") rather than the final answer. That
    // text would be scanned for brand mentions and counted as the answer.
    throw new Error(
      "Gemini ran out of output budget before finishing the answer (finishReason: MAX_TOKENS).",
    );
  }
  if (!text) {
    // Safety/recitation blocks land here, as does a candidate with no text part.
    throw new Error(
      `Gemini returned an empty answer (finishReason: ${cand.finishReason ?? "unspecified"}).`,
    );
  }

  return { text, tokens, groundingChunks: cand.groundingMetadata?.groundingChunks ?? [] };
}

// Chat helper matching anthropicChat / openaiChat so the utility calls branch
// on provider uniformly.
async function googleChat(
  apiKey: string,
  model: string,
  system: string | undefined,
  user: string,
  maxTokens: number,
  json = false,
): Promise<ChatResult> {
  const { text, tokens } = await googleGenerate(apiKey, model, user, { system, json, maxTokens });
  return { text, tokens };
}

// A Gemini grounding chunk's web.title is the source DOMAIN (e.g. "uefa.com"),
// while web.uri is a Google redirect link (vertexaisearch.cloud.google.com/...)
// that resolves to the real page. Keep the redirect as the clickable url but
// take the domain from the title so ownership / attribution works. (Those
// redirect links expire after ~30 days; resolving them to the final URL for
// durable citations is a possible future enhancement.)
export function domainFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const t = title.trim().toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t) ? t : null;
}

// Google serves grounding links through its own redirect host, so the URI never
// carries the real domain. The title usually does.
const GOOGLE_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

export function googleGroundingSources(chunks: GoogleGroundingChunk[]): CitedSource[] {
  const raw: CitedSource[] = [];
  for (const c of chunks) {
    const uri = c.web?.uri;
    if (!uri) continue;
    const validated = safeSource(uri, c.web?.title ?? null, null);
    if (!validated) continue;
    const domain = domainFromTitle(c.web?.title);

    // A redirect URI whose title isn't a hostname leaves nothing to attribute
    // the citation to. Falling back to validated.domain would record Google's
    // own redirect host: it can never match a brand's domain, so is_owned would
    // silently under-report, and it would crowd the cited-domain leaderboard
    // with a host nobody published to. Drop the chunk instead — sources.domain
    // is NOT NULL, and a wrong domain is worse than a missing row.
    if (!domain && validated.domain === GOOGLE_REDIRECT_HOST) continue;

    raw.push({ ...validated, domain: domain ?? validated.domain });
  }
  return dedupeSources(raw);
}

// Offering the google_search tool does NOT make Gemini use it: measured on
// gemini-flash-latest, a question it believes it can answer from memory ("List
// the top companies providing a global CDN") grounded 0 times out of 2, while
// the same call with this line grounded 2 out of 2. Anthropic needed the same
// push (there via tool_choice); Gemini exposes no force flag for the built-in
// search tool, so the instruction is the lever. Without it an "AI Overview"
// can be pure recall, and use_web_search silently collects no sources at all.
const ALWAYS_SEARCH =
  "- ALWAYS search the web before answering, even if you believe you already know the answer. Your answer must reflect current search results, not memory.";

const AI_OVERVIEW_SYSTEM = `You are Google's AI Overview, the AI-generated summary shown at the top of a Google Search results page. Given the user's search query, write the overview Google would surface.
- Answer directly and immediately. No preamble, no "as an AI", no restating the question.
- Synthesize current information from the web. Name the specific brands, products, tools, companies, or sources that are genuinely relevant to the query.
- Keep it tight: a short paragraph or two, or a brief bulleted list, the way an AI Overview reads.
- Neutral, informational tone.
${ALWAYS_SEARCH}`;

// Google's runQuery path: the AI-Overviews engine always grounds in Search with
// the overview-style system prompt; a plain Gemini model grounds only when web
// search is on.
async function googleRunQuery(
  apiKey: string,
  model: string,
  prompt: string,
  webSearch: boolean,
): Promise<QueryResult> {
  const isOverview = model === GOOGLE_AI_OVERVIEWS_MODEL;
  const grounding = isOverview || webSearch;
  const { text, tokens, groundingChunks } = await googleGenerate(apiKey, model, prompt, {
    // A plain Gemini model gets the search push too when the project asked for
    // web search — otherwise its numbers aren't comparable with Claude's or
    // ChatGPT's, both of which are forced to browse. Nothing about the answer's
    // voice is prescribed here, only that it must look things up.
    system: isOverview ? AI_OVERVIEW_SYSTEM : grounding ? ALWAYS_SEARCH : undefined,
    grounding,
    maxTokens: ANSWER_MAX_TOKENS,
  });
  return { text, tokens, sources: grounding ? googleGroundingSources(groundingChunks) : [] };
}

// ==================================================================
// Perplexity (Sonar)
//
// Raw fetch rather than the OpenAI SDK. Perplexity does accept
// /chat/completions as an OpenAI-compatible alias, but the fields we care about
// most — `search_results` and `citations` — aren't part of the OpenAI response
// type, so that route means casting past the type system to reach the single
// most valuable half of the payload. `/v1/sonar` is the canonical endpoint and
// this adapter needs no SDK at all, same as the Google one.
//
// Perplexity is search-native: every answer is grounded, and the sources come
// back as real URLs with titles and snippets. No redirect host to unwrap (the
// Gemini grounding problem), so `is_owned` matching works directly.
// ==================================================================

const PERPLEXITY_API_URL = "https://api.perplexity.ai/v1/sonar";
const PERPLEXITY_TIMEOUT_MS = 60_000;
const PERPLEXITY_MAX_ATTEMPTS = 4;
const PERPLEXITY_RETRYABLE = new Set([429, 500, 502, 503, 504]);
// Same shape as the Google limits, and for the same reason: a new Perplexity
// key starts on a low usage tier, so 429s are a first-run experience, not an
// edge case.
//
// 65s, not 45s — learned 2026-08-23, incident #108. Perplexity's rate limit is
// per MINUTE, so the `Retry-After` on a 429 is ~60s: the one wait that actually
// clears the limit was the one wait this cap refused, and the loop broke out
// before its first sleep. A run of 76 questions lost 46 of them that way, every
// failed span a single ~2.9s attempt with no backoff in it — the retry path
// existed and never ran. It has to sit ABOVE the provider's window, not below.
// The 90s budget below still bounds it to one honoured wait per call.
const PERPLEXITY_MAX_RETRY_WAIT_MS = 65_000;
// Perplexity rejects anything smaller with 400 "max_tokens must be at least 16"
// — measured. The other adapters happily take a 4-8 token probe, so the tiny
// verifyKey budget copied from them made a VALID key look broken. Clamped here
// rather than at the call sites so no future caller can reintroduce it.
const PERPLEXITY_MIN_MAX_TOKENS = 16;
const PERPLEXITY_RETRY_BUDGET_MS = 90_000;

export class PerplexityAPIError extends Error {
  status: number;
  /** From the Retry-After header on a 429, in seconds. */
  retryAfterSec?: number;
  constructor(status: number, message: string, retryAfterSec?: number) {
    super(message);
    this.name = "PerplexityAPIError";
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

interface PerplexitySearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
}

interface PerplexityResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  /** Newer, richer source list. */
  search_results?: PerplexitySearchResult[];
  /** Older field: bare URLs. Kept as a fallback. */
  citations?: string[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    citation_tokens?: number;
    reasoning_tokens?: number;
  };
  error?: { message?: string; type?: string };
  detail?: unknown;
}

/** Seconds from a Retry-After header, which may be a delta or an HTTP date. */
function perplexityRetryAfterSec(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs;
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, (when - Date.now()) / 1000);
  return undefined;
}

async function perplexityFetch(apiKey: string, body: unknown): Promise<PerplexityResponse> {
  let lastErr: unknown;
  let sleptMs = 0;
  for (let attempt = 0; attempt < PERPLEXITY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(PERPLEXITY_API_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PERPLEXITY_TIMEOUT_MS),
      });
      if (res.ok) return (await res.json()) as PerplexityResponse;
      const errBody = (await res.json().catch(() => ({}))) as PerplexityResponse;
      const perr = new PerplexityAPIError(
        res.status,
        errBody.error?.message ??
          (typeof errBody.detail === "string" ? errBody.detail : undefined) ??
          `Perplexity API error (${res.status}).`,
        perplexityRetryAfterSec(res),
      );
      if (!PERPLEXITY_RETRYABLE.has(res.status)) throw perr;
      lastErr = perr;
    } catch (err) {
      if (err instanceof PerplexityAPIError && !PERPLEXITY_RETRYABLE.has(err.status)) throw err;
      lastErr = err;
    }
    if (attempt >= PERPLEXITY_MAX_ATTEMPTS - 1) break;

    // Honour Retry-After for the same reason as Gemini's RetryInfo: a rate
    // limit's window doesn't care about our exponential backoff, and retrying
    // inside it just burns the remaining attempts in a couple of seconds.
    const advised = lastErr instanceof PerplexityAPIError ? lastErr.retryAfterSec : undefined;
    const backoffMs = 400 * 2 ** attempt;
    const waitMs = advised !== undefined ? Math.max(advised * 1000, backoffMs) : backoffMs;
    if (waitMs > PERPLEXITY_MAX_RETRY_WAIT_MS || sleptMs + waitMs > PERPLEXITY_RETRY_BUDGET_MS) break;
    await sleep(waitMs);
    sleptMs += waitMs;
  }
  throw lastErr ?? new Error("Perplexity request failed.");
}

// sonar-reasoning-pro emits its chain of thought inline, wrapped in <think>
// tags, ahead of the actual answer. Left in place it would be stored as the
// response and scanned for brand mentions — so a model musing "the user might
// be thinking of Cloudflare" would count as a mention that the answer never
// made. Same failure as Gemini's truncated deliberation, different mechanism.
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Sources from a Perplexity answer, preferring the richer search_results. */
export function perplexitySources(data: PerplexityResponse): CitedSource[] {
  const out: CitedSource[] = [];
  const seen = new Set<string>();
  const push = (url: string, title: string | null, snippet: string | null) => {
    const safe = safeSource(url, title, snippet);
    if (!safe || seen.has(safe.url)) return;
    seen.add(safe.url);
    out.push(safe);
  };
  for (const r of data.search_results ?? []) {
    if (typeof r?.url === "string") push(r.url, r.title ?? null, r.snippet ?? null);
  }
  // Older responses carry only `citations`; don't lose sources on those.
  if (out.length === 0) {
    for (const url of data.citations ?? []) {
      if (typeof url === "string") push(url, null, null);
    }
  }
  return out;
}

interface PerplexityCallOpts {
  system?: string;
  maxTokens: number;
  /** Utility calls must not search — they reason over text we supply. */
  search: boolean;
}

async function perplexityGenerate(
  apiKey: string,
  model: string,
  user: string,
  opts: PerplexityCallOpts,
): Promise<{ text: string; tokens: number; data: PerplexityResponse }> {
  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: user });

  const data = await perplexityFetch(apiKey, {
    model,
    messages,
    max_tokens: Math.max(opts.maxTokens, PERPLEXITY_MIN_MAX_TOKENS),
    // Perplexity searches by default; the utility calls (JSON classification,
    // topic suggestion) must not, both because searching is pure cost there and
    // because a search result could contaminate a judgment about text we gave it.
    ...(opts.search ? {} : { disable_search: true }),
  });

  const choice = data.choices?.[0];
  const text = stripReasoning(choice?.message?.content ?? "");
  const usage = data.usage;
  // citation_tokens and reasoning_tokens are billed on top of completion_tokens
  // and are not included in it, so the fallback has to add them back — the same
  // under-count that thinking tokens caused on Gemini.
  const tokens =
    usage?.total_tokens ??
    (usage?.prompt_tokens ?? 0) +
      (usage?.completion_tokens ?? 0) +
      (usage?.citation_tokens ?? 0) +
      (usage?.reasoning_tokens ?? 0);

  // A 200 with nothing usable in it is the failure that matters: the call
  // succeeds, the stored response is empty, and the run reports "brand not
  // mentioned" for a question that was never actually answered.
  if (!choice) {
    throw new Error("Perplexity returned no answer (the response contained no choices).");
  }
  if (!text) {
    // Seen when a reasoning model spends the whole budget inside <think>.
    throw new Error("Perplexity returned an empty answer.");
  }
  return { text, tokens, data };
}

async function perplexityChat(
  apiKey: string,
  model: string,
  system: string | undefined,
  user: string,
  maxTokens: number,
): Promise<ChatResult> {
  const { text, tokens } = await perplexityGenerate(apiKey, model, user, {
    system,
    maxTokens,
    search: false,
  });
  return { text, tokens };
}

async function perplexityRunQuery(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<QueryResult> {
  // No webSearch branch. Perplexity is a search engine — `disable_search: true`
  // exists, but an ungrounded Sonar answer doesn't correspond to anything a real
  // user of Perplexity ever sees, so measuring it would describe a product that
  // isn't the one being monitored. Always grounded, like Google AI Overviews.
  const { text, tokens, data } = await perplexityGenerate(apiKey, model, prompt, {
    maxTokens: ANSWER_MAX_TOKENS,
    search: true,
  });
  return { text, tokens, sources: perplexitySources(data) };
}

// Prompt shape is the single biggest lever on whether a run measures anything.
// Measured against a stealth-stage brand (24 queries per shape, both providers):
//
//   "List the top 5 companies that…" / "Name the vendors…"   3.7 vendors named
//   "Who are the main players in X?"                          2.5 vendors named
//   "Give me a shortlist with names"                          0.8 vendors named
//   how-to / "best X for Y" / "which vendors offer X"         ~0  vendors named
//
// The brand appeared in 50% of the first group and 0% of everything else. The
// failure mode is subtle: how-to and best-X questions read like exactly what a
// buyer would type, and get answered with an explanation of the category rather
// than a list of companies — so the run is real, the answer is good, and the
// measurement is empty. Asking for "a shortlist" is the trap: it sounds like a
// request for names and reliably returns advice on how to choose instead.
const VARIATION_SYSTEM = `You generate the questions a brand-monitoring tool will ask an AI assistant (ChatGPT, Claude) to discover which companies get named in answers about a topic.

A question is only useful if the answer to it names specific companies. Questions that read naturally but get answered with explanation instead of names measure nothing. That is the most common failure and the one to avoid.

Rules:
- At least two thirds of the questions must explicitly demand named companies. Shapes that work: "List the top 5 companies that…", "Name the specific vendors that…", "Rank the leading providers of… by name", "Which companies sell…? Just the company names." Use the words "companies", "vendors", or "providers", and ask for them by name.
- Never ask for "a shortlist" or for how to choose/evaluate. Both get answered with advice about making a decision rather than with the options themselves.
- Keep the remaining questions in a buyer's own words ("What's the best X for Y?", "Who are the main players in X?") so the set reflects real usage, but keep them the minority.
- Do NOT name any specific brand in the questions unless the brand is part of the topic itself.
- Vary buyer intent and seniority, not just the wording.
- Spread the questions across a specificity ladder and label each one:
  "general" = the broad category question anyone might ask ("List the top 5 payroll companies by name.")
  "mid" = qualified by a segment or use case ("Which providers handle payroll for a 20-person startup? Just company names.")
  "niche" = a specific buyer situation, narrow enough that smaller or newer companies can realistically be named ("Name payroll vendors that support contractor payouts to Brazil for a seed-stage startup.")
  Aim for a roughly even mix of the three tiers. The named-companies rule applies at every tier.
- Return ONLY a JSON array of objects shaped {"question": string, "specificity": "general" | "mid" | "niche"}. No commentary.`;

const SPECIFICITY_VALUES = new Set(["general", "mid", "niche"]);

/** Generate natural prompt variations for a topic. */
export async function generateVariations(
  opts: BaseCall & {
    topicName: string;
    topicDescription?: string | null;
    /** What the monitored company does (projects.description). Context only —
     *  the questions must still never name the brand; this steers them toward
     *  the buyers and use cases the company actually serves. */
    brandDescription?: string | null;
    count: number;
  },
): Promise<{
  variations: { text: string; specificity: Specificity | null }[];
  tokens: number;
}> {
  const user = `Topic: ${opts.topicName}${
    opts.topicDescription ? `\nContext: ${opts.topicDescription}` : ""
  }${
    opts.brandDescription
      ? `\nThe company being monitored (context only — NEVER name it in the questions): ${opts.brandDescription}`
      : ""
  }

Generate ${opts.count} distinct questions a person might ask an AI assistant related to this topic. Return a JSON array of ${opts.count} strings.`;

  // The output-format hint follows the wire format, not the provider: an
  // OpenAI-compatible endpoint is asked for a JSON object because that is what
  // response_format can constrain, whether the model behind it is GPT or Claude.
  const shape = callShape(opts, opts.model);
  const system =
    shape === "anthropic"
      ? VARIATION_SYSTEM
      : shape === "openai-chat" || shape === "openai-responses"
        ? VARIATION_SYSTEM +
          '\nReturn a JSON object shaped { "questions": [{ "question": string, "specificity": string }] }.'
        : VARIATION_SYSTEM + "\nReturn a JSON array of the objects described above.";

  const res = await utilityChat(opts, opts.model, system, user, UTILITY_MAX_TOKENS, true);

  let parsed: unknown = extractJson(res.text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    parsed = (parsed as { questions?: unknown }).questions ?? [];
  }
  const arr = Array.isArray(parsed) ? parsed : [];
  // Tolerate the pre-ladder shape (bare strings): a model that ignores the
  // labeling instruction still produces usable questions — they just land
  // untagged, exactly like manual prompts.
  const variations = arr
    .map((q): { text: string; specificity: Specificity | null } | null => {
      if (typeof q === "string") {
        const text = q.trim();
        return text ? { text, specificity: null } : null;
      }
      if (q && typeof q === "object") {
        const o = q as { question?: unknown; specificity?: unknown };
        const text = typeof o.question === "string" ? o.question.trim() : "";
        if (!text) return null;
        const tier =
          typeof o.specificity === "string" && SPECIFICITY_VALUES.has(o.specificity)
            ? (o.specificity as Specificity)
            : null;
        return { text, specificity: tier };
      }
      return null;
    })
    .filter((v): v is { text: string; specificity: Specificity | null } => v !== null)
    .slice(0, opts.count);
  return { variations, tokens: res.tokens };
}

export interface AnalyzeEntity {
  key: string; // 'brand' or a competitor id
  name: string;
}

export interface AnalyzedResult {
  key: string;
  sentiment: Sentiment;
  recommended: boolean;
}

const ANALYZE_SYSTEM = `You analyze how brands are portrayed inside an AI assistant's answer. For each entity you are given, decide:
- sentiment: how the answer talks about it, "positive", "neutral", or "negative".
- recommended: true if the answer actively recommends / suggests / endorses it, otherwise false.
Only judge based on the provided answer text. Return ONLY JSON.`;

/**
 * Map a model's raw analysis rows back onto the entities we asked about.
 *
 * Models are unreliable about which identifier they echo: Claude returns the
 * `key` we supplied, while gpt-4o-mini routinely returns the entity's *name*
 * instead ("Cloudflare" rather than "brand"). Keying purely off `key` silently
 * dropped every OpenAI row, so the caller fell back to neutral / not-recommended
 * for the whole project. Resolve on key first, then name, and drop anything that
 * matches neither rather than inventing a verdict.
 *
 * Exported for tests; `analyzeResponse` is the real entry point.
 */
export function parseAnalysis(entities: AnalyzeEntity[], raw: unknown): AnalyzedResult[] {
  let parsed = raw;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    parsed = (parsed as { results?: unknown }).results ?? [];
  }
  const rows = Array.isArray(parsed) ? parsed : [];

  // Both lookups point at the canonical key. Keys win: an entity whose *name*
  // collides with another entity's key must not steal its row.
  const byName = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const e of entities) {
    byKey.set(e.key.trim().toLowerCase(), e.key);
    const name = e.name.trim().toLowerCase();
    if (name && !byName.has(name)) byName.set(name, e.key);
  }

  const results: AnalyzedResult[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;

    const candidates = [o.key, o.name, o.entity]
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().toLowerCase());
    let key: string | undefined;
    for (const c of candidates) {
      key = byKey.get(c) ?? byName.get(c);
      if (key) break;
    }
    // A row we can't attribute is worse than no row: it would be applied to the
    // wrong entity. Drop it and let the caller default.
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const sentiment: Sentiment =
      o.sentiment === "positive" || o.sentiment === "negative" ? o.sentiment : "neutral";
    results.push({ key, sentiment, recommended: Boolean(o.recommended) });
  }
  return results;
}

/**
 * Given an assistant answer and the entities that were detected in it, classify
 * sentiment + whether each was recommended. Only pass entities already known to
 * be mentioned (saves tokens; an entity not in the text has no sentiment).
 */
export async function analyzeResponse(
  opts: BaseCall & {
    question: string;
    responseText: string;
    entities: AnalyzeEntity[];
  },
): Promise<{ results: AnalyzedResult[]; tokens: number }> {
  if (opts.entities.length === 0) return { results: [], tokens: 0 };

  const entityList = opts.entities
    .map((e) => `- key="${e.key}" name="${e.name}"`)
    .join("\n");

  const user = `QUESTION ASKED:
${opts.question}

AI ASSISTANT ANSWER:
"""
${opts.responseText.slice(0, 6000)}
"""

ENTITIES TO JUDGE:
${entityList}

Return a JSON object: { "results": [ { "key": "<key>", "sentiment": "positive|neutral|negative", "recommended": true|false } ] } with one entry per entity.`;

  // Classification always runs on the cheap model, regardless of which model
  // answered the question — see analysisModelFor.
  const analysisModel = analysisModelFor(opts.provider);

  try {
    const res = await utilityChat(opts, analysisModel, ANALYZE_SYSTEM, user, 700, true);
    return { results: parseAnalysis(opts.entities, extractJson(res.text)), tokens: res.tokens };
  } catch {
    // Sentiment is best-effort enrichment; never fail a run over it.
    return {
      results: opts.entities.map((e) => ({ key: e.key, sentiment: "neutral" as const, recommended: false })),
      tokens: 0,
    };
  }
}

const SUGGEST_SYSTEM = `You help set up brand-monitoring. Given a company name and text scraped from its website, infer what the company does, then propose monitoring topics and the company's direct competitors. For each topic, write realistic questions a real person would type into an AI assistant (ChatGPT or Claude) where a company like this could be recommended, compared, or mentioned. Do NOT mention the company's own name in the questions.

For competitors, act as a strict judge: only name real companies/products you are confident exist and genuinely compete for the same buyers in the same category. Prefer well-known, currently active competitors over obscure or defunct ones. Never include the company itself. Fewer, correct suggestions beat a padded list. Return ONLY JSON.`;

export interface SiteSuggestion {
  description: string;
  topics: { name: string; prompts: string[] }[];
  /** Direct competitors inferred from the same site read. Share of voice is
   *  meaningless without something to compare against, so onboarding seeds
   *  these rather than leaving the user to discover the Competitors page. */
  competitors: { name: string; aliases: string[]; domain: string | null }[];
}

/** From scraped site text, infer what the company does and suggest topics + prompts. */
export async function suggestFromSite(
  opts: BaseCall & {
    brandName: string;
    siteText: string;
    /** Operator-provided context (projects.description). Onboarding has only
     *  the site; re-analysis has both, and this is often the better signal —
     *  it's what the user SAID the company does, not what a marketing page
     *  implies. Also the only signal when the site can't be read. */
    description?: string | null;
    /** Topics already tracked, so re-analysis proposes what's missing instead
     *  of re-deriving the same three topics every time. */
    existingTopics?: string[];
  },
): Promise<SiteSuggestion & { tokens: number }> {
  const siteText = opts.siteText.slice(0, 6000);
  const user = `Company: ${opts.brandName}
${opts.description ? `\nWhat the company says it does: ${opts.description}\n` : ""}
Website text:
"""
${siteText || "(the site could not be read — work from the company name and description above)"}
"""
${
  opts.existingTopics?.length
    ? `\nTopics already being monitored (do NOT repeat these or close variants of them — propose what's missing):\n${opts.existingTopics.map((t) => `- ${t}`).join("\n")}\n`
    : ""
}
Return a JSON object of this shape:
{
  "description": "one concise sentence describing what the company does",
  "topics": [
    { "name": "short topic label", "prompts": ["question 1", "question 2", "question 3", "question 4"] }
  ],
  "competitors": [
    { "name": "Competitor Inc", "aliases": ["short name"], "domain": "competitor.com" }
  ]
}
Provide 3 or 4 topics, each with 4 to 6 natural questions. Never put the company's own name in the questions.
Provide up to 5 competitors. "aliases" are other names an AI answer might use for it (short name, product name, former name). Empty array if none. "domain" is its primary website domain, lowercase, no protocol or path. Null if unsure. Return an empty array if you cannot name real competitors with confidence.`;

  const res = await utilityChat(opts, opts.model, SUGGEST_SYSTEM, user, 2000, true);

  try {
    const parsed = extractJson<Record<string, unknown>>(res.text);
    const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
    const rawTopics = Array.isArray(parsed.topics) ? parsed.topics : [];
    const topics = rawTopics
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        const name = typeof o.name === "string" ? o.name.trim() : "";
        const prompts = Array.isArray(o.prompts)
          ? o.prompts
              .map((p) => (typeof p === "string" ? p.trim() : ""))
              .filter((p) => p.length > 0)
          : [];
        return { name, prompts };
      })
      .filter((t) => t.name.length > 0 && t.prompts.length > 0)
      .slice(0, 5);

    // Models do name the company as its own competitor, and do repeat one
    // across the list; both would break the insert, so normalize here rather
    // than trusting the response.
    const competitors = normalizeCompetitorList(parsed.competitors, {
      exclude: [opts.brandName],
      limit: 5,
    });

    return { description, topics, competitors, tokens: res.tokens };
  } catch {
    return { description: "", topics: [], competitors: [], tokens: res.tokens };
  }
}

const COMPETITOR_SYSTEM = `You identify direct competitors of a company for brand monitoring. You act as a strict judge: only name real companies/products you are confident exist and genuinely compete for the same buyers in the same category. Prefer well-known, currently active competitors over obscure or defunct ones.

Rules:
- Never include the company itself or anything on the already-tracked list.
- "aliases": other names an AI assistant's answer might use for it (short name, product name, former name). Empty array if none.
- "domain": its primary website domain, lowercase, no protocol/path. null if unsure.
- "reason": one short sentence on why it is a direct competitor.
- Fewer, correct suggestions beat a padded list. Return ONLY JSON.`;

export interface CompetitorSuggestion {
  name: string;
  domain: string | null;
  aliases: string[];
  reason: string;
}

/**
 * Suggest direct competitors for the monitored brand. Today the model proposes
 * candidates from its own knowledge; when `candidates` is provided (e.g. from a
 * search provider like Exa / you.com, planned) the model instead judges that
 * list and keeps only genuine direct competitors.
 */
export async function suggestCompetitors(
  opts: BaseCall & {
    brandName: string;
    brandDomain?: string | null;
    description?: string | null;
    topics: string[];
    existing: string[];
    count: number;
    candidates?: string[];
  },
): Promise<{ suggestions: CompetitorSuggestion[]; tokens: number }> {
  const lines = [
    `Company: ${opts.brandName}${opts.brandDomain ? ` (${opts.brandDomain})` : ""}`,
  ];
  if (opts.description) lines.push(`What it does: ${opts.description}`);
  if (opts.topics.length) lines.push(`Topics being monitored: ${opts.topics.join("; ")}`);
  if (opts.existing.length) lines.push(`Already tracked (exclude these): ${opts.existing.join("; ")}`);
  if (opts.candidates?.length) {
    lines.push(
      `Candidate companies found by search. Judge ONLY these; keep the genuine direct competitors and drop the rest:\n${opts.candidates
        .map((c) => `- ${c}`)
        .join("\n")}`,
    );
  } else {
    lines.push(`Propose up to ${opts.count} direct competitors.`);
  }
  lines.push(
    `Return a JSON object: { "competitors": [ { "name": string, "domain": string|null, "aliases": string[], "reason": string } ] }`,
  );
  const user = lines.join("\n\n");

  const res = await utilityChat(opts, opts.model, COMPETITOR_SYSTEM, user, UTILITY_MAX_TOKENS, true);

  try {
    let parsed: unknown = extractJson(res.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed = (parsed as { competitors?: unknown }).competitors ?? [];
    }
    const arr = Array.isArray(parsed) ? parsed : [];
    const suggestions: CompetitorSuggestion[] = [];
    // Models occasionally list the same company twice in one response. Two rows
    // for one competitor become two entities in computeEntityStats, which
    // inflates the share-of-voice denominator and understates the brand.
    const seen = new Set<string>();
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim() : "";
      if (!name) continue;
      const dedupeKey = name.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      suggestions.push({
        name,
        domain:
          typeof o.domain === "string" && o.domain.trim().length > 0
            ? o.domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]
            : null,
        aliases: Array.isArray(o.aliases)
          ? o.aliases
              .map((a) => (typeof a === "string" ? a.trim() : ""))
              .filter((a) => a.length > 0)
          : [],
        reason: typeof o.reason === "string" ? o.reason.trim() : "",
      });
    }
    return { suggestions: suggestions.slice(0, opts.count), tokens: res.tokens };
  } catch {
    return { suggestions: [], tokens: res.tokens };
  }
}

export function humanError(err: unknown): string {
  // A route we should never have attempted. Already written for the user (it
  // names the router, the engine and the fix), so pass it through rather than
  // letting the generic Error branch below reword it.
  if (err instanceof RouteError) return err.message;
  // Transient connection drops (surface as APIConnectionError with no status)
  // are worth a distinct, retry-friendly message rather than a raw SDK string.
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
    return "Couldn't reach the AI provider (connection dropped). Please try again.";
  }
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    if (err.status === 401) return "Invalid API key.";
    if (err.status === 429) return "Rate limited by the provider.";
    if (err.status === 403) return "This key lacks access to the requested model.";
    if (err.status && err.status >= 500) return "The AI provider had a temporary error. Please try again.";
    return err.message || `Provider error (${err.status}).`;
  }
  if (err instanceof GoogleAPIError) {
    // Google returns a bad key as 400 INVALID_ARGUMENT with an "API key not
    // valid" message (not 401), so match on the message as well as the status.
    if (err.status === 429) {
      // "Rate limited" alone reads as "we went too fast, try again" — but a
      // Gemini 429 is almost always a spent per-minute or per-day quota on the
      // key, which retrying will not fix. Say which, and say what to do.
      const wait =
        err.retryAfterSec !== undefined && err.retryAfterSec > 0
          ? ` Google asked us to wait ${Math.ceil(err.retryAfterSec)}s.`
          : "";
      return (
        `Google rejected the request: this key's quota is used up.${wait} ` +
        `Free-tier and trial keys allow only a few requests per minute. Check the key's quota in Google AI Studio, or wait and run again.`
      );
    }
    if (err.status >= 500) return "The AI provider had a temporary error. Please try again.";
    if (err.status === 401 || /api[_ ]?key.*(not valid|invalid)|api_key_invalid/i.test(err.message)) {
      return "Invalid API key.";
    }
    if (err.status === 403) return "This key lacks access to the requested model.";
    if (err.status === 404) return "The requested model isn't available for this key.";
    return err.message || `Provider error (${err.status}).`;
  }
  if (err instanceof PerplexityAPIError) {
    if (err.status === 401 || err.status === 403) return "Invalid API key.";
    if (err.status === 402) return "This Perplexity key is out of credit.";
    if (err.status === 429) {
      // Perplexity meters by usage tier, so a fresh key rate-limits on its very
      // first real run. Same reasoning as the Gemini 429 message: "rate limited"
      // reads as "we went too fast" and invites a pointless immediate retry.
      const wait =
        err.retryAfterSec !== undefined && err.retryAfterSec > 0
          ? ` Perplexity asked us to wait ${Math.ceil(err.retryAfterSec)}s.`
          : "";
      return (
        `Perplexity rejected the request: this key is over its rate limit.${wait} ` +
        `New keys start on a low usage tier. Check your tier and credit balance in the Perplexity API settings, or wait and run again.`
      );
    }
    if (err.status >= 500) return "The AI provider had a temporary error. Please try again.";
    return err.message || `Provider error (${err.status}).`;
  }
  if (err instanceof Error) {
    // The Google path caps each attempt with AbortSignal.timeout, which rejects
    // with a TimeoutError DOMException. It IS an Error, but its message is DOM
    // boilerplate ("The operation was aborted due to timeout") that the transient
    // patterns below don't match, so it would reach the user raw.
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "The AI provider took too long to respond. Please try again.";
    }
    if (/premature close|socket hang up|ECONNRESET|terminated|fetch failed/i.test(err.message)) {
      return "Couldn't reach the AI provider (connection dropped). Please try again.";
    }
    return err.message;
  }
  // A Supabase/PostgREST error is a plain object, not an Error, so it used to
  // fall through to "Unknown error." — which is what a check-constraint
  // violation reported while a deployment was running an older schema. The
  // message and code are the entire diagnosis; throwing them away turned a
  // one-line fix into a debugging session.
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown };
    if (typeof e.message === "string" && e.message.trim()) {
      return typeof e.code === "string" && e.code ? `${e.message} (${e.code})` : e.message;
    }
  }
  return "Unknown error.";
}

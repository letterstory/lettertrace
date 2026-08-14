import type { Provider, RouterId } from "./types";
import { GOOGLE_AI_OVERVIEWS_MODEL, PROVIDERS } from "./models";

// ==================================================================
// LLM routers (gateways).
//
// A router is a CREDENTIAL, not an answer engine. One router key reaches many
// providers, so it slots in beside BYOK provider keys as another way to pay for
// a call — it is never a `Provider` of its own.
//
// That distinction is load-bearing for the product, not just for tidiness. A run
// served by Concentrate against Claude still measured *Claude*: it asked Claude's
// weights and got Claude's answer. If the router were its own provider, a client
// moving from a direct Anthropic key to a router would break their trend line at
// the switch and split their share of voice across two entries that are the same
// answer surface. So `runs.provider` stays 'anthropic' and the router is
// recorded alongside it in `runs.route`, which is what explains a step change in
// the data without inventing a second engine.
//
// The hard part is not reaching the models, it is reaching them the SAME WAY.
// Every monitored answer is measured with the provider's own native browsing,
// forced (see anthropicWebSearch / openaiWebSearch in lib/llm). A gateway that
// normalizes requests to a lowest-common-denominator shape can accept those
// params and quietly drop them, and an ungrounded answer is not a cheaper
// version of a grounded one — it is a different measurement that still looks
// like data. Hence `search` below, and hence the probe at credential-save time
// (probeRouterSearch in lib/llm): a router is allowed to serve monitored
// web-search runs for a provider only once we have SEEN it return real sources.
// ==================================================================

export type { RouterId };

/**
 * Which wire format we speak to a router for a given provider.
 *
 * Concentrate mirrors both providers' own APIs — an Anthropic-Messages "skin"
 * and OpenAI's Responses API. Preferring the native shape wherever it exists is
 * the whole
 * reason a routed measurement survives intact: the request is byte-for-byte the
 * one we send the provider directly — Anthropic's server-side
 * `web_search_20250305` tool with its forcing `tool_choice`, OpenAI's
 * `web_search_preview` with its own — and the reply comes back in the shape the
 * existing citation parsers already read.
 *
 * The distinction is measured, not assumed. Asked "what is the capital of
 * France?" — a question the model plainly knows — Concentrate's Responses
 * endpoint with a forced `tool_choice` still returned two cited sources, while
 * the same request with the tool merely offered returned none, and so did
 * chat-completions with `web_search_options`. Forcing is honoured; the
 * alternatives only permit. That difference is why 'openai-responses' names the
 * Responses API specifically rather than treating any OpenAI-compatible endpoint
 * as interchangeable. 'openai-chat' is the plain chat-completions surface, used
 * for routed calls that aren't grounded — where there is nothing to force — and
 * for a router that has no Responses API at all.
 */
export type RouteShape = "anthropic" | "openai-chat" | "openai-responses";

/**
 * How native web search is expressed through a router for one provider.
 *
 * - 'passthrough' — we send the provider's own search params and the router is
 *   expected to forward them untouched. Expressible, but only trustworthy once
 *   probed, so a credential must confirm it before this provider can serve
 *   monitored web-search runs.
 * - 'none' — no way to ask for native search in this router's documented
 *   surface. Utility calls are fine; monitored web-search runs are refused
 *   rather than silently run ungrounded.
 *
 * There was a third, 'plugin', for a router that substitutes its own gateway
 * flag for the provider's search params. It is real native browsing but cannot
 * be compelled the way `tool_choice` can, which makes it a weaker measurement
 * than a direct key — and it existed only for OpenRouter, which this build
 * doesn't ship. It was removed rather than left unreachable; bringing that
 * router back means bringing the tier and its warning copy back with it.
 */
export type SearchSupport = "passthrough" | "none";

export interface RouterProviderSupport {
  shape: RouteShape;
  search: SearchSupport;
  /**
   * Model slug for this provider through this router. Routers namespace models
   * as `vendor/model`, but the exact slug string is the router's to define and
   * ours only to match — so this maps our catalog ids explicitly where they
   * differ, and falls back to `vendor/<our id>`. A wrong slug surfaces at
   * save time (the probe calls the mapped slug), never mid-run.
   */
  slugPrefix: string;
  slugOverrides?: Record<string, string>;
}

export interface RouterInfo {
  id: RouterId;
  label: string;
  /** Shown on the credential card: what this router is for. */
  blurb: string;
  keyUrl: string;
  docsUrl: string;
  /** Prefix we can show as a placeholder. Empty when the router doesn't use one. */
  keyPrefix: string;
  /** Base URL for the OpenAI-compatible surface (SDK appends /chat/completions). */
  openaiBaseUrl: string;
  /**
   * Base URL for the Anthropic-Messages surface, as the Anthropic SDK wants it
   * (the SDK appends `/v1/messages` itself). Null when the router has no skin.
   */
  anthropicBaseUrl: string | null;
  /**
   * Which header carries the credential on that surface.
   *
   * The Anthropic SDK sends exactly one — `x-api-key` when an apiKey is set,
   * `Authorization: Bearer` when only an authToken is — so this can't be hedged
   * by sending both. Each entry follows what the router documents. Getting it
   * wrong surfaces as a 401 the moment the key is saved, not mid-run, since
   * verification uses this same path.
   */
  anthropicAuth: "x-api-key" | "bearer";
  /** Extra top-level body fields for a call through this router. */
  extraBody?: (provider: Provider, opts: { webSearch: boolean }) => Record<string, unknown>;
  providers: Partial<Record<Provider, RouterProviderSupport>>;
}

// Google and Perplexity are deliberately absent from the routers below.
//
// Not because the models are unreachable — they are — but because their
// measurement paths don't survive normalization. Gemini's answers are grounded
// with a `google_search` tool whose grounding chunks come back through a
// Google-specific redirect host we resolve ourselves, and the "Google AI
// Overviews" engine is a pseudo-model: a real Gemini model plus a forced-search
// system prompt that imitates the Overviews style. Perplexity's search is not a
// parameter at all, it is the product, and its sources arrive in its own shape.
// Routing any of the three through an OpenAI-compatible endpoint would return an
// answer, and it would be a different measurement wearing the same label. Those
// engines keep requiring a direct key, and `engineKeyMessage` says so plainly.

export const ROUTERS: Record<RouterId, RouterInfo> = {
  concentrate: {
    id: "concentrate",
    label: "Concentrate",
    blurb: "One key for every provider, with no markup on tokens.",
    keyUrl: "https://concentrate.ai/",
    docsUrl: "https://concentrate.ai/docs/api-reference/introduction",
    // Concentrate's docs show bearer auth without advertising a key prefix.
    keyPrefix: "",
    openaiBaseUrl: "https://api.concentrate.ai/v1",
    anthropicBaseUrl: "https://api.concentrate.ai",
    // Concentrate's API reference documents bearer auth for the whole API.
    anthropicAuth: "bearer",
    providers: {
      anthropic: {
        shape: "anthropic",
        search: "passthrough",
        slugPrefix: "anthropic",
      },
      openai: {
        // Concentrate mirrors OpenAI's Responses API at /v1/responses, forced
        // `tool_choice` included, so the monitored path sends the same request
        // it sends OpenAI directly. Probed 2026-07-30 against gpt-4o-mini:
        // forced returned sources on a question answerable from memory, offered
        // returned none. `web_search_options` on chat-completions also reaches
        // the web but cannot be compelled, so it is deliberately not used.
        shape: "openai-responses",
        search: "passthrough",
        slugPrefix: "openai",
      },
      google: {
        // Routable, but never measurable. Probed 2026-08-02 with a live key:
        // the call succeeds and returns a ~36-character ungrounded answer with
        // no sources — Concentrate mirrors Google's chat surface but not its
        // grounding, and there is no equivalent of the forced tool_choice that
        // makes the Anthropic and OpenAI paths comparable. Ungrounded runs are
        // served; a grounded project is refused rather than quietly measured
        // against an answer that never searched.
        shape: "openai-chat",
        search: "none",
        // Our catalog carries Google's rolling ALIASES (gemini-flash-latest),
        // which no router resolves — every model needs an explicit slug, and
        // the `slugPrefix` fallback would produce a 404. A Google model added
        // to the catalog without an entry here will not route.
        slugPrefix: "google",
        slugOverrides: {
          "gemini-pro-latest": "google/gemini-2.5-pro",
          "gemini-flash-latest": "google/gemini-2.5-flash",
          "gemini-flash-lite-latest": "google/gemini-2.5-flash-lite",
        },
      },
    },
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "400+ models behind one key. Claude is measurable; GPT is not.",
    keyUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    keyPrefix: "sk-or-v1-",
    openaiBaseUrl: "https://openrouter.ai/api/v1",
    anthropicBaseUrl: "https://openrouter.ai/api",
    // Both x-api-key and bearer were accepted when probed; x-api-key is what the
    // Anthropic SDK sends unprompted, so it is the one with fewer moving parts.
    anthropicAuth: "x-api-key",
    extraBody: (provider) => ({
      // Pin the upstream and refuse fallbacks. OpenRouter price-load-balances a
      // model across upstream hosts that can serve different quantizations, and
      // moves between them silently. For a product whose output is a trend line
      // that is a measurement change disguised as a visibility change: the
      // mention rate shifts because routing shifted. Verified accepted — a
      // pinned request came back "served by: OpenAI".
      provider: { order: [OPENROUTER_UPSTREAM[provider]], allow_fallbacks: false },
    }),
    providers: {
      anthropic: {
        // The Anthropic skin forwards the forced web_search tool intact. Probed
        // 2026-07-31 with a live key: asked for the capital of France — a
        // question answerable from memory — it still returned 13 cited sources.
        shape: "anthropic",
        search: "passthrough",
        slugPrefix: "anthropic",
      },
      openai: {
        // OpenRouter cannot ask an OpenAI model for its OWN web search:
        // "The requested model does not support native web search. Use engine
        // 'auto' or 'exa' instead." Both of those route the search through Exa,
        // a third-party service — which measures something different from the
        // provider's own browsing and breaks the README's claim that Lettertrace
        // uses no search service beyond the provider's. So GPT through this
        // router serves ungrounded projects and utility work only, and a
        // grounded project is refused with a message naming the fix.
        shape: "openai-chat",
        search: "none",
        slugPrefix: "openai",
      },
      google: {
        // Routable, but never measurable. Probed 2026-08-02 with a live key:
        // a plain call returns no structured sources at all, and the only thing
        // that grounds is OpenRouter's `:online` suffix — its own Exa-backed
        // web plugin, not Google's native grounding. Substituting that would
        // mean measuring a different search engine and labelling it Gemini,
        // which is the one thing this product must not do. So `search: "none"`,
        // exactly as for OpenRouter's GPT path: a grounded project is refused
        // with a message naming the fixes, an ungrounded one runs fine.
        shape: "openai-chat",
        search: "none",
        // Our catalog carries Google's rolling ALIASES (gemini-flash-latest),
        // which no router resolves — every model needs an explicit slug, and
        // the `slugPrefix` fallback would produce a 404. A Google model added
        // to the catalog without an entry here will not route.
        slugPrefix: "google",
        slugOverrides: {
          "gemini-pro-latest": "google/gemini-2.5-pro",
          "gemini-flash-latest": "google/gemini-2.5-flash",
          "gemini-flash-lite-latest": "google/gemini-2.5-flash-lite",
        },
      },
    },
  },
  // Probed 2026-08-03 with a live key. The Anthropic skin is confirmed
  // end-to-end: forced web_search returned 9 cited sources on a question
  // answerable from memory, through the base URL and auth header recorded
  // below. Gemini's slug resolves on the chat surface (utility-tier only, as
  // everywhere). The one open question is GPT grounding — see the openai
  // entry for what was observed and what would raise it.
  merge: {
    id: "merge",
    label: "Merge Gateway",
    blurb: "Every major provider behind one endpoint, with routing and spend controls.",
    keyUrl: "https://gateway.merge.dev/",
    docsUrl: "https://docs.merge.dev/merge-gateway/get-started",
    // Merge's docs show keys only through SDK `apiKey` params, no prefix shown.
    keyPrefix: "",
    // Per-provider surfaces under one host: the docs name /v1/openai,
    // /v1/anthropic, /v1/ai-sdk. The OpenAI SDK appends /chat/completions.
    openaiBaseUrl: "https://api-gateway.merge.dev/v1/openai",
    // The Anthropic SDK appends /v1/messages itself. Probed 2026-08-03: this
    // base plus that suffix answered a forced-search request with real sources.
    anthropicBaseUrl: "https://api-gateway.merge.dev/v1/anthropic",
    // Undocumented but probed: x-api-key (the Anthropic SDK's default)
    // authenticated the grounded probe above.
    anthropicAuth: "x-api-key",
    providers: {
      anthropic: {
        // Native-shape skin, probed 2026-08-03: the forced web_search tool
        // survived the gateway and returned 9 cited sources. As always,
        // 'passthrough' still gates per credential at save time.
        shape: "anthropic",
        search: "passthrough",
        slugPrefix: "anthropic",
      },
      openai: {
        // Probed 2026-08-04 after Merge fixed their Responses tool passthrough
        // (any web-search tool drew a bare 502 the day before): the forced
        // `web_search_preview` now executes — the reply carries a completed
        // `web_search_call` and `url_citation` annotations on a question
        // answerable from memory. Same Responses shape as a direct OpenAI key,
        // so the citation parsers read it unchanged.
        shape: "openai-responses",
        search: "passthrough",
        slugPrefix: "openai",
      },
      google: {
        // Same stance as both routers above: routable for ungrounded runs,
        // refused for grounded ones — no router has shown us Google's native
        // grounding intact. Probed 2026-08-03: `google/gemini-2.5-flash`
        // resolves on the chat surface (HTTP 200), so the slug scheme holds.
        shape: "openai-chat",
        search: "none",
        slugPrefix: "google",
        slugOverrides: {
          "gemini-pro-latest": "google/gemini-2.5-pro",
          "gemini-flash-latest": "google/gemini-2.5-flash",
          "gemini-flash-lite-latest": "google/gemini-2.5-flash-lite",
        },
      },
    },
  },
};

/**
 * OpenRouter's upstream-provider names, for the pinning above.
 *
 * A name here is NOT a claim that any router serves the engine — `providers`
 * on each RouterInfo is the only thing that decides that, and no router lists
 * xai. This map is total over `Provider` because the pinning helper is, so an
 * entry is required for every provider whether or not it is ever reached.
 */
const OPENROUTER_UPSTREAM: Record<Provider, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google-vertex",
  perplexity: "perplexity",
  xai: "xai",
  deepseek: "deepseek",
};

/** Display order for the settings cards and CLI listing: Merge leads. */
export const ROUTER_LIST: RouterInfo[] = [ROUTERS.merge, ROUTERS.concentrate, ROUTERS.openrouter];

export function isRouterId(value: string): value is RouterId {
  return value === "concentrate" || value === "openrouter" || value === "merge";
}

/** Narrow an untrusted router value, or null. */
export function parseRouterId(value: unknown): RouterId | null {
  return typeof value === "string" && isRouterId(value) ? value : null;
}

export function unknownRouterMessage(): string {
  return `Unknown router. Supported: ${ROUTER_LIST.map((r) => r.id).join(", ")}.`;
}

/** How a router serves one provider, or null if it doesn't. */
export function routerSupport(
  router: RouterId,
  provider: Provider,
): RouterProviderSupport | null {
  return ROUTERS[router].providers[provider] ?? null;
}

/** The providers a router can serve at all (utility calls included). */
export function routerProviders(router: RouterId): Provider[] {
  return Object.keys(ROUTERS[router].providers) as Provider[];
}

/**
 * The router's slug for one of our catalog models, or null when the router
 * can't serve that provider.
 *
 * The AI Overviews pseudo-model is refused here rather than mapped: it is not a
 * model any router has, it is a Gemini call plus our own system prompt.
 */
export function routerSlug(
  router: RouterId,
  provider: Provider,
  model: string,
): string | null {
  if (model === GOOGLE_AI_OVERVIEWS_MODEL) return null;
  const support = routerSupport(router, provider);
  if (!support) return null;
  return support.slugOverrides?.[model] ?? `${support.slugPrefix}/${model}`;
}

/**
 * Can this router serve a MONITORED run for this engine?
 *
 * `verified` is the set of providers whose native search this credential has
 * actually been observed to pass through (stored per credential — see
 * lib/router-keys). When web search is off the question doesn't arise: an
 * ungrounded answer is what was asked for, so any provider the router reaches
 * will do.
 */
export function routerCanMeasure(
  router: RouterId,
  provider: Provider,
  opts: { webSearch: boolean; verified: Provider[] },
): boolean {
  const support = routerSupport(router, provider);
  if (!support) return false;
  if (!opts.webSearch) return true;
  if (support.search === "none") return false;
  return opts.verified.includes(provider);
}

/**
 * Why a router can't serve this engine, phrased as the fix.
 *
 * Only called when routerCanMeasure said no, and deliberately specific about
 * which of the three reasons applies — "your router can't do that" would leave
 * a user toggling settings at random. The direct key is always the way out,
 * so every branch names it.
 */
export function routerRefusalMessage(
  router: RouterId,
  provider: Provider,
  opts: { webSearch: boolean; verified: Provider[] },
): string {
  const routerLabel = ROUTERS[router].label;
  const providerLabel = PROVIDERS[provider].label;
  const support = routerSupport(router, provider);

  if (!support) {
    const served = routerProviders(router)
      .map((p) => PROVIDERS[p].label)
      .join(" and ");
    return (
      `${routerLabel} can't measure ${providerLabel} the way Lettertrace needs to. ` +
      `Through ${routerLabel} it serves ${served}; ${providerLabel} answers are only comparable on a direct ${providerLabel} key. ` +
      `Add one in Settings, or switch your answer engine.`
    );
  }
  if (support.search === "none" && opts.webSearch) {
    return (
      `Your project asks ${providerLabel} to search the live web, and ${routerLabel} has no way to request ${providerLabel}'s own web search. ` +
      `Running it anyway would answer from the model's memory and record it as a search-grounded measurement. ` +
      `Turn off web search for this project, or add a direct ${providerLabel} key in Settings.`
    );
  }
  return (
    `${routerLabel} hasn't been confirmed to pass ${providerLabel}'s web search through on this key. ` +
    `Re-check the key in Settings, or add a direct ${providerLabel} key.`
  );
}

/**
 * A saved router credential as a PICKER sees it: which gateway, and which
 * engines this key's native search has actually been confirmed for.
 *
 * Deliberately not the decrypted credential. Choosing an answer engine needs to
 * know what a key can reach, never what the key is, so this shape is safe to
 * hand a client component — it is the non-secret half of DecryptedRouterKey.
 */
export interface RouterCoverage {
  router: RouterId;
  searchVerified: Provider[];
}

/**
 * Whether the user's saved credentials can serve an engine, and how.
 *
 * The states mirror the ones resolveRunKeyFor produces at run time — 'direct'
 * and 'routed' are its 'own', 'unroutable' is its 'unroutable', 'none' is its
 * 'mismatch'/'none' — because selection is the same question execution asks,
 * one step earlier. Answering it two different ways is what let a user pick an
 * engine the next run would refuse.
 */
export type EngineCoverage =
  | { kind: "direct" }
  | { kind: "routed"; router: RouterId }
  | { kind: "unroutable"; router: RouterId; reason: string }
  | { kind: "none" };

/**
 * Resolve coverage for one engine, in the same order the run resolver uses:
 * a direct key, then a router that can MEASURE the engine, then a router that
 * merely reaches it.
 *
 * `webSearch` is the project's grounding setting, not a preference — with it on,
 * a router that can't carry the provider's own search can't serve the engine at
 * all, so the same credentials cover different engines depending on the toggle.
 */
export function engineCoverage(
  provider: Provider,
  opts: { direct: Provider[]; routers: RouterCoverage[]; webSearch: boolean },
): EngineCoverage {
  if (opts.direct.includes(provider)) return { kind: "direct" };

  const usable = opts.routers.find((rk) =>
    routerCanMeasure(rk.router, provider, {
      webSearch: opts.webSearch,
      verified: rk.searchVerified,
    }),
  );
  if (usable) return { kind: "routed", router: usable.router };

  // Reachable, but not comparably. The run would be refused, so the refusal is
  // composed HERE, in the same words, rather than left for the user to discover
  // by running — and it names which of the three fixes applies.
  const blocked = opts.routers.find((rk) => routerSupport(rk.router, provider) !== null);
  if (blocked) {
    return {
      kind: "unroutable",
      router: blocked.router,
      reason: routerRefusalMessage(blocked.router, provider, {
        webSearch: opts.webSearch,
        verified: blocked.searchVerified,
      }),
    };
  }

  return { kind: "none" };
}

/**
 * Every engine these credentials can actually run, direct keys first.
 *
 * Direct keys lead because that is the order the resolvers prefer them in, so a
 * list offered as "engines you already have" reads in the order they'd be used.
 */
export function coveredProviders(opts: {
  direct: Provider[];
  routers: RouterCoverage[];
  webSearch: boolean;
}): Provider[] {
  const routed = (Object.keys(PROVIDERS) as Provider[]).filter(
    (p) => engineCoverage(p, opts).kind === "routed",
  );
  return Array.from(new Set([...opts.direct, ...routed]));
}

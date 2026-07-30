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
// served by OpenRouter against Claude still measured *Claude*: it asked Claude's
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
 * Both routers offer an Anthropic-Messages-compatible endpoint (a "skin") in
 * addition to the OpenAI-compatible one. Preferring the native shape wherever it
 * exists is the whole reason the Anthropic path survives routing intact: the
 * request is byte-for-byte the one we send Anthropic directly, including the
 * server-side `web_search_20250305` tool and its forcing `tool_choice`, and the
 * reply comes back in the shape the existing citation parser already reads.
 * Rewriting that into OpenAI chat-completions would mean giving up both the
 * forced browse and the inline citations.
 */
export type RouteShape = "anthropic" | "openai-chat";

/**
 * How native web search is expressed through a router for one provider.
 *
 * - 'passthrough' — we send the provider's own search params and the router is
 *   expected to forward them untouched. Expressible, but only trustworthy once
 *   probed, so a credential must confirm it before this provider can serve
 *   monitored web-search runs.
 * - 'plugin' — the router replaces the provider's params with its own gateway
 *   flag. Still native browsing at the provider, but we cannot force the browse
 *   the way `tool_choice` does; see PLUGIN_SEARCH_CAVEAT.
 * - 'none' — no way to ask for native search in this router's documented
 *   surface. Utility calls are fine; monitored web-search runs are refused
 *   rather than silently run ungrounded.
 */
export type SearchSupport = "passthrough" | "plugin" | "none";

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

/**
 * Why a plugin-shaped search is weaker than a passthrough one.
 *
 * The direct paths force the browse — `tool_choice` on Anthropic, on OpenAI's
 * Responses API — because left to choose, a model answers a well-known question
 * from memory and cites nothing. Measured in a live pilot, Claude searched on 4
 * of 10 prompts where OpenAI searched on 10, which made the two providers'
 * mention rates measure different things. A gateway plugin flag has no equivalent
 * of "you must search", so a plugin-served engine can drift the same way. It is
 * still worth offering — it is real native browsing — but it is not equivalent,
 * and the UI says so rather than presenting the two as interchangeable.
 */
export const PLUGIN_SEARCH_CAVEAT =
  "Search runs through the router's web plugin, which can't force a browse the way a direct key can. Some answers may come from the model's memory instead of the live web.";

// Google and Perplexity are deliberately absent from both routers below.
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
        shape: "openai-chat",
        // Concentrate documents web search on its normalized Responses API but
        // does not document the parameter that turns it on, and guessing one
        // would produce exactly the failure this whole module guards against: a
        // request that looks grounded, is accepted, and returns memory. Left at
        // 'none' until Concentrate's surface is known; utility calls are
        // unaffected, and monitored web-search runs are refused with a message
        // that names the fix. Raise this to 'passthrough' once verified.
        search: "none",
        slugPrefix: "openai",
      },
    },
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "400+ models behind one key. Widest coverage.",
    keyUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    keyPrefix: "sk-or-v1-",
    openaiBaseUrl: "https://openrouter.ai/api/v1",
    anthropicBaseUrl: "https://openrouter.ai/api",
    // OpenRouter's Anthropic-compatible endpoint takes the same `x-api-key` the
    // Anthropic SDK sends by default — it is what makes ANTHROPIC_BASE_URL work
    // with an OpenRouter key.
    anthropicAuth: "x-api-key",
    extraBody: (provider, { webSearch }) => ({
      // Pin the upstream and refuse fallbacks. OpenRouter price-load-balances a
      // model across several upstream hosts that can serve different
      // quantizations and different context handling, and it will silently move
      // between them. For a product whose output is a trend line, that is a
      // measurement change disguised as a visibility change: the brand's
      // mention rate shifts because routing shifted. Pinning trades some
      // availability for a comparable series, which is the right trade here.
      provider: { order: [OPENROUTER_UPSTREAM[provider]], allow_fallbacks: false },
      // Force the provider's own search rather than OpenRouter's Exa fallback.
      // Unspecified, the plugin uses native search "if available" and otherwise
      // silently substitutes Exa — a third-party search service, which would
      // both change what is being measured and break the README's claim that
      // Lettertrace uses no search service beyond the provider's own.
      ...(webSearch
        ? { plugins: [{ id: "web", engine: "native", max_results: WEB_PLUGIN_MAX_RESULTS }] }
        : {}),
    }),
    providers: {
      anthropic: {
        shape: "anthropic",
        search: "passthrough",
        slugPrefix: "anthropic",
      },
      openai: {
        shape: "openai-chat",
        search: "plugin",
        slugPrefix: "openai",
      },
    },
  },
};

/** Matches WEB_SEARCH_MAX_USES on the direct paths, so a routed answer draws on
 *  a comparable number of sources rather than a wider or narrower read. */
const WEB_PLUGIN_MAX_RESULTS = 5;

/** OpenRouter's upstream-provider names, for the pinning above. */
const OPENROUTER_UPSTREAM: Record<Provider, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google-vertex",
  perplexity: "perplexity",
};

export const ROUTER_LIST: RouterInfo[] = Object.values(ROUTERS);

export function isRouterId(value: string): value is RouterId {
  return value === "concentrate" || value === "openrouter";
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
  if (support.search === "plugin") return true;
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

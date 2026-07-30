import { describe, it, expect } from "vitest";
import { GOOGLE_AI_OVERVIEWS_MODEL } from "@/lib/models";
import {
  ROUTERS,
  isRouterId,
  parseRouterId,
  routerCanMeasure,
  routerProviders,
  routerRefusalMessage,
  routerSlug,
  routerSupport,
} from "@/lib/routers";
import type { Provider } from "@/lib/types";

describe("router registry", () => {
  it("narrows only known routers", () => {
    expect(isRouterId("openrouter")).toBe(true);
    expect(isRouterId("concentrate")).toBe(true);
    expect(isRouterId("litellm")).toBe(false);
    expect(parseRouterId(42)).toBeNull();
    expect(parseRouterId("openrouter")).toBe("openrouter");
  });

  // The whole design rests on a router never becoming a Provider. If one ever
  // appears in the provider catalog, share of voice splits across two entries
  // that are the same answer surface — so assert the separation directly.
  it("keeps routers out of the provider union", () => {
    const providers: string[] = ["anthropic", "openai", "google", "perplexity"];
    for (const id of Object.keys(ROUTERS)) {
      expect(providers).not.toContain(id);
    }
  });

  it("serves only the engines whose measurement survives a gateway", () => {
    expect(routerProviders("openrouter")).toEqual(["anthropic", "openai"]);
    expect(routerProviders("concentrate")).toEqual(["anthropic", "openai"]);
    // Gemini's grounding chunks, the AI Overviews pseudo-model and Perplexity's
    // always-on search are all provider-shaped; routed, they'd answer with a
    // different measurement under the same label.
    expect(routerSupport("openrouter", "google")).toBeNull();
    expect(routerSupport("openrouter", "perplexity")).toBeNull();
  });

  it("prefers each router's Anthropic-compatible endpoint for Claude", () => {
    // Speaking Anthropic's own wire format is what preserves the forced
    // web_search tool and the inline citations the parser reads.
    expect(routerSupport("openrouter", "anthropic")?.shape).toBe("anthropic");
    expect(routerSupport("concentrate", "anthropic")?.shape).toBe("anthropic");
    expect(ROUTERS.openrouter.anthropicBaseUrl).toBe("https://openrouter.ai/api");
    expect(ROUTERS.concentrate.anthropicBaseUrl).toBe("https://api.concentrate.ai");
  });

  // The Anthropic SDK sends one auth header, not both, so each router's entry
  // has to match what that router documents or every routed Claude call 401s.
  it("records each router's auth header for the Anthropic surface", () => {
    expect(ROUTERS.openrouter.anthropicAuth).toBe("x-api-key");
    expect(ROUTERS.concentrate.anthropicAuth).toBe("bearer");
  });
});

describe("routerSlug", () => {
  it("namespaces a catalog model under its vendor", () => {
    expect(routerSlug("openrouter", "anthropic", "claude-opus-4-8")).toBe(
      "anthropic/claude-opus-4-8",
    );
    expect(routerSlug("concentrate", "openai", "gpt-4o")).toBe("openai/gpt-4o");
  });

  it("refuses the AI Overviews pseudo-model", () => {
    // It isn't a model any router has: it's a Gemini call plus our own system
    // prompt. Mapping it to a slug would send the request somewhere real and
    // return something that isn't an AI Overview.
    expect(routerSlug("openrouter", "google", GOOGLE_AI_OVERVIEWS_MODEL)).toBeNull();
  });

  it("refuses an engine the router doesn't serve", () => {
    expect(routerSlug("openrouter", "perplexity", "sonar-pro")).toBeNull();
  });
});

describe("routerCanMeasure", () => {
  const verified: Provider[] = ["anthropic"];

  it("allows any reachable engine when the project isn't grounded", () => {
    expect(
      routerCanMeasure("concentrate", "openai", { webSearch: false, verified: [] }),
    ).toBe(true);
  });

  it("requires a confirmed passthrough for a grounded run", () => {
    expect(routerCanMeasure("openrouter", "anthropic", { webSearch: true, verified })).toBe(
      true,
    );
    expect(
      routerCanMeasure("openrouter", "anthropic", { webSearch: true, verified: [] }),
    ).toBe(false);
  });

  // OpenRouter's plugin is the router's own flag over native provider search, so
  // there is nothing per-credential to verify — but it can't force the browse,
  // which is why PLUGIN_SEARCH_CAVEAT is shown rather than nothing.
  it("accepts a plugin-shaped search without a per-key probe", () => {
    expect(
      routerCanMeasure("openrouter", "openai", { webSearch: true, verified: [] }),
    ).toBe(true);
  });

  it("never allows an engine the router doesn't serve", () => {
    expect(
      routerCanMeasure("openrouter", "google", { webSearch: false, verified: [] }),
    ).toBe(false);
  });
});

describe("routerRefusalMessage", () => {
  it("names the alternative engines when the router can't serve one", () => {
    const message = routerRefusalMessage("openrouter", "google", {
      webSearch: true,
      verified: [],
    });
    expect(message).toContain("Google (Gemini)");
    expect(message).toContain("Anthropic (Claude) and OpenAI (ChatGPT)");
  });

  it("offers turning grounding off when search can't be requested", () => {
    const message = routerRefusalMessage("concentrate", "openai", {
      webSearch: true,
      verified: [],
    });
    expect(message).toContain("Turn off web search");
    expect(message).toContain("Concentrate");
  });

  it("points at a re-check when only the probe is missing", () => {
    const message = routerRefusalMessage("openrouter", "anthropic", {
      webSearch: true,
      verified: [],
    });
    expect(message).toContain("Re-check the key");
  });
});

describe("OpenRouter request body", () => {
  it("pins the upstream and forbids fallbacks", () => {
    // Unpinned, OpenRouter price-load-balances across upstreams that can serve
    // different quantizations, so a trend line moves when routing moves.
    const body = ROUTERS.openrouter.extraBody!("anthropic", { webSearch: false }) as {
      provider: { order: string[]; allow_fallbacks: boolean };
    };
    expect(body.provider).toEqual({ order: ["anthropic"], allow_fallbacks: false });
  });

  it("forces native search rather than the Exa fallback", () => {
    const body = ROUTERS.openrouter.extraBody!("openai", { webSearch: true }) as {
      plugins: { id: string; engine: string; max_results: number }[];
    };
    // Left unspecified, OpenRouter substitutes Exa when native isn't available —
    // a third-party search service, which changes what is measured and breaks
    // the product's "no search service but the provider's own" claim.
    expect(body.plugins).toEqual([{ id: "web", engine: "native", max_results: 5 }]);
  });

  it("asks for no web plugin when the project isn't grounded", () => {
    const body = ROUTERS.openrouter.extraBody!("openai", { webSearch: false }) as Record<
      string,
      unknown
    >;
    expect(body.plugins).toBeUndefined();
  });
});

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
    expect(isRouterId("concentrate")).toBe(true);
    // OpenRouter was built and then dropped before shipping: its entries rested
    // on documentation where Concentrate's rest on a live probe. Nothing should
    // accept the identifier while the registry has no entry for it.
    expect(isRouterId("openrouter")).toBe(false);
    expect(isRouterId("litellm")).toBe(false);
    expect(parseRouterId(42)).toBeNull();
    expect(parseRouterId("concentrate")).toBe("concentrate");
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
    expect(routerProviders("concentrate")).toEqual(["anthropic", "openai"]);
    // Gemini's grounding chunks, the AI Overviews pseudo-model and Perplexity's
    // always-on search are all provider-shaped; routed, they'd answer with a
    // different measurement under the same label.
    expect(routerSupport("concentrate", "google")).toBeNull();
    expect(routerSupport("concentrate", "perplexity")).toBeNull();
  });

  // Both of these are the provider's OWN wire format, which is what preserves
  // the forced browse and the citation shapes the parsers already read. Probed
  // live on 2026-07-30: both returned real sources.
  it("speaks each provider's native API rather than a normalized one", () => {
    expect(routerSupport("concentrate", "anthropic")?.shape).toBe("anthropic");
    expect(routerSupport("concentrate", "openai")?.shape).toBe("openai-responses");
    expect(ROUTERS.concentrate.anthropicBaseUrl).toBe("https://api.concentrate.ai");
    expect(ROUTERS.concentrate.openaiBaseUrl).toBe("https://api.concentrate.ai/v1");
  });

  // The Anthropic SDK sends one auth header, not both, so the entry has to match
  // what the router documents or every routed Claude call 401s.
  it("records the auth header for the Anthropic surface", () => {
    expect(ROUTERS.concentrate.anthropicAuth).toBe("bearer");
  });
});

describe("routerSlug", () => {
  it("namespaces a catalog model under its vendor", () => {
    expect(routerSlug("concentrate", "anthropic", "claude-opus-4-8")).toBe(
      "anthropic/claude-opus-4-8",
    );
    expect(routerSlug("concentrate", "openai", "gpt-4o")).toBe("openai/gpt-4o");
  });

  it("refuses the AI Overviews pseudo-model", () => {
    // It isn't a model any router has: it's a Gemini call plus our own system
    // prompt. Mapping it to a slug would send the request somewhere real and
    // return something that isn't an AI Overview.
    expect(routerSlug("concentrate", "google", GOOGLE_AI_OVERVIEWS_MODEL)).toBeNull();
  });

  it("refuses an engine the router doesn't serve", () => {
    expect(routerSlug("concentrate", "perplexity", "sonar-pro")).toBeNull();
  });
});

describe("routerCanMeasure", () => {
  const verified: Provider[] = ["anthropic", "openai"];

  it("allows any reachable engine when the project isn't grounded", () => {
    expect(
      routerCanMeasure("concentrate", "openai", { webSearch: false, verified: [] }),
    ).toBe(true);
  });

  it("requires a confirmed passthrough for a grounded run", () => {
    expect(
      routerCanMeasure("concentrate", "anthropic", { webSearch: true, verified }),
    ).toBe(true);
    expect(
      routerCanMeasure("concentrate", "anthropic", { webSearch: true, verified: [] }),
    ).toBe(false);
  });

  // Confirmation is per engine. One endpoint on the gateway carrying search says
  // nothing about the other, and either can regress on its own.
  it("checks the engine being run, not the credential as a whole", () => {
    expect(
      routerCanMeasure("concentrate", "openai", { webSearch: true, verified: ["anthropic"] }),
    ).toBe(false);
  });

  it("never allows an engine the router doesn't serve", () => {
    expect(
      routerCanMeasure("concentrate", "google", { webSearch: false, verified: [] }),
    ).toBe(false);
  });
});

/**
 * Temporarily mark one engine as unsearchable and ask for the refusal.
 *
 * routerRefusalMessage reads the registry rather than taking support as an
 * argument, so the only way to reach the 'none' branch is to put a router in
 * that state — and no shipped router is in it, now that Concentrate's Responses
 * endpoint turned out to honour a forced browse. Restored in a finally, so a
 * failing assertion can't leave the registry lying to every other test.
 */
function refusalForSearchless(): string {
  const support = ROUTERS.concentrate.providers.openai!;
  const original = support.search;
  support.search = "none";
  try {
    return routerRefusalMessage("concentrate", "openai", { webSearch: true, verified: [] });
  } finally {
    support.search = original;
  }
}

describe("routerRefusalMessage", () => {
  it("names the alternative engines when the router can't serve one", () => {
    const message = routerRefusalMessage("concentrate", "google", {
      webSearch: true,
      verified: [],
    });
    expect(message).toContain("Google (Gemini)");
    expect(message).toContain("Anthropic (Claude) and OpenAI (ChatGPT)");
  });

  // The branch stays because it is the guard for the next router added, so
  // exercise it against a stub rather than deleting the coverage with the case.
  it("offers turning grounding off when search can't be requested", () => {
    expect(refusalForSearchless()).toContain("Turn off web search");
  });

  it("points at a re-check when only the probe is missing", () => {
    const message = routerRefusalMessage("concentrate", "anthropic", {
      webSearch: true,
      verified: [],
    });
    expect(message).toContain("Re-check the key");
  });
});

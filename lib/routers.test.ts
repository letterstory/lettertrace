import { describe, it, expect } from "vitest";
import { GOOGLE_AI_OVERVIEWS_MODEL } from "@/lib/models";
import {
  ROUTERS,
  coveredProviders,
  engineCoverage,
  isRouterId,
  parseRouterId,
  routerCanMeasure,
  routerProviders,
  routerRefusalMessage,
  routerSlug,
  routerSupport,
  type RouterCoverage,
} from "@/lib/routers";
import type { Provider } from "@/lib/types";

describe("router registry", () => {
  it("narrows only known routers", () => {
    expect(isRouterId("concentrate")).toBe(true);
    expect(isRouterId("openrouter")).toBe(true);
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
    expect(routerProviders("openrouter")).toEqual(["anthropic", "openai"]);
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
  // what the router accepts or every routed Claude call 401s. Both probed live.
  it("records the auth header for each Anthropic surface", () => {
    expect(ROUTERS.concentrate.anthropicAuth).toBe("bearer");
    expect(ROUTERS.openrouter.anthropicAuth).toBe("x-api-key");
  });

  // Probed 2026-07-31 against a live key. OpenRouter carries Claude's forced
  // web_search (13 sources on a question answerable from memory) but cannot ask
  // an OpenAI model for its OWN search — "does not support native web search,
  // use engine auto or exa" — and Exa is a third-party service that measures
  // something different. So GPT through OpenRouter is ungrounded-only.
  it("records what each router can actually ground", () => {
    expect(routerSupport("openrouter", "anthropic")?.search).toBe("passthrough");
    expect(routerSupport("openrouter", "openai")?.search).toBe("none");
    expect(routerSupport("concentrate", "anthropic")?.search).toBe("passthrough");
    expect(routerSupport("concentrate", "openai")?.search).toBe("passthrough");
  });

  it("still serves ungrounded work on the engine it cannot ground", () => {
    // A refusal would be wrong: nothing is being claimed about the live web.
    expect(routerCanMeasure("openrouter", "openai", { webSearch: false, verified: [] })).toBe(true);
    expect(routerCanMeasure("openrouter", "openai", { webSearch: true, verified: ["openai"] })).toBe(false);
  });
});

describe("OpenRouter request body", () => {
  it("pins the upstream and forbids fallbacks", () => {
    // Unpinned, OpenRouter price-load-balances across upstreams that can serve
    // different quantizations, so a trend line moves when routing moves.
    // Verified accepted: a pinned request came back "served by: OpenAI".
    const body = ROUTERS.openrouter.extraBody!("anthropic", { webSearch: true }) as {
      provider: { order: string[]; allow_fallbacks: boolean };
    };
    expect(body.provider).toEqual({ order: ["anthropic"], allow_fallbacks: false });
  });

  it("never asks for a web plugin", () => {
    // The plugin would route through Exa for OpenAI models, which is a
    // third-party search service and a different measurement.
    const body = ROUTERS.openrouter.extraBody!("openai", { webSearch: true }) as Record<string, unknown>;
    expect(body.plugins).toBeUndefined();
  });

  it("Concentrate needs no extra body", () => {
    expect(ROUTERS.concentrate.extraBody).toBeUndefined();
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

describe("routerRefusalMessage", () => {
  it("names the alternative engines when the router can't serve one", () => {
    const message = routerRefusalMessage("concentrate", "google", {
      webSearch: true,
      verified: [],
    });
    expect(message).toContain("Google (Gemini)");
    expect(message).toContain("Anthropic (Claude) and OpenAI (ChatGPT)");
  });

  // OpenRouter cannot ask an OpenAI model for its own web search — its only
  // options route through Exa — so this is the real case, not a stub.
  it("offers turning grounding off when search can't be requested", () => {
    const message = routerRefusalMessage("openrouter", "openai", {
      webSearch: true,
      verified: [],
    });
    expect(message).toContain("Turn off web search");
    expect(message).toContain("OpenRouter");
    expect(message).toContain("OpenAI (ChatGPT)");
  });

  it("points at a re-check when only the probe is missing", () => {
    const message = routerRefusalMessage("concentrate", "anthropic", {
      webSearch: true,
      verified: [],
    });
    expect(message).toContain("Re-check the key");
  });
});

// LET-176. A user holding only router keys was told every engine would fail,
// because the answer-engine picker asked "do you have a provider key?" while the
// run resolver asks "can anything you hold measure this engine?". These are the
// picker's half of that second question, and they have to agree with
// resolveRunKeyFor's states or the two surfaces drift apart again.
describe("engineCoverage", () => {
  // Confirmed for both engines, which is what saving the key probes for.
  const concentrate: RouterCoverage = {
    router: "concentrate",
    searchVerified: ["anthropic", "openai"],
  };
  const openrouter: RouterCoverage = {
    router: "openrouter",
    searchVerified: ["anthropic"],
  };

  it("covers an engine reachable only through a saved router", () => {
    expect(
      engineCoverage("anthropic", { direct: [], routers: [concentrate], webSearch: true }),
    ).toEqual({ kind: "routed", router: "concentrate" });
  });

  it("still covers an engine held as a direct key", () => {
    // And prefers it: the run resolver tries the direct key first, so a picker
    // that named a router here would describe a call that won't be made.
    expect(
      engineCoverage("anthropic", {
        direct: ["anthropic"],
        routers: [concentrate],
        webSearch: true,
      }),
    ).toEqual({ kind: "direct" });
  });

  it("covers a grounded engine only through a router confirmed to ground it", () => {
    // OpenRouter reaches GPT but cannot ask it for its own web search, so a
    // grounded project is 'unroutable' — reachable, not measurable — and the
    // reason carries the fix rather than a bare refusal.
    const grounded = engineCoverage("openai", {
      direct: [],
      routers: [openrouter],
      webSearch: true,
    });
    expect(grounded.kind).toBe("unroutable");
    expect(grounded.kind === "unroutable" && grounded.reason).toContain("Turn off web search");

    // Same credentials, same engine, grounding off: nothing is being claimed
    // about the live web, so the router serves it.
    expect(
      engineCoverage("openai", { direct: [], routers: [openrouter], webSearch: false }),
    ).toEqual({ kind: "routed", router: "openrouter" });
  });

  it("prefers a router that can measure over one that merely reaches", () => {
    expect(
      engineCoverage("openai", {
        direct: [],
        routers: [openrouter, concentrate],
        webSearch: true,
      }),
    ).toEqual({ kind: "routed", router: "concentrate" });
  });

  it("reports no coverage for an engine no router serves", () => {
    // The LET-176 report itself: router keys, no Google key. Gemini's grounding
    // doesn't survive a gateway, so no router reaches it at all — which is a
    // different message from "reachable but not measurable".
    expect(
      engineCoverage("google", {
        direct: [],
        routers: [concentrate, openrouter],
        webSearch: true,
      }),
    ).toEqual({ kind: "none" });
  });

  it("treats a router as no coverage when the user has saved none", () => {
    expect(engineCoverage("anthropic", { direct: [], routers: [], webSearch: false })).toEqual({
      kind: "none",
    });
  });
});

describe("coveredProviders", () => {
  it("lists direct keys first, then what the routers add", () => {
    const covered = coveredProviders({
      direct: ["google"],
      routers: [{ router: "concentrate", searchVerified: ["anthropic", "openai"] }],
      webSearch: true,
    });
    expect(covered).toEqual(["google", "anthropic", "openai"]);
  });

  it("drops an engine the routers can reach but not ground", () => {
    const routers: RouterCoverage[] = [{ router: "openrouter", searchVerified: ["anthropic"] }];
    expect(coveredProviders({ direct: [], routers, webSearch: true })).toEqual(["anthropic"]);
    expect(coveredProviders({ direct: [], routers, webSearch: false })).toEqual([
      "anthropic",
      "openai",
    ]);
  });

  it("never invents coverage for an engine that needs a direct key", () => {
    const covered = coveredProviders({
      direct: [],
      routers: [
        { router: "concentrate", searchVerified: ["anthropic", "openai"] },
        { router: "openrouter", searchVerified: ["anthropic"] },
      ],
      webSearch: false,
    });
    expect(covered).not.toContain("google");
    expect(covered).not.toContain("perplexity");
  });
});

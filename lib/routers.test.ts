import { describe, it, expect } from "vitest";
import { GOOGLE_AI_OVERVIEWS_MODEL } from "@/lib/models";
import {
  ROUTERS,
  ROUTER_LIST,
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
    expect(isRouterId("merge")).toBe(true);
    expect(isRouterId("litellm")).toBe(false);
    expect(parseRouterId(42)).toBeNull();
    expect(parseRouterId("concentrate")).toBe("concentrate");
  });

  it("lists every registered router, Merge first", () => {
    // ROUTER_LIST is hand-ordered for display, which means a new registry
    // entry can be silently forgotten from it — this catches that.
    expect(ROUTER_LIST.map((r) => r.id)).toEqual(["merge", "concentrate", "openrouter"]);
    expect(new Set(ROUTER_LIST.map((r) => r.id))).toEqual(new Set(Object.keys(ROUTERS)));
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
    expect(routerProviders("concentrate")).toEqual(["anthropic", "openai", "google"]);
    expect(routerProviders("openrouter")).toEqual(["anthropic", "openai", "google"]);
    expect(routerProviders("merge")).toEqual(["anthropic", "openai", "google"]);
    // Perplexity stays out: its search is always on and inseparable from the
    // answer, so a routed Perplexity call cannot be the ungrounded fallback the
    // `search: "none"` tier relies on. Gemini earns its place only in that
    // tier — reachable, never grounded (see the routed Gemini cases below).
    expect(routerSupport("concentrate", "perplexity")).toBeNull();
    expect(routerSupport("openrouter", "perplexity")).toBeNull();
    expect(routerSupport("merge", "perplexity")).toBeNull();
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
    // Probed 2026-08-03: x-api-key authenticated a grounded Claude call.
    expect(ROUTERS.merge.anthropicAuth).toBe("x-api-key");
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
    // Merge, probed 2026-08-03 (Claude: 9 sources) and 2026-08-04 (GPT: forced
    // web_search_preview executed with url_citation annotations, once Merge
    // fixed the Responses tool passthrough that had been returning bare 502s).
    expect(routerSupport("merge", "anthropic")?.search).toBe("passthrough");
    expect(routerSupport("merge", "openai")?.search).toBe("passthrough");
    expect(routerSupport("merge", "openai")?.shape).toBe("openai-responses");
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

  it("Concentrate adds nothing extra — every engine forces its own search tool", () => {
    // Gemini used to rely on a `web_search_options` hint here; it now goes
    // through the Responses API with a forced `web_search` tool (like OpenAI),
    // so no provider needs extraBody.
    expect(ROUTERS.concentrate.extraBody!("google", { webSearch: true })).toEqual({});
    expect(ROUTERS.concentrate.extraBody!("google", { webSearch: false })).toEqual({});
    expect(ROUTERS.concentrate.extraBody!("anthropic", { webSearch: true })).toEqual({});
    expect(ROUTERS.concentrate.extraBody!("openai", { webSearch: true })).toEqual({});
  });

  it("Concentrate serves Gemini on the openai-responses shape", () => {
    // The forced web_search tool lives on the Responses path; the old
    // openai-chat shape only hinted and grounded at random.
    expect(ROUTERS.concentrate.providers.google?.shape).toBe("openai-responses");
  });
});

describe("routerSlug", () => {
  it("namespaces a catalog model under its vendor", () => {
    expect(routerSlug("concentrate", "anthropic", "claude-opus-4-8")).toBe(
      "anthropic/claude-opus-4-8",
    );
    expect(routerSlug("concentrate", "openai", "gpt-4o")).toBe("openai/gpt-4o");
  });

  it("resolves the AI Overviews pseudo-model to its backing Gemini slug", () => {
    // It isn't a model any router has: it's a Gemini call plus our overview
    // system prompt. It routes on its backing model's slug (the adapter re-applies
    // the overview prompt), so a router that carries Google grounding can serve
    // it — the same slug Gemini Flash resolves to.
    expect(routerSlug("concentrate", "google", GOOGLE_AI_OVERVIEWS_MODEL)).toBe(
      "google/gemini-2.5-flash",
    );
    expect(routerSlug("concentrate", "google", GOOGLE_AI_OVERVIEWS_MODEL)).toBe(
      routerSlug("concentrate", "google", "gemini-flash-latest"),
    );
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
      routerCanMeasure("concentrate", "perplexity", { webSearch: false, verified: [] }),
    ).toBe(false);
  });
});

describe("routerRefusalMessage", () => {
  it("names the alternative engines when the router can't serve one", () => {
    const message = routerRefusalMessage("concentrate", "perplexity", {
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
    // Perplexity is the engine no router serves at all — a different state
    // from Gemini's "reachable but never grounded" (covered below).
    expect(
      engineCoverage("perplexity", {
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
    // Grounded: only Claude survives the gateway. GPT and Gemini are both
    // reachable and both `search: "none"`, so both drop out.
    expect(coveredProviders({ direct: [], routers, webSearch: true })).toEqual(["anthropic"]);
    expect(coveredProviders({ direct: [], routers, webSearch: false })).toEqual([
      "anthropic",
      "openai",
      "google",
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
    // Perplexity is served by no router, so it can never appear. Gemini is not
    // asserted here — ungrounded, it is legitimately covered.
    expect(covered).not.toContain("perplexity");
  });
});

// ---------------------------------------------------------------------------
// Routed Gemini (LET-176).
//
// Both routers can SERVE Gemini and neither can GROUND it — probed 2026-08-02
// against live keys. These cases pin that distinction, because the tempting
// fix (accept OpenRouter's `:online` Exa plugin as grounding) would silently
// swap the search engine underneath a number labelled "Gemini".
// ---------------------------------------------------------------------------

describe("routed Gemini", () => {
  it("is reachable through every router", () => {
    for (const router of ["openrouter", "concentrate", "merge"] as const) {
      expect(routerProviders(router)).toContain("google");
    }
  });

  it("is selectable for an ungrounded project", () => {
    const cov = engineCoverage("google", {
      direct: [],
      routers: [{ router: "openrouter", searchVerified: [] }],
      webSearch: false,
    });
    expect(cov.kind).toBe("routed");
  });

  it("is refused for a grounded project, however the key was verified", () => {
    // `verified` cannot rescue it: search is "none", so there is no native
    // grounding to have verified in the first place.
    for (const verified of [[], ["google"] as Provider[]]) {
      const cov = engineCoverage("google", {
        direct: [],
        routers: [{ router: "openrouter", searchVerified: verified }],
        webSearch: true,
      });
      expect(cov.kind).toBe("unroutable");
    }
  });

  it("maps every catalog Gemini model to a real router slug", () => {
    // Google's catalog ids are rolling aliases no router resolves, so each one
    // needs an explicit override; the slugPrefix fallback would 404.
    for (const model of ["gemini-pro-latest", "gemini-flash-latest", "gemini-flash-lite-latest"]) {
      const slug = routerSlug("openrouter", "google", model);
      expect(slug).toMatch(/^google\/gemini-2\.5-(pro|flash|flash-lite)$/);
    }
  });

  it("routes the AI Overviews pseudo-model only where Google grounding survives", () => {
    // AI Overviews is grounded-always, riding the Gemini path on its backing
    // slug. Every router resolves that slug (a naming question), but the surface
    // can only be MEASURED where the router carries Google's native search — just
    // Concentrate. On the others it gets a slug but is refused for the grounded
    // run it always is, so it stays on a direct key.
    for (const router of ["openrouter", "concentrate", "merge"] as const) {
      expect(routerSlug(router, "google", GOOGLE_AI_OVERVIEWS_MODEL)).toBe("google/gemini-2.5-flash");
    }
    const grounded = { webSearch: true, verified: ["google"] as Provider[] };
    expect(routerCanMeasure("concentrate", "google", grounded)).toBe(true);
    expect(routerCanMeasure("openrouter", "google", grounded)).toBe(false);
    expect(routerCanMeasure("merge", "google", grounded)).toBe(false);
  });
});

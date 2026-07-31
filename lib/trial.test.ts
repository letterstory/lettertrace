import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// trial.ts pulls in lib/data (getDecryptedKey), which calls React's cache() at
// module load, unavailable in the node test env. Stub it so the import graph
// stays clean; resolveKey's own use of it is mocked per-test below.
vi.mock("@/lib/data", () => ({
  getDecryptedKey: vi.fn(),
  getConfiguredProviders: vi.fn(),
  getDecryptedRouterKeys: vi.fn(),
}));

import { getDecryptedKey, getConfiguredProviders, getDecryptedRouterKeys } from "@/lib/data";
import type { Provider, RouterId } from "@/lib/types";
import {
  resolveKey,
  resolveRunKeyFor,
  engineKeyMessage,
  nextRunMessage,
  trialKeyFor,
  trialModelFor,
  trialEnabled,
  pickDefaultProvider,
} from "@/lib/trial";

// Grounding is a required argument on the real resolver (a router that can't
// carry native search must not serve a project that asks for it). Every case
// below that predates routers is about direct keys, where the flag changes
// nothing, so default it off here and pass it explicitly in the router cases.
function runKeyFor(
  db: never,
  userId: string,
  provider: Provider,
  model?: string,
  opts: { webSearch: boolean } = { webSearch: false },
) {
  return resolveRunKeyFor(db, userId, provider, model, opts);
}

/** Stand in a saved router credential, with the engines it has been shown to
 *  carry native web search for. */
function hasRouter(router: RouterId, searchVerified: Provider[] = []) {
  vi.mocked(getDecryptedRouterKeys).mockResolvedValue([
    { router, baseUrl: null, searchVerified, apiKey: `key-for-${router}` },
  ]);
}

// getTrialRunsUsed reads profiles.trial_runs_used; everything else in resolveKey
// is env + the mocked key lookup.
function db(runsUsed: number) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { trial_runs_used: runsUsed } }),
        }),
      }),
    }),
  } as never;
}

// The trial helpers read shared (operator) keys straight from the environment,
// so drive them by mutating process.env and restore it afterward.
const TRIAL_VARS = [
  "TRIAL_ANTHROPIC_API_KEY",
  "TRIAL_OPENAI_API_KEY",
  "TRIAL_GOOGLE_API_KEY",
  "TRIAL_PERPLEXITY_API_KEY",
  "TRIAL_ANTHROPIC_MODEL",
  "TRIAL_OPENAI_MODEL",
  "TRIAL_GOOGLE_MODEL",
  "TRIAL_RUN_LIMIT",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const v of TRIAL_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  process.env.TRIAL_RUN_LIMIT = "5";
  vi.mocked(getDecryptedKey).mockReset().mockResolvedValue(null);
  vi.mocked(getConfiguredProviders).mockReset().mockResolvedValue([]);
  vi.mocked(getDecryptedRouterKeys).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  for (const v of TRIAL_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("resolveKey", () => {
  it("uses the user's own key when they have one", async () => {
    vi.mocked(getDecryptedKey).mockResolvedValue("sk-ant-own");
    const k = await resolveKey(db(0), "user-1", "anthropic");
    expect(k.source).toBe("own");
    expect(k.apiKey).toBe("sk-ant-own");
  });

  // The bug this guards: the runs page gated its button on a BYOK key alone,
  // so a trial user with free runs left saw it disabled even though the run
  // endpoint — which calls this same resolver — would have accepted it.
  it("falls back to the trial key when none of the user's own exist and runs remain", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    const k = await resolveKey(db(1), "user-1", "anthropic");
    expect(k.source).toBe("trial");
    expect(k.remaining).toBe(4);
    expect(k.limit).toBe(5);
  });

  it("reports exhausted once the allowance is spent", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    const k = await resolveKey(db(5), "user-1", "anthropic");
    expect(k.source).toBe("exhausted");
    expect(k.remaining).toBe(0);
  });

  it("reports none when no trial key is configured at all", async () => {
    const k = await resolveKey(db(0), "user-1", "anthropic");
    expect(k.source).toBe("none");
  });

  // A trial run is forced onto the provider's cheap model, which is why the
  // runs page must name k.model rather than the project's default — it said
  // "Claude Opus 4.8" and then ran Haiku.
  it("returns the trial model, not the requested one", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    process.env.TRIAL_ANTHROPIC_MODEL = "claude-haiku-4-5";
    const k = await resolveKey(db(0), "user-1", "anthropic", "claude-opus-4-8");
    expect(k.model).toBe("claude-haiku-4-5");
  });

  it("honours the requested model when using the user's own key", async () => {
    vi.mocked(getDecryptedKey).mockResolvedValue("sk-ant-own");
    const k = await resolveKey(db(0), "user-1", "anthropic", "claude-opus-4-8");
    expect(k.model).toBe("claude-opus-4-8");
  });

  it("respects a configured TRIAL_RUN_LIMIT", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    process.env.TRIAL_RUN_LIMIT = "2";
    expect((await resolveKey(db(1), "u", "anthropic")).source).toBe("trial");
    expect((await resolveKey(db(2), "u", "anthropic")).source).toBe("exhausted");
  });
});

// Only the named providers have a stored key.
function ownsKeysFor(...providers: string[]) {
  vi.mocked(getConfiguredProviders).mockResolvedValue(providers as never);
  vi.mocked(getDecryptedKey).mockImplementation(async (_db, _user, p) =>
    providers.includes(p) ? `key-for-${p}` : null,
  );
}

describe("resolveRunKeyFor", () => {
  // LET-172. The user picked GPT-4o as their answer engine and had only an
  // Anthropic key saved; the run resolved to Claude Opus 4.8 and stored those
  // answers as this project's monitoring data. A run must never answer as an
  // assistant other than the one selected — the trend line is the product.
  it("refuses to substitute another provider's key for the chosen engine", async () => {
    ownsKeysFor("anthropic");
    const k = await runKeyFor(db(0), "user-1", "openai", "gpt-4o");
    expect(k.source).toBe("mismatch");
    expect(k.apiKey).toBeUndefined();
    expect(k.provider).toBe("openai");
    expect(k.available).toEqual(["anthropic"]);
  });

  it("names the engine and the switch in the mismatch message", async () => {
    ownsKeysFor("anthropic");
    const k = await runKeyFor(db(0), "user-1", "openai", "gpt-4o");
    const message = engineKeyMessage(k);
    expect(message).toContain("GPT-4o");
    expect(message).toContain("OpenAI (ChatGPT)");
    expect(message).toContain("Anthropic (Claude)");
  });

  it("lists every switchable engine when several keys are held", async () => {
    ownsKeysFor("anthropic", "google");
    const k = await runKeyFor(db(0), "user-1", "openai");
    expect(k.available).toEqual(["anthropic", "google"]);
    expect(engineKeyMessage(k)).toContain("Anthropic (Claude) or Google (Gemini)");
  });

  it("uses the chosen engine's own key, with the requested model", async () => {
    ownsKeysFor("openai", "anthropic");
    const k = await runKeyFor(db(0), "user-1", "openai", "gpt-4o");
    expect(k.source).toBe("own");
    expect(k.apiKey).toBe("key-for-openai");
    expect(k.model).toBe("gpt-4o");
  });

  // A trial swaps the MODEL to cap operator cost, which is fine — it's still
  // the assistant the user picked — but `requested` has to keep the difference
  // visible so the UI doesn't promise Opus and deliver Haiku.
  it("takes a trial key only for the chosen provider, and records the swap", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    process.env.TRIAL_ANTHROPIC_MODEL = "claude-haiku-4-5";
    const k = await runKeyFor(db(0), "user-1", "anthropic", "claude-opus-4-8");
    expect(k.source).toBe("trial");
    expect(k.model).toBe("claude-haiku-4-5");
    expect(k.requested).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  });

  it("ignores a trial key belonging to a different provider", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    const k = await runKeyFor(db(0), "user-1", "openai", "gpt-4o");
    expect(k.source).toBe("none");
    expect(k.apiKey).toBeUndefined();
  });

  it("reports exhausted when the chosen engine's trial is spent and no key is held", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    const k = await runKeyFor(db(5), "user-1", "anthropic");
    expect(k.source).toBe("exhausted");
  });

  // Holding a usable key elsewhere is the more actionable fact than a spent
  // allowance: switching engine costs nothing, topping up the trial isn't a
  // thing they can do.
  it("prefers mismatch over exhausted when another key is available", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    ownsKeysFor("openai");
    const k = await runKeyFor(db(5), "user-1", "anthropic");
    expect(k.source).toBe("mismatch");
  });

  it("defaults the model when none is given", async () => {
    ownsKeysFor("openai");
    const k = await runKeyFor(db(0), "user-1", "openai");
    expect(k.model).toBe("gpt-4o");
    expect(k.requested.model).toBe("gpt-4o");
  });
});

// A router is a credential, not an engine. These cases pin the two properties
// that follow from that and are expensive to get wrong: the run is still
// attributed to the engine that answered, and a router only serves a monitored
// run when it measures the same way a direct key would.
describe("resolveRunKeyFor with a router credential", () => {
  it("serves the run through a router that carries the engine's web search", async () => {
    hasRouter("concentrate", ["anthropic"]);
    const k = await runKeyFor(db(0), "user-1", "anthropic", "claude-opus-4-8", {
      webSearch: true,
    });
    expect(k.source).toBe("own");
    expect(k.apiKey).toBe("key-for-concentrate");
    expect(k.route).toEqual({ router: "concentrate", baseUrl: null });
    // The engine is unchanged: this is what keeps one continuous trend line
    // across a switch from a direct key to a gateway.
    expect(k.provider).toBe("anthropic");
    expect(k.model).toBe("claude-opus-4-8");
  });

  it("refuses a grounded run when the router's search passthrough is unconfirmed", async () => {
    hasRouter("concentrate", []);
    const k = await runKeyFor(db(0), "user-1", "anthropic", undefined, { webSearch: true });
    expect(k.source).toBe("unroutable");
    expect(k.apiKey).toBeUndefined();
    expect(engineKeyMessage(k)).toContain("hasn't been confirmed");
  });

  // Same credential, same engine, ungrounded project: nothing is being claimed
  // about the live web, so there is nothing to verify.
  it("allows an ungrounded run on the same unconfirmed router", async () => {
    hasRouter("concentrate", []);
    const k = await runKeyFor(db(0), "user-1", "anthropic", undefined, { webSearch: false });
    expect(k.source).toBe("own");
    expect(k.route?.router).toBe("concentrate");
  });

  // Grounding is confirmed per ENGINE, not per credential. A key that carries
  // Claude's web search says nothing about whether it carries OpenAI's — they
  // are different endpoints on the router, and one can regress without the
  // other. Treating one verified engine as blanket approval is how an
  // unverified engine would slip into a monitored run.
  it("won't lend one engine's confirmed grounding to another", async () => {
    hasRouter("concentrate", ["anthropic"]);
    const k = await runKeyFor(db(0), "user-1", "openai", "gpt-4o", { webSearch: true });
    expect(k.source).toBe("unroutable");
    expect(engineKeyMessage(k)).toContain("hasn't been confirmed");
    // Same key, the engine it WAS confirmed for: allowed.
    const ok = await runKeyFor(db(0), "user-1", "anthropic", undefined, { webSearch: true });
    expect(ok.source).toBe("own");
    expect(ok.route?.router).toBe("concentrate");
  });

  it("prefers the user's own direct key over a router that could serve it", async () => {
    ownsKeysFor("anthropic");
    hasRouter("concentrate", ["anthropic"]);
    const k = await runKeyFor(db(0), "user-1", "anthropic", undefined, { webSearch: true });
    expect(k.apiKey).toBe("key-for-anthropic");
    expect(k.route).toBeUndefined();
  });

  // A router counts as holding a key for every engine it covers. Telling a
  // router user "you have no keys" and offering no switch was the failure this
  // guards: the engines their gateway does cover are exactly the useful advice.
  it("offers the router's own engines as the switch for an engine it can't serve", async () => {
    hasRouter("concentrate", ["anthropic"]);
    const k = await runKeyFor(db(0), "user-1", "google", undefined, { webSearch: true });
    expect(k.source).toBe("mismatch");
    expect(k.available).toEqual(["anthropic", "openai"]);
    expect(engineKeyMessage(k)).toContain("Anthropic (Claude) or OpenAI (ChatGPT)");
  });

  it("takes a router key before falling back to the operator's trial", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    hasRouter("concentrate", ["anthropic"]);
    const k = await runKeyFor(db(0), "user-1", "anthropic", undefined, { webSearch: true });
    expect(k.source).toBe("own");
    expect(k.apiKey).toBe("key-for-concentrate");
  });

  // The router is not the measurement, but it is worth surfacing: a run that
  // changed credential is the first thing to suspect when a series steps.
  it("names the router in the next-run description", async () => {
    hasRouter("concentrate", ["anthropic"]);
    const k = await runKeyFor(db(0), "user-1", "anthropic", "claude-opus-4-8", {
      webSearch: true,
    });
    expect(nextRunMessage(k)).toContain("via Concentrate");
    expect(nextRunMessage(k)).toContain("Claude Opus 4.8");
  });
});

describe("resolveKey with a router credential", () => {
  it("uses a router for utility work when no direct key exists", async () => {
    hasRouter("concentrate");
    const k = await resolveKey(db(0), "user-1", "anthropic");
    expect(k.source).toBe("own");
    expect(k.route?.router).toBe("concentrate");
    expect(k.provider).toBe("anthropic");
  });

  // Suggestion and classification calls never search, so an unverified router
  // is fine here — but the preferred engine still wins over credential type.
  it("keeps the preferred engine when its own key exists", async () => {
    vi.mocked(getDecryptedKey).mockImplementation(async (_db, _user, p) =>
      p === "anthropic" ? "sk-ant-own" : null,
    );
    hasRouter("concentrate");
    const k = await resolveKey(db(0), "user-1", "anthropic");
    expect(k.apiKey).toBe("sk-ant-own");
    expect(k.route).toBeUndefined();
  });

  // The router covers anthropic/openai but not the requested perplexity, so the
  // fallback lands on an engine it can actually reach rather than refusing.
  it("falls back to an engine the router covers", async () => {
    hasRouter("concentrate");
    const k = await resolveKey(db(0), "user-1", "perplexity");
    expect(k.source).toBe("own");
    expect(k.provider).toBe("anthropic");
    expect(k.route?.router).toBe("concentrate");
    expect(k.requested.provider).toBe("perplexity");
  });
});

describe("trial key resolution", () => {
  it("reads the google trial key from TRIAL_GOOGLE_API_KEY, not the openai slot", () => {
    process.env.TRIAL_GOOGLE_API_KEY = "AIzaTrialGoogle";
    process.env.TRIAL_OPENAI_API_KEY = "sk-trial-openai";
    expect(trialKeyFor("google")).toBe("AIzaTrialGoogle");
    expect(trialKeyFor("openai")).toBe("sk-trial-openai");
    expect(trialKeyFor("anthropic")).toBeNull();
  });

  it("falls back to the given model when no google trial model is set", () => {
    expect(trialModelFor("google", "gemini-flash-latest")).toBe("gemini-flash-latest");
    process.env.TRIAL_GOOGLE_MODEL = "gemini-flash-lite-latest";
    expect(trialModelFor("google", "gemini-flash-latest")).toBe("gemini-flash-lite-latest");
  });

  it("counts google when deciding whether any trial is offered", () => {
    expect(trialEnabled()).toBe(false);
    process.env.TRIAL_GOOGLE_API_KEY = "AIzaTrialGoogle";
    expect(trialEnabled()).toBe(true);
  });

  // The list was written out by hand and never gained perplexity, so a
  // perplexity-only deployment reported that it offered no trial at all.
  it("counts perplexity too", () => {
    process.env.TRIAL_PERPLEXITY_API_KEY = "pplx-trial";
    expect(trialEnabled()).toBe(true);
  });

  it("can pick google as the default provider when only its trial key is set", () => {
    process.env.TRIAL_GOOGLE_API_KEY = "AIzaTrialGoogle";
    expect(pickDefaultProvider()).toBe("google");
  });

  it("still prefers anthropic when it has a trial key too", () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    process.env.TRIAL_GOOGLE_API_KEY = "AIzaTrialGoogle";
    expect(pickDefaultProvider()).toBe("anthropic");
  });
});

describe("nextRunMessage", () => {
  // The reported bug: "Each run asks your prompts to Claude Opus 4.8" sat above
  // a list of completed runs labelled Claude Haiku 4.5. Both were true, nothing
  // said why, so the copy read as simply wrong.
  it("names both models when the trial substitutes a cheaper one", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    process.env.TRIAL_ANTHROPIC_MODEL = "claude-haiku-4-5";
    const k = await runKeyFor(db(0), "user-1", "anthropic", "claude-opus-4-8");
    const message = nextRunMessage(k);
    expect(message).toContain("Claude Haiku 4.5");
    expect(message).toContain("Claude Opus 4.8");
    expect(message).toContain("Anthropic (Claude)");
  });

  it("speaks about the next run, not about runs in general", async () => {
    ownsKeysFor("anthropic");
    const k = await runKeyFor(db(0), "user-1", "anthropic", "claude-opus-4-8");
    expect(nextRunMessage(k)).toMatch(/^Your next run/);
    expect(nextRunMessage(k)).not.toMatch(/Each run/);
  });

  it("stays a single clause on an own key, with no trial aside", async () => {
    ownsKeysFor("anthropic");
    const k = await runKeyFor(db(0), "user-1", "anthropic", "claude-opus-4-8");
    const message = nextRunMessage(k);
    expect(message).toContain("Claude Opus 4.8");
    expect(message).not.toContain("Free runs");
  });

  // No TRIAL_*_MODEL configured: the trial runs the model they picked, so
  // there is no substitution to explain.
  it("adds no aside when the trial runs the chosen model anyway", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    const k = await runKeyFor(db(0), "user-1", "anthropic", "claude-opus-4-8");
    expect(k.source).toBe("trial");
    expect(nextRunMessage(k)).not.toContain("Free runs");
  });
});

// A trial user is the likeliest person to want a router — no provider account
// yet, and one signup instead of one per assistant — but a router key ranks
// BELOW the trial in both resolvers, so they never meet one in the ordinary
// course of things. The exhausted message is the one place the choice is in
// front of them, and it has to name it.
describe("the exhausted message offers the router", () => {
  it("names both ways to keep monitoring", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    const k = await runKeyFor(db(5), "user-1", "anthropic", "claude-opus-4-8");
    const message = engineKeyMessage(k);
    expect(k.source).toBe("exhausted");
    expect(message).toContain("Anthropic (Claude) key");
    expect(message).toContain("Concentrate");
    expect(message).toContain("OpenRouter");
  });

  // The engines come from the registry, so the pitch can't outlive the support
  // entry that backs it.
  // No per-engine promise in this line. Routers differ in what they can
  // MEASURE — Concentrate carries both engines' native search, OpenRouter only
  // Claude's — so naming engines here would over-promise for one of them. The
  // settings card states coverage per router, where it can be accurate.
  it("promises no engine it might not be able to measure", async () => {
    process.env.TRIAL_ANTHROPIC_API_KEY = "sk-ant-trial";
    const message = engineKeyMessage(await runKeyFor(db(5), "user-1", "anthropic"));
    expect(message).toContain("router key");
    expect(message).not.toContain("Perplexity");
    expect(message).not.toContain("Gemini");
  });
});

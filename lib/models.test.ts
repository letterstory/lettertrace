import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDERS,
  PROVIDER_LIST,
  GOOGLE_AI_OVERVIEWS_MODEL,
  isProvider,
  defaultModelFor,
  modelLabel,
  analysisModelFor,
  isModelFor,
  resolveEngine,
} from "@/lib/models";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider catalog", () => {
  it("recognizes every provider and rejects unknown ones", () => {
    expect(isProvider("anthropic")).toBe(true);
    expect(isProvider("openai")).toBe(true);
    expect(isProvider("google")).toBe(true);
    expect(isProvider("perplexity")).toBe(true);
    expect(isProvider("gemini")).toBe(false); // "gemini" is a model line, not our provider id
    expect(isProvider("mistral")).toBe(false);
  });

  it("exposes google (Gemini) in the catalog", () => {
    expect(PROVIDERS.google.label).toContain("Gemini");
    expect(PROVIDERS.google.keyPrefix).toBe("AIza");
    expect(PROVIDER_LIST.map((p) => p.id)).toContain("google");
  });

  it("defaults google to its flagship model", () => {
    expect(defaultModelFor("google")).toBe("gemini-pro-latest");
  });

  // The consumer-surface refresh (2026-08): these are what ChatGPT and
  // claude.ai actually serve, offered WITHOUT touching the defaults — a
  // default swap changes the measured surface under every project that never
  // picked a model, and rates are only comparable run-over-run on one surface.
  it("offers the current consumer models without moving the defaults", () => {
    const openaiIds = PROVIDERS.openai.models.map((m) => m.id);
    expect(openaiIds).toContain("gpt-5.6-sol");
    expect(openaiIds).toContain("gpt-5.6-luna");
    expect(defaultModelFor("openai")).toBe("gpt-4o");
    const anthropicIds = PROVIDERS.anthropic.models.map((m) => m.id);
    expect(anthropicIds).toContain("claude-sonnet-5");
    expect(defaultModelFor("anthropic")).toBe("claude-opus-4-8");
  });

  it("offers Google AI Overviews as a distinct engine under google", () => {
    const ids = PROVIDERS.google.models.map((m) => m.id);
    expect(ids).toContain(GOOGLE_AI_OVERVIEWS_MODEL);
    // It must not be the default (the flagship Gemini model is).
    expect(defaultModelFor("google")).not.toBe(GOOGLE_AI_OVERVIEWS_MODEL);
    expect(modelLabel("google", GOOGLE_AI_OVERVIEWS_MODEL)).toBe("Google AI Overviews");
  });

  it("exposes perplexity (Sonar) in the catalog", () => {
    expect(PROVIDERS.perplexity.label).toContain("Sonar");
    expect(PROVIDERS.perplexity.keyPrefix).toBe("pplx-");
    expect(PROVIDER_LIST.map((p) => p.id)).toContain("perplexity");
    expect(defaultModelFor("perplexity")).toBe("sonar-pro");
  });

  // sonar-deep-research runs for minutes on a single question, well past the
  // 300s the run route allows for an ENTIRE run. Listing it would offer a
  // model whose only possible outcome is a timeout mid-run.
  it("keeps sonar-deep-research out of the catalog", () => {
    const ids = PROVIDERS.perplexity.models.map((m) => m.id);
    expect(ids).not.toContain("sonar-deep-research");
    expect(analysisModelFor("perplexity")).not.toBe("sonar-deep-research");
  });

  it("labels known models and passes through unknown ones", () => {
    expect(modelLabel("google", "gemini-flash-latest")).toBe("Gemini Flash");
    expect(modelLabel("google", "gemini-9-imaginary")).toBe("gemini-9-imaginary");
  });

  it("keeps the google catalog on rolling aliases, never pinned versions", () => {
    // Every pinned id this shipped with (gemini-2.5-pro/flash/flash-lite,
    // gemini-2.0-flash, gemini-3-pro-preview) now answers 404 "no longer
    // available to new users" on a fresh key — a pin rots silently and 404s
    // every run for anyone onboarding after the cut-off. Only the -latest
    // aliases and the pseudo-model belong here.
    for (const { id } of PROVIDERS.google.models) {
      if (id === GOOGLE_AI_OVERVIEWS_MODEL) continue;
      expect(id).toMatch(/-latest$/);
    }
    // The cheap classification model has to survive the same rule.
    expect(analysisModelFor("google")).toMatch(/-latest$/);
  });
});

describe("analysisModelFor", () => {
  it("defaults to the cheap model for each provider", () => {
    expect(analysisModelFor("anthropic")).toBe("claude-haiku-4-5");
    expect(analysisModelFor("openai")).toBe("gpt-4o-mini");
    expect(analysisModelFor("google")).toBe("gemini-flash-lite-latest");
  });

  it("never returns the flagship answer models", () => {
    expect(analysisModelFor("anthropic")).not.toBe(defaultModelFor("anthropic"));
    expect(analysisModelFor("openai")).not.toBe(defaultModelFor("openai"));
    expect(analysisModelFor("google")).not.toBe(defaultModelFor("google"));
  });

  it("honors per-provider env overrides", () => {
    vi.stubEnv("ANALYSIS_ANTHROPIC_MODEL", "claude-sonnet-4-6");
    vi.stubEnv("ANALYSIS_OPENAI_MODEL", " gpt-4o ");
    vi.stubEnv("ANALYSIS_GOOGLE_MODEL", "gemini-flash-latest");
    expect(analysisModelFor("anthropic")).toBe("claude-sonnet-4-6");
    expect(analysisModelFor("openai")).toBe("gpt-4o"); // trimmed
    expect(analysisModelFor("google")).toBe("gemini-flash-latest");
  });

  it("ignores blank overrides", () => {
    vi.stubEnv("ANALYSIS_ANTHROPIC_MODEL", "   ");
    expect(analysisModelFor("anthropic")).toBe("claude-haiku-4-5");
  });
});

describe("isModelFor", () => {
  it("accepts each provider's own models and rejects other providers'", () => {
    expect(isModelFor("openai", "gpt-4o")).toBe(true);
    expect(isModelFor("anthropic", "claude-opus-4-8")).toBe(true);
    expect(isModelFor("openai", "claude-opus-4-8")).toBe(false);
    expect(isModelFor("anthropic", "gpt-4o")).toBe(false);
  });

  // The pseudo-model is a real catalog entry under google, so validation has to
  // let it through or the AI Overviews engine becomes unselectable.
  it("accepts the Google AI Overviews pseudo-model", () => {
    expect(isModelFor("google", GOOGLE_AI_OVERVIEWS_MODEL)).toBe(true);
  });

  it("rejects an id that is in no catalog", () => {
    expect(isModelFor("google", "banana")).toBe(false);
  });
});

describe("resolveEngine", () => {
  // The bug: the write paths applied provider and model independently, so a
  // request naming only the provider kept the old model and persisted pairs
  // like openai + claude-opus-4-8 that only failed later, at the provider.
  it("falls back to the provider's default when no model is given", () => {
    for (const model of [undefined, null, "", "   ", 42]) {
      const r = resolveEngine("openai", model);
      expect(r).toEqual({ ok: true, provider: "openai", model: "gpt-4o" });
    }
  });

  it("refuses a model the provider doesn't offer", () => {
    const r = resolveEngine("openai", "claude-opus-4-8");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("OpenAI (ChatGPT)");
      expect(r.message).toContain("claude-opus-4-8");
      // Names what IS available, so a caller doesn't have to guess.
      expect(r.message).toContain("gpt-4o");
    }
  });

  it("refuses an id that is in no catalog at all", () => {
    // modelLabel echoes an unknown id verbatim, so storing this would show
    // "banana" as the selected engine.
    expect(resolveEngine("google", "banana").ok).toBe(false);
  });

  it("passes a valid pair through unchanged, trimming whitespace", () => {
    expect(resolveEngine("anthropic", "  claude-haiku-4-5 ")).toEqual({
      ok: true,
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("accepts every model in the catalog for its own provider", () => {
    for (const info of PROVIDER_LIST) {
      for (const m of info.models) {
        expect(resolveEngine(info.id, m.id)).toEqual({
          ok: true,
          provider: info.id,
          model: m.id,
        });
      }
    }
  });
});

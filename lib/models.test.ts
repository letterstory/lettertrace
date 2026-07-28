import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDERS,
  PROVIDER_LIST,
  GOOGLE_AI_OVERVIEWS_MODEL,
  isProvider,
  defaultModelFor,
  modelLabel,
  analysisModelFor,
} from "@/lib/models";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider catalog", () => {
  it("recognizes all three providers and rejects unknown ones", () => {
    expect(isProvider("anthropic")).toBe(true);
    expect(isProvider("openai")).toBe(true);
    expect(isProvider("google")).toBe(true);
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

  it("offers Google AI Overviews as a distinct engine under google", () => {
    const ids = PROVIDERS.google.models.map((m) => m.id);
    expect(ids).toContain(GOOGLE_AI_OVERVIEWS_MODEL);
    // It must not be the default (the flagship Gemini model is).
    expect(defaultModelFor("google")).not.toBe(GOOGLE_AI_OVERVIEWS_MODEL);
    expect(modelLabel("google", GOOGLE_AI_OVERVIEWS_MODEL)).toBe("Google AI Overviews");
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

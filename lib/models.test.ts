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
    expect(defaultModelFor("google")).toBe("gemini-2.5-pro");
  });

  it("offers Google AI Overviews as a distinct engine under google", () => {
    const ids = PROVIDERS.google.models.map((m) => m.id);
    expect(ids).toContain(GOOGLE_AI_OVERVIEWS_MODEL);
    // It must not be the default (the flagship Gemini model is).
    expect(defaultModelFor("google")).not.toBe(GOOGLE_AI_OVERVIEWS_MODEL);
    expect(modelLabel("google", GOOGLE_AI_OVERVIEWS_MODEL)).toBe("Google AI Overviews");
  });

  it("labels known models and passes through unknown ones", () => {
    expect(modelLabel("google", "gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
    expect(modelLabel("google", "gemini-9-imaginary")).toBe("gemini-9-imaginary");
  });
});

describe("analysisModelFor", () => {
  it("defaults to the cheap model for each provider", () => {
    expect(analysisModelFor("anthropic")).toBe("claude-haiku-4-5");
    expect(analysisModelFor("openai")).toBe("gpt-4o-mini");
    expect(analysisModelFor("google")).toBe("gemini-2.5-flash-lite");
  });

  it("never returns the flagship answer models", () => {
    expect(analysisModelFor("anthropic")).not.toBe(defaultModelFor("anthropic"));
    expect(analysisModelFor("openai")).not.toBe(defaultModelFor("openai"));
    expect(analysisModelFor("google")).not.toBe(defaultModelFor("google"));
  });

  it("honors per-provider env overrides", () => {
    vi.stubEnv("ANALYSIS_ANTHROPIC_MODEL", "claude-sonnet-4-6");
    vi.stubEnv("ANALYSIS_OPENAI_MODEL", " gpt-4o ");
    vi.stubEnv("ANALYSIS_GOOGLE_MODEL", "gemini-2.5-flash");
    expect(analysisModelFor("anthropic")).toBe("claude-sonnet-4-6");
    expect(analysisModelFor("openai")).toBe("gpt-4o"); // trimmed
    expect(analysisModelFor("google")).toBe("gemini-2.5-flash");
  });

  it("ignores blank overrides", () => {
    vi.stubEnv("ANALYSIS_ANTHROPIC_MODEL", "   ");
    expect(analysisModelFor("anthropic")).toBe("claude-haiku-4-5");
  });
});

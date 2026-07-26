import { describe, it, expect } from "vitest";
import {
  PROVIDERS,
  PROVIDER_LIST,
  GOOGLE_AI_OVERVIEWS_MODEL,
  isProvider,
  defaultModelFor,
  modelLabel,
} from "@/lib/models";

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

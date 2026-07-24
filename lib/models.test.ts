import { afterEach, describe, expect, it, vi } from "vitest";
import { analysisModelFor, defaultModelFor, isProvider } from "@/lib/models";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("analysisModelFor", () => {
  it("defaults to the cheap model for each provider", () => {
    expect(analysisModelFor("anthropic")).toBe("claude-haiku-4-5");
    expect(analysisModelFor("openai")).toBe("gpt-4o-mini");
  });

  it("never returns the flagship answer models", () => {
    expect(analysisModelFor("anthropic")).not.toBe(defaultModelFor("anthropic"));
    expect(analysisModelFor("openai")).not.toBe(defaultModelFor("openai"));
  });

  it("honors per-provider env overrides", () => {
    vi.stubEnv("ANALYSIS_ANTHROPIC_MODEL", "claude-sonnet-4-6");
    vi.stubEnv("ANALYSIS_OPENAI_MODEL", " gpt-4o ");
    expect(analysisModelFor("anthropic")).toBe("claude-sonnet-4-6");
    expect(analysisModelFor("openai")).toBe("gpt-4o"); // trimmed
  });

  it("ignores blank overrides", () => {
    vi.stubEnv("ANALYSIS_ANTHROPIC_MODEL", "   ");
    expect(analysisModelFor("anthropic")).toBe("claude-haiku-4-5");
  });
});

describe("isProvider", () => {
  it("accepts only known providers", () => {
    expect(isProvider("anthropic")).toBe(true);
    expect(isProvider("openai")).toBe(true);
    expect(isProvider("gemini")).toBe(false);
  });
});

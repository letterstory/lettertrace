import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDecryptedKey } from "@/lib/data";
import { resolveKey } from "@/lib/trial";

vi.mock("@/lib/data", () => ({ getDecryptedKey: vi.fn() }));

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

const ENV = { ...process.env };
beforeEach(() => {
  vi.mocked(getDecryptedKey).mockReset().mockResolvedValue(null);
  delete process.env.TRIAL_ANTHROPIC_API_KEY;
  delete process.env.TRIAL_OPENAI_API_KEY;
  process.env.TRIAL_RUN_LIMIT = "5";
});
afterEach(() => {
  process.env = { ...ENV };
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

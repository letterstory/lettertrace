import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// trial.ts pulls in lib/data (getDecryptedKey), which calls React's cache() at
// module load, unavailable in the node test env. Stub it so the import graph
// stays clean; resolveKey's own use of it is mocked per-test below.
vi.mock("@/lib/data", () => ({ getDecryptedKey: vi.fn() }));

import { getDecryptedKey } from "@/lib/data";
import {
  resolveKey,
  trialKeyFor,
  trialModelFor,
  trialEnabled,
  pickDefaultProvider,
} from "@/lib/trial";

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

describe("trial key resolution", () => {
  it("reads the google trial key from TRIAL_GOOGLE_API_KEY, not the openai slot", () => {
    process.env.TRIAL_GOOGLE_API_KEY = "AIzaTrialGoogle";
    process.env.TRIAL_OPENAI_API_KEY = "sk-trial-openai";
    expect(trialKeyFor("google")).toBe("AIzaTrialGoogle");
    expect(trialKeyFor("openai")).toBe("sk-trial-openai");
    expect(trialKeyFor("anthropic")).toBeNull();
  });

  it("falls back to the given model when no google trial model is set", () => {
    expect(trialModelFor("google", "gemini-2.5-flash")).toBe("gemini-2.5-flash");
    process.env.TRIAL_GOOGLE_MODEL = "gemini-2.5-flash-lite";
    expect(trialModelFor("google", "gemini-2.5-flash")).toBe("gemini-2.5-flash-lite");
  });

  it("counts google when deciding whether any trial is offered", () => {
    expect(trialEnabled()).toBe(false);
    process.env.TRIAL_GOOGLE_API_KEY = "AIzaTrialGoogle";
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

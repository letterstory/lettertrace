import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// trial.ts pulls in lib/data (getDecryptedKey), which calls React's cache() at
// module load, unavailable in the node test env. These tests exercise only the
// env-driven helpers, so stub data out to keep the import graph clean.
vi.mock("@/lib/data", () => ({ getDecryptedKey: vi.fn() }));

import {
  trialKeyFor,
  trialModelFor,
  trialEnabled,
  pickDefaultProvider,
} from "@/lib/trial";

// The trial helpers read shared (operator) keys straight from the environment,
// so drive them by mutating process.env and restore it afterward.
const TRIAL_VARS = [
  "TRIAL_ANTHROPIC_API_KEY",
  "TRIAL_OPENAI_API_KEY",
  "TRIAL_GOOGLE_API_KEY",
  "TRIAL_ANTHROPIC_MODEL",
  "TRIAL_OPENAI_MODEL",
  "TRIAL_GOOGLE_MODEL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const v of TRIAL_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of TRIAL_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
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

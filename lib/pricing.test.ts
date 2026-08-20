import { describe, it, expect, afterEach } from "vitest";
import {
  spendMicros,
  tokenRateUsd,
  trialSpendLimitMicros,
  formatUsd,
  searchRateUsd,
} from "./pricing";

const ENV_KEYS = [
  "TRIAL_SPEND_LIMIT_USD",
  "RATE_SEARCH_USD",
  "RATE_ANTHROPIC_USD_PER_MTOK",
  "RATE_OPENAI_USD_PER_MTOK",
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("token rates", () => {
  it("prices each Anthropic model at its own rate", () => {
    expect(tokenRateUsd("anthropic", "claude-haiku-4-5")).toBe(5);
    expect(tokenRateUsd("anthropic", "claude-sonnet-4-6")).toBe(15);
    expect(tokenRateUsd("anthropic", "claude-opus-4-8")).toBe(25);
  });

  it("falls back to the dearest rate for a model it doesn't know", () => {
    // The whole point of the fallback: a model added to the catalog without a
    // rate must not be free. Cheaper-than-real would be a hole; dearer is only
    // an early stop.
    const known = tokenRateUsd("anthropic", "claude-opus-4-8");
    expect(tokenRateUsd("anthropic", "claude-something-new")).toBeGreaterThanOrEqual(known);
  });

  it("lets a deployment correct a rate without a release", () => {
    process.env.RATE_ANTHROPIC_USD_PER_MTOK = "2";
    expect(tokenRateUsd("anthropic", "claude-opus-4-8")).toBe(2);
  });

  it("ignores a nonsense override rather than pricing at NaN", () => {
    process.env.RATE_OPENAI_USD_PER_MTOK = "not-a-number";
    expect(tokenRateUsd("openai", "gpt-4o")).toBeGreaterThan(0);
  });
});

describe("spend", () => {
  it("charges tokens at the model's rate", () => {
    // 1M tokens on a $5/MTok model = $5 = 5_000_000 micros.
    expect(spendMicros({ provider: "anthropic", model: "claude-haiku-4-5", tokens: 1_000_000 })).toBe(
      5_000_000,
    );
  });

  it("charges a grounded answer for its search allowance", () => {
    const plain = spendMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      tokens: 1000,
      webSearch: false,
    });
    const grounded = spendMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      tokens: 1000,
      webSearch: true,
    });
    // The interesting property is not the exact figure but the ORDER: on a cheap
    // model the searches dominate, and a cost model that ignored them would
    // under-count a grounded run by more than an order of magnitude.
    expect(grounded).toBeGreaterThan(plain * 10);
  });

  it("never returns a negative or fractional charge", () => {
    expect(spendMicros({ provider: "openai", model: "gpt-4o", tokens: -5 })).toBe(0);
    expect(spendMicros({ provider: "openai", model: "gpt-4o", tokens: NaN })).toBe(0);
    const tiny = spendMicros({ provider: "anthropic", model: "claude-haiku-4-5", tokens: 1 });
    expect(Number.isInteger(tiny)).toBe(true);
  });

  it("rounds a real charge up, so a long run of tiny calls can't be free", () => {
    // Round-to-nearest would floor thousands of sub-micro calls to zero, which
    // is precisely the accounting hole this whole module exists to close.
    const one = spendMicros({ provider: "anthropic", model: "claude-haiku-4-5", tokens: 1 });
    expect(one).toBeGreaterThan(0);
  });

  it("respects a search-rate override", () => {
    process.env.RATE_SEARCH_USD = "0";
    expect(searchRateUsd()).toBe(0);
    const grounded = spendMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      tokens: 1000,
      webSearch: true,
    });
    const plain = spendMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      tokens: 1000,
      webSearch: false,
    });
    expect(grounded).toBe(plain);
  });
});

describe("the ceiling", () => {
  it("defaults to $15", () => {
    // Raised from $5 in the visibility overhaul, alongside the run allowance.
    expect(trialSpendLimitMicros()).toBe(15_000_000);
  });

  it("is configurable", () => {
    process.env.TRIAL_SPEND_LIMIT_USD = "25";
    expect(trialSpendLimitMicros()).toBe(25_000_000);
  });

  it("treats zero as a real setting, not as unset", () => {
    // "0" is how an operator turns the free tier off entirely. Reading it as
    // missing would hand out the $15 default to exactly the deployment that
    // asked for none.
    process.env.TRIAL_SPEND_LIMIT_USD = "0";
    expect(trialSpendLimitMicros()).toBe(0);
  });

  it("falls back to the default on a malformed value", () => {
    process.env.TRIAL_SPEND_LIMIT_USD = "five dollars";
    expect(trialSpendLimitMicros()).toBe(15_000_000);
  });

  it("formats as money for the refusal message", () => {
    expect(formatUsd(5_000_000)).toBe("$5.00");
    expect(formatUsd(1_500_000)).toBe("$1.50");
  });
});

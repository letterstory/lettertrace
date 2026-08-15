// ==================================================================
// What a call costs, in money.
//
// This exists for one job: putting a dollar ceiling on what a single free-tier
// user can spend of the OPERATOR's keys. It is not billing, it is not an
// invoice, and nothing user-facing quotes it. That framing decides every
// judgement call below — when in doubt, over-estimate. Charging too much stops
// a runaway account slightly early; charging too little is how a trial user
// runs up a bill nobody sees until it arrives.
//
// Two deliberate over-estimates:
//
//   1. Every token is billed at the model's OUTPUT rate. The adapters report a
//      single combined figure (`tokens`), and splitting input from output would
//      mean touching all four of them. Output is the dearer half, so pricing
//      everything at it is the safe direction, and it costs nothing to be
//      exactly right later — one field, one function.
//
//   2. A grounded answer is charged for the full search allowance it asked for
//      (WEB_SEARCH_MAX_USES), not the searches it actually ran. We ask for a
//      ceiling and can't see the actual count without parsing every provider's
//      tool blocks. On a cheap model the searches, not the tokens, are the
//      bill — so this is the number that matters most and the one most worth
//      replacing with a real count later.
//
// PROVENANCE — read before trusting a row:
//   Anthropic's rates are the published API prices.
//   The other three are deliberately-high placeholders, NOT quoted rates: they
//   sit at or above the dearest model each vendor offers, so the cap can only
//   trigger early. Replace them with real per-model figures when you want the
//   ceiling to sit where the spend actually is. Same for SEARCH_USD, which is a
//   conservative stand-in rather than a verified per-search price.
//
// Everything here is overridable by env so a deployment can correct a rate
// without a release.
// ==================================================================

import type { Provider } from "@/lib/types";

/** USD per million tokens, charged at each model's output rate (see above). */
const RATES: Record<Provider, { models: Record<string, number>; fallback: number }> = {
  // Published Anthropic API pricing.
  anthropic: {
    models: {
      "claude-opus-4-8": 25,
      "claude-sonnet-5": 10,
      "claude-sonnet-4-6": 15,
      "claude-haiku-4-5": 5,
    },
    fallback: 25,
  },
  // The 5.6 rows are published output rates (Sol $30/Mtok; Luna quoted $1.20–6,
  // charged at the higher figure per the err-high rule). Anything else falls
  // back to the deliberately-high placeholder — see PROVENANCE above.
  openai: {
    models: {
      "gpt-5.6-sol": 30,
      "gpt-5.6-luna": 6,
    },
    fallback: 30,
  },
  google: { models: {}, fallback: 30 },
  perplexity: { models: {}, fallback: 30 },
  // xAI prices in tiers — a lower rate under 200k tokens in the request, a
  // higher one at or above it. These are the HIGH tier, per the err-high rule
  // at the top of this file: the cheaper tier would let a long-context run
  // overshoot the cap it was supposed to stop.
  xai: {
    models: {
      "grok-4.6": 12,
      "grok-4.3": 5,
    },
    fallback: 12,
  },
  // Published output rates are $0.87 (Pro) and $0.28 (Flash) per Mtok — an
  // order of magnitude under everything else here. Rounded UP to whole dollars,
  // and the fallback sits well above both, because DeepSeek has announced a
  // significant price rise with no figure attached: under-charging silently is
  // the failure this table exists to prevent.
  deepseek: {
    models: {
      "deepseek-v4-pro": 1,
      "deepseek-v4-flash": 1,
    },
    fallback: 5,
  },
  // Published output rate is $4.25/Mtok, rounded up. Fallback padded well above
  // it since this is a brand-new product (public preview since April 2026) with
  // no pricing track record yet to trust past its current published figure.
  meta: {
    models: {
      "muse-spark-1.2": 5,
    },
    fallback: 8,
  },
};

/**
 * USD per web search. A stand-in, not a quoted price: searches are billed per
 * call by every provider that offers them, and this sits high enough that a
 * search-heavy run is never under-counted.
 */
const DEFAULT_SEARCH_USD = 0.01;

/** The search allowance a grounded ask requests; kept in step with lib/llm. */
const SEARCH_USES_PER_ANSWER = 5;

const MICROS_PER_USD = 1_000_000;

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** USD per million tokens for an engine, erring high on anything unrecognised. */
export function tokenRateUsd(provider: Provider, model: string): number {
  const table = RATES[provider];
  if (!table) return 30;
  const override = envNumber(`RATE_${provider.toUpperCase()}_USD_PER_MTOK`, NaN);
  if (Number.isFinite(override)) return override;
  return table.models[model] ?? table.fallback;
}

/** USD per search. */
export function searchRateUsd(): number {
  return envNumber("RATE_SEARCH_USD", DEFAULT_SEARCH_USD);
}

export interface SpendInput {
  provider: Provider;
  model: string;
  /** Combined prompt + completion tokens, as the adapters report them. */
  tokens: number;
  /** Whether this call asked the provider to search. */
  webSearch?: boolean;
}

/**
 * What a single call cost, in micro-dollars (integer, so it can be summed in
 * the database without float drift). Rounded up: a call always costs something,
 * and a long run of "0" answers is exactly the hole this closes.
 */
export function spendMicros(input: SpendInput): number {
  const tokens = Number.isFinite(input.tokens) && input.tokens > 0 ? input.tokens : 0;
  const tokenUsd = (tokens / 1_000_000) * tokenRateUsd(input.provider, input.model);
  const searchUsd = input.webSearch ? SEARCH_USES_PER_ANSWER * searchRateUsd() : 0;
  const micros = Math.ceil((tokenUsd + searchUsd) * MICROS_PER_USD);
  return micros > 0 ? micros : 0;
}

const DEFAULT_TRIAL_SPEND_LIMIT_USD = 5;

/**
 * The per-user ceiling on operator-funded spend, in micro-dollars
 * (env: TRIAL_SPEND_LIMIT_USD). Zero disables the free tier outright, which is
 * a legitimate configuration — it is not the same as "unset".
 */
export function trialSpendLimitMicros(): number {
  const raw = process.env.TRIAL_SPEND_LIMIT_USD;
  const parsed = Number(raw);
  const usd =
    raw !== undefined && raw !== "" && Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : DEFAULT_TRIAL_SPEND_LIMIT_USD;
  return Math.round(usd * MICROS_PER_USD);
}

/** For messages: micro-dollars as a plain dollar figure. */
export function formatUsd(micros: number): string {
  return `$${(micros / MICROS_PER_USD).toFixed(2)}`;
}

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Project, Provider } from "@/lib/types";
import { getDecryptedKey, getConfiguredProviders } from "@/lib/data";
import { defaultModelFor, modelLabel, PROVIDERS } from "@/lib/models";

// ------------------------------------------------------------------
// Free-trial layer. When the operator configures a shared (trial) key, users
// who haven't added their own key get a CONFIGURABLE number of free monitoring
// runs on it (default 5). After that, data collection stops until they bring
// their own key. With no trial keys set, the app is bring-your-own-key from
// the start (the default). Token usage is still recorded per user so the
// operator can watch spend, but the gate is runs.
// ------------------------------------------------------------------

const DEFAULT_TRIAL_RUN_LIMIT = 5;

/** The configurable per-user free-run allowance (env: TRIAL_RUN_LIMIT). */
export function trialRunLimit(): number {
  const raw = Number(process.env.TRIAL_RUN_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TRIAL_RUN_LIMIT;
}

const TRIAL_KEY_ENV: Record<Provider, string> = {
  anthropic: "TRIAL_ANTHROPIC_API_KEY",
  openai: "TRIAL_OPENAI_API_KEY",
  google: "TRIAL_GOOGLE_API_KEY",
  perplexity: "TRIAL_PERPLEXITY_API_KEY",
};

const TRIAL_MODEL_ENV: Record<Provider, string> = {
  anthropic: "TRIAL_ANTHROPIC_MODEL",
  openai: "TRIAL_OPENAI_MODEL",
  google: "TRIAL_GOOGLE_MODEL",
  perplexity: "TRIAL_PERPLEXITY_MODEL",
};

// Derived from the env map above rather than written out again, so a provider
// added to the catalog can't be silently skipped here — omitting perplexity
// from this list is what made a perplexity-only deployment report no trial.
const PROVIDER_IDS = Object.keys(TRIAL_KEY_ENV) as Provider[];

/** The operator's shared key for a provider, if configured. */
export function trialKeyFor(provider: Provider): string | null {
  const v = process.env[TRIAL_KEY_ENV[provider]];
  return v && v.trim() ? v.trim() : null;
}

/** Optional cheaper model to use during the trial (caps operator cost). */
export function trialModelFor(provider: Provider, fallback: string): string {
  const v = process.env[TRIAL_MODEL_ENV[provider]];
  return v && v.trim() ? v.trim() : fallback;
}

/** True if a trial is offered for at least one provider. */
export function trialEnabled(): boolean {
  return PROVIDER_IDS.some((p) => trialKeyFor(p));
}

/** How many free trial runs this user has already consumed. */
export async function getTrialRunsUsed(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  const { data } = await supabase
    .from("profiles")
    .select("trial_runs_used")
    .eq("id", userId)
    .maybeSingle();
  return Number((data as { trial_runs_used?: number } | null)?.trial_runs_used ?? 0);
}

export type KeySource = "own" | "trial" | "none" | "exhausted" | "mismatch";

export interface ResolvedKey {
  source: KeySource;
  apiKey?: string;
  provider: Provider;
  model: string; // model to run with (own -> project model; trial -> trial override)
  /** What was ASKED for, before any substitution. `provider`/`model` above are
   *  what will actually be called, and the two differ whenever a trial forces a
   *  cheaper model or a non-run task falls back to another provider's key. Every
   *  surface that tells a user which engine they're on needs both. */
  requested: { provider: Provider; model: string };
  remaining?: number; // free runs left (for 'trial'/'exhausted')
  limit?: number; // the free-run allowance
  /** For 'mismatch': providers the user DOES hold a key for, so the message can
   *  name the one-click fix instead of just refusing. */
  available?: Provider[];
}

/** The provider new projects default to: one we can actually serve (has a trial key), else anthropic. */
export function pickDefaultProvider(): Provider {
  if (trialKeyFor("anthropic")) return "anthropic";
  if (trialKeyFor("openai")) return "openai";
  if (trialKeyFor("google")) return "google";
  if (trialKeyFor("perplexity")) return "perplexity";
  return "anthropic";
}

const PROVIDER_ORDER: Record<Provider, Provider[]> = {
  anthropic: ["anthropic", "openai", "google", "perplexity"],
  openai: ["openai", "anthropic", "google", "perplexity"],
  google: ["google", "anthropic", "openai", "perplexity"],
  perplexity: ["perplexity", "anthropic", "openai", "google"],
};

/**
 * Resolve a key for AUXILIARY work — prompt/competitor/topic suggestion — by
 * preferring `preferred` and then falling back to any other provider the user
 * can pay for. Own key beats trial; trial requires free runs remaining. This is
 * what lets users never pick a provider themselves.
 *
 * Cross-provider fallback is safe HERE and only here: the output is a list of
 * suggestions the user reviews, not a measurement that gets stored and charted.
 * Monitoring runs must use resolveRunKey instead — see the note there.
 *
 * - 'own'       the user's own key (unlimited by us)
 * - 'trial'     the operator's shared key, free runs still remaining
 * - 'exhausted' had trial access but used up their free runs -> must add own key
 * - 'none'      no own key and no trial configured -> must add own key
 */
export async function resolveKey(
  supabase: SupabaseClient,
  userId: string,
  preferred: Provider,
  preferredModel?: string,
): Promise<ResolvedKey> {
  const order = PROVIDER_ORDER[preferred];
  const modelFor = (p: Provider) =>
    p === preferred && preferredModel ? preferredModel : defaultModelFor(p);
  const requested = { provider: preferred, model: modelFor(preferred) };

  // 1. The user's own key (unlimited by us).
  for (const p of order) {
    const own = await getDecryptedKey(supabase, userId, p);
    if (own) return { source: "own", apiKey: own, provider: p, model: modelFor(p), requested };
  }

  // 2. A trial key, if free runs remain.
  const limit = trialRunLimit();
  const used = await getTrialRunsUsed(supabase, userId);
  let trialConfigured = false;
  for (const p of order) {
    const tk = trialKeyFor(p);
    if (!tk) continue;
    trialConfigured = true;
    if (used < limit) {
      return {
        source: "trial",
        apiKey: tk,
        provider: p,
        model: trialModelFor(p, modelFor(p)),
        requested,
        remaining: Math.max(0, limit - used),
        limit,
      };
    }
  }

  if (trialConfigured) {
    return { source: "exhausted", provider: preferred, model: requested.model, requested, remaining: 0, limit };
  }
  return { source: "none", provider: preferred, model: requested.model, requested };
}

/**
 * Resolve the key for a MONITORING RUN, for the chosen engine and nothing else.
 *
 * Deliberately strict where resolveKey is forgiving. A run's answers are stored
 * with a provider/model and charted as "how this assistant talks about your
 * brand", so quietly asking a different assistant because that's the key we
 * happened to find doesn't degrade gracefully — it fabricates the measurement.
 * A user with GPT-4o selected and only an Anthropic key saved got a Claude run
 * labelled as their monitoring data, and every later point on the trend line
 * was a different engine than the one before it.
 *
 * So: only the requested provider's key is acceptable. When it's missing we say
 * which engine is selected, which key is missing, and — via 'mismatch' — which
 * engines they could switch to instead.
 */
export async function resolveRunKeyFor(
  supabase: SupabaseClient,
  userId: string,
  provider: Provider,
  model?: string,
): Promise<ResolvedKey> {
  const requested = { provider, model: model || defaultModelFor(provider) };
  const base = { provider, model: requested.model, requested };

  const own = await getDecryptedKey(supabase, userId, provider);
  if (own) return { ...base, source: "own", apiKey: own };

  // The operator's shared key, but only for the engine actually chosen.
  const limit = trialRunLimit();
  const trialKey = trialKeyFor(provider);
  if (trialKey) {
    const used = await getTrialRunsUsed(supabase, userId);
    if (used < limit) {
      return {
        ...base,
        source: "trial",
        apiKey: trialKey,
        // Still a substitution, but within the chosen provider: the answers
        // remain that assistant's, and `requested` carries the difference.
        model: trialModelFor(provider, requested.model),
        remaining: Math.max(0, limit - used),
        limit,
      };
    }
  }

  // No key for the selected engine. Holding a key for a DIFFERENT one is the
  // more useful thing to report than "no key": the fix is a dropdown, not a
  // signup. This is the case that used to fall through and run on Claude.
  const others = (await getConfiguredProviders(supabase, userId)).filter(
    (p) => p !== provider,
  );
  if (others.length > 0) return { ...base, source: "mismatch", available: others };

  if (trialKey) return { ...base, source: "exhausted", remaining: 0, limit };
  return { ...base, source: "none" };
}

/** Resolve the key for a project's monitoring run (delegates to resolveRunKeyFor). */
export async function resolveRunKey(
  supabase: SupabaseClient,
  userId: string,
  project: Project,
): Promise<ResolvedKey> {
  return resolveRunKeyFor(supabase, userId, project.default_provider, project.default_model);
}

/**
 * The one phrasing of "your selected engine has no key" — shared so the
 * dashboard, the onboarding flow and the REST API can't drift into describing
 * the same state three different ways. Handles 'mismatch', 'none' and
 * 'exhausted'; the usable sources ('own'/'trial') have nothing to explain.
 */
export function engineKeyMessage(key: ResolvedKey): string {
  const engine = modelLabel(key.requested.provider, key.requested.model);
  const providerLabel = PROVIDERS[key.requested.provider].label;

  if (key.source === "exhausted") {
    return `You've used all ${key.limit ?? 0} free runs on ${engine}. Add your own ${providerLabel} key in Settings to keep monitoring.`;
  }
  if (key.source === "mismatch") {
    const have = (key.available ?? []).map((p) => PROVIDERS[p].label);
    const alternatives =
      have.length === 1 ? have[0] : `${have.slice(0, -1).join(", ")} or ${have[have.length - 1]}`;
    return `Your answer engine is set to ${engine}, but no ${providerLabel} key is saved. Add one in Settings, or switch your answer engine to ${alternatives} — you already have a key for that.`;
  }
  return `Your answer engine is set to ${engine}. Add a ${providerLabel} key in Settings to run.`;
}

/** Add consumed tokens to the caller's trial tally (atomic, self-scoped rpc).
 * Recording only; the free tier is gated on runs, not tokens. */
export async function recordTrialUsage(
  supabase: SupabaseClient,
  tokens: number,
): Promise<void> {
  if (!tokens || tokens <= 0) return;
  await supabase.rpc("increment_trial_tokens", { amount: Math.round(tokens) });
}

/**
 * Atomically take one free run if the caller is still under the allowance.
 * Called BEFORE a trial run executes: a single UPDATE gates and counts in one
 * step, so parallel requests can't all pass the check while the counter lags.
 * Returns false when the allowance is spent (treat as exhausted).
 */
export async function consumeTrialRun(supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase.rpc("consume_trial_run", {
    max_runs: trialRunLimit(),
  });
  if (error) return false;
  return data === true;
}

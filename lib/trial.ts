import type { SupabaseClient } from "@supabase/supabase-js";
import type { Project, Provider } from "@/lib/types";
import { getDecryptedKey } from "@/lib/data";
import { defaultModelFor } from "@/lib/models";

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
  return Boolean(
    trialKeyFor("anthropic") || trialKeyFor("openai") || trialKeyFor("google"),
  );
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

export type KeySource = "own" | "trial" | "none" | "exhausted";

export interface ResolvedKey {
  source: KeySource;
  apiKey?: string;
  provider: Provider;
  model: string; // model to run with (own -> project model; trial -> trial override)
  remaining?: number; // free runs left (for 'trial'/'exhausted')
  limit?: number; // the free-run allowance
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
 * Resolve the best available key for a task, preferring `preferred` then falling
 * back to the other provider. Own key beats trial; trial requires free runs
 * remaining. This is what lets users never pick a provider themselves.
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

  // 1. The user's own key (unlimited by us).
  for (const p of order) {
    const own = await getDecryptedKey(supabase, userId, p);
    if (own) return { source: "own", apiKey: own, provider: p, model: modelFor(p) };
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
        remaining: Math.max(0, limit - used),
        limit,
      };
    }
  }

  if (trialConfigured) {
    return { source: "exhausted", provider: preferred, model: modelFor(preferred), remaining: 0, limit };
  }
  return { source: "none", provider: preferred, model: modelFor(preferred) };
}

/** Resolve the key for a project's monitoring run (delegates to resolveKey). */
export async function resolveRunKey(
  supabase: SupabaseClient,
  userId: string,
  project: Project,
): Promise<ResolvedKey> {
  return resolveKey(supabase, userId, project.default_provider, project.default_model);
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

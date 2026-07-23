import type { SupabaseClient } from "@supabase/supabase-js";
import type { Project, Provider } from "@/lib/types";
import { getDecryptedKey } from "@/lib/data";
import { defaultModelFor } from "@/lib/models";

// ------------------------------------------------------------------
// Free-trial layer. When the operator configures a shared (trial) key, users
// who haven't added their own key may run against it until they cross a
// CONFIGURABLE token threshold, after which they're prompted to bring their own
// key to scale. With no trial keys set, the app is bring-your-own-key from the
// start (the default).
// ------------------------------------------------------------------

const DEFAULT_TRIAL_LIMIT = 100_000;

/** The configurable per-user trial token allowance (env: TRIAL_TOKEN_LIMIT). */
export function trialTokenLimit(): number {
  const raw = Number(process.env.TRIAL_TOKEN_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TRIAL_LIMIT;
}

/** The operator's shared key for a provider, if configured. */
export function trialKeyFor(provider: Provider): string | null {
  const v =
    provider === "anthropic"
      ? process.env.TRIAL_ANTHROPIC_API_KEY
      : process.env.TRIAL_OPENAI_API_KEY;
  return v && v.trim() ? v.trim() : null;
}

/** Optional cheaper model to use during the trial (caps operator cost). */
export function trialModelFor(provider: Provider, fallback: string): string {
  const v =
    provider === "anthropic"
      ? process.env.TRIAL_ANTHROPIC_MODEL
      : process.env.TRIAL_OPENAI_MODEL;
  return v && v.trim() ? v.trim() : fallback;
}

/** True if a trial is offered for at least one provider. */
export function trialEnabled(): boolean {
  return Boolean(trialKeyFor("anthropic") || trialKeyFor("openai"));
}

/** How many trial tokens this user has already consumed. */
export async function getTrialUsage(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  const { data } = await supabase
    .from("profiles")
    .select("trial_tokens_used")
    .eq("id", userId)
    .maybeSingle();
  return Number((data as { trial_tokens_used?: number } | null)?.trial_tokens_used ?? 0);
}

export type KeySource = "own" | "trial" | "none" | "exhausted";

export interface ResolvedKey {
  source: KeySource;
  apiKey?: string;
  provider: Provider;
  model: string; // model to run with (own -> project model; trial -> trial override)
  remaining?: number; // trial tokens left (for 'trial'/'exhausted')
  limit?: number;
}

/** The provider new projects default to: one we can actually serve (has a trial key), else anthropic. */
export function pickDefaultProvider(): Provider {
  if (trialKeyFor("anthropic")) return "anthropic";
  if (trialKeyFor("openai")) return "openai";
  return "anthropic";
}

const PROVIDER_ORDER: Record<Provider, Provider[]> = {
  anthropic: ["anthropic", "openai"],
  openai: ["openai", "anthropic"],
};

/**
 * Resolve the best available key for a task, preferring `preferred` then falling
 * back to the other provider. Own key beats trial; trial requires being under the
 * token threshold. This is what lets users never pick a provider themselves.
 * - 'own'       the user's own key (unlimited by us)
 * - 'trial'     the operator's shared key, still under the token threshold
 * - 'exhausted' had trial access but crossed the threshold -> must add own key
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

  // 2. A trial key, if still under the token threshold.
  const limit = trialTokenLimit();
  const used = await getTrialUsage(supabase, userId);
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

/** Add consumed tokens to the caller's trial tally (atomic, self-scoped rpc). */
export async function recordTrialUsage(
  supabase: SupabaseClient,
  tokens: number,
): Promise<void> {
  if (!tokens || tokens <= 0) return;
  await supabase.rpc("increment_trial_tokens", { amount: Math.round(tokens) });
}

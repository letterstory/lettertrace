import type { SupabaseClient } from "@supabase/supabase-js";
import type { Project, Provider, RouteInfo } from "@/lib/types";
import {
  getDecryptedKey,
  getDecryptedKeys,
  getConfiguredProviders,
  getDecryptedRouterKeys,
  type DecryptedRouterKey,
} from "@/lib/data";
import {
  defaultModelFor,
  modelLabel,
  providerCanMeasure,
  providerRefusalMessage,
  PROVIDER_LIST,
  PROVIDERS,
} from "@/lib/models";
import {
  ROUTERS,
  ROUTER_LIST,
  routerCanMeasure,
  routerProviders,
  routerRefusalMessage,
  routerSupport,
} from "@/lib/routers";
import { article } from "@/lib/utils";
import { formatUsd, trialSpendLimitMicros } from "@/lib/pricing";

// ------------------------------------------------------------------
// Credential resolution + the free-trial layer.
//
// Three ways a call can be paid for, in this order of preference:
//   1. the user's own provider key      (unlimited by us)
//   2. an LLM router credential        (unlimited by us; one key, many engines)
//   3. the operator's shared trial key (metered: a few free runs, then stop)
//
// A router key resolves to source 'own' deliberately, not to a source of its
// own. `source` answers one question — who pays, and is it metered — and on that
// question a router key is indistinguishable from a direct key: it is the user's
// credential, we don't meter it, and no free run is consumed. Every gate that
// reads `source` therefore keeps working unchanged. WHICH credential carried the
// call travels separately, in `route`, because that is a different question with
// a different consumer (it is recorded on the run so a step change in a trend
// line can be attributed to a credential switch).
//
// With no trial keys set, the app is bring-your-own-key from the start (the
// default). Token usage is still recorded per user so the operator can watch
// spend, but the gate is runs.
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
  xai: "TRIAL_XAI_API_KEY",
  deepseek: "TRIAL_DEEPSEEK_API_KEY",
  meta: "TRIAL_META_API_KEY",
};

const TRIAL_MODEL_ENV: Record<Provider, string> = {
  anthropic: "TRIAL_ANTHROPIC_MODEL",
  openai: "TRIAL_OPENAI_MODEL",
  google: "TRIAL_GOOGLE_MODEL",
  perplexity: "TRIAL_PERPLEXITY_MODEL",
  xai: "TRIAL_XAI_MODEL",
  deepseek: "TRIAL_DEEPSEEK_MODEL",
  meta: "TRIAL_META_MODEL",
};

// Catalog order, from the catalog itself: this is also the fallback/default walk order.
const PROVIDER_IDS: Provider[] = PROVIDER_LIST.map((p) => p.id);

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
  return (await getTrialUsage(supabase, userId)).runs;
}

/** What the free tier has cost this user so far, in micro-dollars. */
export async function getTrialSpendMicros(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  return (await getTrialUsage(supabase, userId)).spendMicros;
}

export interface TrialUsage {
  runs: number;
  spendMicros: number;
}

/**
 * Both meters in one read. They are always wanted together — the free tier is
 * gated on whichever runs out first — and two round trips per resolve is two
 * more than this needs.
 *
 * A missing profile row reads as zero usage rather than as an error: it is the
 * state a brand-new account is in for the moment before the signup trigger
 * lands, and refusing to serve them would be a worse bug than a free run.
 */
export async function getTrialUsage(
  supabase: SupabaseClient,
  userId: string,
): Promise<TrialUsage> {
  const { data } = await supabase
    .from("profiles")
    .select("trial_runs_used, trial_spend_micros")
    .eq("id", userId)
    .maybeSingle();
  const row = data as { trial_runs_used?: number; trial_spend_micros?: number } | null;
  return {
    runs: Number(row?.trial_runs_used ?? 0),
    spendMicros: Number(row?.trial_spend_micros ?? 0),
  };
}

/**
 * Is this user still inside BOTH free-tier ceilings?
 *
 * Runs bound how often they can start something; spend bounds what those
 * somethings may cost. Neither implies the other: five runs of a thousand
 * prompts is a large bill under a small run count, and a script hammering
 * /suggest spends without touching the run counter at all.
 */
function withinTrial(usage: TrialUsage, runLimit: number, capMicros: number): boolean {
  return usage.runs < runLimit && usage.spendMicros < capMicros;
}

export type KeySource =
  | "own"
  | "trial"
  | "none"
  | "exhausted"
  | "mismatch"
  // The only credential that could pay for this engine is a router that can't
  // measure it comparably — a distinct state from "no key", because the fix is
  // different (switch engine, turn off web search, or add a direct key) and
  // because running it anyway would produce data that looks fine and isn't.
  | "unroutable"
  // The engine itself can't ground: this project wants live-web answers and the
  // provider's API has no search at all. Distinct from 'unroutable' because no
  // credential can fix it — the fix is the project's grounding setting or a
  // different engine, and saying "your router can't measure this" to someone
  // holding a direct key would be nonsense. See providerCanMeasure.
  | "ungrounded";

export interface ResolvedKey {
  source: KeySource;
  apiKey?: string;
  provider: Provider;
  model: string; // model to run with (own -> project model; trial -> trial override)
  /** Set when `apiKey` is a router credential: which gateway to call through.
   *  Null/absent means a direct provider call, as it always was. */
  route?: RouteInfo | null;
  /** For 'unroutable': the pre-composed explanation, which needs the router and
   *  the reason it refused — neither of which is recoverable from the fields
   *  above once the resolver has returned. */
  refusal?: string;
  /** What was ASKED for, before any substitution. `provider`/`model` above are
   *  what will actually be called, and the two differ whenever a trial forces a
   *  cheaper model or a non-run task falls back to another provider's key. Every
   *  surface that tells a user which engine they're on needs both. */
  requested: { provider: Provider; model: string };
  remaining?: number; // free runs left (for 'trial'/'exhausted')
  limit?: number; // the free-run allowance
  /** For 'exhausted': WHICH ceiling was hit. The two need different words —
   *  "you've used all 5 free runs" is simply false for someone stopped by the
   *  spend cap on their second run, and sends them looking for a bug. */
  exhaustedBy?: "runs" | "spend";
  /** For 'trial'/'exhausted': operator-funded spend so far, and the ceiling,
   *  both in micro-dollars. */
  spentMicros?: number;
  capMicros?: number;
  /** For 'mismatch': providers the user DOES hold a key for, so the message can
   *  name the one-click fix instead of just refusing. */
  available?: Provider[];
}

/** The provider new projects default to: the first in catalog order with a trial key, else anthropic. */
export function pickDefaultProvider(): Provider {
  return PROVIDER_IDS.find((p) => trialKeyFor(p)) ?? "anthropic";
}

/** Preference order for AUXILIARY work: the requested provider, then the rest in catalog order. */
function providerOrder(preferred: Provider): Provider[] {
  return [preferred, ...PROVIDER_IDS.filter((p) => p !== preferred)];
}

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
  const order = providerOrder(preferred);
  const modelFor = (p: Provider) =>
    p === preferred && preferredModel ? preferredModel : defaultModelFor(p);
  const requested = { provider: preferred, model: modelFor(preferred) };

  // 1. Anything the user pays for, closest engine first: for each provider in
  //    preference order, their own key and then a router that reaches it.
  //
  //    Provider order outranks credential type on purpose. These are suggestion
  //    and classification calls, so the engine's suitability matters more than
  //    which credential settles the bill, and a user holding a direct Claude key
  //    should get Claude rather than Claude-via-a-gateway. Web search never
  //    applies to utility work, so any router that reaches the engine will do.
  const [ownKeys, routerKeys] = await Promise.all([
    getDecryptedKeys(supabase, userId),
    getDecryptedRouterKeys(supabase, userId),
  ]);
  for (const p of order) {
    const own = ownKeys[p];
    if (own) return { source: "own", apiKey: own, provider: p, model: modelFor(p), requested };

    const viaRouter = routerKeys.find((rk) => routerSupport(rk.router, p) !== null);
    if (viaRouter) {
      return {
        source: "own",
        apiKey: viaRouter.apiKey,
        route: routeOf(viaRouter),
        provider: p,
        model: modelFor(p),
        requested,
      };
    }
  }

  // 2. A trial key, if free runs AND free spend remain.
  const limit = trialRunLimit();
  const cap = trialSpendLimitMicros();
  const usage = await getTrialUsage(supabase, userId);
  let trialConfigured = false;
  for (const p of order) {
    const tk = trialKeyFor(p);
    if (!tk) continue;
    trialConfigured = true;
    if (withinTrial(usage, limit, cap)) {
      return {
        source: "trial",
        apiKey: tk,
        provider: p,
        model: trialModelFor(p, modelFor(p)),
        requested,
        remaining: Math.max(0, limit - usage.runs),
        limit,
        spentMicros: usage.spendMicros,
        capMicros: cap,
      };
    }
  }

  if (trialConfigured) {
    return {
      source: "exhausted",
      provider: preferred,
      model: requested.model,
      requested,
      remaining: Math.max(0, limit - usage.runs),
      limit,
      exhaustedBy: usage.spendMicros >= cap ? "spend" : "runs",
      spentMicros: usage.spendMicros,
      capMicros: cap,
    };
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
  model: string | undefined,
  // Required, not defaulted, so the compiler names every call site if this ever
  // grows another caller. Getting it wrong is not a cosmetic bug: a router that
  // hasn't been shown to pass native search through must not serve a project
  // that asks for grounded answers, and only the caller knows whether it does.
  opts: { webSearch: boolean },
): Promise<ResolvedKey> {
  const requested = { provider, model: model || defaultModelFor(provider) };
  const base = { provider, model: requested.model, requested };

  // Before any credential question: can this engine even produce the kind of
  // answer the project asked for? A provider whose API cannot browse must not
  // serve a grounded project on ANY credential, so this outranks every branch
  // below — finding a perfectly good key first and refusing afterwards would
  // just be a slower way to reach the same answer, and an easy one to forget in
  // one of the paths. See providerCanMeasure.
  if (!providerCanMeasure(provider, { webSearch: opts.webSearch })) {
    return { ...base, source: "ungrounded", refusal: providerRefusalMessage(provider) };
  }

  const own = await getDecryptedKey(supabase, userId, provider);
  if (own) return { ...base, source: "own", apiKey: own };

  // A router credential, but only one that can measure this engine the same way
  // a direct key would — see routerCanMeasure. A router that reaches the engine
  // without carrying its web search is refused below rather than used here.
  const routerKeys = await getDecryptedRouterKeys(supabase, userId);
  const usable = routerKeys.find((rk) =>
    routerCanMeasure(rk.router, provider, {
      webSearch: opts.webSearch,
      verified: rk.searchVerified,
    }),
  );
  if (usable) {
    return { ...base, source: "own", apiKey: usable.apiKey, route: routeOf(usable) };
  }

  // The operator's shared key, but only for the engine actually chosen.
  const limit = trialRunLimit();
  const cap = trialSpendLimitMicros();
  const trialKey = trialKeyFor(provider);
  let trialUsage: TrialUsage | null = null;
  if (trialKey) {
    trialUsage = await getTrialUsage(supabase, userId);
    if (withinTrial(trialUsage, limit, cap)) {
      return {
        ...base,
        source: "trial",
        apiKey: trialKey,
        // Still a substitution, but within the chosen provider: the answers
        // remain that assistant's, and `requested` carries the difference.
        model: trialModelFor(provider, requested.model),
        remaining: Math.max(0, limit - trialUsage.runs),
        limit,
        spentMicros: trialUsage.spendMicros,
        capMicros: cap,
      };
    }
  }

  // A router the user holds could reach this engine but not measure it. Reported
  // as its own state, and before the mismatch/none branches: "no key" would be
  // false (they have a credential that reaches it) and "switch engines" alone
  // would omit the two other fixes — turning web search off, or re-checking the
  // key. routerRefusalMessage picks whichever of the three applies.
  const blocked = routerKeys.find((rk) => routerSupport(rk.router, provider) !== null);
  if (blocked) {
    return {
      ...base,
      source: "unroutable",
      refusal: routerRefusalMessage(blocked.router, provider, {
        webSearch: opts.webSearch,
        verified: blocked.searchVerified,
      }),
    };
  }

  // No key for the selected engine. Holding a key for a DIFFERENT one is the
  // more useful thing to report than "no key": the fix is a dropdown, not a
  // signup. This is the case that used to fall through and run on Claude.
  //
  // A router counts as holding keys for every engine it can serve: to a user who
  // set up one router key and picked Gemini, "you have no keys" is simply wrong,
  // and the engines their router does cover are exactly the switch worth
  // offering. Deduped, since two routers can cover the same engine.
  const direct = await getConfiguredProviders(supabase, userId);
  const viaRouters = routerKeys.flatMap((rk) => routerProviders(rk.router));
  const others = Array.from(new Set([...direct, ...viaRouters])).filter((p) => p !== provider);
  if (others.length > 0) return { ...base, source: "mismatch", available: others };

  if (trialKey) {
    const usage = trialUsage ?? (await getTrialUsage(supabase, userId));
    return {
      ...base,
      source: "exhausted",
      remaining: Math.max(0, limit - usage.runs),
      limit,
      exhaustedBy: usage.spendMicros >= cap ? "spend" : "runs",
      spentMicros: usage.spendMicros,
      capMicros: cap,
    };
  }
  return { ...base, source: "none" };
}

/** Resolve the key for a project's monitoring run (delegates to resolveRunKeyFor).
 *  The project is what knows whether its answers are supposed to be grounded. */
export async function resolveRunKey(
  supabase: SupabaseClient,
  userId: string,
  project: Project,
): Promise<ResolvedKey> {
  return resolveRunKeyFor(supabase, userId, project.default_provider, project.default_model, {
    webSearch: project.use_web_search,
  });
}

/**
 * The routers on offer, by name, read from the registry.
 *
 * Deliberately no per-engine promise here. Routers differ in what they can
 * actually MEASURE — one carries both engines' native search, another only
 * Claude's — so a single line naming engines would over-promise for one of them
 * the moment a second router exists. The settings card states coverage per
 * router, where it can be accurate.
 */
function routerNames(): string {
  const names = ROUTER_LIST.map((r) => r.label);
  return names.length <= 1
    ? names[0] ?? "a gateway"
    : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** The RouteInfo for a stored router credential. */
function routeOf(key: DecryptedRouterKey): RouteInfo {
  return { router: key.router, baseUrl: key.baseUrl };
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

  // Composed by the resolver, which is the only place that still knows which
  // router refused and why. 'ungrounded' carries its refusal the same way — the
  // reason differs (the engine can't search at all, rather than the credential
  // not carrying its search) but both arrive pre-written and naming the fix.
  if ((key.source === "unroutable" || key.source === "ungrounded") && key.refusal) {
    return key.refusal;
  }

  if (key.source === "exhausted") {
    // The spend ceiling and the run ceiling are different refusals. Someone
    // stopped on their second run by a large project needs to know it was the
    // size of the run, not a count they haven't reached — otherwise the message
    // contradicts the run counter sitting next to it.
    if (key.exhaustedBy === "spend") {
      return (
        `This account has used its ${formatUsd(key.capMicros ?? 0)} of free ${engine} usage. ` +
        `Add your own ${providerLabel} key in Settings to keep monitoring, ` +
        `or one router key (${routerNames()}) that covers several assistants at once.`
      );
    }
    // Name the router here and only here. A router key ranks BELOW the trial in
    // both resolvers — a working grounded credential beats refusing — so a trial
    // user never encounters one in the ordinary course of things, and they are
    // the likeliest person to want one: no provider account yet, and a router is
    // a single signup rather than one per assistant. This is the moment the
    // choice is actually in front of them.
    return (
      `You've used all ${key.limit ?? 0} free runs on ${engine}. ` +
      `Add your own ${providerLabel} key in Settings to keep monitoring, ` +
      `or one router key (${routerNames()}) that covers several assistants at once.`
    );
  }
  if (key.source === "mismatch") {
    const have = (key.available ?? []).map((p) => PROVIDERS[p].label);
    const alternatives =
      have.length === 1 ? have[0] : `${have.slice(0, -1).join(", ")} or ${have[have.length - 1]}`;
    return `Your answer engine is set to ${engine}, but no ${providerLabel} key is saved. Add one in Settings, or switch your answer engine to ${alternatives}, which you already have a key for.`;
  }
  return `Your answer engine is set to ${engine}. Add ${article(providerLabel)} ${providerLabel} key in Settings to run.`;
}

/**
 * What the NEXT run will ask, for a key that can actually run.
 *
 * Phrased about the next run rather than about runs in general, which is the
 * bug this replaces: "Each run asks your prompts to Claude Opus 4.8" sat
 * directly above a list of completed runs that said Claude Haiku 4.5, so it
 * read as a contradiction. Both were true — the heading described the next run
 * on the user's own key, the rows recorded earlier runs on the trial's cheaper
 * model — but nothing said so, leaving the user to work out the rule themselves.
 *
 * When the trial substitutes a model, name both: the one that will run and the
 * one their own key would use. That difference is the whole explanation, and
 * `requested` exists to carry it.
 */
export function nextRunMessage(key: ResolvedKey): string {
  const willRun = modelLabel(key.provider, key.model);
  const chosen = modelLabel(key.requested.provider, key.requested.model);
  const providerLabel = PROVIDERS[key.requested.provider].label;

  if (key.source === "trial" && key.model !== key.requested.model) {
    return `Your next run asks your active prompts to ${willRun}. Free runs use a cheaper model on our keys. Add your own ${providerLabel} key to run ${chosen}.`;
  }
  // Name the router when one is carrying the run. It is the same engine either
  // way — which is why runs.provider doesn't change — but a user who set up a
  // gateway should be able to see that it is the thing being billed, and a run
  // recorded "via Concentrate" is what later explains a step in the trend line.
  if (key.route) {
    const routerLabel = ROUTERS[key.route.router].label;
    return `Your next run asks your active prompts to ${willRun} via ${routerLabel} and records where your brand shows up.`;
  }
  return `Your next run asks your active prompts to ${willRun} and records where your brand shows up.`;
}

/** Add consumed tokens to the caller's trial tally (atomic, self-scoped rpc).
 * Recording only — the enforceable meter is spend, below. */
export async function recordTrialUsage(
  supabase: SupabaseClient,
  tokens: number,
): Promise<void> {
  if (!tokens || tokens <= 0) return;
  await supabase.rpc("increment_trial_tokens", { amount: Math.round(tokens) });
}

/**
 * How much this run may spend, given the key that will pay for it.
 *
 * Null for anything but a trial: on the user's own credential (direct or via a
 * router) there is nothing for us to ration, and cutting their run short would
 * be us rationing their money.
 */
export function runBudgetMicros(key: ResolvedKey): number | null {
  if (key.source !== "trial") return null;
  return Math.max(0, (key.capMicros ?? 0) - (key.spentMicros ?? 0));
}

/**
 * Add operator-funded spend to the caller's tally (atomic, self-scoped rpc).
 *
 * Called AFTER the money is spent, unlike consumeTrialRun which gates before.
 * That ordering is forced: the cost isn't known until the provider answers. The
 * consequence is that the LAST call of a run can carry the total past the cap —
 * bounded overshoot, by design. Enforcing per-call in advance would mean
 * refusing on an estimate, and the estimate is the thing we're least sure of.
 */
export async function recordTrialSpend(
  supabase: SupabaseClient,
  micros: number,
): Promise<void> {
  if (!micros || micros <= 0) return;
  await supabase.rpc("increment_trial_spend", { amount: Math.round(micros) });
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

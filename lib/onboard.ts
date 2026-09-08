import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfiguredProviders, getRouterKeysPublic } from "@/lib/data";
import {
  executeRun,
  prepareRun,
  resumeRun,
  settleAbandonedRun,
  type ExecuteRunParams,
  type RunContext,
  type RunResult,
} from "@/lib/engine";
import {
  consumeTrialRun,
  consumeTrialRunFor,
  engineKeyMessage,
  getTrialUsage,
  pickDefaultProvider,
  recordTrialSpend,
  recordTrialSpendFor,
  recordTrialUsage,
  recordTrialUsageFor,
  resolveKey,
  resolveRunKey,
  resolveRunKeyFor,
  runBudgetMicros,
  trialCoveredProviders,
  trialRunLimit,
  type KeySource,
  type ResolvedKey,
} from "@/lib/trial";
import { spendMicros, trialSpendLimitMicros } from "@/lib/pricing";
import { coveredProviders } from "@/lib/routers";
import { defaultModelFor } from "@/lib/models";
import { fireAndForget } from "@/lib/notify";
import { recordOpsError } from "@/lib/ops";
import { generateApiKey, hashApiKey, keyHint } from "@/lib/crypto";
import { scrapeDomain, type ScrapeReader } from "@/lib/scrape";
import { suggestFromSite, humanError } from "@/lib/llm";
import { normalizeCompetitorList, type CompetitorInput } from "@/lib/competitors";
import type { Project, Provider, Schedule } from "@/lib/types";

// ------------------------------------------------------------------
// Onboarding: from a URL to a monitored brand, on the free trial.
//
// The dashboard wizard (/api/onboarding/suggest + /complete) and the API's
// one-shot POST /api/v1/onboard do the same work — read the site, suggest what
// to ask, save the organization, run the first sweep — and they must spend the
// free trial the same way: one free run per engine the sweep launches, taken
// atomically before the engine is asked, exactly as the Run button does. This
// module is that shared work, so the two surfaces can't drift on what a free
// run costs or when the trial hands over to the account's own key.
//
// "Hands over" is the whole trial design and nothing here changes it: every
// engine's credential is resolved through resolveRunKeyFor, where the owner's
// own provider or router key always beats the trial. An onboarded organization
// runs on the operator's shared key only until its owner brings a key, and then
// on theirs — no transfer step, no flag to flip.
// ------------------------------------------------------------------

// ---------- the trial meter --------------------------------------------------

/**
 * The three trial meters, behind one interface.
 *
 * The dashboard consumes the trial through auth.uid()-scoped RPCs on the
 * user's own session; the API and the scheduler through the *_for variants on
 * the service-role client, addressed by user id. Same meters, two ways to
 * reach them — the sweep below shouldn't know which.
 */
export interface TrialMeter {
  /** Atomically take one free run; false once the allowance is spent. */
  consume(): Promise<boolean>;
  recordUsage(tokens: number): Promise<void>;
  recordSpend(micros: number): Promise<void>;
}

/** The signed-in user's own meters (RLS client, self-scoped RPCs). */
export function sessionTrialMeter(supabase: SupabaseClient): TrialMeter {
  return {
    consume: () => consumeTrialRun(supabase),
    recordUsage: (tokens) => recordTrialUsage(supabase, tokens),
    recordSpend: (micros) => recordTrialSpend(supabase, micros),
  };
}

/** A named user's meters, for the service-role client (API, cron). */
export function serviceTrialMeter(supabase: SupabaseClient, userId: string): TrialMeter {
  return {
    consume: () => consumeTrialRunFor(supabase, userId),
    recordUsage: (tokens) => recordTrialUsageFor(supabase, userId, tokens),
    recordSpend: (micros) => recordTrialSpendFor(supabase, userId, micros),
  };
}

// ---------- where the allowance stands ---------------------------------------

export interface TrialSnapshot {
  used: number;
  limit: number;
  remaining: number;
  spendMicros: number;
  capMicros: number;
  /** Under both ceilings, so a trial-funded run could still be granted. */
  active: boolean;
}

export async function trialSnapshot(
  supabase: SupabaseClient,
  userId: string,
): Promise<TrialSnapshot> {
  const usage = await getTrialUsage(supabase, userId);
  const limit = trialRunLimit();
  const capMicros = trialSpendLimitMicros();
  return {
    used: usage.runs,
    limit,
    remaining: Math.max(0, limit - usage.runs),
    spendMicros: usage.spendMicros,
    capMicros,
    active: usage.runs < limit && usage.spendMicros < capMicros,
  };
}

// ---------- which engine a new organization starts on ------------------------

export interface EngineChoice {
  provider: Provider;
  model: string;
  /** Every engine the owner's OWN credentials can run grounded. */
  runnable: Provider[];
}

/**
 * Start the project on an engine this user can actually run. Runs never
 * substitute another provider's key, so defaulting purely on the operator's
 * trial config would hand a BYOK user a project whose first monitor can't
 * execute — with a perfectly good key sitting in Settings. Their own key wins
 * over the trial; the env default applies only when they have none.
 *
 * A router key counts here exactly as a direct key does. New projects are
 * created grounded (use_web_search defaults on), so coverage is asked for the
 * grounded case.
 */
export async function pickProjectEngine(
  supabase: SupabaseClient,
  userId: string,
): Promise<EngineChoice> {
  const [providers, routerKeys] = await Promise.all([
    getConfiguredProviders(supabase, userId),
    getRouterKeysPublic(supabase, userId),
  ]);
  const runnable = coveredProviders({
    direct: providers,
    routers: routerKeys.map((k) => ({ router: k.router, searchVerified: k.search_verified ?? [] })),
    webSearch: true,
  });
  const envDefault = pickDefaultProvider();
  const provider =
    runnable.length === 0 || runnable.includes(envDefault) ? envDefault : runnable[0];
  return { provider, model: defaultModelFor(provider), runnable };
}

// ---------- what gets saved --------------------------------------------------

export interface TopicInput {
  name: string;
  prompts: string[];
}

export interface SavedCounts {
  topics: number;
  prompts: number;
  competitors: number;
}

/**
 * Persist competitors, then topics and their prompts. Competitors go first on
 * purpose: executeRun reads them to detect rival mentions, so seeding them
 * after the first run would leave that run's answers scored against the brand
 * alone and no share of voice to show.
 *
 * A competitor insert failure is not fatal — the project and its topics are
 * already real, and the user can add competitors from the Competitors page.
 */
export async function persistOnboarding(
  supabase: SupabaseClient,
  project: Pick<Project, "id">,
  input: { topics: TopicInput[]; competitors: CompetitorInput[]; promptSource?: "ai" | "manual" },
): Promise<SavedCounts> {
  const saved: SavedCounts = { topics: 0, prompts: 0, competitors: 0 };

  if (input.competitors.length > 0) {
    const { error } = await supabase.from("competitors").insert(
      input.competitors.map((c) => ({
        project_id: project.id,
        name: c.name,
        aliases: c.aliases,
        domain: c.domain,
      })),
    );
    if (error) console.error("[onboarding] competitor insert failed:", error.message);
    else saved.competitors = input.competitors.length;
  }

  for (const topic of input.topics) {
    const { data: topicRow } = await supabase
      .from("topics")
      .insert({ project_id: project.id, name: topic.name, description: null })
      .select("id")
      .single();
    if (!topicRow) continue;
    saved.topics += 1;
    const rows = topic.prompts.map((text) => ({
      project_id: project.id,
      topic_id: (topicRow as { id: string }).id,
      text,
      source: input.promptSource ?? ("ai" as const),
      is_active: true,
    }));
    if (rows.length) {
      const { error } = await supabase.from("prompts").insert(rows);
      if (!error) saved.prompts += rows.length;
    }
  }
  return saved;
}

// ---------- the first sweep --------------------------------------------------

export interface SweepRun {
  provider: Provider;
  model: string;
  runId: string;
  status: "running" | "completed" | "failed";
  /** Who paid: the owner's own credential, or a free run off the allowance. */
  keySource: "own" | "trial";
  /** Which gateway carried it, if any. */
  route: string | null;
}

export type SweepOutcome =
  | { ran: true; runs: SweepRun[] }
  /** Nothing could pay for any engine. `needsKey` is the resolver's word for
   *  why — 'mismatch' means they hold a key, just not for this project's
   *  engine, so the fix is a dropdown rather than a signup. */
  | { ran: false; needsKey: Exclude<KeySource, "own" | "trial">; keyMessage: string }
  /** Every engine that could start failed to. */
  | { ran: false; error: string };

/**
 * The first measurement is a SWEEP: one run per engine the account can fund —
 * the owner's own coverage, plus the trial's while the allowance lasts — in
 * parallel, so the wall clock stays roughly one run. Probing every engine on
 * the first run maximizes the chance of finding a mention at all, which is the
 * moment the product proves itself.
 *
 * Each trial-funded engine atomically consumes a free run BEFORE executing,
 * sequentially, so the sweep stops being granted runs at exactly the engine
 * where the allowance ran out. A consumed run counts even if it later fails —
 * the same deal as the Run button, which is the point.
 *
 * `background` returns as soon as every run row exists; the answers finish
 * after the caller has responded (a sweep takes minutes) and the trial is
 * metered at the end of each run, inside the background chain.
 */
export async function firstSweep(opts: {
  supabase: SupabaseClient;
  /** The OWNER: whose keys pay, whose trial is consumed. */
  userId: string;
  project: Project;
  /** From pickProjectEngine — the engines the owner's own keys cover. */
  runnable: Provider[];
  meter: TrialMeter;
  context: RunContext;
  background?: boolean;
}): Promise<SweepOutcome> {
  const { supabase, userId, project, meter } = opts;

  const trial = await trialSnapshot(supabase, userId);
  const sweep = Array.from(
    new Set([...opts.runnable, ...(trial.active ? trialCoveredProviders(true) : [])]),
  );
  // The project's own engine leads: its run is the one the response points at.
  sweep.sort((a, b) =>
    a === project.default_provider ? -1 : b === project.default_provider ? 1 : 0,
  );

  const keys: ResolvedKey[] = [];
  for (const p of sweep) {
    const k = await resolveRunKeyFor(supabase, userId, p, defaultModelFor(p), {
      webSearch: true,
    });
    if ((k.source === "own" || k.source === "trial") && k.apiKey) keys.push(k);
  }

  if (keys.length === 0) {
    const key = await resolveRunKey(supabase, userId, project);
    return {
      ran: false,
      needsKey: key.source === "own" || key.source === "trial" ? "none" : key.source,
      keyMessage: engineKeyMessage(key),
    };
  }

  const funded: ResolvedKey[] = [];
  for (const k of keys) {
    if (k.source === "trial" && !(await meter.consume())) continue;
    funded.push(k);
  }
  if (funded.length === 0) {
    const key = await resolveRunKey(supabase, userId, project);
    return {
      ran: false,
      needsKey: "exhausted",
      keyMessage: engineKeyMessage({ ...key, source: "exhausted", limit: trial.limit }),
    };
  }

  // Trial-funded runs share the remaining spend budget rather than each
  // claiming all of it — the recorded overshoot past the cap is otherwise
  // multiplied by however many runs launched from the same snapshot.
  const trialRuns = funded.filter((k) => k.source === "trial").length;

  const settled = await Promise.allSettled(
    funded.map(async (k): Promise<SweepRun> => {
      const budget = runBudgetMicros(k);
      const params: ExecuteRunParams = {
        supabase,
        project,
        provider: k.provider,
        model: k.model,
        apiKey: k.apiKey!,
        route: k.route,
        budgetMicros: budget === null ? null : Math.floor(budget / Math.max(trialRuns, 1)),
        context: opts.context,
      };
      const meterRun = async (result: RunResult) => {
        if (k.source !== "trial") return;
        await meter.recordUsage(result.tokensUsed);
        await meter.recordSpend(result.spendMicros);
      };
      const summary = (runId: string, status: SweepRun["status"]): SweepRun => ({
        provider: k.provider,
        model: k.model,
        runId,
        status,
        keySource: k.source as "own" | "trial",
        route: k.route?.router ?? null,
      });

      if (opts.background) {
        const prepared = await prepareRun(params);
        fireAndForget(
          resumeRun(prepared, params)
            .then(meterRun)
            .catch(async (err) => {
              recordOpsError("onboard.background-run", err, { run_id: prepared.runId });
              await settleAbandonedRun(
                supabase,
                prepared.runId,
                `The run stopped unexpectedly: ${err instanceof Error ? err.message : "unknown error"}`,
              ).catch(() => {});
            }),
        );
        return summary(prepared.runId, "running");
      }

      const result = await executeRun(params);
      await meterRun(result);
      return summary(result.runId, result.status);
    }),
  );

  const runs = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  if (runs.length === 0) {
    const firstFailure = settled.find(
      (s): s is PromiseRejectedResult => s.status === "rejected",
    );
    return { ran: false, error: humanError(firstFailure?.reason) };
  }
  return { ran: true, runs };
}

// ---------- the brand behind a URL -------------------------------------------

const GENERIC_TITLE_WORDS = new Set([
  "home",
  "homepage",
  "welcome",
  "official site",
  "official website",
  "website",
]);

/** "https://www.acme.com/pricing" -> "acme.com". Null when unparseable. */
export function hostOfUrl(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/**
 * A brand name when the caller didn't send one: the page title's brand
 * segment when there is one, else the host's label. Deliberately modest —
 * the caller (a person, or the system that knows the company) should send the
 * name, and the model's description is what actually explains the company.
 */
export function brandNameFrom(opts: {
  brandName?: string | null;
  title?: string | null;
  host: string;
}): string {
  const given = opts.brandName?.trim();
  if (given) return given;

  const label = opts.host.split(".")[0] ?? opts.host;
  const fromHost = label ? label.charAt(0).toUpperCase() + label.slice(1) : opts.host;

  const segments = (opts.title ?? "")
    .split(/\s+[|–—:\-·]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 40 && !GENERIC_TITLE_WORDS.has(s.toLowerCase()));
  if (segments.length === 0) return fromHost;
  // Prefer the segment that names the host ("Acme" for acme.com), else the
  // shortest — titles put the brand in the short part and the pitch in the
  // long one.
  const named = segments.find((s) => s.toLowerCase().replace(/\s+/g, "").includes(label));
  return named ?? segments.reduce((a, b) => (b.length < a.length ? b : a));
}

// ---------- the one-shot flow ------------------------------------------------

export class OnboardError extends Error {
  constructor(
    public code: "invalid",
    message: string,
  ) {
    super(message);
  }
}

export interface OnboardInput {
  url: string;
  brandName?: string | null;
  name?: string | null;
  description?: string | null;
  brandAliases?: string[];
  /** Further domains the brand owns (phantom sites). The URL's host leads. */
  extraDomains?: string[];
  /** Sent topics skip the suggestion step entirely: the caller knows what to
   *  ask. Absent, the site is read and the model proposes them. */
  topics?: TopicInput[] | null;
  competitors?: unknown;
  /** API onboarding defaults to "off": programmatic callers orchestrate their
   *  own cadence. The dashboard wizard starts daily. */
  schedule?: Schedule;
  /** Run the first sweep (default true). */
  run?: boolean;
  /** Return once the run rows exist (default true for the API). */
  background?: boolean;
}

export interface SiteRead {
  host: string;
  url: string | null;
  title: string | null;
  reader: ScrapeReader | null;
  scraped: boolean;
  error?: string;
}

export interface SuggestionSummary {
  description: string;
  topics: number;
  competitors: number;
  keySource: "own" | "trial";
  tokens: number;
}

export interface OnboardOutcome {
  project: Project;
  site: SiteRead;
  suggestion: SuggestionSummary | null;
  /** Why no suggestion was made: 'no_key' | 'trial_exhausted' | 'ai_failed'
   *  | 'topics_given'. */
  suggestionSkipped?: string;
  saved: SavedCounts;
  topics: TopicInput[];
  competitors: CompetitorInput[];
  /** Null when no run was asked for, or there was nothing to ask. */
  sweep: SweepOutcome | null;
  sweepSkipped?: string;
  trial: TrialSnapshot;
}

/**
 * Onboard a URL into `userId`'s account: read the site (Firecrawl when
 * configured), suggest topics + prompts + competitors, create the organization,
 * save everything, and launch the first sweep on whatever can pay for it —
 * the owner's keys first, the free trial while it lasts.
 *
 * The suggestion call is metered against the trial's spend ceiling when it
 * runs on the operator's key (no free RUN is consumed for it — same rule as
 * the dashboard's /suggest). The sweep consumes one free run per trial-funded
 * engine, exactly as the Run button does.
 */
export async function onboardFromUrl(opts: {
  supabase: SupabaseClient;
  userId: string;
  meter: TrialMeter;
  input: OnboardInput;
  context: RunContext;
}): Promise<OnboardOutcome> {
  const { supabase, userId, meter, input } = opts;

  const host = hostOfUrl(input.url);
  if (!host) throw new OnboardError("invalid", "That doesn't look like a valid URL.");

  // 1. Read the site. A failed read is not fatal: the model can work from the
  //    brand name and description, and the caller sees `site.error`.
  const scrape = await scrapeDomain(input.url);
  const site: SiteRead = {
    host,
    url: scrape.url ?? null,
    title: scrape.title || null,
    reader: scrape.reader ?? null,
    scraped: scrape.ok && !!scrape.text,
    ...(scrape.ok ? {} : { error: scrape.error }),
  };

  const brand_name = brandNameFrom({ brandName: input.brandName, title: site.title, host });
  const brand_aliases = (input.brandAliases ?? []).map((a) => a.trim()).filter(Boolean);
  const name = input.name?.trim() || brand_name;

  // 2. Suggest, unless the caller brought topics.
  let topics: TopicInput[] = (input.topics ?? [])
    .map((t) => ({
      name: (t.name ?? "").trim(),
      prompts: (t.prompts ?? []).map((p) => String(p).trim()).filter(Boolean),
    }))
    .filter((t) => t.name && t.prompts.length > 0);
  let competitorsRaw: unknown = input.competitors;
  let description = input.description?.trim() || null;
  let suggestion: SuggestionSummary | null = null;
  let suggestionSkipped: string | undefined;

  if (topics.length > 0) {
    suggestionSkipped = "topics_given";
  } else {
    const key = await resolveKey(supabase, userId, pickDefaultProvider());
    if (!key.apiKey || (key.source !== "own" && key.source !== "trial")) {
      suggestionSkipped = key.source === "exhausted" ? "trial_exhausted" : "no_key";
    } else {
      try {
        const suggested = await suggestFromSite({
          provider: key.provider,
          model: key.model,
          apiKey: key.apiKey,
          route: key.route,
          brandName: brand_name,
          siteText: site.scraped ? (scrape.text ?? "") : "",
          description,
        });
        if (key.source === "trial") {
          await meter.recordUsage(suggested.tokens);
          await meter.recordSpend(
            spendMicros({ provider: key.provider, model: key.model, tokens: suggested.tokens }),
          );
        }
        topics = suggested.topics
          .map((t) => ({ name: t.name.trim(), prompts: t.prompts.map((p) => p.trim()).filter(Boolean) }))
          .filter((t) => t.name && t.prompts.length > 0);
        if (competitorsRaw === undefined || competitorsRaw === null) {
          competitorsRaw = suggested.competitors;
        }
        if (!description && suggested.description) description = suggested.description;
        suggestion = {
          description: suggested.description,
          topics: topics.length,
          competitors: suggested.competitors.length,
          keySource: key.source,
          tokens: suggested.tokens,
        };
      } catch (e) {
        suggestionSkipped = `ai_failed: ${humanError(e)}`;
      }
    }
  }

  const competitors = normalizeCompetitorList(competitorsRaw, {
    exclude: [brand_name, ...brand_aliases],
  });

  // 3. Create the organization on an engine this account can run.
  const engine = await pickProjectEngine(supabase, userId);
  const seen = new Set<string>([host]);
  const brand_domains = [
    host,
    ...(input.extraDomains ?? [])
      .map((d) => hostOfUrl(d) ?? d.trim().toLowerCase())
      .filter((d) => d && !seen.has(d) && seen.add(d)),
  ];

  const { data: projRow, error: projErr } = await supabase
    .from("projects")
    .insert({
      user_id: userId,
      name,
      brand_name,
      brand_aliases,
      brand_domains,
      description,
      default_provider: engine.provider,
      default_model: engine.model,
      schedule: input.schedule ?? "off",
    })
    .select("*")
    .single();
  if (projErr || !projRow) {
    throw new Error(projErr?.message ?? "Could not create the organization.");
  }
  const project = projRow as Project;

  // 4. Save what will be asked.
  const saved = await persistOnboarding(supabase, project, {
    topics,
    competitors,
    promptSource: input.topics && input.topics.length > 0 ? "manual" : "ai",
  });

  // 5. The first sweep.
  let sweep: SweepOutcome | null = null;
  let sweepSkipped: string | undefined;
  if (input.run === false) {
    sweepSkipped = "not_requested";
  } else if (saved.prompts === 0) {
    sweepSkipped = "no_prompts";
  } else {
    sweep = await firstSweep({
      supabase,
      userId,
      project,
      runnable: engine.runnable,
      meter,
      context: opts.context,
      background: input.background ?? true,
    });
  }

  return {
    project,
    site,
    suggestion,
    ...(suggestionSkipped ? { suggestionSkipped } : {}),
    saved,
    topics,
    competitors,
    sweep,
    ...(sweepSkipped ? { sweepSkipped } : {}),
    trial: await trialSnapshot(supabase, userId),
  };
}

// ---------- handing the organization to its owner ----------------------------

export interface OnboardingAccount {
  userId: string;
  email: string;
  /** True when the account was created by this call; false when an existing
   *  account with this address was adopted. */
  created: boolean;
}

/**
 * The account an onboarded organization belongs to, by email: adopted when
 * one exists, created otherwise. Service-role only.
 *
 * A created account has no password. Its owner claims it the way anyone
 * recovers an account — "forgot password" on the login page, or a magic link —
 * and everything set up for them is already there: the organization, the
 * runs, the free trial the onboarding spent from. That IS the transfer.
 */
export async function resolveOnboardingAccount(
  service: SupabaseClient,
  emailRaw: string,
): Promise<OnboardingAccount> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new OnboardError("invalid", "That doesn't look like a valid email address.");
  }

  const { data: existing } = await service
    .from("profiles")
    .select("id, email")
    .eq("email", email)
    .maybeSingle();
  if (existing) {
    return { userId: (existing as { id: string }).id, email, created: false };
  }

  const { data, error } = await service.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error || !data?.user) {
    throw new Error(`Could not create an account for ${email}: ${error?.message ?? "unknown error"}`);
  }
  // The signup trigger creates the profile row; make sure of it, since every
  // meter and the org switcher key on that row existing.
  await service
    .from("profiles")
    .upsert({ id: data.user.id, email }, { onConflict: "id", ignoreDuplicates: true });
  return { userId: data.user.id, email, created: true };
}

/** Same ceiling as Settings → API keys. */
export const MAX_API_KEYS_PER_USER = 10;

export type MintedKey =
  | { ok: true; id: string; name: string; hint: string; key: string }
  | { ok: false; error: string };

/**
 * Mint a Lettertrace API key for `userId` and return the plaintext ONCE — the
 * credential the new owner (or the system onboarding on their behalf) uses to
 * add their own provider key, read reports, and trigger runs.
 */
export async function mintApiKey(
  service: SupabaseClient,
  userId: string,
  name: string,
): Promise<MintedKey> {
  const { count } = await service
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if ((count ?? 0) >= MAX_API_KEYS_PER_USER) {
    return {
      ok: false,
      error: `This account already has ${MAX_API_KEYS_PER_USER} API keys. Remove one first.`,
    };
  }
  const plaintext = generateApiKey();
  const cleanName = name.trim().slice(0, 80) || "API key";
  const { data, error } = await service
    .from("api_keys")
    .insert({
      user_id: userId,
      name: cleanName,
      key_hash: hashApiKey(plaintext),
      key_hint: keyHint(plaintext),
    })
    .select("id, name, key_hint")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not create the API key." };
  }
  const row = data as { id: string; name: string; key_hint: string };
  return { ok: true, id: row.id, name: row.name, hint: row.key_hint, key: plaintext };
}

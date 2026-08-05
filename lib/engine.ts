import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ActorType,
  Competitor,
  LogChannel,
  Project,
  Prompt,
  Provider,
  RouteInfo,
} from "@/lib/types";
import { runQuery, analyzeResponse, humanError, type AnalyzeEntity } from "@/lib/llm";
import { detectMention, brandTerms } from "@/lib/mentions";
import { pageKey } from "@/lib/metrics";
import { analysisModelFor, modelLabel } from "@/lib/models";
import { spendMicros } from "@/lib/pricing";
import { recordOps, recordOpsError } from "@/lib/ops";
import { logActivity } from "@/lib/activity";
import { selectAll } from "@/lib/paging";

/**
 * Who/what asked for a run, forwarded to the activity log so every run — from
 * the dashboard, the API, MCP, or the cron scheduler — lands in one feed. When
 * absent the run is attributed to the internal system.
 */
export interface RunContext {
  channel?: LogChannel;
  actorType?: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
}

// Run at most this many queries at once. Low enough to stay under provider
// rate limits, high enough that a full-size run finishes inside the 300s
// invocation ceiling: 60 answers with web search on a slow engine run ~20s
// each, and at 4-wide that exact workload was killed at the cap three times,
// seconds short of done. 8-wide it clears the ceiling with half left over.
const CONCURRENCY = 8;

// Flush the progress counter every few answers rather than every answer — the
// row is a checkpoint, not a log. Fixed rather than tied to CONCURRENCY so a
// wider pool doesn't make completed_count staler for whoever reads it mid-run.
const PROGRESS_EVERY = 4;

// The brand's registrable web host, e.g. "notion.so" from a messy domain entry.
export function hostOf(domain: string | null): string {
  if (!domain) return "";
  return domain
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .replace(/^www\./i, "")
    .toLowerCase();
}

// A cited source is "owned" when its domain is, or is a subdomain of, the host.
/** Links written inline in the answer text (markdown targets + bare URLs),
 *  deduped by page identity, trailing punctuation trimmed. These are real
 *  citations some engines never repeat in their structured source list. */
export function extractInlineLinks(text: string): { url: string; domain: string }[] {
  const found = new Map<string, { url: string; domain: string }>();
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/gi)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    const key = pageKey(url);
    if (!key || found.has(key)) continue;
    found.set(key, { url, domain: hostOf(url) });
  }
  return [...found.values()];
}

export function isOwnedDomain(sourceDomain: string, ownedHost: string): boolean {
  if (!ownedHost || !sourceDomain) return false;
  return sourceDomain === ownedHost || sourceDomain.endsWith(`.${ownedHost}`);
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface RunResult {
  runId: string;
  status: "completed" | "failed";
  totalResponses: number;
  tokensUsed: number;
  /** What this run cost, in micro-dollars, when it ran on an operator key.
   *  Zero for a run on the user's own credential — that spend isn't ours. */
  spendMicros: number;
  /** Set when the run stopped early because the free-tier ceiling was reached:
   *  the answers stored are real, there are just fewer of them than planned. */
  budgetStopped?: boolean;
  error?: string;
}

/**
 * How long a run may sit in "running" before it is treated as abandoned.
 *
 * A run cannot outlive the invocation executing it, and every route that starts
 * one caps at maxDuration = 300s. So anything still "running" well past that is
 * not slow, it is gone: the process was killed mid-flight and the code that
 * settles the row never got to run. Three times the ceiling leaves room for a
 * platform that is more generous than ours without ever racing a live run.
 */
export const ABANDONED_RUN_MS = 15 * 60 * 1000;

/** True when a "running" row has outlived any invocation that could still be
 *  working on it. Exported for tests and for callers that only want to report. */
export function isAbandoned(run: { status: string; started_at: string | null }, now = Date.now()): boolean {
  if (run.status !== "running") return false;
  // No started_at is itself a broken row; created_at is not read here because
  // the only writer of "running" sets started_at in the same insert.
  if (!run.started_at) return false;
  return now - new Date(run.started_at).getTime() > ABANDONED_RUN_MS;
}

/**
 * Settle a run that will never finish itself.
 *
 * Every path that executes a run settles its own row on the way out — unless the
 * process dies first, which is exactly what happens to a background run that
 * outlives its serverless invocation. The row then reads "running" forever, and
 * a client polling GET /v1/runs/:id/status polls forever with it: the status
 * endpoint is a promise that the state is eventually terminal, and nothing was
 * keeping that promise.
 *
 * Guarded on status = 'running' so it is idempotent and cannot race a run that
 * settled itself between the read and this write — the loser of that race
 * updates nothing rather than overwriting a real result with a failure.
 * `completed_count` is deliberately left alone: answers stored before the
 * interruption are real, and the run row should say how far it got.
 */
export async function settleAbandonedRun(
  supabase: SupabaseClient,
  runId: string,
  reason: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error: reason,
    })
    .eq("id", runId)
    .eq("status", "running")
    .select("id");
  const settled = (data ?? []).length > 0;
  // An abandoned run means an invocation died mid-flight — the single most
  // useful thing to know about a deployment's health, and previously visible
  // only as a row quietly changing state.
  if (settled) recordOps("run.abandoned", { level: "error", signature: "run.abandoned" });
  return settled;
}

/** What an interrupted run says for itself. Shared so the sweeper, the status
 *  endpoint and the background catch can't describe it three different ways. */
export const INTERRUPTED_RUN_ERROR =
  "The run was interrupted before it finished — the server stopped executing it. Answers stored before that point were kept. Run it again to collect the rest.";

/**
 * Settle every run that nothing is executing any more.
 *
 * A run row is written "running" up front and settled by the code that executes
 * it — so if that process dies mid-flight, nothing ever settles it. This is the
 * batch form of settleAbandonedRun, shared by the cron tick and the admin page:
 * cron because it needs no one watching, the admin page because an operator
 * looking at deployment health shouldn't wait a day for the next tick to be
 * shown a failure as a failure. Returns what it settled so callers can report
 * it rather than have it inferred from a client complaint.
 */
export async function sweepAbandonedRuns(supabase: SupabaseClient): Promise<string[]> {
  const cutoff = new Date(Date.now() - ABANDONED_RUN_MS).toISOString();
  const { data } = await supabase
    .from("runs")
    .select("id")
    .eq("status", "running")
    .lt("started_at", cutoff);

  const settled: string[] = [];
  for (const row of (data ?? []) as { id: string }[]) {
    if (await settleAbandonedRun(supabase, row.id, INTERRUPTED_RUN_ERROR)) settled.push(row.id);
  }
  return settled;
}

export interface ExecuteRunParams {
  supabase: SupabaseClient;
  project: Project;
  provider: Provider;
  model: string;
  apiKey: string;
  /** Set when `apiKey` is an LLM router credential. `provider` still names the
   *  engine that answers; this only says which gateway carried the call, and is
   *  recorded on the run so a credential switch is visible in the data. */
  route?: RouteInfo | null;
  /** Attribution for the activity log. Defaults to the internal system. */
  context?: RunContext;
  /**
   * How much operator money this run may spend, in micro-dollars. Omit (or
   * null) for a run on the user's own key, where there is nothing for us to
   * ration.
   *
   * A run has no natural size — prompts x replicates, with no cap on prompts —
   * so a per-run allowance is the only thing standing between one free account
   * and an arbitrary bill. Checked between answers rather than up front,
   * because the cost of an answer isn't known until it arrives.
   */
  budgetMicros?: number | null;
}

/** A run row already created and logged, plus everything the job loop needs. */
export interface PreparedRun {
  runId: string;
  /** One entry per planned ANSWER (prompts × replicates). */
  jobs: Prompt[];
  competitors: Competitor[];
  attribution: {
    userId: string;
    projectId: string;
    actorType: ActorType;
    actorId: string | null;
    actorLabel: string;
    channel: LogChannel;
    category: "run";
    targetType: string;
  };
  startedMs: number;
}

/**
 * Create the run row (status "running") and log run.started without executing
 * anything. Callers that must answer immediately — a run takes minutes, and no
 * HTTP client should have to hold a connection that long — return the run id
 * from here and hand the PreparedRun to resumeRun after responding. Everyone
 * else calls executeRun, which is exactly prepareRun + resumeRun.
 */
export async function prepareRun(params: ExecuteRunParams): Promise<PreparedRun> {
  const { supabase, project, provider, model, route } = params;
  const startedMs = Date.now();

  // Attribution shared by every run event below. project.user_id is always the
  // owner, so a run is visible in its owner's feed no matter who triggered it.
  const attribution = {
    userId: project.user_id,
    projectId: project.id,
    actorType: params.context?.actorType ?? ("system" as ActorType),
    actorId: params.context?.actorId ?? null,
    actorLabel: params.context?.actorLabel ?? "System",
    channel: params.context?.channel ?? ("system" as LogChannel),
    category: "run" as const,
    targetType: "run",
  };

  // Paged: a run must ask the WHOLE portfolio. A silently truncated prompt list
  // would just look like a smaller run, and the mention rate it produced would
  // be over a different set of questions than the one before it.
  const prompts = await selectAll<Prompt>((from, to) =>
    supabase
      .from("prompts")
      .select("*")
      .eq("project_id", project.id)
      .eq("is_active", true)
      .range(from, to),
  );

  const competitors = await selectAll<Competitor>((from, to) =>
    supabase.from("competitors").select("*").eq("project_id", project.id).range(from, to),
  );

  // Ask each prompt `replicates` times. Provider answers vary between identical
  // calls, so one ask can't tell "not mentioned" from "mentioned, unlucky" — at
  // a true 50% rate a single ask reads zero half the time, and the whole point
  // of the product is that a zero is believable. Each ask is its own response
  // row, so the mention rate is over answers rather than over prompts.
  const replicates = Math.min(Math.max(Math.trunc(project.replicates ?? 1), 1), 10);
  const jobs = prompts.flatMap((p) => Array.from({ length: replicates }, () => p));

  // Create the run row up front so the UI can show progress.
  const { data: runRow, error: runErr } = await supabase
    .from("runs")
    .insert({
      project_id: project.id,
      status: "running",
      provider,
      model,
      // Null for a direct provider key. Never a substitute for `provider`: the
      // engine that answered is what the run measured.
      route: route?.router ?? null,
      // Planned ANSWERS, not prompts — this is what the UI counts against.
      prompt_count: jobs.length,
      completed_count: 0,
      replicates,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    throw new Error(`Failed to create run: ${runErr?.message ?? "unknown"}`);
  }
  const runId = runRow.id as string;

  await logActivity({
    ...attribution,
    action: "run.started",
    status: "info",
    targetId: runId,
    summary: `Run started on ${modelLabel(provider, model)} (${jobs.length} ${jobs.length === 1 ? "answer" : "answers"} planned)`,
    metadata: { provider, model, route: route?.router ?? null, prompt_count: jobs.length, replicates },
  });

  return { runId, jobs, competitors, attribution, startedMs };
}

/** Execute a prepared run's jobs and settle the run row. */
export async function resumeRun(prepared: PreparedRun, params: ExecuteRunParams): Promise<RunResult> {
  const { supabase, project, provider, model, apiKey, route, budgetMicros } = params;
  const { runId, jobs, competitors, attribution, startedMs } = prepared;

  if (jobs.length === 0) {
    await supabase
      .from("runs")
      .update({ status: "completed", finished_at: new Date().toISOString() })
      .eq("id", runId);
    await logActivity({
      ...attribution,
      action: "run.completed",
      status: "success",
      targetId: runId,
      summary: "Run completed with no active prompts to ask",
      durationMs: Date.now() - startedMs,
      metadata: { provider, model, total_responses: 0, tokens_used: 0 },
    });
    return { runId, status: "completed", totalResponses: 0, tokensUsed: 0, spendMicros: 0 };
  }

  // Mention terms derive from the PRIMARY domain only: phantom-site names
  // aren't the brand name, so they shouldn't count as brand mentions.
  const bTerms = brandTerms(project.brand_name, project.brand_aliases);
  // Every domain (main + phantoms) counts when flagging cited sources as "yours".
  const ownedHosts = project.brand_domains.map(hostOf).filter(Boolean);
  let processed = 0; // asks attempted (success or failure)
  let succeeded = 0; // answers actually stored
  let tokensUsed = 0; // total provider tokens consumed (for trial metering)
  let spentMicros = 0; // what those tokens and searches cost, when we're paying
  let hardError: string | undefined;

  // A ceiling only applies when the operator is footing the bill. On the user's
  // own key there is nothing to ration, and capping their run would be us
  // rationing their money.
  const ceiling = typeof budgetMicros === "number" ? Math.max(0, budgetMicros) : null;
  let budgetStopped = false;
  const overBudget = () => ceiling !== null && spentMicros >= ceiling;

  await mapPool(jobs, CONCURRENCY, async (prompt) => {
    // Checked per job rather than up front: the run is concurrent, so this is
    // the point where in-flight answers have already reported their cost. Jobs
    // already dispatched finish and are kept — a stored answer is real data,
    // and throwing it away would waste money we have already spent.
    if (overBudget()) {
      budgetStopped = true;
      return;
    }
    try {
      const { text: answer, tokens: qTokens, sources } = await runQuery({
        provider,
        model,
        apiKey,
        route,
        prompt: prompt.text,
        webSearch: project.use_web_search,
      });
      tokensUsed += qTokens;
      spentMicros += spendMicros({
        provider,
        model,
        tokens: qTokens,
        webSearch: project.use_web_search,
      });

      const { data: respRow } = await supabase
        .from("responses")
        .insert({
          run_id: runId,
          project_id: project.id,
          prompt_id: prompt.id,
          topic_id: prompt.topic_id,
          provider,
          model,
          response_text: answer,
        })
        .select("id")
        .single();

      if (!respRow) return;
      const responseId = respRow.id as string;
      succeeded++;

      // Store the web sources the model cited: the provider's structured
      // citations PLUS links written inline in the answer text. Some engines
      // (ChatGPT especially) cite as markdown links without repeating them in
      // the structured list — skipping those under-counts citations, and the
      // pages it misses are often the very ones being tracked. Inline links
      // are deduped against the structured set by page identity (host+path).
      const structuredKeys = new Set(sources.map((s) => pageKey(s.url)).filter(Boolean));
      const inline = extractInlineLinks(answer).filter((l) => !structuredKeys.has(pageKey(l.url)));
      if (sources.length > 0 || inline.length > 0) {
        const sourceRows = [
          ...sources.map((s) => ({
            response_id: responseId,
            run_id: runId,
            project_id: project.id,
            url: s.url,
            domain: s.domain,
            title: s.title,
            snippet: s.snippet,
            is_owned: ownedHosts.some((h) => isOwnedDomain(s.domain, h)),
          })),
          ...inline.map((l) => ({
            response_id: responseId,
            run_id: runId,
            project_id: project.id,
            url: l.url,
            domain: l.domain,
            title: null,
            snippet: null,
            is_owned: ownedHosts.some((h) => isOwnedDomain(l.domain, h)),
          })),
        ];
        await supabase.from("sources").insert(sourceRows);
      }

      // Deterministic detection: brand + each competitor.
      const detected: {
        key: string;
        name: string;
        type: "brand" | "competitor";
        competitorId: string | null;
        count: number;
        firstPosition: number;
      }[] = [];

      const brandHit = detectMention(answer, bTerms);
      if (brandHit.mentioned) {
        detected.push({
          key: "brand",
          name: project.brand_name,
          type: "brand",
          competitorId: null,
          count: brandHit.count,
          firstPosition: brandHit.firstPosition,
        });
      }
      for (const c of competitors) {
        const hit = detectMention(answer, [c.name, ...c.aliases]);
        if (hit.mentioned) {
          detected.push({
            key: c.id,
            name: c.name,
            type: "competitor",
            competitorId: c.id,
            count: hit.count,
            firstPosition: hit.firstPosition,
          });
        }
      }

      // Sentiment / recommendation enrichment (best-effort) for detected entities.
      let analyzed: Record<string, { sentiment: "positive" | "neutral" | "negative"; recommended: boolean }> = {};
      if (detected.length > 0) {
        const entities: AnalyzeEntity[] = detected.map((d) => ({ key: d.key, name: d.name }));
        const { results, tokens: aTokens } = await analyzeResponse({
          provider,
          model,
          apiKey,
          route,
          question: prompt.text,
          responseText: answer,
          entities,
        });
        tokensUsed += aTokens;
        // Classification runs on the provider's cheap model and never searches,
        // but it is still the operator's money and there are as many of these
        // as there are answers.
        spentMicros += spendMicros({
          provider,
          model: analysisModelFor(provider),
          tokens: aTokens,
          webSearch: false,
        });
        analyzed = Object.fromEntries(
          results.map((r) => [r.key, { sentiment: r.sentiment, recommended: r.recommended }]),
        );
      }

      if (detected.length > 0) {
        const mentionRows = detected.map((d) => ({
          response_id: responseId,
          run_id: runId,
          project_id: project.id,
          topic_id: prompt.topic_id,
          entity_type: d.type,
          competitor_id: d.competitorId,
          entity_name: d.name,
          mentioned: true,
          mention_count: d.count,
          first_position: d.firstPosition,
          sentiment: analyzed[d.key]?.sentiment ?? "neutral",
          recommended: analyzed[d.key]?.recommended ?? false,
        }));
        await supabase.from("mentions").insert(mentionRows);
      }
    } catch (err) {
      // A single failed ask shouldn't kill the whole run.
      if (!hardError) hardError = humanError(err);
      // ...but every one of them is recorded. Only the FIRST becomes the run's
      // error message, so without this a run that lost 90 of 100 answers to a
      // rate limit looks identical to one that lost a single answer.
      recordOpsError("engine.answer", err, { provider, model, route: route?.router ?? "direct" });
    } finally {
      processed++;
      // Periodic progress checkpoint, completed_count reflects stored answers.
      if (processed % PROGRESS_EVERY === 0 || processed === jobs.length) {
        await supabase.from("runs").update({ completed_count: succeeded }).eq("id", runId);
      }
    }
  });

  const finishedAt = new Date().toISOString();
  // A run only "completed" if at least one answer was actually stored; otherwise
  // it failed and we surface the captured error rather than reporting success.
  const status = succeeded > 0 ? "completed" : "failed";

  // Stopping on the ceiling is not a failure and must not read as one: the
  // answers that were stored are as good as any other run's. But it IS a
  // shortfall, and a run that silently returns 40 of 200 answers would look
  // like the prompts stopped working. Say which it was, in the run's own row.
  const shortfall = budgetStopped ? jobs.length - processed : 0;
  const budgetNote = budgetStopped
    ? `Stopped after ${succeeded} of ${jobs.length} answers: this account reached its free-usage limit. ` +
      `Add your own provider key in Settings to run the remaining ${shortfall}.`
    : null;
  await supabase
    .from("runs")
    .update({
      status,
      completed_count: succeeded,
      finished_at: finishedAt,
      error:
        status === "failed"
          ? hardError ?? budgetNote ?? "No answers were stored, every prompt failed."
          : budgetNote,
    })
    .eq("id", runId);

  await supabase
    .from("projects")
    .update({ last_run_at: finishedAt })
    .eq("id", project.id);

  await logActivity({
    ...attribution,
    action: status === "completed" ? "run.completed" : "run.failed",
    status: status === "completed" ? "success" : "failure",
    targetId: runId,
    summary:
      status === "completed"
        ? budgetStopped
          ? `Run stopped at the free-usage limit: ${succeeded} of ${jobs.length} ${jobs.length === 1 ? "answer" : "answers"} stored on ${modelLabel(provider, model)}`
          : `Run completed: ${succeeded} of ${jobs.length} ${jobs.length === 1 ? "answer" : "answers"} stored on ${modelLabel(provider, model)}`
        : `Run failed: ${hardError ?? budgetNote ?? "no answers were stored"}`,
    durationMs: Date.now() - startedMs,
    metadata: {
      provider,
      model,
      total_responses: succeeded,
      prompt_count: jobs.length,
      tokens_used: tokensUsed,
      spend_micros: spentMicros,
      ...(budgetStopped ? { budget_stopped: true, unrun_prompts: shortfall } : {}),
      ...(hardError ? { error: hardError } : {}),
    },
  });

  recordOps(status === "completed" ? "run.completed" : "run.failed", {
    level: status === "completed" ? "info" : "error",
    // Signed by engine and outcome, not by run id: the useful question is
    // "which engine is failing", and a per-run signature could never answer it.
    signature: `run.${status}:${provider}/${model}`,
    sample: {
      provider,
      model,
      route: route?.router ?? "direct",
      planned: jobs.length,
      stored: succeeded,
      failed: jobs.length - succeeded,
      duration_ms: Date.now() - startedMs,
      budget_stopped: Boolean(budgetStopped),
    },
  });

  return {
    runId,
    status,
    totalResponses: succeeded,
    tokensUsed,
    spendMicros: spentMicros,
    ...(budgetStopped ? { budgetStopped: true } : {}),
    error: hardError,
  };
}

/**
 * Create a run for a project and execute every active prompt against the chosen
 * model with the user's key, detecting + storing brand/competitor mentions.
 * `supabase` may be a user-scoped (RLS) client or the service client (cron).
 */
export async function executeRun(params: ExecuteRunParams): Promise<RunResult> {
  return resumeRun(await prepareRun(params), params);
}

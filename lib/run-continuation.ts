import type { SupabaseClient } from "@supabase/supabase-js";
import type { Competitor, Project, Prompt, Provider } from "@/lib/types";
import { resumeRun, RUN_TIME_BUDGET_MS, MAX_RUN_CONTINUATIONS, type PreparedRun } from "@/lib/engine";
import { resolveRunKeyFor } from "@/lib/trial";
import { reportBaseUrl } from "@/lib/report-email-delivery";
import { selectAll } from "@/lib/paging";
import { recordOps } from "@/lib/ops";

/**
 * CONTINUING A RUN THAT RAN OUT OF TIME.
 *
 * A run executes inside one serverless invocation, and stops dispatching at the
 * invocation's time budget (RUN_TIME_BUDGET_MS). Before this module a stop was
 * the end: the run settled "completed" with the tail of the portfolio never
 * asked, and nothing ever asked it. For a slow reasoning model that ceiling is
 * ~220 answers, so every bigger run measured a different, tail-less question set
 * from the one it planned (Letterstory, 2026-10-02: 25 of 33 ChatGPT runs).
 *
 * Now a background run on the user's own key continues instead: its last act is
 * to start the next LEG in a fresh invocation (POST /api/internal/runs/:id/
 * continue, authorized by CRON_SECRET), and leave its row "running" with its
 * progress written. The leg asks only what is still missing — each active prompt
 * up to the run's replicates, minus the answers already stored for it — and
 * settles the run, or continues again, up to MAX_RUN_CONTINUATIONS times.
 *
 * Each leg moves `runs.started_at` to its own start. That column is what the
 * abandoned-run sweeper measures (isAbandoned), and a continued run is alive for
 * longer than any single invocation; a leg that dies is still swept 20 minutes
 * after IT started. The cadence anchor is unaffected: it is the run's created_at.
 */

/** The route that runs a leg. One constant so the route and caller can't drift. */
export const CONTINUE_PATH = (runId: string) => `/api/internal/runs/${runId}/continue`;

/**
 * Ask a fresh invocation to run leg `leg` of `runId`. Resolves true once the
 * route has accepted it (202), false when it can't be scheduled: no site URL or
 * CRON_SECRET (a self-hosted install with neither), or the request failed. False
 * settles the run the way a stop always did, so nothing is lost by declining.
 */
export async function scheduleRunContinuation(runId: string, leg: number): Promise<boolean> {
  const base = reportBaseUrl();
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) return false;
  try {
    const res = await fetch(`${base}${CONTINUE_PATH(runId)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ leg }),
      // The route answers as soon as it has the leg; this only bounds a hung
      // connection so the finishing leg can still settle in its own margin.
      signal: AbortSignal.timeout(10_000),
    });
    return res.status === 202;
  } catch {
    return false;
  }
}

/**
 * The jobs still missing from a run: each active prompt asked up to
 * `replicates` times, minus the answers already stored for it on this run.
 * Pure, so the arithmetic is tested without a database.
 */
export function missingJobs(prompts: Prompt[], replicates: number, storedByPrompt: Map<string, number>): Prompt[] {
  const reps = Math.min(Math.max(Math.trunc(replicates || 1), 1), 10);
  return prompts.flatMap((p) => {
    const missing = Math.max(0, reps - (storedByPrompt.get(p.id) ?? 0));
    return Array.from({ length: missing }, () => p);
  });
}

interface RunRow {
  id: string;
  project_id: string;
  status: string;
  provider: Provider;
  model: string;
  prompt_count: number;
  replicates: number | null;
  created_at: string;
}

/**
 * Settle a run that can't continue, keeping whatever earlier legs stored.
 * Guarded on status = 'running', like settleAbandonedRun, so it cannot
 * overwrite a run that settled itself in the meantime.
 */
async function settleUncontinued(
  supabase: SupabaseClient,
  run: RunRow,
  stored: number,
  reason: string,
): Promise<void> {
  await supabase
    .from("runs")
    .update({
      status: stored > 0 ? "completed" : "failed",
      completed_count: stored,
      finished_at: new Date().toISOString(),
      error: `Stopped after ${stored} of ${run.prompt_count} answers: ${reason}`,
    })
    .eq("id", run.id)
    .eq("status", "running");
  recordOps("run.continue_failed", { level: "warn", signature: `run.continue_failed: ${reason}` });
}

/**
 * Run leg `leg` of a continued run. Returns what happened, for the route's
 * logs: "skipped" when there is nothing to continue (the run already settled,
 * or the leg number is out of range), "settled" when it couldn't continue or
 * had nothing left, "ran" when it executed the missing jobs.
 */
export async function continueRun(
  supabase: SupabaseClient,
  runId: string,
  leg: number,
): Promise<"skipped" | "settled" | "ran"> {
  if (!Number.isInteger(leg) || leg < 1 || leg > MAX_RUN_CONTINUATIONS) return "skipped";

  const { data: runData } = await supabase
    .from("runs")
    .select("id, project_id, status, provider, model, prompt_count, replicates, created_at")
    .eq("id", runId)
    .maybeSingle();
  const run = runData as RunRow | null;
  if (!run || run.status !== "running") return "skipped";

  // The heartbeat first: from here this leg is what is executing the run.
  await supabase
    .from("runs")
    .update({ started_at: new Date().toISOString() })
    .eq("id", run.id)
    .eq("status", "running");

  const answered = await selectAll<{ prompt_id: string | null }>((from, to) =>
    supabase.from("responses").select("prompt_id").eq("run_id", run.id).range(from, to),
  );
  const stored = answered.length;
  const storedByPrompt = new Map<string, number>();
  for (const r of answered) {
    if (r.prompt_id) storedByPrompt.set(r.prompt_id, (storedByPrompt.get(r.prompt_id) ?? 0) + 1);
  }

  const { data: projectData } = await supabase.from("projects").select("*").eq("id", run.project_id).maybeSingle();
  const project = projectData as Project | null;
  if (!project) {
    await settleUncontinued(supabase, run, stored, "its project no longer exists.");
    return "settled";
  }

  // The same resolver the first leg used. Only the user's own key continues
  // (RunContinuation): if that is no longer what resolves for this engine — the
  // key was removed, or now routes elsewhere — stop rather than finish the run
  // on a different credential than the one it started on.
  const key = await resolveRunKeyFor(supabase, project.user_id, run.provider, run.model, {
    webSearch: project.use_web_search,
  });
  if (key.source !== "own" || key.provider !== run.provider || key.model !== run.model || !key.apiKey) {
    await settleUncontinued(
      supabase,
      run,
      stored,
      "the run reached its time limit and could not continue, because the key it started on is no longer available.",
    );
    return "settled";
  }

  const prompts = await selectAll<Prompt>((from, to) =>
    supabase.from("prompts").select("*").eq("project_id", project.id).eq("is_active", true).range(from, to),
  );
  const jobs = missingJobs(prompts, run.replicates ?? project.replicates ?? 1, storedByPrompt);
  if (jobs.length === 0) {
    await supabase
      .from("runs")
      .update({
        status: stored > 0 ? "completed" : "failed",
        completed_count: stored,
        finished_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", run.id)
      .eq("status", "running");
    return "settled";
  }

  const competitors = await selectAll<Competitor>((from, to) =>
    supabase.from("competitors").select("*").eq("project_id", project.id).range(from, to),
  );

  const startedMs = Date.now();
  const prepared: PreparedRun = {
    runId: run.id,
    jobs,
    competitors,
    // The trigger's own attribution isn't stored on the run; a continuation is
    // the system finishing what that trigger started.
    attribution: {
      userId: project.user_id,
      projectId: project.id,
      actorType: "system",
      actorId: null,
      actorLabel: "System",
      channel: "system",
      category: "run",
      targetType: "run",
    },
    startedMs,
    // The cadence anchor stays the run's own start, not this leg's.
    startedAt: run.created_at,
  };

  await resumeRun(prepared, {
    supabase,
    project,
    provider: key.provider,
    model: key.model,
    apiKey: key.apiKey,
    route: key.route,
    keySource: "own",
    budgetMicros: null,
    timeBudgetMs: RUN_TIME_BUDGET_MS,
    continuation: {
      leg,
      priorStored: stored,
      planned: run.prompt_count,
      schedule: (next) => scheduleRunContinuation(run.id, next),
    },
  });
  return "ran";
}

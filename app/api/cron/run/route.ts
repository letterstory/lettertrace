import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { executeRun, mapPool, sweepAbandonedRuns, RUN_TIME_BUDGET_MS } from "@/lib/engine";
import {
  resolveRunKey,
  consumeTrialRunFor,
  recordTrialUsageFor,
  recordTrialSpendFor,
  runBudgetMicros,
} from "@/lib/trial";
import { withSpan } from "@/lib/otel";
import { isScheduleDue } from "@/lib/utils";
import type { Span } from "@opentelemetry/api";
import type { Project } from "@/lib/types";

export const maxDuration = 800;
export const dynamic = "force-dynamic";

// How many due projects the tick runs at once. Until 2026-09-12 it was one:
// every project ran to completion before the next started, and the tick's
// wall clock was the SUM of every run. It grew with the project count —
// 104 s for 7 due projects on 08-28, 711 s for 80 on 09-12 — against the same
// 800 s ceiling, and half the runs were single-question runs that still cost
// 7–10 s each in setup and bookkeeping. Four abreast, the tick's wall clock is
// roughly a quarter of that sum. Kept modest because each run already asks
// up to CONCURRENCY questions at once, and projects funded by the trial share
// one provider key, so the pool width multiplies the load on it.
// Not exported: a Next.js route module may only export handlers and the
// known config fields, and the build rejects anything else.
const SWEEP_CONCURRENCY = 4;

interface ProjectResult {
  projectId: string;
  status: "completed" | "failed" | "skipped";
  reason?: string;
  runId?: string;
  totalResponses?: number;
}

// Scheduler entrypoint. Runs every due project. Supports POST (manual curl)
// and GET (Vercel Cron, which sends the Authorization: Bearer $CRON_SECRET header).
// Constant-time comparison so the secret can't be probed via response timing.
function authorized(header: string | null, secret: string | undefined): boolean {
  if (!header || !secret) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handle(request: Request) {
  if (!authorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // One span over the whole tick, parenting every run it starts. The counts it
  // carries are the ones that explain a quiet day: due, skipped for want of a
  // key, and actually run.
  return withSpan("cron.run", {}, (span) => sweepAndRun(span));
}

async function sweepAndRun(span: Span) {
  const supabase = createServiceClient();

  // Before anything else, and unconditionally: a stranded row is stranded
  // whether or not a project happens to be due this tick.
  const sweptRunIds = await sweepAbandonedRuns(supabase);

  const { data: projectRows, error: projErr } = await supabase
    .from("projects")
    .select("*")
    .neq("schedule", "off");

  if (projErr) {
    return NextResponse.json(
      { error: projErr.message, sweptRuns: sweptRunIds },
      { status: 500 },
    );
  }

  const projects = (projectRows ?? []) as Project[];
  const now = Date.now();
  const due = projects.filter((project) => isScheduleDue(project, now));

  // Due projects run SWEEP_CONCURRENCY at a time inside this one invocation,
  // so the budget is the tick's, not each run's: a run that starts ten
  // minutes in has ten minutes less before the platform kills the whole tick,
  // and measuring from its own started_at would let it run straight into
  // that. Once the tick's budget is spent, what is left is left for the next
  // tick; executeRun with no time asks nothing and settles the row as such.
  const results = await mapPool(due, SWEEP_CONCURRENCY, (project) =>
    runDueProject(supabase, project, Math.max(0, RUN_TIME_BUDGET_MS - (Date.now() - now))),
  );

  span.setAttributes({
    "cron.projects.scheduled": projects.length,
    "cron.projects.processed": results.length,
    "cron.projects.skipped": results.filter((r) => r.status === "skipped").length,
    "cron.projects.failed": results.filter((r) => r.status === "failed").length,
    "cron.runs.swept": sweptRunIds.length,
  });

  return NextResponse.json({ processed: results, sweptRuns: sweptRunIds });
}

async function runDueProject(
  supabase: ReturnType<typeof createServiceClient>,
  project: Project,
  timeBudgetMs: number,
): Promise<ProjectResult> {
  try {
    // Ask the run resolver rather than reading provider_keys directly. The
    // direct read predates router credentials and silently skipped anyone
    // paying through a gateway — their scheduled runs simply never happened,
    // with "no key" as the only trace. The resolver also knows whether the
    // project's grounding survives the route.
    //
    // Scheduled runs execute on the user's own key, or on the trial while
    // its allowance lasts — "cadence from the onset": onboarding defaults
    // to daily but lets the user pick the cadence up front, and the trial
    // funds the beginning either way. The same atomic gate as manual runs
    // applies, via the service-scoped RPC (auth.uid() doesn't exist here);
    // when the allowance is out — or the RPC isn't applied to this database
    // yet — the consume returns false and the project is skipped, exactly as
    // it always was. The gate is atomic in the database, so two of one
    // user's projects running side by side cannot both take the last run.
    const key = await resolveRunKey(supabase, project.user_id, project);
    const usable =
      (key.source === "own" || key.source === "trial") && Boolean(key.apiKey);
    if (!usable) {
      return {
        projectId: project.id,
        status: "skipped",
        reason: key.source === "own" ? "no key" : key.source,
      };
    }
    if (
      key.source === "trial" &&
      !(await consumeTrialRunFor(supabase, project.user_id))
    ) {
      return { projectId: project.id, status: "skipped", reason: "exhausted" };
    }

    const result = await executeRun({
      supabase,
      project,
      provider: key.provider,
      model: key.model,
      apiKey: key.apiKey!,
      route: key.route,
      keySource: key.source === "trial" ? "trial" : "own",
      budgetMicros: runBudgetMicros(key),
      timeBudgetMs,
      context: {
        channel: "cron",
        actorType: "cron",
        actorId: "scheduler",
        actorLabel: "Scheduler",
      },
    });
    if (key.source === "trial") {
      await recordTrialUsageFor(supabase, project.user_id, result.tokensUsed);
      await recordTrialSpendFor(supabase, project.user_id, result.spendMicros);
    }
    return {
      projectId: project.id,
      status: result.status,
      runId: result.runId,
      totalResponses: result.totalResponses,
    };
  } catch (e) {
    return {
      projectId: project.id,
      status: "failed",
      reason: e instanceof Error ? e.message : "unknown error",
    };
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}

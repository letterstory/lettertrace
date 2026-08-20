import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { executeRun, sweepAbandonedRuns } from "@/lib/engine";
import {
  resolveRunKey,
  consumeTrialRunFor,
  recordTrialUsageFor,
  recordTrialSpendFor,
  runBudgetMicros,
} from "@/lib/trial";
import { withSpan } from "@/lib/otel";
import type { Span } from "@opentelemetry/api";
import type { Project } from "@/lib/types";

export const maxDuration = 800;
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function isDue(project: Project, now: number): boolean {
  if (project.schedule === "off") return false;
  if (!project.last_run_at) return true;
  const last = new Date(project.last_run_at).getTime();
  const interval = project.schedule === "weekly" ? WEEK_MS : DAY_MS;
  return now - last >= interval;
}

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
  const results: ProjectResult[] = [];

  for (const project of projects) {
    if (!isDue(project, now)) continue;

    try {
      // Ask the run resolver rather than reading provider_keys directly. The
      // direct read predates router credentials and silently skipped anyone
      // paying through a gateway — their scheduled runs simply never happened,
      // with "no key" as the only trace. The resolver also knows whether the
      // project's grounding survives the route.
      //
      // Scheduled runs execute on the user's own key, or on the trial while
      // its allowance lasts — "cadence from the onset": onboarding starts
      // every project on a daily schedule, and the trial funds the beginning.
      // The same atomic gate as manual runs applies, via the service-scoped
      // RPC (auth.uid() doesn't exist here); when the allowance is out — or
      // the RPC isn't applied to this database yet — the consume returns
      // false and the project is skipped, exactly as it always was.
      const key = await resolveRunKey(supabase, project.user_id, project);
      const usable =
        (key.source === "own" || key.source === "trial") && Boolean(key.apiKey);
      if (!usable) {
        results.push({
          projectId: project.id,
          status: "skipped",
          reason: key.source === "own" ? "no key" : key.source,
        });
        continue;
      }
      if (
        key.source === "trial" &&
        !(await consumeTrialRunFor(supabase, project.user_id))
      ) {
        results.push({ projectId: project.id, status: "skipped", reason: "exhausted" });
        continue;
      }

      const result = await executeRun({
        supabase,
        project,
        provider: key.provider,
        model: key.model,
        apiKey: key.apiKey!,
        route: key.route,
        budgetMicros: runBudgetMicros(key),
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
      results.push({
        projectId: project.id,
        status: result.status,
        runId: result.runId,
        totalResponses: result.totalResponses,
      });
    } catch (e) {
      results.push({
        projectId: project.id,
        status: "failed",
        reason: e instanceof Error ? e.message : "unknown error",
      });
    }
  }

  span.setAttributes({
    "cron.projects.scheduled": projects.length,
    "cron.projects.processed": results.length,
    "cron.projects.skipped": results.filter((r) => r.status === "skipped").length,
    "cron.projects.failed": results.filter((r) => r.status === "failed").length,
    "cron.runs.swept": sweptRunIds.length,
  });

  return NextResponse.json({ processed: results, sweptRuns: sweptRunIds });
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}

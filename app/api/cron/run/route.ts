import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { executeRun } from "@/lib/engine";
import { resolveRunKey } from "@/lib/trial";
import type { Project } from "@/lib/types";

export const maxDuration = 300;
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

  const supabase = createServiceClient();

  const { data: projectRows, error: projErr } = await supabase
    .from("projects")
    .select("*")
    .neq("schedule", "off");

  if (projErr) {
    return NextResponse.json({ error: projErr.message }, { status: 500 });
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
      // Scheduled runs stay strictly self-funded: `source` is 'own' for both a
      // direct key and a router key, and anything else — including a trial with
      // free runs left — is skipped, so an unattended schedule can never spend
      // the operator's allowance.
      const key = await resolveRunKey(supabase, project.user_id, project);
      if (key.source !== "own" || !key.apiKey) {
        results.push({
          projectId: project.id,
          status: "skipped",
          reason: key.source === "own" ? "no key" : key.source,
        });
        continue;
      }

      const result = await executeRun({
        supabase,
        project,
        provider: key.provider,
        model: key.model,
        apiKey: key.apiKey,
        route: key.route,
        context: {
          channel: "cron",
          actorType: "cron",
          actorId: "scheduler",
          actorLabel: "Scheduler",
        },
      });
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

  return NextResponse.json({ processed: results });
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}

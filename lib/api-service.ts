import type { SupabaseClient } from "@supabase/supabase-js";
import type { Mention, Project, Run } from "@/lib/types";
import {
  computeEntityStats,
  computeRunSummary,
  type EntityStat,
  type RunSummary,
} from "@/lib/metrics";
import { executeRun, type RunResult } from "@/lib/engine";
import { resolveRunKey } from "@/lib/trial";
import { PROVIDERS } from "@/lib/models";

// Operations behind the programmatic surface, shared by the REST v1 routes and
// the MCP tools so the two can't drift apart. Callers authenticate with a
// Lettertrace API key, so `supabase` is the service-role client: RLS is
// bypassed and every query here scopes by userId explicitly.

/** A project row trimmed to what the API exposes. */
export function projectSummary(p: Project) {
  return {
    id: p.id,
    name: p.name,
    brand_name: p.brand_name,
    brand_domain: p.brand_domain,
    default_provider: p.default_provider,
    default_model: p.default_model,
    schedule: p.schedule,
    use_web_search: p.use_web_search,
    last_run_at: p.last_run_at,
    created_at: p.created_at,
  };
}

/** Fetch a project only if it belongs to the user. */
export async function getOwnedProject(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
): Promise<Project | null> {
  const { data } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as Project | null) ?? null;
}

/** Recent runs for a project. Null when the project isn't the user's. */
export async function listRuns(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  limit = 20,
): Promise<Run[] | null> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) return null;
  const { data } = await supabase
    .from("runs")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  return (data as Run[] | null) ?? [];
}

export interface RunReport {
  run: Run;
  totalResponses: number;
  summary: RunSummary;
  entities: EntityStat[];
}

/** The most recent completed run for a project, if any. */
export async function latestCompletedRun(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
): Promise<Run | null> {
  const runs = await listRuns(supabase, userId, projectId, 50);
  return runs?.find((r) => r.status === "completed") ?? null;
}

/**
 * Share-of-voice report for one run: brand summary plus per-entity stats,
 * computed with the same lib/metrics functions the dashboard uses.
 * Null when the run doesn't exist or isn't the user's.
 */
export async function getRunReport(
  supabase: SupabaseClient,
  userId: string,
  runId: string,
): Promise<RunReport | null> {
  const { data: runRow } = await supabase
    .from("runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  const run = runRow as Run | null;
  if (!run) return null;

  const project = await getOwnedProject(supabase, userId, run.project_id);
  if (!project) return null;

  const [{ count }, { data: mentionRows }] = await Promise.all([
    supabase
      .from("responses")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId),
    supabase.from("mentions").select("*").eq("run_id", runId),
  ]);

  const mentions = (mentionRows ?? []) as Mention[];
  const totalResponses = count ?? 0;

  return {
    run,
    totalResponses,
    summary: computeRunSummary(mentions, totalResponses),
    entities: computeEntityStats(mentions, totalResponses),
  };
}

export type TriggerOutcome =
  | { ok: true; result: RunResult }
  | { ok: false; code: "not_found" | "no_key"; message: string };

/**
 * Execute a monitoring run for one of the user's projects.
 *
 * Programmatic runs are BYOK-only: the free-trial gate lives in
 * auth.uid()-scoped RPCs that a service-role request can't consume, and
 * keeping the trial off the API surface also keeps it from being farmed
 * by scripts. Dashboard runs are unaffected.
 */
export async function triggerRunForProject(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
): Promise<TriggerOutcome> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) {
    return { ok: false, code: "not_found", message: "Project not found." };
  }

  const key = await resolveRunKey(supabase, userId, project);
  if (key.source !== "own") {
    const providerLabel = PROVIDERS[project.default_provider].label;
    return {
      ok: false,
      code: "no_key",
      message: `API-triggered runs require your own ${providerLabel} key. Add one in Settings (free-trial runs are dashboard-only).`,
    };
  }

  const result = await executeRun({
    supabase,
    project,
    provider: key.provider,
    model: key.model,
    apiKey: key.apiKey!,
  });
  return { ok: true, result };
}

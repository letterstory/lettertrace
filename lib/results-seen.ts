import type { SupabaseClient } from "@supabase/supabase-js";
import type { Project, Run } from "@/lib/types";

// ------------------------------------------------------------------
// "Has the owner looked at this run yet?"
//
// A run finishing produces no signal at all today. The scheduler and the REST
// API both finish runs while nobody is on the page, and even a manual run just
// quietly becomes another row in a list — so the data a user is paying tokens
// for can sit unread indefinitely. projects.results_seen_at is the high-water
// mark of "I have looked", and anything that finished after it is worth a nudge.
//
// A timestamp rather than a per-run seen flag: the question is never "which of
// these twelve runs have I read", it's "is there anything new since I last
// looked". One column answers that, and it can't drift out of sync with the
// runs table.
// ------------------------------------------------------------------

/** Runs worth nudging about: both outcomes are news the user hasn't been told.
 *  A silent failure is if anything MORE worth surfacing than a silent success —
 *  it means monitoring has stopped and nothing said so. */
const FINISHED = ["completed", "failed"] as const;

/**
 * Is `a` strictly later than `b`? Compared as instants, not as strings.
 *
 * These timestamps arrive in two shapes — Postgres renders timestamptz as
 * `…+00:00` while `toISOString()` produces `…Z` — and comparing those as text
 * orders them by the suffix character once the digits match, not by time. It
 * happens to come out right today only because every value we compare has been
 * normalized by a read from Postgres first. That's an invisible dependency on
 * where the string came from, so parse instead and let the format stop mattering.
 */
function isAfter(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

/**
 * The project's most recent finished run, if it finished after the owner last
 * looked at results. Null when there's nothing new — which is the common case,
 * so this is one indexed row read on the dashboard's critical path.
 */
export async function getUnseenRun(
  supabase: SupabaseClient,
  project: Project,
): Promise<Run | null> {
  const { data } = await supabase
    .from("runs")
    .select("*")
    .eq("project_id", project.id)
    .in("status", FINISHED as unknown as string[])
    .not("finished_at", "is", null)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const run = data as Run | null;
  if (!run?.finished_at) return null;

  // Never looked: the newest finished run is unseen. That's the right first
  // impression for an account that has runs but has never opened one.
  if (!project.results_seen_at) return run;
  return isAfter(run.finished_at, project.results_seen_at) ? run : null;
}

export type MarkSeenOutcome =
  | { ok: true; changed: boolean; seenAt: string }
  | { ok: false; code: "not_found" };

/**
 * Record that the owner has looked at this project's results.
 *
 * With a `runId`, the mark lands on that run's finish time rather than now:
 * opening an older report shouldn't silently mark a NEWER run as read, which
 * is exactly the run they still need to see. Without one (an explicit dismiss)
 * it lands on now, acknowledging everything that has finished so far.
 *
 * The high-water mark only ever moves forward, so re-opening an old report
 * can't resurrect a nudge the user already cleared.
 */
export async function markResultsSeen(
  supabase: SupabaseClient,
  project: Project,
  runId?: string | null,
): Promise<MarkSeenOutcome> {
  let seenAt = new Date().toISOString();

  if (runId) {
    const { data } = await supabase
      .from("runs")
      .select("finished_at")
      .eq("id", runId)
      .eq("project_id", project.id)
      .maybeSingle();
    const run = data as { finished_at: string | null } | null;
    // Unknown run, or someone else's: say so rather than quietly marking
    // everything read on the strength of an id we couldn't verify.
    if (!run) return { ok: false, code: "not_found" };
    // A run still in flight has no finish time to mark against; treat viewing
    // it as acknowledging everything already finished.
    if (run.finished_at) seenAt = run.finished_at;
  }

  const current = project.results_seen_at;
  if (current && !isAfter(seenAt, current)) {
    return { ok: true, changed: false, seenAt: current };
  }

  const { error } = await supabase
    .from("projects")
    .update({ results_seen_at: seenAt })
    .eq("id", project.id);
  if (error) throw error;

  return { ok: true, changed: true, seenAt };
}

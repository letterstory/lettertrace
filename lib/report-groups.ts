import type { SupabaseClient } from "@supabase/supabase-js";
import { RUN_TIME_BUDGET_MS } from "./engine";
import { resolveEngine } from "./models";
import { selectAll } from "./paging";
import { buildStoredReportEmail, reportBaseUrl, sendOwnerReportEmail } from "./report-email-delivery";
import type { Project, Provider, Run } from "./types";

/**
 * A report group exists for one reason: to turn N runs the user asked for in
 * one click into ONE email instead of N. It does not execute anything — the
 * browser drives the runs through /api/runs, exactly as "run on all engines"
 * always did, and each run reports back which group it belonged to.
 *
 * Every requested engine ends up accounted for in one of two ways: a run row
 * carrying this group's id (whatever its outcome), or an entry in `skipped`
 * saying why no run was ever attempted. When the two together cover every
 * requested provider, the group finalizes and the email goes out.
 */
export interface ReportGroup {
  id: string;
  project_id: string;
  requested_providers: Provider[];
  skipped: Record<string, string>;
  email_status: "pending" | "claimed" | "sent" | "failed" | "suppressed";
  last_activity_at: string;
  finished_at: string | null;
  created_at: string;
}

/**
 * How long a group may go without any engine being accounted for before the
 * sweeper calls it abandoned — which is what happens when the tab is closed
 * mid-batch, since nothing else drives the remaining runs.
 *
 * Derived from the run budget rather than picked: a single run may legitimately
 * occupy RUN_TIME_BUDGET_MS (~11m20s) without reporting anything, so a timeout
 * shorter than that would close out batches that are still working. The margin
 * covers the request overhead either side of the run itself.
 */
export const GROUP_ABANDON_MS = RUN_TIME_BUDGET_MS + 8 * 60 * 1000;

const GROUP_COLUMNS =
  "id, project_id, requested_providers, skipped, email_status, last_activity_at, finished_at, created_at";

async function groupRuns(supabase: SupabaseClient, groupId: string): Promise<Run[]> {
  return selectAll<Run>((from, to) =>
    supabase.from("runs").select("*").eq("report_group_id", groupId).range(from, to),
  );
}

export async function loadGroup(
  supabase: SupabaseClient,
  groupId: string,
): Promise<ReportGroup | null> {
  const { data, error } = await supabase
    .from("report_groups")
    .select(GROUP_COLUMNS)
    .eq("id", groupId)
    .maybeSingle();
  if (error) throw error;
  return (data as ReportGroup | null) ?? null;
}

/**
 * Record that an engine will never produce a run, and why. The reason is the
 * same sentence the user was shown inline — engineKeyMessage names the fix —
 * so the email and the dashboard cannot describe the same refusal differently.
 */
export async function recordGroupSkip(
  supabase: SupabaseClient,
  groupId: string,
  provider: Provider,
  reason: string,
): Promise<void> {
  const group = await loadGroup(supabase, groupId);
  if (!group || group.email_status !== "pending") return;
  if (group.skipped[provider]) return;
  const { error } = await supabase
    .from("report_groups")
    .update({
      skipped: { ...group.skipped, [provider]: reason },
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", groupId)
    .eq("email_status", "pending");
  if (error) throw error;
}

export async function touchGroup(supabase: SupabaseClient, groupId: string): Promise<void> {
  const { error } = await supabase
    .from("report_groups")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", groupId)
    .eq("email_status", "pending");
  if (error) throw error;
}

/** Providers that still owe an outcome: no run row and no recorded skip. */
export function outstandingProviders(group: ReportGroup, runs: Run[]): Provider[] {
  const answered = new Set<string>([...runs.map((run) => run.provider), ...Object.keys(group.skipped)]);
  return group.requested_providers.filter((provider) => !answered.has(provider));
}

/**
 * Send the group's one email, once. The claim is a conditional UPDATE rather
 * than a read-then-write: two runs finishing at the same instant both reach
 * here, and only the one that moves the row off 'pending' may contact Resend.
 *
 * There is deliberately no retry. A worker that dies between the claim and the
 * outcome leaves the row 'claimed', and that email is lost rather than risked
 * twice — a duplicate report is worse than a missing one, and the run data it
 * describes is still on the dashboard either way.
 */
export async function finishGroup(supabase: SupabaseClient, group: ReportGroup): Promise<void> {
  const now = new Date().toISOString();
  const { data: claimed, error } = await supabase
    .from("report_groups")
    .update({ email_status: "claimed", finished_at: now, email_attempted_at: now })
    .eq("id", group.id)
    .eq("email_status", "pending")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!claimed) return;

  let status: "sent" | "failed" | "suppressed" = "failed";
  try {
    const { data: project, error: projectError } = await supabase
      .from("projects").select("*").eq("id", group.project_id).single();
    if (projectError) throw projectError;
    const runs = await groupRuns(supabase, group.id);
    // An engine whose model could not be resolved has no model label to print.
    // Leaving it undefined prints "OpenAI (ChatGPT)"; filling it with the
    // provider id printed "OpenAI (ChatGPT) (openai)".
    const requested = group.requested_providers.map((provider) => {
      const engine = resolveEngine(provider, undefined);
      return { provider, model: engine.ok ? engine.model : undefined };
    });
    // Configuration, not a failed report: without a link base every URL in the
    // message would be wrong, and a report nobody can open is worse than none.
    if (!reportBaseUrl()) {
      status = "suppressed";
    } else {
      const content = await buildStoredReportEmail(supabase, project as Project, requested, runs);
      status = await sendOwnerReportEmail(supabase, project as Project, content);
    }
  } catch (cause) {
    console.error(`[report-groups] could not prepare email ${group.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const { error: updateError } = await supabase.from("report_groups")
    .update({ email_status: status, email_sent_at: status === "sent" ? new Date().toISOString() : null })
    .eq("id", group.id).eq("email_status", "claimed");
  if (updateError) throw updateError;
}

/**
 * Called after every run in a group settles. Finalizes only once every
 * requested engine has an outcome, so a four-engine batch mails after the
 * fourth and not after the first.
 */
export async function finalizeGroupIfComplete(
  supabase: SupabaseClient,
  groupId: string,
): Promise<boolean> {
  const group = await loadGroup(supabase, groupId);
  if (!group || group.email_status !== "pending") return false;
  const runs = await groupRuns(supabase, group.id);
  if (outstandingProviders(group, runs).length > 0) return false;
  await finishGroup(supabase, group);
  return true;
}

/**
 * Close out groups the browser stopped driving. Closing the tab mid-batch
 * leaves the remaining engines with no run row and no skip, so without this
 * the group would stay pending for ever: no email, and a Reports page that
 * polls for progress that is never coming.
 */
export async function sweepAbandonedGroups(supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - GROUP_ABANDON_MS).toISOString();
  const { data, error } = await supabase
    .from("report_groups")
    .select(GROUP_COLUMNS)
    .eq("email_status", "pending")
    .lt("last_activity_at", cutoff)
    .order("last_activity_at")
    .limit(50);
  if (error) throw error;

  let closed = 0;
  for (const group of (data ?? []) as ReportGroup[]) {
    try {
      const runs = await groupRuns(supabase, group.id);
      const outstanding = outstandingProviders(group, runs);
      if (outstanding.length > 0) {
        const skipped = { ...group.skipped };
        for (const provider of outstanding) {
          skipped[provider] = "This report was never started — the page was closed before it ran.";
        }
        const { error: updateError } = await supabase
          .from("report_groups")
          .update({ skipped })
          .eq("id", group.id)
          .eq("email_status", "pending");
        if (updateError) throw updateError;
        group.skipped = skipped;
      }
      await finishGroup(supabase, group);
      closed++;
    } catch (cause) {
      console.error(`[report-groups] could not close abandoned group ${group.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return closed;
}

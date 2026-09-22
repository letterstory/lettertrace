import type { SupabaseClient } from "@supabase/supabase-js";
import { computeEntityStats } from "./metrics";
import { modelLabel, PROVIDERS } from "./models";
import { sendMail } from "./notify";
import { selectAll } from "./paging";
import {
  buildFailedReportEmail,
  buildMultiReportEmail,
  buildSingleReportEmail,
  type ReportEmailContent,
  type ReportEmailFailure,
  type ReportEmailEngine,
} from "./report-email";
import type { Mention, Project, Provider, Run } from "./types";

export type ReportDelivery = "sent" | "suppressed" | "failed";

/**
 * The one place a link base is decided. Callers must ask HERE rather than
 * reading NEXT_PUBLIC_SITE_URL themselves: a value like "lettertrace.com" with
 * no scheme is truthy but unusable, and a caller that only checked for
 * emptiness recorded that configuration problem as a failed send.
 */
export function reportBaseUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** An engine with no model is one the catalog could not resolve; it has no
 *  model label to print, and inventing one printed the provider id twice. */
export function failureForEngine(engine: { provider: Provider; model?: string }): ReportEmailFailure {
  return {
    providerLabel: PROVIDERS[engine.provider].label,
    ...(engine.model ? { modelLabel: modelLabel(engine.provider, engine.model) } : {}),
  };
}

async function statsForRun(supabase: SupabaseClient, run: Run, brandName: string) {
  const mentions = await selectAll<Mention>((from, to) =>
    supabase.from("mentions").select("*").eq("run_id", run.id).range(from, to),
  );
  const stats = computeEntityStats(mentions, run.completed_count, brandName);
  const brand = stats.find((stat) => stat.type === "brand");
  const competitor = stats.find((stat) => stat.type === "competitor");
  if (!brand) throw new Error("Report email could not calculate brand measurements.");
  return { brand, competitor };
}

export async function buildStoredReportEmail(
  supabase: SupabaseClient,
  project: Pick<Project, "brand_name">,
  requested: { provider: Provider; model?: string }[],
  runs: Run[],
): Promise<ReportEmailContent> {
  const url = reportBaseUrl();
  if (!url) throw new Error("NEXT_PUBLIC_SITE_URL must be an absolute http(s) URL.");
  // A run that stored no answers is not a 0% measurement, it is an absent one.
  // Counting it as 0% would chart a loss the run never observed.
  const completed = runs.filter((run) => run.status === "completed" && run.completed_count > 0);
  const completedProviders = new Set(completed.map((run) => run.provider));
  const failures = requested
    .filter((engine) => !completedProviders.has(engine.provider))
    .map(failureForEngine);

  if (requested.length === 1) {
    const run = completed[0];
    if (!run) return buildFailedReportEmail({ brandName: project.brand_name, failure: failures[0], baseUrl: url });
    const { brand, competitor } = await statsForRun(supabase, run, project.brand_name);
    return buildSingleReportEmail({
      brandName: project.brand_name,
      runId: run.id,
      providerLabel: PROVIDERS[run.provider].label,
      modelLabel: modelLabel(run.provider, run.model),
      completedAnswers: run.completed_count,
      plannedAnswers: run.prompt_count,
      brandMentionedAnswers: brand.responsesMentioned,
      visibility: brand.mentionRate,
      shareOfVoice: brand.shareOfVoice,
      sentiment: brand.totalMentionCount ? brand.sentimentScore : null,
      topCompetitor: competitor ? { name: competitor.name, visibility: competitor.mentionRate } : null,
      baseUrl: url,
    });
  }

  const summaries: ReportEmailEngine[] = await Promise.all(completed.map(async (run) => {
    const { brand } = await statsForRun(supabase, run, project.brand_name);
    return {
      runId: run.id,
      providerLabel: PROVIDERS[run.provider].label,
      modelLabel: modelLabel(run.provider, run.model),
      visibility: brand.mentionRate,
      shareOfVoice: brand.shareOfVoice,
    };
  }));
  return buildMultiReportEmail({
    brandName: project.brand_name,
    requestedEngineCount: requested.length,
    reports: summaries,
    failures,
    baseUrl: url,
  });
}

export async function sendOwnerReportEmail(
  supabase: SupabaseClient,
  project: Pick<Project, "id" | "user_id">,
  content: ReportEmailContent,
): Promise<ReportDelivery> {
  try {
    const { data: current, error } = await supabase
      .from("projects")
      .select("report_emails_enabled")
      .eq("id", project.id)
      .maybeSingle();
    if (error) throw error;
    if (!current?.report_emails_enabled || !process.env.RESEND_API_KEY?.trim() ||
        !process.env.ADMIN_ALERT_FROM?.trim()) return "suppressed";

    const { data: owner, error: ownerError } = await supabase.auth.admin.getUserById(project.user_id);
    if (ownerError) throw ownerError;
    const address = owner.user?.email?.trim();
    if (!address) return "suppressed";
    const outcome = await sendMail({ to: [address], subject: content.subject, body: content.text, html: content.html });
    return outcome === "sent" ? "sent" : outcome === "not-configured" ? "suppressed" : "failed";
  } catch (error) {
    console.error(`[report-email] delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}

/**
 * Tell the owner a DUE scheduled run could not start — and say it once.
 *
 * The cause is almost always a missing key or a spent allowance, neither of
 * which fixes itself, so the sweep meets the same project in the same state
 * every interval. Mailing on each pass turned the one failure guaranteed to
 * recur into the one that fills an inbox, which is how a real alert stops
 * being read. projects.schedule_skip_alerted_at holds the fact that we have
 * already said it; the next run that actually starts clears it.
 */
export async function alertScheduleSkip(
  supabase: SupabaseClient,
  project: Pick<Project, "id" | "user_id" | "brand_name" | "default_provider" | "default_model">,
  reason: string,
): Promise<ReportDelivery | "already-alerted"> {
  try {
    const { data: current, error } = await supabase
      .from("projects")
      .select("schedule_skip_alerted_at")
      .eq("id", project.id)
      .maybeSingle();
    if (error) throw error;
    if (current?.schedule_skip_alerted_at) return "already-alerted";

    // Claim before sending, so two sweeps meeting the same project don't both
    // mail. The same reasoning as a report group's email claim.
    const { data: claimed, error: claimError } = await supabase
      .from("projects")
      .update({ schedule_skip_alerted_at: new Date().toISOString() })
      .eq("id", project.id)
      .is("schedule_skip_alerted_at", null)
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) return "already-alerted";

    return await sendSingleReportAttempt(supabase, project, {
      provider: project.default_provider,
      model: project.default_model,
    });
  } catch (cause) {
    console.error(`[report-email] could not alert schedule skip (${reason}): ${cause instanceof Error ? cause.message : String(cause)}`);
    return "failed";
  }
}

export async function clearScheduleSkipAlert(
  supabase: SupabaseClient,
  project: Pick<Project, "id">,
): Promise<void> {
  const { error } = await supabase
    .from("projects")
    .update({ schedule_skip_alerted_at: null })
    .eq("id", project.id)
    .not("schedule_skip_alerted_at", "is", null);
  if (error) {
    console.error(`[report-email] could not clear schedule skip alert: ${error.message}`);
  }
}

export async function sendSingleReportAttempt(
  supabase: SupabaseClient,
  project: Pick<Project, "id" | "user_id" | "brand_name">,
  engine: { provider: Provider; model?: string },
  runId?: string,
): Promise<ReportDelivery> {
  try {
    // A missing link base is configuration suppression, not a failed report.
    // Do not prepare or send a message that could point at the wrong site.
    if (!reportBaseUrl()) return "suppressed";
    let runs: Run[] = [];
    if (runId) {
      const { data, error } = await supabase.from("runs").select("*")
        .eq("id", runId).eq("project_id", project.id).maybeSingle();
      if (error) throw error;
      if (data) runs = [data as Run];
    }
    const content = await buildStoredReportEmail(supabase, project, [engine], runs);
    return sendOwnerReportEmail(supabase, project, content);
  } catch (cause) {
    console.error(`[report-email] could not prepare ${runId ?? "failed attempt"}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return "failed";
  }
}

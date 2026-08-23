import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Flame } from "lucide-react";
import { requireAdmin } from "@/lib/admin";
import { classifyEmail } from "@/lib/growth";
import { deriveCompany } from "@/lib/accounts";
import { createServiceClient } from "@/lib/supabase/service";
import { Badge, Card, SectionHeading, StatCard } from "@/components/ui";
import { formatDate, timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

/**
 * One account, opened up: how often they run, what they monitor, and what
 * they've done. Reached from the People directory on the Growth page.
 *
 * Like the run page, this crosses the user boundary on purpose (service role):
 * the operator is reading their own product's data to understand who is using
 * it and decide who to reach. The admin gate is the whole access control, so it
 * 404s exactly like the rest of /admin for anyone else.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

const SCHEDULE_TONE = { off: "sand", daily: "mint", weekly: "teal" } as const;

interface ProjectRow {
  id: string;
  name: string;
  brand_name: string;
  brand_domains: string[];
  description: string | null;
  schedule: "off" | "daily" | "weekly";
  default_provider: string;
  default_model: string;
  replicates: number;
  use_web_search: boolean;
  last_run_at: string | null;
  created_at: string;
}
interface RunRow {
  id: string;
  project_id: string;
  status: string;
  provider: string;
  model: string;
  prompt_count: number;
  completed_count: number;
  created_at: string;
}
interface TopicRow {
  id: string;
  project_id: string;
  name: string;
}
interface PromptRow {
  id: string;
  project_id: string;
  topic_id: string | null;
  text: string;
  target_url: string | null;
}
interface CompetitorRow {
  id: string;
  project_id: string;
  name: string;
  domain: string | null;
}
interface WatchRow {
  project_id: string;
  enabled: boolean;
  sites: string[];
}
interface ActivityRow {
  id: string;
  category: string;
  action: string;
  status: string;
  summary: string;
  channel: string;
  created_at: string;
}

function statusTone(status: string): "mint" | "terracotta" | "butter" {
  return status === "completed" ? "mint" : status === "failed" ? "terracotta" : "butter";
}
function activityTone(status: string): "mint" | "terracotta" | "butter" | "neutral" {
  return status === "success"
    ? "mint"
    : status === "failure"
      ? "terracotta"
      : status === "pending"
        ? "butter"
        : "neutral";
}

/** 30 days of this account's runs as bars — the answer to "how often". Inline
 *  SVG, colours through style so CSS var() resolves. Mirrors the Growth page. */
function RunSparkline({ series }: { series: { day: string; runs: number }[] }) {
  const max = Math.max(1, ...series.map((d) => d.runs));
  const barW = 600 / series.length;
  return (
    <svg
      viewBox="0 0 600 90"
      preserveAspectRatio="none"
      className="h-24 w-full"
      role="img"
      aria-label="Runs per day, last 30 days"
    >
      {series.map((d, i) => {
        const h = d.runs === 0 ? 2 : Math.max(4, (d.runs / max) * 82);
        return (
          <rect
            key={d.day}
            x={i * barW + 1.5}
            y={86 - h}
            width={barW - 3}
            height={h}
            rx={1.5}
            style={{
              fill: d.runs === 0 ? "rgb(var(--c-ink) / 0.12)" : "rgb(var(--c-mint-bright))",
            }}
          >
            <title>{`${d.day} · ${d.runs} run${d.runs === 1 ? "" : "s"}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function ColumnHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`text-[10px] font-medium uppercase tracking-wider text-ink-faint ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

export default async function AdminAccountPage({ params }: { params: { id: string } }) {
  const admin = await requireAdmin();
  if (!admin) notFound();
  if (!UUID_RE.test(params.id)) notFound();

  const svc = createServiceClient();
  const { data: profile } = await svc
    .from("profiles")
    .select("id, email, created_at, trial_runs_used, trial_tokens_used, trial_spend_micros")
    .eq("id", params.id)
    .maybeSingle();
  if (!profile) notFound();

  const { data: projectRows } = await svc
    .from("projects")
    .select(
      "id, name, brand_name, brand_domains, description, schedule, default_provider, default_model, replicates, use_web_search, last_run_at, created_at",
    )
    .eq("user_id", profile.id)
    .order("created_at", { ascending: true });
  const projects = (projectRows ?? []) as ProjectRow[];
  const projectIds = projects.map((p) => p.id);

  // now/since are needed by the cadence query below, so they're computed here
  // rather than down in the derivation block.
  const now = Date.now();
  const since30d = new Date(now - 30 * DAY_MS).toISOString();

  const emptyRows = Promise.resolve({ data: [] as unknown[] });
  const [recentQ, totalRunsQ, cadenceQ, topicsQ, promptsQ, competitorsQ, watchQ, activityQ] =
    await Promise.all([
      // The Recent-runs list: the latest few, whatever their age. Capped at what
      // the section renders so the count and the list can never disagree.
      projectIds.length
        ? svc
            .from("runs")
            .select(
              "id, project_id, status, provider, model, prompt_count, completed_count, created_at",
            )
            .in("project_id", projectIds)
            .order("created_at", { ascending: false })
            .limit(60)
        : emptyRows,
      // Total runs, exact — the headline number, never capped.
      projectIds.length
        ? svc.from("runs").select("id", { count: "exact", head: true }).in("project_id", projectIds)
        : Promise.resolve({ count: 0 }),
      // Cadence: EVERY run in the last 30 days, date-filtered so runs30d/runs7d
      // and the sparkline stay accurate for heavy accounts instead of saturating
      // at a row cap (the whole reason this page exists is the busy ones). Mirrors
      // the 30-day fetch the Growth top-accounts list uses.
      projectIds.length
        ? svc
            .from("runs")
            .select("created_at")
            .in("project_id", projectIds)
            .gte("created_at", since30d)
            .limit(5_000)
        : emptyRows,
      projectIds.length
        ? svc.from("topics").select("id, project_id, name").in("project_id", projectIds)
        : emptyRows,
    projectIds.length
      ? svc
          .from("prompts")
          .select("id, project_id, topic_id, text, target_url")
          .in("project_id", projectIds)
          .eq("is_active", true)
          .limit(1_000)
      : emptyRows,
    projectIds.length
      ? svc.from("competitors").select("id, project_id, name, domain").in("project_id", projectIds)
      : emptyRows,
    projectIds.length
      ? svc.from("web_mention_watch").select("project_id, enabled, sites").in("project_id", projectIds)
      : emptyRows,
    svc
      .from("activity_logs")
      .select("id, category, action, status, summary, channel, created_at")
      .eq("user_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(40),
  ]);

  const runs = (recentQ.data ?? []) as RunRow[];
  const totalRuns = (totalRunsQ as { count: number | null }).count ?? runs.length;
  const cadence = (cadenceQ.data ?? []) as { created_at: string }[];
  const topics = (topicsQ.data ?? []) as TopicRow[];
  const prompts = (promptsQ.data ?? []) as PromptRow[];
  const competitors = (competitorsQ.data ?? []) as CompetitorRow[];
  const watches = (watchQ.data ?? []) as WatchRow[];
  const activity = (activityQ.data ?? []) as ActivityRow[];

  // ---- Derived identity ----------------------------------------------------
  const email = profile.email as string | null;
  const emailClass = classifyEmail(email);
  const brands = [...new Set(projects.map((p) => p.brand_name).filter(Boolean))];
  const company = deriveCompany(email, emailClass, brands);

  // ---- Cadence -------------------------------------------------------------
  const projLast = projects.reduce<string | null>(
    (acc, p) => (p.last_run_at && (!acc || p.last_run_at > acc) ? p.last_run_at : acc),
    null,
  );
  const runLast = runs[0]?.created_at ?? null; // recent runs are ordered desc
  const lastRunAt = projLast && runLast ? (projLast > runLast ? projLast : runLast) : (projLast ?? runLast);

  // Derived from the date-filtered cadence fetch, not the 60-row recent list, so
  // these stay accurate however many runs a heavy account fires.
  const byDay = new Map<string, number>();
  let runs30d = 0;
  let runs7d = 0;
  for (const r of cadence) {
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t) || t < now - 30 * DAY_MS || t > now) continue;
    runs30d += 1;
    if (t >= now - 7 * DAY_MS) runs7d += 1;
    const day = r.created_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const series: { day: string; runs: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
    series.push({ day, runs: byDay.get(day) ?? 0 });
  }
  const bestDay = series.reduce((a, b) => (b.runs > a.runs ? b : a), series[0]);

  // ---- Per-project rollups -------------------------------------------------
  const topicName = new Map(topics.map((t) => [t.id, t.name]));
  const projectName = new Map(projects.map((p) => [p.id, p.brand_name || p.name]));
  const countBy = <T extends { project_id: string }>(rows: T[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.project_id, (m.get(r.project_id) ?? 0) + 1);
    return m;
  };
  const topicCountByProject = countBy(topics);
  const promptCountByProject = countBy(prompts);
  const competitorsByProject = new Map<string, CompetitorRow[]>();
  for (const c of competitors) {
    const list = competitorsByProject.get(c.project_id) ?? [];
    list.push(c);
    competitorsByProject.set(c.project_id, list);
  }
  const watchByProject = new Map(watches.map((w) => [w.project_id, w]));
  const promptsByProject = new Map<string, PromptRow[]>();
  for (const p of prompts) {
    const list = promptsByProject.get(p.project_id) ?? [];
    list.push(p);
    promptsByProject.set(p.project_id, list);
  }

  // trial_spend_micros and trial_tokens_used are bigint columns; PostgREST can
  // hand a bigint back as a string, so coerce before arithmetic and formatting.
  const spendUsd = Number(profile.trial_spend_micros ?? 0) / 1_000_000;
  const trialRuns = Number(profile.trial_runs_used ?? 0);
  const trialTokens = Number(profile.trial_tokens_used ?? 0);

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/admin/growth"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-faint hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Growth
        </Link>
        <SectionHeading
          title={company || email || "Account"}
          description={
            email
              ? `${email} · ${emailClass} address · signed up ${timeAgo(profile.created_at)} (${formatDate(profile.created_at)})`
              : "This account has no email on file."
          }
          action={<Badge tone={emailClass === "work" ? "teal" : emailClass === "burner" ? "terracotta" : "sand"}>{emailClass}</Badge>}
        />
      </div>

      {/* ---- The numbers ---------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Total runs"
          value={totalRuns.toLocaleString()}
          hint={lastRunAt ? `last run ${timeAgo(lastRunAt)}` : "never run"}
          accent="mint"
        />
        <StatCard
          label="Last 30 days"
          value={runs30d.toLocaleString()}
          hint={`${runs7d} in the last 7d`}
          accent="teal"
        />
        <StatCard
          label="Monitoring"
          value={projects.length.toLocaleString()}
          hint={`${topics.length} topic${topics.length === 1 ? "" : "s"} · ${prompts.length} prompt${prompts.length === 1 ? "" : "s"}`}
          accent="butter"
        />
        <StatCard
          label="Trial spend"
          value={spendUsd.toLocaleString(undefined, { style: "currency", currency: "USD" })}
          hint={`${trialRuns} free run${trialRuns === 1 ? "" : "s"} · ${trialTokens.toLocaleString()} tokens`}
          accent="sand"
        />
      </div>

      {/* ---- Cadence -------------------------------------------------------- */}
      <Card className="flex flex-col">
        <div className="flex flex-col px-5 pb-4 pt-5">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">Runs per day</h3>
            <span className="text-xs text-ink-faint">30d</span>
          </div>
          <div className="mt-3">
            <RunSparkline series={series} />
          </div>
          <p className="mt-3 text-xs tabular-nums text-ink-faint">
            {runs30d.toLocaleString()} runs in 30 days · best day {bestDay.runs} · hover bars for
            counts
          </p>
        </div>
      </Card>

      {/* ---- What they monitor ---------------------------------------------- */}
      <section className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold text-ink">What they monitor</h3>
          <p className="mt-1 max-w-3xl text-sm text-ink-faint">
            The brands, cadence and competitors this account tracks, one card per organization.
          </p>
        </div>
        {projects.length === 0 ? (
          <Card>
            <p className="px-5 py-8 text-sm text-ink-faint">
              No organizations yet: this account signed up but never set one up.
            </p>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {projects.map((p) => {
              const comps = competitorsByProject.get(p.id) ?? [];
              const watch = watchByProject.get(p.id);
              return (
                <Card key={p.id}>
                  <div className="space-y-3 px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-ink">{p.brand_name || p.name}</p>
                        <p className="truncate text-xs text-ink-faint">
                          {p.brand_domains.length > 0 ? p.brand_domains.join(" · ") : "no domains"}
                        </p>
                      </div>
                      <Badge tone={SCHEDULE_TONE[p.schedule] ?? "sand"}>{p.schedule}</Badge>
                    </div>
                    {p.description && (
                      <p className="line-clamp-2 text-xs text-ink-soft">{p.description}</p>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
                      <span>{topicCountByProject.get(p.id) ?? 0} topics</span>
                      <span>{promptCountByProject.get(p.id) ?? 0} prompts</span>
                      <span>{comps.length} competitors</span>
                      <span className="font-mono">
                        {p.default_provider}/{p.default_model}
                      </span>
                      <span>×{p.replicates} replicates</span>
                      <span>{p.use_web_search ? "web search on" : "web search off"}</span>
                      {watch?.enabled && <span>web mentions: {watch.sites.join(", ")}</span>}
                    </div>
                    {comps.length > 0 && (
                      <p className="text-xs text-ink-faint">
                        <span className="text-ink-soft">Competitors:</span>{" "}
                        {comps.map((c) => c.name).join(", ")}
                      </p>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ---- Their prompts -------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h3 className="text-lg font-semibold text-ink">Their prompts</h3>
          <span className="text-sm tabular-nums text-ink-faint">{prompts.length}</span>
        </div>
        <p className="max-w-3xl text-sm text-ink-faint">
          The active questions they ask the engines every run: what they actually care about being
          the answer to.
        </p>
        <Card>
          {prompts.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-faint">No active prompts.</p>
          ) : (
            <div className="max-h-96 divide-y divide-ink/5 overflow-y-auto">
              {prompts.map((p) => (
                <div key={p.id} className="flex items-start gap-3 px-5 py-2.5">
                  <span className="min-w-0 flex-1 text-sm text-ink">{p.text}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    {p.topic_id && topicName.get(p.topic_id) && (
                      <Badge tone="neutral">{topicName.get(p.topic_id)}</Badge>
                    )}
                    {projects.length > 1 && (
                      <span className="hidden text-xs text-ink-faint sm:inline">
                        {projectName.get(p.project_id)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>

      {/* ---- Recent runs ---------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h3 className="text-lg font-semibold text-ink">Recent runs</h3>
          <span className="text-sm tabular-nums text-ink-faint">
            {runs.length}
            {totalRuns > runs.length ? ` of ${totalRuns.toLocaleString()}` : ""}
          </span>
        </div>
        <Card>
          {runs.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-faint">No runs yet.</p>
          ) : (
            <>
              <div className="flex items-center gap-4 border-b border-ink/10 px-5 py-2">
                <ColumnHeader className="flex-1">Organization · engine</ColumnHeader>
                <ColumnHeader className="w-20 text-right">Status</ColumnHeader>
                <ColumnHeader className="w-16 text-right">Answers</ColumnHeader>
                <ColumnHeader className="w-20 text-right">When</ColumnHeader>
                <span className="w-4" />
              </div>
              <div className="max-h-96 divide-y divide-ink/5 overflow-y-auto">
                {runs.map((run, i) => (
                  <Link
                    key={run.id}
                    href={`/admin/runs/${run.id}`}
                    className="flex items-center gap-4 px-5 py-2.5 transition hover:bg-ink/[0.03]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-ink">
                        {projectName.get(run.project_id) ?? "(deleted org)"}
                        {i === 0 && (
                          <Flame
                            className="ml-1 inline h-3.5 w-3.5 align-[-2px] text-terracotta"
                            aria-hidden
                          />
                        )}
                      </p>
                      <p className="truncate font-mono text-xs text-ink-faint">
                        {run.provider}/{run.model}
                      </p>
                    </div>
                    <span className="w-20 shrink-0 text-right">
                      <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                    </span>
                    <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-ink-faint">
                      {run.completed_count}/{run.prompt_count}
                    </span>
                    <span className="w-20 shrink-0 text-right text-xs tabular-nums text-ink-faint">
                      {timeAgo(run.created_at)}
                    </span>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                  </Link>
                ))}
              </div>
            </>
          )}
        </Card>
      </section>

      {/* ---- Activity log --------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h3 className="text-lg font-semibold text-ink">Activity</h3>
          <span className="text-sm tabular-nums text-ink-faint">{activity.length}</span>
        </div>
        <p className="max-w-3xl text-sm text-ink-faint">
          Everything this account has done lately, whatever the surface: dashboard, API, CLI or the
          scheduler.
        </p>
        <Card>
          {activity.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-faint">
              Nothing recorded: either this account is quiet, or activity logging is not populated
              on this deployment.
            </p>
          ) : (
            <div className="max-h-96 divide-y divide-ink/5 overflow-y-auto">
              {activity.map((a) => (
                <div key={a.id} className="flex items-start gap-3 px-5 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">{a.summary}</span>
                    <span className="block truncate font-mono text-xs text-ink-faint">
                      {a.category} · {a.channel}
                    </span>
                  </span>
                  <Badge tone={activityTone(a.status)}>{a.status}</Badge>
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-ink-faint">
                    {timeAgo(a.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>

      <p className="text-xs text-ink-faint">
        Operator view: this page shows one account’s own content so you can see who is using the
        product and what they monitor.{" "}
        <Link href="/admin/growth" className="underline">
          Back to Growth
        </Link>
      </p>
    </div>
  );
}

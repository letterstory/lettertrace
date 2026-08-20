import Link from "next/link";
import {
  BarChart3,
  CheckCircle2,
  Circle,
  KeyRound,
  ListChecks,
  Play,
  Users,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  SectionHeading,
  StatCard,
} from "@/components/ui";
import {
  ShareBars,
  SentimentDonut,
  TrendChart,
  EngineTrendChart,
} from "@/components/dashboard/charts-lazy";
import { MeasurementNote } from "@/components/dashboard/measurement-note";
import { Onboarding } from "./onboarding";
import { createClient } from "@/lib/supabase/server";
import { getConfiguredProviders, getProject } from "@/lib/data";
import {
  computeCitationStats,
  computeEntityStats,
  computeMeasurementQuality,
  computeRunSummary,
  computeTopicStats,
  type EntityStat,
} from "@/lib/metrics";
import { modelLabel, PROVIDERS } from "@/lib/models";
import { formatDate, pct, timeAgo } from "@/lib/utils";
import type { Mention, Provider, Run, Source, Topic } from "@/lib/types";

export const dynamic = "force-dynamic";

function sentimentLabel(score: number): string {
  if (score >= 0.2) return "Positive";
  if (score <= -0.2) return "Negative";
  return "Mixed";
}

function signed(value: number): string {
  const fixed = value.toFixed(2);
  return value > 0 ? `+${fixed}` : fixed;
}

export default async function DashboardPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const project = await getProject(supabase, user.id);

  if (!project) {
    return <Onboarding />;
  }

  // Quick counts + provider config.
  const [
    topicsCount,
    activePromptsCount,
    competitorsCount,
    configuredProviders,
    runsResult,
  ] = await Promise.all([
    supabase
      .from("topics")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id),
    supabase
      .from("prompts")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id)
      .eq("is_active", true),
    supabase
      .from("competitors")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id),
    getConfiguredProviders(supabase, user.id),
    supabase
      .from("runs")
      .select("*")
      .eq("project_id", project.id)
      .eq("status", "completed")
      .order("created_at", { ascending: false }),
  ]);

  const topics = topicsCount.count ?? 0;
  const activePrompts = activePromptsCount.count ?? 0;
  const competitors = competitorsCount.count ?? 0;
  const hasKey = configuredProviders.length > 0;
  const runs = (runsResult.data as Run[] | null) ?? [];

  const heading = (
    <SectionHeading
      title="Overview"
      description={`How AI assistants talk about ${project.brand_name}.`}
      action={
        runs.length > 0 ? (
          <Button href="/dashboard/runs" variant="secondary" size="sm">
            View all runs
          </Button>
        ) : undefined
      }
    />
  );

  // --------------------------------------------------------------
  // Onboarding state: no completed runs yet.
  // --------------------------------------------------------------
  if (runs.length === 0) {
    const steps = [
      {
        done: hasKey,
        title: "Add an API key",
        description: "Bring your own OpenAI, Anthropic, or Google key, it stays encrypted.",
        href: "/dashboard/settings",
        icon: KeyRound,
      },
      {
        done: competitors > 0,
        title: "Add competitors",
        description: "Benchmark your share of voice against rival brands.",
        href: "/dashboard/competitors",
        icon: Users,
      },
      {
        done: activePrompts > 0,
        title: "Add topics & generate variations",
        description: "Turn a topic into realistic prompts people actually ask.",
        href: "/dashboard/topics",
        icon: ListChecks,
      },
      {
        done: false,
        title: "Run your first monitor",
        description: "Query the models with your key and see who gets mentioned.",
        href: "/dashboard/runs",
        icon: Play,
      },
    ];

    return (
      <div className="space-y-8">
        {heading}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Topics" value={topics} accent="teal" />
          <StatCard label="Active prompts" value={activePrompts} accent="mint" />
          <StatCard label="Competitors" value={competitors} accent="sand" />
          <StatCard
            label="API key"
            value={hasKey ? "Ready" : "None"}
            accent="terracotta"
            hint={hasKey ? "Bring-your-own-key set" : "Add one to run monitors"}
          />
        </div>

        <Card>
          <CardBody className="p-6 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-ink">Get started</h3>
                <p className="mt-1 text-sm text-ink-soft">
                  Four quick steps to your first visibility report.
                </p>
              </div>
              <Badge tone="terracotta">
                {steps.filter((s) => s.done).length} / {steps.length} done
              </Badge>
            </div>

            <ol className="mt-6 space-y-3">
              {steps.map((step, i) => {
                const Icon = step.icon;
                return (
                  <li key={step.title}>
                    <Link
                      href={step.href}
                      className="group flex items-start gap-4 rounded border border-ink/10 bg-paper p-4 transition hover:border-ink/25 hover:shadow-card"
                    >
                      <span className="mt-0.5 shrink-0">
                        {step.done ? (
                          <CheckCircle2 className="h-6 w-6 text-mint-bright" />
                        ) : (
                          <Circle className="h-6 w-6 text-ink-faint/50" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-ink-faint">
                            Step {i + 1}
                          </span>
                          <Icon className="h-3.5 w-3.5 text-ink-faint" />
                        </div>
                        <p className="mt-0.5 font-medium text-ink">{step.title}</p>
                        <p className="mt-0.5 text-sm text-ink-soft">
                          {step.description}
                        </p>
                      </div>
                      <span className="mt-1 shrink-0 text-sm font-medium text-terracotta-dark opacity-0 transition group-hover:opacity-100">
                        {step.done ? "Review" : "Start"} →
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </CardBody>
        </Card>
      </div>
    );
  }

  // --------------------------------------------------------------
  // Results state: at least one completed run exists.
  // --------------------------------------------------------------
  const latestRun = runs[0];

  // Runs can span answer engines now. The latest run per engine feeds the
  // by-engine card and the overall rollup; the trend goes per-engine (and
  // deeper) the moment a second engine appears, because ten mixed runs is only
  // ~three points per line.
  const engineLatest = new Map<Provider, Run>();
  for (const run of runs) {
    if (!engineLatest.has(run.provider as Provider)) {
      engineLatest.set(run.provider as Provider, run);
    }
  }
  const multiEngine = engineLatest.size > 1;

  // One batched fetch covers the latest run AND the trend: all mentions
  // for those runs in a single IN query, grouped in memory, replacing ~2
  // queries per historical run. Per-run answer counts come straight from
  // runs.completed_count (set by the engine), so no response rows are fetched
  // for counting — responses are only read for the latest run's topic split.
  const trendRuns = runs.slice(0, multiEngine ? 20 : 10);
  const trendIds = trendRuns.map((r) => r.id);
  // Each engine's latest run may sit outside the trend window; its mentions
  // are still needed for the by-engine card.
  const mentionIds = Array.from(
    new Set([...trendIds, ...Array.from(engineLatest.values(), (r) => r.id)]),
  );

  const [mentionsResult, latestResponsesResult, topicsList, latestSourcesResult] = await Promise.all([
    // NOTE: capped at 1000 rows by PostgREST; fine for ~20 runs of mention rows
    // (only detected entities produce rows). Revisit if trend depth grows.
    supabase.from("mentions").select("*").in("run_id", mentionIds),
    supabase.from("responses").select("topic_id").eq("run_id", latestRun.id),
    supabase.from("topics").select("*").eq("project_id", project.id),
    supabase
      .from("sources")
      .select("response_id, url, is_owned")
      .eq("run_id", latestRun.id),
  ]);

  const allMentions = (mentionsResult.data as Mention[] | null) ?? [];
  const latestResponses =
    (latestResponsesResult.data as { topic_id: string | null }[] | null) ?? [];

  const mentionsByRun = new Map<string, Mention[]>();
  for (const m of allMentions) {
    const list = mentionsByRun.get(m.run_id) ?? [];
    list.push(m);
    mentionsByRun.set(m.run_id, list);
  }
  const responseCountByRun = new Map<string, number>(
    trendRuns.map((r) => [r.id, r.completed_count]),
  );

  const latestMentions = mentionsByRun.get(latestRun.id) ?? [];
  const totalResponses = latestRun.completed_count;

  const stats = computeEntityStats(latestMentions, totalResponses, project.brand_name);
  const brand = stats.find((s) => s.type === "brand");
  const summary = computeRunSummary(latestMentions, totalResponses, project.brand_name);
  // How much this run actually measured. Without it a 0% reads the same whether
  // the models picked a competitor or recommended nobody at all.
  const quality = computeMeasurementQuality(latestMentions, totalResponses);

  // Citations move before mentions do — for a brand with no mentions yet, this
  // is the only card on this page that will change.
  const citations = computeCitationStats(
    (latestSourcesResult.data as Pick<Source, "response_id" | "url" | "is_owned">[] | null) ?? [],
    totalResponses,
  );

  // Trend across recent completed runs (chronological). Single-engine keeps
  // the visibility + share pair; once runs span engines each run becomes a
  // point on its own engine's visibility line — a blended line would zigzag
  // between numbers that aren't comparable.
  const trendData = trendRuns
    .slice()
    .reverse()
    .map((run) => {
      const s = computeRunSummary(
        mentionsByRun.get(run.id) ?? [],
        responseCountByRun.get(run.id) ?? 0,
      );
      return {
        date: formatDate(run.created_at),
        visibility: Math.round(s.brandMentionRate * 100),
        share: Math.round(s.brandShareOfVoice * 100),
      };
    });
  const engineSeries = Array.from(engineLatest.keys(), (p) => ({
    key: p,
    label: PROVIDERS[p]?.label ?? p,
  }));
  const engineTrendData = trendRuns
    .slice()
    .reverse()
    .map((run) => {
      const s = computeRunSummary(
        mentionsByRun.get(run.id) ?? [],
        responseCountByRun.get(run.id) ?? 0,
      );
      return {
        date: formatDate(run.created_at),
        [run.provider]: Math.round(s.brandMentionRate * 100),
      };
    });

  // Latest run per engine → the by-engine card and the overall rollup.
  // Rollup per the design doc: a simple mean across engines, each counted
  // equally ("average across N engines" — explainable beats clever), with an
  // engine dropping out of the rollup once its latest run is older than 30
  // days. Stale engines stay visible in the card, tagged with their age.
  const STALE_MS = 30 * 24 * 60 * 60 * 1000;
  const engineRows = Array.from(engineLatest.entries(), ([provider, run]) => {
    const s = computeRunSummary(mentionsByRun.get(run.id) ?? [], run.completed_count);
    return {
      provider,
      label: PROVIDERS[provider]?.label ?? provider,
      model: modelLabel(run.provider, run.model),
      visibility: s.brandMentionRate,
      share: s.brandShareOfVoice,
      ranAt: run.created_at,
      stale: Date.now() - new Date(run.created_at).getTime() > STALE_MS,
    };
  }).sort((a, b) => b.visibility - a.visibility);
  const rollupRows = engineRows.filter((r) => !r.stale);
  const overallVisibility =
    rollupRows.length > 0
      ? rollupRows.reduce((sum, r) => sum + r.visibility, 0) / rollupRows.length
      : null;

  // Share-of-voice leaderboard (brand + competitors, desc by share).
  const shareEntities: EntityStat[] = [...stats].sort(
    (a, b) => b.shareOfVoice - a.shareOfVoice,
  );
  const shareBarData = shareEntities.map((s) => ({
    name: s.name,
    value: Math.round(s.shareOfVoice * 100),
    isBrand: s.type === "brand",
  }));

  // Sentiment donut for the brand.
  const sentimentData = brand
    ? [
        { name: "Positive", value: brand.sentiment.positive },
        { name: "Neutral", value: brand.sentiment.neutral },
        { name: "Negative", value: brand.sentiment.negative },
      ]
    : [];

  // Per-topic breakdown (latest run only).
  const responsesByTopic = new Map<string | null, number>();
  for (const row of latestResponses) {
    responsesByTopic.set(row.topic_id, (responsesByTopic.get(row.topic_id) ?? 0) + 1);
  }
  const topicStats = computeTopicStats(latestMentions, responsesByTopic);
  const topicNames = new Map<string, string>(
    ((topicsList.data as Topic[] | null) ?? []).map((t) => [t.id, t.name]),
  );

  return (
    <div className="space-y-8">
      {heading}

      {/* Headline stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard
          label="Brand visibility"
          value={pct(brand?.mentionRate ?? 0)}
          accent="terracotta"
          // Show the sample behind the rate. A 0% from three answers and a 0%
          // from thirty look identical without it, and only one is a finding.
          hint={`${summary.brandResponsesMentioned} of ${totalResponses} answers · 95% CI ${pct(
            summary.brandMentionRateInterval.low,
          )}–${pct(summary.brandMentionRateInterval.high)}`}
        />
        <StatCard
          label="Cited your site"
          value={pct(citations.ownedCitationRate)}
          accent="teal"
          hint={
            citations.distinctOwnedUrls > 0
              ? `${citations.responsesWithOwnedSource} of ${totalResponses} answers · ${citations.distinctOwnedUrls} page${
                  citations.distinctOwnedUrls === 1 ? "" : "s"
                } cited`
              : "models haven't read your pages yet"
          }
        />
        <StatCard
          label="Share of voice"
          value={pct(brand?.shareOfVoice ?? 0)}
          accent="mint"
          hint="your slice of all brand mentions"
        />
        <StatCard
          label="Sentiment"
          value={
            <span className="flex items-baseline gap-2">
              {signed(brand?.sentimentScore ?? 0)}
              <span className="text-sm font-medium text-ink-faint">
                {sentimentLabel(brand?.sentimentScore ?? 0)}
              </span>
            </span>
          }
          accent="sand"
          hint="net tone when you appear"
        />
        <StatCard
          label="Prominence"
          value={pct(brand?.avgProminence ?? 0)}
          accent="teal"
          hint="how early you appear"
        />
      </div>

      {/* What the numbers above are worth. */}
      <MeasurementNote
        totalResponses={totalResponses}
        responsesNamingSomeone={quality.responsesNamingSomeone}
        informativeRate={quality.informativeRate}
        brandMentioned={(summary.brandResponsesMentioned ?? 0) > 0}
        competitorsTracked={competitors}
      />

      {/* Visibility by engine + the overall rollup. Only once a second engine
          has data — for a single engine the headline stats already say it. */}
      {multiEngine && (
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-ink">Overall AI visibility</h3>
                <p className="mt-0.5 text-sm text-ink-soft">
                  {overallVisibility !== null
                    ? `Average across ${rollupRows.length} engine${rollupRows.length === 1 ? "" : "s"}, latest run each.`
                    : "No engine has run in the last 30 days."}
                </p>
              </div>
              {overallVisibility !== null && (
                <span className="text-3xl font-semibold tracking-tight text-ink">
                  {pct(overallVisibility)}
                </span>
              )}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {engineRows.map((row) => (
                <div key={row.provider} className="rounded border border-ink/10 p-3.5">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                    {row.label}
                  </p>
                  <p className="mt-1 text-2xl font-semibold text-ink">{pct(row.visibility)}</p>
                  <p className="mt-1 text-xs text-ink-soft">
                    share of voice {pct(row.share)}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {row.model} · {timeAgo(row.ranAt)}
                    {/* Stale engines stay listed but leave the rollup — an
                        engine last measured a month ago isn't "overall" truth. */}
                    {row.stale && " · not in average"}
                  </p>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Trend + sentiment donut */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-ink">Visibility over time</h3>
                <p className="mt-0.5 text-sm text-ink-soft">
                  {multiEngine
                    ? "Brand visibility across recent runs, one line per answer engine."
                    : "Brand visibility and share of voice across recent runs."}
                </p>
              </div>
            </div>
            {multiEngine ? (
              <EngineTrendChart data={engineTrendData} series={engineSeries} />
            ) : (
              <TrendChart data={trendData} />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <h3 className="text-lg font-semibold text-ink">Brand sentiment</h3>
            <p className="mt-0.5 text-sm text-ink-soft">
              Tone of answers that mention {project.brand_name}.
            </p>
            <div className="mt-4">
              <SentimentDonut data={sentimentData} />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Share of voice + per-topic */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardBody>
            <h3 className="text-lg font-semibold text-ink">Share of voice</h3>
            <p className="mt-0.5 text-sm text-ink-soft">
              You vs. tracked competitors in the latest run.
            </p>
            {/* Mention detection only looks for the brand and the competitors
                this project tracks, so with none configured the chart can
                never populate no matter what the answers said. "No share of
                voice yet" gave no hint of that — say which of the two is
                actually the problem. */}
            {competitors === 0 ? (
              <div className="mt-4 rounded border border-dashed border-ink/15 px-5 py-8 text-center">
                <p className="text-sm text-ink-soft">
                  No competitors tracked yet, so there is nothing to compare against.
                </p>
                <p className="mt-1 text-sm text-ink-faint">
                  We only look for brands you list. Companies named in an answer are
                  invisible until you add them.
                </p>
                <Link
                  href="/dashboard/competitors"
                  className="mt-3 inline-block text-sm font-medium text-terracotta-dark transition hover:text-terracotta"
                >
                  Add competitors →
                </Link>
              </div>
            ) : (
              <div className="mt-4">
                <ShareBars data={shareBarData} />
              </div>
            )}
            <ul className="mt-4 space-y-2">
              {shareEntities.map((s, i) => (
                <li
                  key={s.key}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="flex items-center gap-2 truncate">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-sm ${
                        s.type === "brand" ? "bg-terracotta" : "bg-teal"
                      }`}
                    />
                    <span className="truncate text-ink">{s.name}</span>
                    {s.type === "brand" && <Badge tone="terracotta">You</Badge>}
                  </span>
                  <span className="shrink-0 font-medium text-ink-soft">
                    {pct(s.shareOfVoice)}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <h3 className="text-lg font-semibold text-ink">By topic</h3>
            <p className="mt-0.5 text-sm text-ink-soft">
              Where you show up most across monitored topics.
            </p>
            {topicStats.length === 0 ? (
              <p className="mt-6 text-sm text-ink-faint">No topic data in this run yet.</p>
            ) : (
              <div className="mt-4 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink/10 text-left text-xs font-medium text-ink-faint">
                      <th className="pb-2 pr-3 font-medium">Topic</th>
                      <th className="pb-2 px-3 text-right font-medium">Answers</th>
                      <th className="pb-2 px-3 text-right font-medium">You</th>
                      <th className="pb-2 pl-3 font-medium">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topicStats.map((t) => {
                      const name =
                        t.topicId === null
                          ? "Uncategorized"
                          : topicNames.get(t.topicId) ?? "Unknown topic";
                      return (
                        <tr
                          key={t.topicId ?? "none"}
                          className="border-b border-ink/[0.06] last:border-0"
                        >
                          <td className="py-2.5 pr-3 text-ink">{name}</td>
                          <td className="py-2.5 px-3 text-right text-ink-soft">
                            {t.totalResponses}
                          </td>
                          <td className="py-2.5 px-3 text-right text-ink-soft">
                            {t.brandMentions}
                          </td>
                          <td className="py-2.5 pl-3">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-16 overflow-hidden rounded-sm bg-ink/[0.08]">
                                <div
                                  className="h-full rounded-sm bg-terracotta"
                                  style={{
                                    width: `${Math.round(t.mentionRate * 100)}%`,
                                  }}
                                />
                              </div>
                              <span className="w-10 shrink-0 text-right text-xs font-medium text-ink-soft">
                                {pct(t.mentionRate)}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Latest run caption */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-ink/10 bg-paper-shade/50 px-5 py-4">
        <p className="text-sm text-ink-faint">
          Latest run:{" "}
          <span className="font-medium text-ink">
            {modelLabel(latestRun.provider, latestRun.model)}
          </span>{" "}
          · {totalResponses} answers · {timeAgo(latestRun.created_at)}
        </p>
        <Button href="/dashboard/runs" variant="secondary" size="sm">
          View all runs
        </Button>
      </div>
    </div>
  );
}

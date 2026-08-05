import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Globe } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { modelLabel } from "@/lib/models";
import { pct, timeAgo } from "@/lib/utils";
import {
  computeEntityStats,
  computePromptEntityStats,
  computeCompetitorCitations,
  SENTIMENT_COLORS,
} from "@/lib/metrics";
import type {
  Competitor,
  Mention,
  Prompt,
  Response,
  Run,
  RunStatus,
  Sentiment,
  Source,
} from "@/lib/types";
import {
  Card,
  CardBody,
  SectionHeading,
  Badge,
  StatCard,
  EmptyState,
} from "@/components/ui";
import { discoverCompanies, untrackedNamesInAnswer } from "@/lib/discover";
import { isAbandoned, settleAbandonedRun, INTERRUPTED_RUN_ERROR } from "@/lib/engine";
import { MarkResultsSeen } from "./mark-seen";
import { TrackUntrackedCompanies } from "./track-companies";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<RunStatus, "mint" | "teal" | "terracotta" | "neutral"> = {
  completed: "mint",
  running: "teal",
  failed: "terracotta",
  pending: "neutral",
};

function SentimentDot({ sentiment }: { sentiment: Sentiment | null }) {
  const color = SENTIMENT_COLORS[sentiment ?? "neutral"];
  return (
    <span
      className="inline-block h-2 w-2 rounded-sm"
      style={{ backgroundColor: color }}
      aria-label={sentiment ?? "neutral"}
    />
  );
}

export default async function RunDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const project = await getProject(supabase, user.id);
  if (!project) {
    return (
      <div className="space-y-8">
        <SectionHeading title="Run" />
        <EmptyState title="No project yet" description="Create your project to view runs." />
      </div>
    );
  }

  const { data: runRow } = await supabase
    .from("runs")
    .select("*")
    .eq("id", params.id)
    .eq("project_id", project.id)
    .maybeSingle();
  if (!runRow) notFound();
  const run = runRow as Run;

  // Self-heal a provably-dead run on read, like the runs list and the status
  // endpoint — so opening a stuck run shows "failed" with its partial answers,
  // not a phantom "running".
  if (isAbandoned(run) && (await settleAbandonedRun(supabase, run.id, INTERRUPTED_RUN_ERROR))) {
    run.status = "failed";
    run.error = INTERRUPTED_RUN_ERROR;
    run.finished_at = new Date().toISOString();
  }

  const { data: responseRows } = await supabase
    .from("responses")
    .select("*")
    .eq("run_id", run.id)
    .order("created_at", { ascending: true });
  const responses = (responseRows ?? []) as Response[];

  const { data: mentionRows } = await supabase
    .from("mentions")
    .select("*")
    .eq("run_id", run.id);
  const mentions = (mentionRows ?? []) as Mention[];

  const { data: sourceRows } = await supabase
    .from("sources")
    .select("*")
    .eq("run_id", run.id);
  const sources = (sourceRows ?? []) as Source[];

  const { data: promptRows } = await supabase
    .from("prompts")
    .select("*")
    .eq("project_id", project.id);
  const prompts = (promptRows ?? []) as Prompt[];
  const promptText = new Map(prompts.map((p) => [p.id, p.text]));

  const { data: competitorRows } = await supabase
    .from("competitors")
    .select("id, name, domain, aliases")
    .eq("project_id", project.id);
  const competitors = (competitorRows ?? []) as Pick<
    Competitor,
    "id" | "name" | "domain" | "aliases"
  >[];

  // Everything already accounted for — the brand, its aliases, and every tracked
  // competitor's name and aliases. discoverCompanies / untrackedNamesInAnswer
  // subtract this, so what's left is genuinely untracked.
  const trackedTerms = [
    project.brand_name,
    ...(project.brand_aliases ?? []),
    ...competitors.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
  ];
  // Companies THIS run named that aren't tracked, most-named first (candidates).
  const untrackedInRun = discoverCompanies(
    responses.map((r) => r.response_text),
    trackedTerms,
    { limit: 12 },
  );

  const mentionsByResponse = new Map<string, Mention[]>();
  for (const m of mentions) {
    const list = mentionsByResponse.get(m.response_id) ?? [];
    list.push(m);
    mentionsByResponse.set(m.response_id, list);
  }

  const sourcesByResponse = new Map<string, Source[]>();
  for (const s of sources) {
    const list = sourcesByResponse.get(s.response_id) ?? [];
    list.push(s);
    sourcesByResponse.set(s.response_id, list);
  }

  const stats = computeEntityStats(mentions, responses.length, project.brand_name);
  const brand = stats.find((s) => s.type === "brand");
  const topCompetitor = stats.find((s) => s.type === "competitor");

  // Competitors per QUESTION, aggregated across replicates — the view the
  // per-answer list below can't give: for each question, who gets named (and
  // whose site gets cited), and where the brand is missing entirely. The two
  // signals are separate events: named in the prose vs. cited as a source.
  const citedRateByPrompt = new Map<string, Map<string, number>>();
  for (const pc of computeCompetitorCitations(sources, competitors, responses, prompts)) {
    citedRateByPrompt.set(
      pc.promptId,
      new Map(pc.competitors.map((c) => [c.name.toLowerCase(), c.citedRate])),
    );
  }
  const competitorName = new Map(competitors.map((c) => [c.name.toLowerCase(), c.name]));
  const competitionByPrompt = computePromptEntityStats(
    mentions,
    responses,
    prompts,
    project.brand_name,
  )
    .map((ps) => {
      const cited = citedRateByPrompt.get(ps.promptId);
      const brandRow = ps.entities.find((e) => e.type === "brand");
      const rivals = ps.entities
        .filter((e) => e.type === "competitor")
        .map((e) => ({
          name: e.name,
          mentionRate: e.mentionRate,
          citedRate: cited?.get(e.name.toLowerCase()) ?? 0,
        }));
      // Rivals cited but never named must still show — being read is a real signal.
      if (cited) {
        for (const [nameLower, citedRate] of cited) {
          if (!rivals.some((r) => r.name.toLowerCase() === nameLower)) {
            rivals.push({
              name: competitorName.get(nameLower) ?? nameLower,
              mentionRate: 0,
              citedRate,
            });
          }
        }
      }
      rivals.sort(
        (a, b) => Math.max(b.mentionRate, b.citedRate) - Math.max(a.mentionRate, a.citedRate),
      );
      return {
        promptId: ps.promptId,
        promptText: ps.promptText,
        totalResponses: ps.totalResponses,
        brandMentionRate: brandRow?.mentionRate ?? 0,
        rivals,
        // The brand is absent while a rival shows up strongly — the ground to build.
        gap:
          (brandRow?.mentionRate ?? 0) === 0 &&
          rivals.some((r) => Math.max(r.mentionRate, r.citedRate) >= 0.3),
      };
    })
    .filter((p) => p.rivals.length > 0)
    // Gaps first, then the questions rivals win hardest.
    .sort((a, b) => {
      if (a.gap !== b.gap) return a.gap ? -1 : 1;
      const at = Math.max(0, ...a.rivals.map((r) => Math.max(r.mentionRate, r.citedRate)));
      const bt = Math.max(0, ...b.rivals.map((r) => Math.max(r.mentionRate, r.citedRate)));
      return bt - at;
    });

  // Was the brand's own site cited? A leading indicator independent of mentions.
  const ownedResponseIds = new Set(sources.filter((s) => s.is_owned).map((s) => s.response_id));
  const anySources = sources.length > 0;

  return (
    <div className="space-y-8">
      {/* Reaching this page is what "checked the results" means, so it clears
          the dashboard nudge however the user arrived. */}
      <MarkResultsSeen runId={run.id} />
      <div className="space-y-4">
        <a
          href="/dashboard/runs"
          className="inline-flex items-center gap-1 text-sm text-ink-faint hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Back to runs
        </a>
        <SectionHeading
          title="Run results"
          description={`${modelLabel(run.provider, run.model)} · ${run.completed_count} / ${run.prompt_count} answers · ${timeAgo(run.created_at)}`}
          action={<Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>}
        />
        {run.error && <p className="text-sm text-terracotta">{run.error}</p>}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Brand visibility"
          value={pct(brand?.mentionRate ?? 0)}
          hint={`${brand?.responsesMentioned ?? 0} of ${responses.length} answers`}
          accent="terracotta"
        />
        <StatCard
          label="Share of voice"
          value={pct(brand?.shareOfVoice ?? 0)}
          hint="Of all brand + competitor mentions"
          accent="teal"
        />
        <StatCard
          label="Sentiment"
          value={brand ? brand.sentimentScore.toFixed(2) : "n/a"}
          hint="-1 to +1 across mentions"
          accent="mint"
        />
        <StatCard
          label="Top competitor"
          value={topCompetitor?.name ?? "None"}
          hint={topCompetitor ? `${pct(topCompetitor.mentionRate)} visibility` : "No competitors mentioned"}
          accent="sand"
        />
      </div>

      {anySources && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-ink/10 bg-paper-shade/50 px-5 py-4 text-sm">
          <Globe className="h-4 w-4 text-ink-faint" />
          {ownedResponseIds.size > 0 ? (
            <p className="text-ink">
              Your site was cited in{" "}
              <span className="font-semibold text-terracotta-dark">
                {ownedResponseIds.size} of {responses.length}
              </span>{" "}
              answers, even where you weren&apos;t named.
            </p>
          ) : (
            <p className="text-ink-faint">
              Your site wasn&apos;t cited as a source in this run. {sources.length} sources were
              pulled across {responses.length} answers.
            </p>
          )}
        </div>
      )}

      {/* The field the tracked numbers can't see — companies the answers named
          that aren't on the competitor list. One click adds them. */}
      <TrackUntrackedCompanies companies={untrackedInRun} />

      {competitionByPrompt.length > 0 && (
        <div className="space-y-3">
          <SectionHeading
            title="Competitors by question"
            description="Across all replicates: who gets named — and whose site gets cited — for each question. “You’re missing” flags where a competitor shows up and your brand doesn’t."
          />
          <div className="space-y-3">
            {competitionByPrompt.map((p) => (
              <Card key={p.promptId}>
                <CardBody className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-serif text-base text-ink">{p.promptText ?? "(prompt removed)"}</p>
                    {p.gap && <Badge tone="terracotta">You&apos;re missing</Badge>}
                  </div>
                  <p className="text-xs text-ink-faint">
                    You:{" "}
                    <span className={p.brandMentionRate > 0 ? "text-terracotta-dark" : "text-ink"}>
                      named {pct(p.brandMentionRate)}
                    </span>{" "}
                    of {p.totalResponses} answers
                  </p>
                  <ul className="space-y-1.5">
                    {p.rivals.map((r) => (
                      <li key={r.name} className="flex items-center gap-3 text-sm">
                        <span className="w-40 shrink-0 truncate font-medium text-ink">{r.name}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded bg-paper-shade">
                          <div
                            className="h-full rounded bg-teal"
                            style={{ width: `${Math.round(r.mentionRate * 100)}%` }}
                          />
                        </div>
                        <span className="w-40 shrink-0 text-right text-xs tabular-nums text-ink-faint">
                          named {pct(r.mentionRate)}
                          {r.citedRate > 0 && (
                            <span className="text-teal-dark"> · cited {pct(r.citedRate)}</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            ))}
          </div>
        </div>
      )}

      {responses.length === 0 ? (
        <EmptyState
          title="No answers recorded"
          description="This run did not produce any answers. Check that your prompts are active and your key is valid."
        />
      ) : (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-ink">Answers ({responses.length})</h3>
          {responses.map((response) => {
            const question = promptText.get(response.prompt_id) ?? "(prompt removed)";
            const rMentions = mentionsByResponse.get(response.id) ?? [];
            const rSources = sourcesByResponse.get(response.id) ?? [];
            // Companies this answer named that aren't tracked — so an answer full
            // of untracked rivals reads as that, not as "named nobody".
            const rUntracked = untrackedNamesInAnswer(response.response_text, trackedTerms);
            return (
              <Card key={response.id}>
                <CardBody className="space-y-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                      Question
                    </p>
                    <p className="mt-1 font-serif text-base text-ink">{question}</p>
                  </div>

                  <div>
                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-faint">
                      Answer
                    </p>
                    <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded bg-paper-shade p-4 text-sm leading-relaxed text-ink-soft">
                      {response.response_text}
                    </div>
                  </div>

                  <div className="space-y-2">
                    {rMentions.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        {rMentions.map((m) => (
                          <div key={m.id} className="flex items-center gap-1.5">
                            <Badge tone={m.entity_type === "brand" ? "terracotta" : "teal"}>
                              <SentimentDot sentiment={m.sentiment} />
                              {m.entity_name}
                              <span className="text-ink-faint">×{m.mention_count}</span>
                            </Badge>
                            {m.recommended && <Badge tone="mint">Recommended</Badge>}
                          </div>
                        ))}
                      </div>
                    )}
                    {rUntracked.length > 0 ? (
                      <p className="text-xs text-ink-faint">
                        {rMentions.length > 0 ? "Also named" : "Named, but not tracked"}:{" "}
                        <span className="text-ink-soft">{rUntracked.join(", ")}</span>
                      </p>
                    ) : (
                      rMentions.length === 0 && (
                        <p className="text-sm text-ink-faint">No companies named.</p>
                      )
                    )}
                  </div>

                  {rSources.length > 0 && (
                    <div className="border-t border-ink/10 pt-4">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
                        Sources cited ({rSources.length})
                      </p>
                      <ul className="space-y-1.5">
                        {rSources.map((s) => (
                          <li key={s.id} className="flex items-start gap-2 text-sm">
                            <Globe
                              className={
                                "mt-0.5 h-3.5 w-3.5 shrink-0 " +
                                (s.is_owned ? "text-terracotta" : "text-ink-faint")
                              }
                            />
                            <span className="min-w-0">
                              <a
                                href={s.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 font-medium text-ink hover:text-terracotta-dark"
                              >
                                <span className="truncate">{s.title || s.domain}</span>
                                <ExternalLink className="h-3 w-3 shrink-0 text-ink-faint" />
                              </a>
                              {s.is_owned && <Badge tone="terracotta">Your site</Badge>}
                              <span className="ml-1 text-xs text-ink-faint">{s.domain}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Globe } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { modelLabel } from "@/lib/models";
import { pct, timeAgo } from "@/lib/utils";
import { computeEntityStats, SENTIMENT_COLORS } from "@/lib/metrics";
import type { Mention, Prompt, Response, Run, RunStatus, Sentiment, Source } from "@/lib/types";
import {
  Card,
  CardBody,
  SectionHeading,
  Badge,
  StatCard,
  EmptyState,
} from "@/components/ui";
import { MarkResultsSeen } from "./mark-seen";

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

                  <div>
                    {rMentions.length === 0 ? (
                      <p className="text-sm text-ink-faint">
                        No brand or competitor mentioned.
                      </p>
                    ) : (
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

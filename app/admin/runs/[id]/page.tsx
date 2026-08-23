import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/admin";
import { classifyEmail } from "@/lib/growth";
import { createServiceClient } from "@/lib/supabase/service";
import { Badge, Card, SectionHeading, StatCard } from "@/components/ui";
import { timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

/**
 * One run, opened up: the prompts that were asked, the answers that came
 * back, and what the engines said about the account's brand. Reached from
 * the Growth page's run log.
 *
 * This crosses the user boundary on purpose (service role): the operator is
 * reading their own product's data to write a better outbound email —
 * "ChatGPT recommended your competitor in 4 of your 12 prompts" beats
 * "just checking in". The admin gate is the whole access control, so it 404s
 * exactly like the rest of /admin for anyone else.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MentionRow {
  response_id: string;
  entity_type: string;
  entity_name: string;
  mentioned: boolean;
  sentiment: string | null;
  recommended: boolean;
}

interface SourceRow {
  response_id: string;
  domain: string;
  is_owned: boolean;
}

export default async function AdminRunPage({ params }: { params: { id: string } }) {
  const admin = await requireAdmin();
  if (!admin) notFound();
  if (!UUID_RE.test(params.id)) notFound();

  const svc = createServiceClient();
  const { data: run } = await svc
    .from("runs")
    .select(
      "id, project_id, status, provider, model, prompt_count, completed_count, replicates, route, error, created_at, finished_at",
    )
    .eq("id", params.id)
    .maybeSingle();
  if (!run) notFound();

  const [{ data: project }, { data: responses }] = await Promise.all([
    svc
      .from("projects")
      .select("id, user_id, name, brand_name")
      .eq("id", run.project_id)
      .maybeSingle(),
    svc
      .from("responses")
      .select("id, prompt_id, provider, model, response_text, created_at")
      .eq("run_id", run.id)
      .order("created_at", { ascending: true })
      .limit(500),
  ]);

  const promptIds = [...new Set((responses ?? []).map((r) => r.prompt_id).filter(Boolean))];
  const [{ data: profile }, { data: prompts }, { data: mentions }, { data: sources }] =
    await Promise.all([
      project
        ? svc.from("profiles").select("email").eq("id", project.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
      promptIds.length > 0
        ? svc.from("prompts").select("id, text").in("id", promptIds as string[])
        : Promise.resolve({ data: [] }),
      svc
        .from("mentions")
        .select("response_id, entity_type, entity_name, mentioned, sentiment, recommended")
        .eq("run_id", run.id)
        .limit(2_000),
      svc
        .from("sources")
        .select("response_id, domain, is_owned")
        .eq("run_id", run.id)
        .limit(2_000),
    ]);

  const promptText = new Map((prompts ?? []).map((p) => [p.id, p.text]));
  const mentionsByResponse = new Map<string, MentionRow[]>();
  for (const m of (mentions ?? []) as MentionRow[]) {
    const list = mentionsByResponse.get(m.response_id) ?? [];
    list.push(m);
    mentionsByResponse.set(m.response_id, list);
  }
  const sourcesByResponse = new Map<string, SourceRow[]>();
  for (const s of (sources ?? []) as SourceRow[]) {
    const list = sourcesByResponse.get(s.response_id) ?? [];
    list.push(s);
    sourcesByResponse.set(s.response_id, list);
  }

  const email = profile?.email ?? null;
  const brandMentioned = (responses ?? []).filter((r) =>
    (mentionsByResponse.get(r.id) ?? []).some((m) => m.entity_type === "brand" && m.mentioned),
  ).length;

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
          title={project?.brand_name || project?.name || "Run"}
          description={
            email
              ? `Run by ${email} (${classifyEmail(email)} address) · project “${project?.name}”`
              : "The owning project has been deleted; the answers below survive it."
          }
          action={
            <Badge
              tone={
                run.status === "completed"
                  ? "mint"
                  : run.status === "failed"
                    ? "terracotta"
                    : "butter"
              }
            >
              {run.status}
            </Badge>
          }
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Engine"
          value={<span className="font-mono text-xl">{run.provider}</span>}
          hint={`${run.model}${run.route ? ` · via ${run.route}` : ""}`}
          accent="teal"
        />
        <StatCard
          label="Answers"
          value={`${run.completed_count}/${run.prompt_count}`}
          hint={`${run.replicates ?? 1} replicate${(run.replicates ?? 1) === 1 ? "" : "s"} per prompt`}
          accent="mint"
        />
        <StatCard
          label="Brand mentioned"
          value={`${brandMentioned}/${(responses ?? []).length}`}
          hint="answers naming the brand"
          accent={brandMentioned > 0 ? "mint" : "terracotta"}
        />
        <StatCard
          label="When"
          value={timeAgo(run.created_at)}
          hint={run.finished_at ? `finished ${timeAgo(run.finished_at)}` : "not finished"}
          accent="sand"
        />
      </div>

      {run.error && (
        <Card className="border-terracotta/40 bg-terracotta/[0.04]">
          <p className="break-words px-6 py-4 font-mono text-xs text-terracotta-dark">
            {run.error}
          </p>
        </Card>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h3 className="text-lg font-semibold text-ink">Answers</h3>
          <span className="text-sm tabular-nums text-ink-faint">{(responses ?? []).length}</span>
        </div>
        {(responses ?? []).length === 0 ? (
          <Card>
            <p className="px-6 py-8 text-sm text-ink-faint">
              No answers recorded: the run {run.status === "failed" ? "failed" : "has not produced any yet"}.
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {(responses ?? []).map((response) => {
              const responseMentions = mentionsByResponse.get(response.id) ?? [];
              const responseSources = sourcesByResponse.get(response.id) ?? [];
              const brand = responseMentions.find((m) => m.entity_type === "brand");
              const competitors = responseMentions.filter(
                (m) => m.entity_type === "competitor" && m.mentioned,
              );
              return (
                <Card key={response.id}>
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-6 py-3.5 [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">
                        {promptText.get(response.prompt_id ?? "") ?? "(prompt deleted)"}
                      </span>
                      {brand?.mentioned ? (
                        <Badge tone={brand.recommended ? "mint" : "teal"}>
                          {brand.recommended ? "recommended" : "mentioned"}
                          {brand.sentiment ? ` · ${brand.sentiment}` : ""}
                        </Badge>
                      ) : (
                        <Badge tone="sand">absent</Badge>
                      )}
                      {competitors.length > 0 && (
                        <Badge tone="butter">
                          {competitors.length} competitor{competitors.length === 1 ? "" : "s"}
                        </Badge>
                      )}
                      <span className="shrink-0 text-xs text-ink-faint transition group-open:rotate-90">
                        ›
                      </span>
                    </summary>
                    <div className="space-y-4 border-t border-ink/5 px-6 py-4">
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                        {response.response_text}
                      </p>
                      {competitors.length > 0 && (
                        <p className="text-xs text-ink-faint">
                          Competitors named:{" "}
                          {competitors
                            .map((c) => `${c.entity_name}${c.recommended ? " (recommended)" : ""}`)
                            .join(", ")}
                        </p>
                      )}
                      {responseSources.length > 0 && (
                        <p className="break-words text-xs text-ink-faint">
                          Cited:{" "}
                          {[...new Set(responseSources.map((s) => `${s.domain}${s.is_owned ? " ✓owned" : ""}`))].join(
                            " · ",
                          )}
                        </p>
                      )}
                    </div>
                  </details>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <p className="text-xs text-ink-faint">
        Operator view: this page shows customer run content so outbound can reference what the
        account actually saw.
      </p>
    </div>
  );
}

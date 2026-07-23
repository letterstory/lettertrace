import type { SupabaseClient } from "@supabase/supabase-js";
import type { Competitor, Project, Prompt, Provider } from "@/lib/types";
import { runQuery, analyzeResponse, humanError, type AnalyzeEntity } from "@/lib/llm";
import { detectMention, brandTerms } from "@/lib/mentions";

// Run at most this many queries at once to stay under provider rate limits.
const CONCURRENCY = 4;

// The brand's registrable web host, e.g. "notion.so" from a messy brand_domain.
function hostOf(domain: string | null): string {
  if (!domain) return "";
  return domain
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .replace(/^www\./i, "")
    .toLowerCase();
}

// A cited source is "owned" when its domain is, or is a subdomain of, the host.
function isOwnedDomain(sourceDomain: string, ownedHost: string): boolean {
  if (!ownedHost || !sourceDomain) return false;
  return sourceDomain === ownedHost || sourceDomain.endsWith(`.${ownedHost}`);
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface RunResult {
  runId: string;
  status: "completed" | "failed";
  totalResponses: number;
  tokensUsed: number;
  error?: string;
}

/**
 * Create a run for a project and execute every active prompt against the chosen
 * model with the user's key, detecting + storing brand/competitor mentions.
 * `supabase` may be a user-scoped (RLS) client or the service client (cron).
 */
export async function executeRun(params: {
  supabase: SupabaseClient;
  project: Project;
  provider: Provider;
  model: string;
  apiKey: string;
}): Promise<RunResult> {
  const { supabase, project, provider, model, apiKey } = params;

  const { data: promptRows } = await supabase
    .from("prompts")
    .select("*")
    .eq("project_id", project.id)
    .eq("is_active", true);
  const prompts = (promptRows ?? []) as Prompt[];

  const { data: competitorRows } = await supabase
    .from("competitors")
    .select("*")
    .eq("project_id", project.id);
  const competitors = (competitorRows ?? []) as Competitor[];

  // Create the run row up front so the UI can show progress.
  const { data: runRow, error: runErr } = await supabase
    .from("runs")
    .insert({
      project_id: project.id,
      status: "running",
      provider,
      model,
      prompt_count: prompts.length,
      completed_count: 0,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    throw new Error(`Failed to create run: ${runErr?.message ?? "unknown"}`);
  }
  const runId = runRow.id as string;

  if (prompts.length === 0) {
    await supabase
      .from("runs")
      .update({ status: "completed", finished_at: new Date().toISOString() })
      .eq("id", runId);
    return { runId, status: "completed", totalResponses: 0, tokensUsed: 0 };
  }

  const bTerms = brandTerms(project.brand_name, project.brand_aliases, project.brand_domain);
  // The brand's own web host, for flagging cited sources as "yours".
  const ownedHost = hostOf(project.brand_domain);
  let processed = 0; // prompts attempted (success or failure)
  let succeeded = 0; // answers actually stored
  let tokensUsed = 0; // total provider tokens consumed (for trial metering)
  let hardError: string | undefined;

  await mapPool(prompts, CONCURRENCY, async (prompt) => {
    try {
      const { text: answer, tokens: qTokens, sources } = await runQuery({
        provider,
        model,
        apiKey,
        prompt: prompt.text,
        webSearch: project.use_web_search,
      });
      tokensUsed += qTokens;

      const { data: respRow } = await supabase
        .from("responses")
        .insert({
          run_id: runId,
          project_id: project.id,
          prompt_id: prompt.id,
          topic_id: prompt.topic_id,
          provider,
          model,
          response_text: answer,
        })
        .select("id")
        .single();

      if (!respRow) return;
      const responseId = respRow.id as string;
      succeeded++;

      // Store the web sources the model cited (native web search).
      if (sources.length > 0) {
        const sourceRows = sources.map((s) => ({
          response_id: responseId,
          run_id: runId,
          project_id: project.id,
          url: s.url,
          domain: s.domain,
          title: s.title,
          snippet: s.snippet,
          is_owned: isOwnedDomain(s.domain, ownedHost),
        }));
        await supabase.from("sources").insert(sourceRows);
      }

      // Deterministic detection: brand + each competitor.
      const detected: {
        key: string;
        name: string;
        type: "brand" | "competitor";
        competitorId: string | null;
        count: number;
        firstPosition: number;
      }[] = [];

      const brandHit = detectMention(answer, bTerms);
      if (brandHit.mentioned) {
        detected.push({
          key: "brand",
          name: project.brand_name,
          type: "brand",
          competitorId: null,
          count: brandHit.count,
          firstPosition: brandHit.firstPosition,
        });
      }
      for (const c of competitors) {
        const hit = detectMention(answer, [c.name, ...c.aliases]);
        if (hit.mentioned) {
          detected.push({
            key: c.id,
            name: c.name,
            type: "competitor",
            competitorId: c.id,
            count: hit.count,
            firstPosition: hit.firstPosition,
          });
        }
      }

      // Sentiment / recommendation enrichment (best-effort) for detected entities.
      let analyzed: Record<string, { sentiment: "positive" | "neutral" | "negative"; recommended: boolean }> = {};
      if (detected.length > 0) {
        const entities: AnalyzeEntity[] = detected.map((d) => ({ key: d.key, name: d.name }));
        const { results, tokens: aTokens } = await analyzeResponse({
          provider,
          model,
          apiKey,
          question: prompt.text,
          responseText: answer,
          entities,
        });
        tokensUsed += aTokens;
        analyzed = Object.fromEntries(
          results.map((r) => [r.key, { sentiment: r.sentiment, recommended: r.recommended }]),
        );
      }

      if (detected.length > 0) {
        const mentionRows = detected.map((d) => ({
          response_id: responseId,
          run_id: runId,
          project_id: project.id,
          topic_id: prompt.topic_id,
          entity_type: d.type,
          competitor_id: d.competitorId,
          entity_name: d.name,
          mentioned: true,
          mention_count: d.count,
          first_position: d.firstPosition,
          sentiment: analyzed[d.key]?.sentiment ?? "neutral",
          recommended: analyzed[d.key]?.recommended ?? false,
        }));
        await supabase.from("mentions").insert(mentionRows);
      }
    } catch (err) {
      // A single failed prompt shouldn't kill the whole run.
      if (!hardError) hardError = humanError(err);
    } finally {
      processed++;
      // Periodic progress checkpoint, completed_count reflects stored answers.
      if (processed % CONCURRENCY === 0 || processed === prompts.length) {
        await supabase.from("runs").update({ completed_count: succeeded }).eq("id", runId);
      }
    }
  });

  const finishedAt = new Date().toISOString();
  // A run only "completed" if at least one answer was actually stored; otherwise
  // it failed and we surface the captured error rather than reporting success.
  const status = succeeded > 0 ? "completed" : "failed";
  await supabase
    .from("runs")
    .update({
      status,
      completed_count: succeeded,
      finished_at: finishedAt,
      error:
        status === "failed"
          ? hardError ?? "No answers were stored, every prompt failed."
          : null,
    })
    .eq("id", runId);

  await supabase
    .from("projects")
    .update({ last_run_at: finishedAt })
    .eq("id", project.id);

  return { runId, status, totalResponses: succeeded, tokensUsed, error: hardError };
}

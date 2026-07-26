import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Mention,
  Project,
  Prompt,
  Provider,
  Response,
  Run,
  Source,
} from "@/lib/types";
import {
  computeEntityStats,
  computeRunSummary,
  type EntityStat,
  type RunSummary,
} from "@/lib/metrics";
import { executeRun, type RunResult } from "@/lib/engine";
import { pickDefaultProvider, resolveKey, resolveRunKey } from "@/lib/trial";
import { defaultModelFor, isProvider, PROVIDERS } from "@/lib/models";

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
    brand_domains: p.brand_domains,
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

function toAliases(value: unknown): string[] {
  const parts =
    Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",")
        : [];
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Brand domains, first = primary. Accepts an array or a comma-separated
// string; deduped case-insensitively, order preserved.
function toDomains(value: unknown): string[] {
  const seen = new Set<string>();
  return toAliases(value).filter((d) => {
    const key = d.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type CreateProjectOutcome =
  | { ok: true; project: Project }
  | { ok: false; code: "invalid"; message: string };

/**
 * Create a project (organization) for the user. Mirrors the dashboard's
 * insert (app/api/project/route.ts): provider/model are chosen automatically
 * unless explicitly sent, aliases default empty. Schedule always starts "off":
 * API callers orchestrate their own cadence and trigger runs explicitly.
 */
export async function createProject(
  supabase: SupabaseClient,
  userId: string,
  input: Record<string, unknown>,
): Promise<CreateProjectOutcome> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const brand_name =
    typeof input.brand_name === "string" ? input.brand_name.trim() : "";

  if (!name) {
    return { ok: false, code: "invalid", message: "A project name is required." };
  }
  if (!brand_name) {
    return { ok: false, code: "invalid", message: "A brand name is required." };
  }

  if (
    typeof input.default_provider === "string" &&
    !isProvider(input.default_provider)
  ) {
    return {
      ok: false,
      code: "invalid",
      message: `Unknown provider "${input.default_provider}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.`,
    };
  }
  const provider: Provider =
    typeof input.default_provider === "string" && isProvider(input.default_provider)
      ? input.default_provider
      : pickDefaultProvider();
  const model =
    typeof input.default_model === "string" && input.default_model.trim().length > 0
      ? input.default_model.trim()
      : defaultModelFor(provider);

  // `user_id` comes from the authenticated key, never the body: the insert is
  // what ties the new project to the caller on the service-role client.
  const { data, error } = await supabase
    .from("projects")
    .insert({
      name,
      brand_name,
      brand_aliases: toAliases(input.brand_aliases),
      brand_domains: toDomains(input.brand_domains),
      description: toNullableString(input.description),
      default_provider: provider,
      default_model: model,
      schedule: "off",
      ...(typeof input.use_web_search === "boolean"
        ? { use_web_search: input.use_web_search }
        : {}),
      user_id: userId,
    })
    .select("*")
    .single();

  if (error || !data) throw error ?? new Error("Failed to create project.");
  return { ok: true, project: data as Project };
}

/** A prompt row trimmed to what the API exposes, with its topic's name. */
export interface PromptSummary {
  id: string;
  text: string;
  topic: string | null;
  source: Prompt["source"];
  is_active: boolean;
  created_at: string;
}

/** The name off a joined `topics(name)` embed (object or array per cardinality). */
function embeddedTopicName(value: unknown): string | null {
  const t = value as { name?: string } | { name?: string }[] | null;
  const row = Array.isArray(t) ? t[0] : t;
  return row?.name ?? null;
}

/** A project's prompts with their topic names. Null when not the user's. */
export async function listProjectPrompts(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
): Promise<PromptSummary[] | null> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) return null;
  const { data } = await supabase
    .from("prompts")
    .select("id, text, source, is_active, created_at, topics(name)")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    text: row.text as string,
    topic: embeddedTopicName(row.topics),
    source: row.source as Prompt["source"],
    is_active: row.is_active as boolean,
    created_at: row.created_at as string,
  }));
}

export type CreatePromptsOutcome =
  | { ok: true; created: PromptSummary[]; skipped: number }
  | { ok: false; code: "not_found" | "invalid"; message: string };

/**
 * Bulk-add prompts to a project. Each entry names its topic; topics are
 * get-or-created per distinct name (case-insensitive against the project's
 * existing topics) since prompts.topic_id is NOT NULL. Prompts whose text the
 * project already has (case-insensitive, including repeats within the batch)
 * are skipped, so callers can re-push their full set idempotently.
 */
export async function createPrompts(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  entries: unknown,
): Promise<CreatePromptsOutcome> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) {
    return { ok: false, code: "not_found", message: "Project not found." };
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      ok: false,
      code: "invalid",
      message: "prompts must be a non-empty array of { text, topic }.",
    };
  }
  const parsed: { text: string; topic: string }[] = [];
  const bad: number[] = [];
  entries.forEach((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const text = typeof e.text === "string" ? e.text.trim() : "";
    const topic = typeof e.topic === "string" ? e.topic.trim() : "";
    if (!text || !topic) bad.push(i);
    else parsed.push({ text, topic });
  });
  if (bad.length > 0) {
    return {
      ok: false,
      code: "invalid",
      message: `Every prompt needs a non-empty text and topic (bad ${bad.length === 1 ? "entry at index" : "entries at indexes"} ${bad.join(", ")}).`,
    };
  }

  // The project is ownership-checked above; children scope by its id.
  const [{ data: topicRows }, { data: promptRows }] = await Promise.all([
    supabase.from("topics").select("id, name").eq("project_id", projectId),
    supabase.from("prompts").select("text").eq("project_id", projectId),
  ]);

  const topicIdByKey = new Map<string, string>();
  const topicNameById = new Map<string, string>();
  for (const t of (topicRows ?? []) as { id: string; name: string }[]) {
    topicIdByKey.set(t.name.trim().toLowerCase(), t.id);
    topicNameById.set(t.id, t.name);
  }

  const seenTexts = new Set(
    ((promptRows ?? []) as { text: string }[]).map((r) => r.text.trim().toLowerCase()),
  );
  const toInsert: { text: string; topic: string }[] = [];
  let skipped = 0;
  for (const e of parsed) {
    const key = e.text.toLowerCase();
    if (seenTexts.has(key)) {
      skipped += 1;
      continue;
    }
    seenTexts.add(key);
    toInsert.push(e);
  }
  if (toInsert.length === 0) return { ok: true, created: [], skipped };

  // Create the topic names this batch introduces (first spelling wins).
  const newNames = toInsert
    .filter((e, i, all) => {
      const key = e.topic.toLowerCase();
      return (
        !topicIdByKey.has(key) &&
        all.findIndex((o) => o.topic.toLowerCase() === key) === i
      );
    })
    .map((e) => e.topic);
  if (newNames.length > 0) {
    const { data: createdTopics, error } = await supabase
      .from("topics")
      .insert(newNames.map((name) => ({ project_id: projectId, name })))
      .select("id, name");
    if (error || !createdTopics) throw error ?? new Error("Failed to create topics.");
    for (const t of createdTopics as { id: string; name: string }[]) {
      topicIdByKey.set(t.name.trim().toLowerCase(), t.id);
      topicNameById.set(t.id, t.name);
    }
  }

  const { data: createdRows, error: insertError } = await supabase
    .from("prompts")
    .insert(
      toInsert.map((e) => ({
        project_id: projectId,
        topic_id: topicIdByKey.get(e.topic.toLowerCase())!,
        text: e.text,
        source: "manual",
        is_active: true,
      })),
    )
    .select("id, topic_id, text, source, is_active, created_at");
  if (insertError || !createdRows) {
    throw insertError ?? new Error("Failed to create prompts.");
  }

  return {
    ok: true,
    created: (createdRows as (PromptSummary & { topic_id: string })[]).map((r) => ({
      id: r.id,
      text: r.text,
      topic: topicNameById.get(r.topic_id) ?? null,
      source: r.source,
      is_active: r.is_active,
      created_at: r.created_at,
    })),
    skipped,
  };
}

/**
 * Toggle a prompt on or off. Ownership walks prompt -> project -> user, and
 * the update itself re-scopes by project id: on the service-role client the
 * explicit userId chain is the security boundary. Null when the prompt
 * doesn't exist or isn't the user's.
 */
export async function setPromptActive(
  supabase: SupabaseClient,
  userId: string,
  promptId: string,
  isActive: boolean,
): Promise<PromptSummary | null> {
  const { data: promptRow } = await supabase
    .from("prompts")
    .select("id, project_id, text, source, is_active, created_at, topics(name)")
    .eq("id", promptId)
    .maybeSingle();
  const prompt = promptRow as
    | (Pick<
        Prompt,
        "id" | "project_id" | "text" | "source" | "is_active" | "created_at"
      > & { topics: unknown })
    | null;
  if (!prompt) return null;

  const project = await getOwnedProject(supabase, userId, prompt.project_id);
  if (!project) return null;

  const { error } = await supabase
    .from("prompts")
    .update({ is_active: isActive })
    .eq("id", promptId)
    .eq("project_id", project.id);
  if (error) throw error;

  return {
    id: prompt.id,
    text: prompt.text,
    topic: embeddedTopicName(prompt.topics),
    source: prompt.source,
    is_active: isActive,
    created_at: prompt.created_at,
  };
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

/** One response's raw artifacts: the model's text plus what it cited and mentioned. */
export interface ResponseArtifact {
  id: string;
  prompt_id: string | null;
  prompt_text: string | null;
  provider: Provider;
  model: string;
  response_text: string;
  sources: Pick<Source, "url" | "domain" | "title" | "snippet" | "is_owned">[];
  mentions: Pick<
    Mention,
    | "entity_type"
    | "entity_name"
    | "mention_count"
    | "first_position"
    | "sentiment"
    | "recommended"
  >[];
}

export interface RunResponses {
  run: Run;
  responses: ResponseArtifact[];
}

/**
 * The raw artifacts of one run: every response's full text with the exact
 * cited source URLs and detected mentions, for callers that do their own
 * downstream analysis (the aggregate view stays in getRunReport). Ownership
 * is checked the same way: run -> project -> user. Null when the run doesn't
 * exist or isn't the user's.
 */
export async function getRunResponses(
  supabase: SupabaseClient,
  userId: string,
  runId: string,
): Promise<RunResponses | null> {
  const { data: runRow } = await supabase
    .from("runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  const run = runRow as Run | null;
  if (!run) return null;

  const project = await getOwnedProject(supabase, userId, run.project_id);
  if (!project) return null;

  const [
    { data: responseRows },
    { data: sourceRows },
    { data: mentionRows },
    { data: promptRows },
  ] = await Promise.all([
    supabase
      .from("responses")
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: true }),
    supabase.from("sources").select("*").eq("run_id", runId),
    supabase.from("mentions").select("*").eq("run_id", runId),
    supabase.from("prompts").select("id, text").eq("project_id", run.project_id),
  ]);

  const promptTextById = new Map(
    ((promptRows ?? []) as Pick<Prompt, "id" | "text">[]).map((p) => [p.id, p.text]),
  );
  const sourcesByResponse = new Map<string, Source[]>();
  for (const s of (sourceRows ?? []) as Source[]) {
    const list = sourcesByResponse.get(s.response_id) ?? [];
    list.push(s);
    sourcesByResponse.set(s.response_id, list);
  }
  const mentionsByResponse = new Map<string, Mention[]>();
  for (const m of (mentionRows ?? []) as Mention[]) {
    const list = mentionsByResponse.get(m.response_id) ?? [];
    list.push(m);
    mentionsByResponse.set(m.response_id, list);
  }

  return {
    run,
    responses: ((responseRows ?? []) as Response[]).map((r) => ({
      id: r.id,
      prompt_id: r.prompt_id,
      prompt_text: r.prompt_id ? promptTextById.get(r.prompt_id) ?? null : null,
      provider: r.provider,
      model: r.model,
      response_text: r.response_text,
      sources: (sourcesByResponse.get(r.id) ?? []).map((s) => ({
        url: s.url,
        domain: s.domain,
        title: s.title,
        snippet: s.snippet,
        is_owned: s.is_owned,
      })),
      mentions: (mentionsByResponse.get(r.id) ?? []).map((m) => ({
        entity_type: m.entity_type,
        entity_name: m.entity_name,
        mention_count: m.mention_count,
        first_position: m.first_position,
        sentiment: m.sentiment,
        recommended: m.recommended,
      })),
    })),
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
  options?: { provider?: Provider; model?: string },
): Promise<TriggerOutcome> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) {
    return { ok: false, code: "not_found", message: "Project not found." };
  }

  // A caller-sent provider/model overrides the project default for this run
  // only (the project row is untouched); key resolution still prefers the
  // requested provider and falls back like the dashboard does.
  const key =
    options?.provider || options?.model
      ? await resolveKey(
          supabase,
          userId,
          options.provider ?? project.default_provider,
          options.model,
        )
      : await resolveRunKey(supabase, userId, project);
  if (key.source !== "own") {
    const providerLabel =
      PROVIDERS[options?.provider ?? project.default_provider].label;
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

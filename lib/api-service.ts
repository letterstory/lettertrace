import type { SupabaseClient } from "@supabase/supabase-js";
import { recordOpsError } from "@/lib/ops";
import type {
  Competitor,
  Mention,
  Project,
  Prompt,
  Provider,
  Response,
  Run,
  Source,
} from "@/lib/types";
import {
  computeCitationStats,
  computeEntityStats,
  computeMeasurementQuality,
  computeRunSummary,
  computeTopicStats,
  measurementVerdict,
  computePageStats,
  computePromptEntityStats,
  computeCompetitorCitations,
  pageKey,
  type CitationStat,
  type EntityStat,
  type MeasurementQuality,
  type MeasurementVerdict,
  type PageStat,
  type PromptEntityStats,
  type PromptCompetitorCitations,
  type RunSummary,
  type TopicStat,
} from "@/lib/metrics";
import { fireAndForget } from "@/lib/notify";
import { normalizeCompetitorList } from "@/lib/competitors";
import { selectAll } from "@/lib/paging";
import { discoverCompanies, type DiscoveredCompany } from "@/lib/discover";
import {
  executeRun,
  prepareRun,
  resumeRun,
  isAbandoned,
  settleAbandonedRun,
  INTERRUPTED_RUN_ERROR,
  type RunContext,
  type RunResult,
} from "@/lib/engine";
import { pickDefaultProvider, resolveRunKeyFor, engineKeyMessage } from "@/lib/trial";
import { isProvider, resolveEngine, PROVIDERS } from "@/lib/models";

// Operations behind the programmatic surface, shared by the REST v1 routes and
// the MCP tools so the two can't drift apart. Callers authenticate with a
// Lettertrace API key, so `supabase` is the service-role client: RLS is
// bypassed and every query here scopes by userId explicitly.

/**
 * Run queries concurrently and get the results back BY NAME.
 *
 * `Promise.all` over a list of queries hands back a positional array, and a
 * positional destructure of seven heterogeneous queries is a trap the type
 * system cannot spring: every PostgREST response carries both `data` and
 * `count`, so pulling `{ count }` out of a `select()` type-checks perfectly.
 * That is how getRunReport once read its competitor head-count out of the
 * prompts query and its prompt targets out of the competitors query — pages[]
 * came back empty and every report read no-competitors, through a typed
 * codebase, past review, all the way to staging.
 *
 * Keying the queries removes the failure mode rather than fixing one instance
 * of it: inserting, removing or reordering a query here cannot misalign
 * anything, because nothing is aligned by position. Concurrency is unchanged —
 * the builders are lazy and all start together inside the Promise.all.
 */
async function allOf<T extends Record<string, PromiseLike<unknown>>>(
  queries: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(queries) as (keyof T)[];
  const settled = await Promise.all(keys.map((k) => queries[k]));
  const out = {} as { [K in keyof T]: Awaited<T[K]> };
  keys.forEach((key, i) => {
    out[key] = settled[i] as Awaited<T[typeof key]>;
  });
  return out;
}

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
    replicates: p.replicates,
    last_run_at: p.last_run_at,
    created_at: p.created_at,
  };
}

/**
 * Fetch a project only if this user may act on it — they created it, or a
 * teammate invited them into it.
 *
 * This is THE ownership boundary for the programmatic surface: `supabase` here
 * is the service-role client, so RLS is off and the explicit check below is
 * all there is. It was `.eq("user_id", userId)` before teams existed; the
 * membership lookup is the same question asked of the wider set.
 */
export async function getAccessibleProject(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
): Promise<Project | null> {
  const { data } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .maybeSingle();
  const project = (data as Project | null) ?? null;
  if (!project) return null;
  if (project.user_id === userId) return project;

  const { data: membership } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .maybeSingle();
  return membership ? project : null;
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

/** A target URL is usable only if it reduces to a page key the source
 *  matcher can compare against (lib/metrics pageKey). */
function normalizeTargetUrl(value: string): string | null {
  return pageKey(value);
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
  // The model has to belong to the provider it will be sent to. Accepting any
  // string here stored pairs that only failed later, at the provider, as an
  // error naming a model id the caller never chose.
  const engine = resolveEngine(provider, input.default_model);
  if (!engine.ok) {
    return { ok: false, code: "invalid", message: engine.message };
  }
  const model = engine.model;

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
      ...(typeof input.replicates === "number"
        ? { replicates: Math.min(Math.max(Math.trunc(input.replicates), 1), 10) }
        : {}),
      user_id: userId,
    })
    .select("*")
    .single();

  if (error || !data) throw error ?? new Error("Failed to create project.");
  return { ok: true, project: data as Project };
}

export type UpdateProjectOutcome =
  | { ok: true; project: Project }
  | { ok: false; code: "not_found" | "invalid"; message: string };

/**
 * Update a project's settings — true PATCH semantics: only the fields the
 * caller sends change, everything else keeps its value (the dashboard's
 * full-form save lives elsewhere). This is how a project created before its
 * configuration was fully known gets fixed without the dashboard: aliases the
 * brand also answers to, replicates once a rate needs tighter intervals,
 * domains as owned sites launch.
 *
 * `schedule` is deliberately not accepted, same stance as createProject: API
 * callers orchestrate their own cadence and trigger runs explicitly.
 */
export async function updateProject(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  input: Record<string, unknown>,
): Promise<UpdateProjectOutcome> {
  const project = await getAccessibleProject(supabase, userId, projectId);
  if (!project) {
    return { ok: false, code: "not_found", message: "Project not found." };
  }

  const update: Record<string, unknown> = {};

  if ("name" in input) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) {
      return { ok: false, code: "invalid", message: "name cannot be empty." };
    }
    update.name = name;
  }
  if ("brand_name" in input) {
    const brandName = typeof input.brand_name === "string" ? input.brand_name.trim() : "";
    if (!brandName) {
      return { ok: false, code: "invalid", message: "brand_name cannot be empty." };
    }
    update.brand_name = brandName;
  }
  if ("brand_aliases" in input) update.brand_aliases = toAliases(input.brand_aliases);
  if ("brand_domains" in input) update.brand_domains = toDomains(input.brand_domains);
  if ("description" in input) update.description = toNullableString(input.description);
  if ("use_web_search" in input) {
    if (typeof input.use_web_search !== "boolean") {
      return { ok: false, code: "invalid", message: "use_web_search must be a boolean." };
    }
    update.use_web_search = input.use_web_search;
  }
  if ("replicates" in input) {
    if (typeof input.replicates !== "number" || !Number.isFinite(input.replicates)) {
      return { ok: false, code: "invalid", message: "replicates must be a number (1–10)." };
    }
    // Applies from the NEXT run; past runs keep the replicates they recorded.
    update.replicates = Math.min(Math.max(Math.trunc(input.replicates), 1), 10);
  }
  // Provider and model move together (the dashboard learned this the hard
  // way): a provider alone re-resolves its default model; a model alone is
  // validated against the provider it will actually be sent to.
  if ("default_provider" in input || "default_model" in input) {
    if (
      "default_provider" in input &&
      (typeof input.default_provider !== "string" || !isProvider(input.default_provider))
    ) {
      return {
        ok: false,
        code: "invalid",
        message: `Unknown provider "${String(input.default_provider)}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.`,
      };
    }
    const provider =
      typeof input.default_provider === "string" && isProvider(input.default_provider)
        ? input.default_provider
        : project.default_provider;
    const model =
      typeof input.default_model === "string" && input.default_model.trim().length > 0
        ? input.default_model.trim()
        : undefined;
    const engine = resolveEngine(provider, model);
    if (!engine.ok) {
      return { ok: false, code: "invalid", message: engine.message };
    }
    update.default_provider = engine.provider;
    update.default_model = engine.model;
  }

  if (Object.keys(update).length === 0) {
    return {
      ok: false,
      code: "invalid",
      message:
        "No recognized fields. Updatable: name, brand_name, brand_aliases, brand_domains, description, use_web_search, replicates, default_provider, default_model.",
    };
  }
  update.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("projects")
    .update(update)
    .eq("id", projectId)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error || !data) throw error ?? new Error("Failed to update project.");
  return { ok: true, project: data as Project };
}

/** A prompt row trimmed to what the API exposes, with its topic's name. */
export interface PromptSummary {
  id: string;
  text: string;
  topic: string | null;
  source: Prompt["source"];
  is_active: boolean;
  /** The page this prompt was written to surface (per-URL cited-hit rates). */
  target_url: string | null;
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
  const project = await getAccessibleProject(supabase, userId, projectId);
  if (!project) return null;
  const { data } = await supabase
    .from("prompts")
    .select("id, text, source, is_active, target_url, created_at, topics(name)")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    text: row.text as string,
    topic: embeddedTopicName(row.topics),
    source: row.source as Prompt["source"],
    is_active: row.is_active as boolean,
    target_url: (row.target_url as string | null) ?? null,
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
  const project = await getAccessibleProject(supabase, userId, projectId);
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
  const parsed: { text: string; topic: string; target_url: string | null }[] = [];
  const bad: number[] = [];
  const badUrls: number[] = [];
  entries.forEach((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const text = typeof e.text === "string" ? e.text.trim() : "";
    const topic = typeof e.topic === "string" ? e.topic.trim() : "";
    if (!text || !topic) {
      bad.push(i);
      return;
    }
    // Optional: the page this prompt is written to surface. Validated here so
    // a typo'd URL fails the request instead of silently never matching a
    // cited source.
    let target_url: string | null = null;
    if (e.target_url !== undefined && e.target_url !== null) {
      const candidate = typeof e.target_url === "string" ? e.target_url.trim() : "";
      if (!candidate || normalizeTargetUrl(candidate) === null) {
        badUrls.push(i);
        return;
      }
      target_url = candidate;
    }
    parsed.push({ text, topic, target_url });
  });
  if (bad.length > 0) {
    return {
      ok: false,
      code: "invalid",
      message: `Every prompt needs a non-empty text and topic (bad ${bad.length === 1 ? "entry at index" : "entries at indexes"} ${bad.join(", ")}).`,
    };
  }
  if (badUrls.length > 0) {
    return {
      ok: false,
      code: "invalid",
      message: `target_url must be a valid URL when present (bad ${badUrls.length === 1 ? "entry at index" : "entries at indexes"} ${badUrls.join(", ")}).`,
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
  const toInsert: { text: string; topic: string; target_url: string | null }[] = [];
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
        target_url: e.target_url,
      })),
    )
    .select("id, topic_id, text, source, is_active, target_url, created_at");
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
      target_url: r.target_url ?? null,
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
export type UpdatePromptOutcome =
  | { ok: true; prompt: PromptSummary }
  | { ok: false; code: "not_found" | "invalid"; message: string };

/**
 * Update a prompt — is_active (deactivate rather than delete: history hangs
 * off prompts) and/or target_url (set, or null to clear the page mapping).
 * Ownership walks prompt -> project -> user, and the update itself re-scopes
 * by project id: on the service-role client the explicit userId chain is the
 * security boundary.
 */
export async function updatePrompt(
  supabase: SupabaseClient,
  userId: string,
  promptId: string,
  patch: { is_active?: boolean; target_url?: string | null },
): Promise<UpdatePromptOutcome> {
  const update: Record<string, unknown> = {};
  if (patch.is_active !== undefined) update.is_active = patch.is_active;
  if (patch.target_url !== undefined) {
    if (patch.target_url === null) {
      update.target_url = null;
    } else {
      const candidate = patch.target_url.trim();
      if (!candidate || normalizeTargetUrl(candidate) === null) {
        return {
          ok: false,
          code: "invalid",
          message: "target_url must be a valid URL, or null to clear it.",
        };
      }
      update.target_url = candidate;
    }
  }
  if (Object.keys(update).length === 0) {
    return {
      ok: false,
      code: "invalid",
      message: "Nothing to update. Send is_active (boolean) and/or target_url (string or null).",
    };
  }

  const { data: promptRow } = await supabase
    .from("prompts")
    .select("id, project_id, text, source, is_active, target_url, created_at, topics(name)")
    .eq("id", promptId)
    .maybeSingle();
  const prompt = promptRow as
    | (Pick<
        Prompt,
        "id" | "project_id" | "text" | "source" | "is_active" | "target_url" | "created_at"
      > & { topics: unknown })
    | null;
  if (!prompt) {
    return { ok: false, code: "not_found", message: "Prompt not found." };
  }

  const project = await getAccessibleProject(supabase, userId, prompt.project_id);
  if (!project) {
    return { ok: false, code: "not_found", message: "Prompt not found." };
  }

  const { error } = await supabase
    .from("prompts")
    .update(update)
    .eq("id", promptId)
    .eq("project_id", project.id);
  if (error) throw error;

  return {
    ok: true,
    prompt: {
      id: prompt.id,
      text: prompt.text,
      topic: embeddedTopicName(prompt.topics),
      source: prompt.source,
      is_active: patch.is_active ?? prompt.is_active,
      target_url: patch.target_url !== undefined ? patch.target_url : (prompt.target_url ?? null),
      created_at: prompt.created_at,
    },
  };
}

/** A competitor as the API returns it (no project_id echo — it's in the URL). */
export interface CompetitorSummary {
  id: string;
  name: string;
  aliases: string[];
  domain: string | null;
  created_at: string;
}

function competitorSummary(c: Competitor): CompetitorSummary {
  return {
    id: c.id,
    name: c.name,
    aliases: c.aliases,
    domain: c.domain,
    created_at: c.created_at,
  };
}

/** A project's tracked competitors. Null when the project isn't the user's. */
export async function listProjectCompetitors(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
): Promise<CompetitorSummary[] | null> {
  const project = await getAccessibleProject(supabase, userId, projectId);
  if (!project) return null;
  const { data } = await supabase
    .from("competitors")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  return ((data ?? []) as Competitor[]).map(competitorSummary);
}

export type CreateCompetitorsOutcome =
  | { ok: true; created: CompetitorSummary[]; skipped: number }
  | { ok: false; code: "not_found" | "invalid"; message: string };

/**
 * Add tracked competitors to a project. Entries are normalized the same way
 * the onboarding wizard's are (lib/competitors): unnamed rows dropped, the
 * brand itself excluded, repeats collapsed. Entries whose name the project
 * already tracks are counted in `skipped` rather than erroring — the caller
 * is usually syncing a list, not appending blindly.
 */
export async function createCompetitors(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  entries: unknown,
): Promise<CreateCompetitorsOutcome> {
  const project = await getAccessibleProject(supabase, userId, projectId);
  if (!project) {
    return { ok: false, code: "not_found", message: "Project not found." };
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      ok: false,
      code: "invalid",
      message: "competitors must be a non-empty array of { name, aliases?, domain? }.",
    };
  }

  const list = normalizeCompetitorList(entries, {
    exclude: [project.brand_name, ...project.brand_aliases],
  });
  if (list.length === 0) {
    return {
      ok: false,
      code: "invalid",
      message: "No usable entries: every competitor needs a non-empty name that isn't the brand itself.",
    };
  }

  const { data: existingRows } = await supabase
    .from("competitors")
    .select("name")
    .eq("project_id", projectId);
  const existing = new Set(
    ((existingRows ?? []) as { name: string }[]).map((r) => r.name.trim().toLowerCase()),
  );

  const toInsert = list.filter((c) => !existing.has(c.name.toLowerCase()));
  const skipped = list.length - toInsert.length;
  if (toInsert.length === 0) return { ok: true, created: [], skipped };

  const { data: created, error } = await supabase
    .from("competitors")
    .insert(
      toInsert.map((c) => ({
        project_id: projectId,
        name: c.name,
        aliases: c.aliases,
        domain: c.domain,
      })),
    )
    .select("*");
  if (error) throw error;

  return {
    ok: true,
    created: ((created ?? []) as Competitor[]).map(competitorSummary),
    skipped,
  };
}

/**
 * Remove a tracked competitor. Ownership is checked competitor -> project ->
 * user. Null when it doesn't exist or isn't the user's; mention history rows
 * keep the entity name they recorded, so past reports stay intact.
 */
export async function deleteCompetitor(
  supabase: SupabaseClient,
  userId: string,
  competitorId: string,
): Promise<CompetitorSummary | null> {
  const { data: row } = await supabase
    .from("competitors")
    .select("*")
    .eq("id", competitorId)
    .maybeSingle();
  const competitor = row as Competitor | null;
  if (!competitor) return null;

  const project = await getAccessibleProject(supabase, userId, competitor.project_id);
  if (!project) return null;

  const { error } = await supabase
    .from("competitors")
    .delete()
    .eq("id", competitorId)
    .eq("project_id", project.id);
  if (error) throw error;

  return competitorSummary(competitor);
}

/** Answers scanned for discovery. Bounded so a long history stays cheap. */
const DISCOVER_ANSWER_LIMIT = 200;

export interface DiscoveredCompetitors {
  companies: DiscoveredCompany[];
  answersScanned: number;
  /** Answers naming the top candidate — many means the category has a default
   *  pick the project isn't tracking; a spread of one-offs means no consensus. */
  topCount: number;
}

/**
 * Companies the stored answers named that the project doesn't track — the
 * dashboard's discovery view, exposed programmatically. Reads text already in
 * the database (no provider call, no key needed). Candidates only: the caller
 * confirms which become tracked competitors via createCompetitors.
 */
export async function discoverProjectCompetitors(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
): Promise<DiscoveredCompetitors | null> {
  const project = await getAccessibleProject(supabase, userId, projectId);
  if (!project) return null;

  const [{ data: responseRows }, { data: competitorRows }] = await Promise.all([
    supabase
      .from("responses")
      .select("response_text")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(DISCOVER_ANSWER_LIMIT),
    supabase.from("competitors").select("name, aliases").eq("project_id", projectId),
  ]);

  const answers = ((responseRows ?? []) as { response_text: string | null }[])
    .map((r) => r.response_text ?? "")
    .filter(Boolean);

  // Everything already accounted for: the brand, its aliases, and every
  // tracked competitor with theirs — offering any of these back would be
  // suggesting something the project already tracks.
  const tracked = [
    project.brand_name,
    ...project.brand_aliases,
    ...((competitorRows ?? []) as Pick<Competitor, "name" | "aliases">[]).flatMap((c) => [
      c.name,
      ...c.aliases,
    ]),
  ];

  const companies = discoverCompanies(answers, tracked, { limit: 24 });
  return {
    companies,
    answersScanned: answers.length,
    topCount: companies[0]?.answers ?? 0,
  };
}

/** Recent runs for a project. Null when the project isn't the user's. */
export async function listRuns(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  limit = 20,
): Promise<Run[] | null> {
  const project = await getAccessibleProject(supabase, userId, projectId);
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
  /** Whether the models read the brand's own pages. Moves before mentions do,
   *  so it's the only progress signal a young brand has. */
  citations: CitationStat;
  /** How many answers named any tracked company. A run that named nobody
   *  measured nothing — read this before believing a zero mention rate. */
  quality: MeasurementQuality;
  /** How to read this run's rates — the dashboard's chip, exposed so API
   *  consumers don't re-derive it: a 0% that's "real-gap" and a 0% that's
   *  "no-competitors" or "thin-sample" are entirely different findings. */
  verdict: MeasurementVerdict;
  /** Per-URL cited-hit rates for prompts mapped to a target page: when the
   *  question a page was built for gets asked, is THAT page the one cited? */
  pages: PageStat[];
  /** Per-topic brand visibility. Content is usually planned by topic, so this is the
   *  join between "we published about X" and "are we surfacing for X". */
  topics: (TopicStat & { topic: string | null })[];
  /** Per-prompt entity breakdown — who gets NAMED for each question, brand and
   *  competitors, scoped to that question's answers. The run's entities[] says
   *  who owns the category; this says which specific questions competitors win
   *  and we don't — the build-for-it queue. */
  promptEntities: PromptEntityStats[];
  /** Per-prompt competitor CITATIONS — whose domain the answers actually cited
   *  for each question. The other half of "showing up": named vs. read. Only
   *  competitors with a resolvable domain appear. */
  competitorCitations: PromptCompetitorCitations[];
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

  const project = await getAccessibleProject(supabase, userId, run.project_id);
  if (!project) return null;

  const results = await allOf({
    responseCount: supabase
      .from("responses")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId),
    // These four grow with answers, prompts and entities, so they page rather
    // than trusting a single unpaginated read — see lib/paging. They hand back
    // rows directly; only the un-paged queries carry a { data } envelope.
    mentions: selectAll<Mention>((f, t) =>
      supabase.from("mentions").select("*").eq("run_id", runId).range(f, t),
    ),
    sources: selectAll<Pick<Source, "response_id" | "url" | "is_owned">>((f, t) =>
      supabase.from("sources").select("response_id, url, is_owned").eq("run_id", runId).range(f, t),
    ),
    responseTopics: selectAll<{ id: string; topic_id: string | null; prompt_id: string | null }>(
      (f, t) => supabase.from("responses").select("id, topic_id, prompt_id").eq("run_id", runId).range(f, t),
    ),
    topics: supabase.from("topics").select("id, name").eq("project_id", run.project_id),
    prompts: selectAll<{ id: string; target_url: string | null; text: string | null }>((f, t) =>
      supabase
        .from("prompts")
        .select("id, target_url, text")
        .eq("project_id", run.project_id)
        .range(f, t),
    ),
    // Loaded as rows (not just a head count) so their domains can attribute
    // cited sources; competitorCount below is derived from the same list.
    competitors: selectAll<{ id: string; name: string; domain: string | null }>((f, t) =>
      supabase
        .from("competitors")
        .select("id, name, domain")
        .eq("project_id", run.project_id)
        .range(f, t),
    ),
  });
  const { count } = results.responseCount;
  const mentionRows = results.mentions;
  const sourceRows = results.sources;
  const responseTopicRows = results.responseTopics;
  const { data: topicRows } = results.topics;
  const promptRows = (results.prompts ?? []) as {
    id: string;
    target_url: string | null;
    text: string | null;
  }[];
  const competitorRows = (results.competitors ?? []) as {
    id: string;
    name: string;
    domain: string | null;
  }[];
  const competitorCount = competitorRows.length;

  const mentions = (mentionRows ?? []) as Mention[];
  const sources = (sourceRows ?? []) as Pick<Source, "response_id" | "url" | "is_owned">[];
  const totalResponses = count ?? 0;

  const responseRows = (responseTopicRows ?? []) as {
    id: string;
    topic_id: string | null;
    prompt_id: string | null;
  }[];
  const responsesByTopic = new Map<string | null, number>();
  for (const r of responseRows) {
    responsesByTopic.set(r.topic_id, (responsesByTopic.get(r.topic_id) ?? 0) + 1);
  }
  const topicNames = new Map(
    ((topicRows ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]),
  );
  const topicStats = computeTopicStats(mentions, responsesByTopic).map((t) => ({
    ...t,
    topic: t.topicId ? topicNames.get(t.topicId) ?? null : null,
  }));

  const summary = computeRunSummary(mentions, totalResponses, project.brand_name);
  // Page-targeted prompts (target_url) measure RETRIEVAL of one page — their
  // answers are how-to explanations that legitimately name nobody. Counting
  // them in the naming-quality basis would read "you added page tracking" as
  // "your prompts can't elicit names" and flip healthy runs to thin-sample,
  // so informativeRate is computed over the non-page responses only.
  // (summary/entities/citations keep the full run — only naming quality has a
  // reduced basis, and quality.totalResponses reports that basis.)
  const pagePromptIds = new Set(
    promptRows.filter((p) => p.target_url).map((p) => p.id),
  );
  const pageResponseIds = new Set(
    responseRows.filter((r) => r.prompt_id && pagePromptIds.has(r.prompt_id)).map((r) => r.id),
  );
  const quality = computeMeasurementQuality(
    mentions.filter((m) => !pageResponseIds.has(m.response_id)),
    Math.max(0, totalResponses - pageResponseIds.size),
  );

  return {
    run,
    totalResponses,
    // Pass the brand name so a run with no brand mentions still reports a brand
    // row (rate 0 with an interval) rather than omitting it — an API consumer
    // tracking "have we been mentioned yet" needs the zero, not a missing key.
    summary,
    entities: computeEntityStats(mentions, totalResponses, project.brand_name),
    citations: computeCitationStats(sources, totalResponses),
    quality,
    verdict: measurementVerdict({
      totalResponses,
      informativeRate: quality.informativeRate,
      brandMentioned: summary.brandResponsesMentioned > 0,
      competitorsTracked: competitorCount,
      informativeBasis: quality.totalResponses,
    }),
    pages: computePageStats(promptRows, responseRows, sources),
    topics: topicStats,
    promptEntities: computePromptEntityStats(
      mentions,
      responseRows,
      promptRows,
      project.brand_name,
    ),
    competitorCitations: computeCompetitorCitations(
      sources,
      competitorRows,
      responseRows,
      promptRows,
    ),
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

  const project = await getAccessibleProject(supabase, userId, run.project_id);
  if (!project) return null;

  const results = await allOf({
    // Every one of these grows with the size of the run — see lib/paging.
    responses: selectAll<Response>((f, t) =>
      supabase
        .from("responses")
        .select("*")
        .eq("run_id", runId)
        .order("created_at", { ascending: true })
        .range(f, t),
    ),
    sources: selectAll<Source>((f, t) =>
      supabase.from("sources").select("*").eq("run_id", runId).range(f, t),
    ),
    mentions: selectAll<Mention>((f, t) =>
      supabase.from("mentions").select("*").eq("run_id", runId).range(f, t),
    ),
    prompts: selectAll<Pick<Prompt, "id" | "text">>((f, t) =>
      supabase.from("prompts").select("id, text").eq("project_id", run.project_id).range(f, t),
    ),
  });
  const responseRows = results.responses;
  const sourceRows = results.sources;
  const mentionRows = results.mentions;
  const promptRows = results.prompts;

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

/** A run accepted in background mode: created and executing, not yet settled. */
export interface BackgroundRunStart {
  runId: string;
  status: "running";
  /** Planned ANSWERS (prompts × replicates), same meaning as runs.prompt_count. */
  promptCount: number;
}

export type TriggerOutcome =
  | { ok: true; result: RunResult | BackgroundRunStart }
  // `invalid_engine` is the caller's request being malformed (a model the
  // provider doesn't offer), distinct from `no_key` which is about billing —
  // routes map them to 400 and 402 respectively.
  | { ok: false; code: "not_found" | "no_key" | "invalid_engine"; message: string };

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
  options?: {
    provider?: Provider;
    model?: string;
    context?: RunContext;
    /** Return as soon as the run row exists; the queries finish after the
     *  response is sent (a run takes minutes — no client should hold the
     *  connection that long). Poll GET /v1/runs/:id/status to follow it. */
    background?: boolean;
  },
): Promise<TriggerOutcome> {
  const project = await getAccessibleProject(supabase, userId, projectId);
  if (!project) {
    return { ok: false, code: "not_found", message: "Project not found." };
  }

  // A caller-sent provider/model overrides the project default for this run
  // only (the project row is untouched). Resolution is strict either way: an
  // API caller that asks for gpt-4o and gets Claude back has no way to notice,
  // and the run row would claim the engine it was actually given.
  //
  // Validated against the catalog first, for the same reason the project write
  // paths are: an override naming a model the provider doesn't offer would be
  // recorded on the run and then rejected by the provider mid-run, after the
  // run row already existed.
  const override = resolveEngine(
    options?.provider ?? project.default_provider,
    options?.model ?? (options?.provider ? undefined : project.default_model),
  );
  if (!override.ok) {
    return { ok: false, code: "invalid_engine", message: override.message };
  }

  const key = await resolveRunKeyFor(supabase, userId, override.provider, override.model, {
    webSearch: project.use_web_search,
  });
  if (key.source !== "own") {
    const providerLabel = PROVIDERS[key.requested.provider].label;
    return {
      ok: false,
      code: "no_key",
      message:
        key.source === "mismatch"
          ? `${engineKeyMessage(key)} (API-triggered runs are BYOK; free-trial runs are dashboard-only.)`
          : `API-triggered runs require your own ${providerLabel} key. Add one in Settings (free-trial runs are dashboard-only).`,
    };
  }

  const runParams = {
    supabase,
    project,
    provider: key.provider,
    model: key.model,
    apiKey: key.apiKey!,
    route: key.route,
    context: options?.context,
  };

  if (options?.background) {
    const prepared = await prepareRun(runParams);
    // Keeps the serverless invocation alive past the response; the run settles
    // its own row (completed/failed) exactly as in the sync path. Routed
    // through fireAndForget rather than calling Vercel's waitUntil directly:
    // off-Vercel — a container, a plain Node host — the import itself is what
    // fails, and this was the one call site that would have taken background
    // runs down with it.
    fireAndForget(
      resumeRun(prepared, runParams).catch(async (err) => {
        // resumeRun never rejects for per-prompt failures, so reaching here
        // means the settle itself failed — and swallowing that left the row
        // reading "running" forever, with the status endpoint reporting it to
        // a poller that would never see a terminal state. Settle it here
        // instead. Only a killed invocation can still strand a row, which is
        // what the cron sweeper is for.
        recordOpsError("api-service.background-run", err, { run_id: prepared.runId });
        await settleAbandonedRun(
          supabase,
          prepared.runId,
          `The run stopped unexpectedly: ${err instanceof Error ? err.message : "unknown error"}`,
        ).catch(() => {});
      }),
    );
    return {
      ok: true,
      result: { runId: prepared.runId, status: "running", promptCount: prepared.jobs.length },
    };
  }

  const result = await executeRun(runParams);
  return { ok: true, result };
}

/**
 * The bare run row — the polling companion to background runs. Deliberately
 * lean: the report recomputes aggregate math over every response, which is
 * the wrong thing to hit every few seconds while a run is still answering.
 * Ownership is checked run -> project -> user. Null when the run doesn't
 * exist or isn't the user's.
 */
export async function getRunStatus(
  supabase: SupabaseClient,
  userId: string,
  runId: string,
): Promise<Run | null> {
  const { data: runRow } = await supabase
    .from("runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  const run = runRow as Run | null;
  if (!run) return null;
  const project = await getAccessibleProject(supabase, userId, run.project_id);
  if (!project) return null;

  // Settle a provably-dead run on the way past. The cron sweeper catches these
  // too, but a poller shouldn't have to wait for the next scheduled tick to be
  // told the thing it is polling is over — this endpoint exists precisely to
  // answer "is it done yet", and "running" is a wrong answer for a run nothing
  // is executing. The write is guarded and idempotent, so concurrent pollers
  // and the sweeper can all race it harmlessly.
  if (isAbandoned(run)) {
    const settled = await settleAbandonedRun(supabase, run.id, INTERRUPTED_RUN_ERROR);
    if (settled) {
      return { ...run, status: "failed", error: INTERRUPTED_RUN_ERROR, finished_at: new Date().toISOString() };
    }
    // Lost the race: someone else settled it. Re-read rather than report stale.
    const { data: fresh } = await supabase.from("runs").select("*").eq("id", run.id).maybeSingle();
    return (fresh as Run | null) ?? run;
  }
  return run;
}

/** One completed run, reduced to the numbers that matter across time. */
export interface HistoryPoint {
  runId: string;
  createdAt: string;
  provider: Provider;
  model: string;
  totalResponses: number;
  brandResponsesMentioned: number;
  brandMentionRate: number;
  brandMentionRateInterval: { low: number; high: number };
  ownedCitationRate: number;
  /** Share of answers that named any tracked company; a low value means this
   *  run's prompts measured little, so read its rates with suspicion. */
  informativeRate: number;
}

export interface ProjectHistory {
  projectId: string;
  brandName: string;
  points: HistoryPoint[];
  /** When the brand was first mentioned in any run, or null if never. This is
   *  the event a content team is waiting on: publish, re-run, watch it flip. */
  firstMentionAt: string | null;
  /** True once any run has recorded a brand mention. */
  everMentioned: boolean;
}

/**
 * Brand visibility across the project's completed runs, oldest first.
 *
 * The single-run report can't answer "is this working yet" — that needs the
 * series. A client with no mentions is the normal case for months, so the
 * question is whether the rate is inching up, whether their pages have started
 * being cited, and whether the first mention has landed.
 */
export async function getProjectHistory(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  limit = 30,
): Promise<ProjectHistory | null> {
  const project = await getAccessibleProject(supabase, userId, projectId);
  if (!project) return null;

  const capped = Math.min(Math.max(Math.trunc(limit) || 30, 1), 100);
  const { data: runRows } = await supabase
    .from("runs")
    .select("*")
    .eq("project_id", projectId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(capped);

  const runs = ((runRows ?? []) as Run[]).slice().reverse(); // oldest first
  if (runs.length === 0) {
    return {
      projectId,
      brandName: project.brand_name,
      points: [],
      firstMentionAt: null,
      everMentioned: false,
    };
  }

  const runIds = runs.map((r) => r.id);
  const [{ data: mentionRows }, { data: sourceRows }] = await Promise.all([
    supabase.from("mentions").select("*").in("run_id", runIds),
    supabase.from("sources").select("run_id, response_id, url, is_owned").in("run_id", runIds),
  ]);

  const mentionsByRun = new Map<string, Mention[]>();
  for (const m of (mentionRows ?? []) as Mention[]) {
    const list = mentionsByRun.get(m.run_id) ?? [];
    list.push(m);
    mentionsByRun.set(m.run_id, list);
  }
  const sourcesByRun = new Map<string, Pick<Source, "response_id" | "url" | "is_owned">[]>();
  for (const s of (sourceRows ?? []) as (Pick<Source, "response_id" | "url" | "is_owned"> & {
    run_id: string;
  })[]) {
    const list = sourcesByRun.get(s.run_id) ?? [];
    list.push({ response_id: s.response_id, url: s.url, is_owned: s.is_owned });
    sourcesByRun.set(s.run_id, list);
  }

  const points: HistoryPoint[] = runs.map((run) => {
    const mentions = mentionsByRun.get(run.id) ?? [];
    // completed_count is the engine's own tally of stored answers, so it needs
    // no extra query per run — the whole point of keeping this cheap.
    const totalResponses = run.completed_count;
    const summary = computeRunSummary(mentions, totalResponses, project.brand_name);
    const citations = computeCitationStats(sourcesByRun.get(run.id) ?? [], totalResponses);
    // NB: history's informativeRate is portfolio-wide (page-targeted responses
    // included) — this endpoint deliberately avoids per-run response/prompt
    // joins to stay cheap. The run REPORT carries the naming-basis rate.
    const quality = computeMeasurementQuality(mentions, totalResponses);
    return {
      runId: run.id,
      createdAt: run.created_at,
      provider: run.provider,
      model: run.model,
      // Which credential carried this point. A history series is exactly where a
      // credential switch needs to be visible: the engine is unchanged, so
      // without this a step in the line has no candidate explanation.
      route: run.route ?? null,
      totalResponses,
      brandResponsesMentioned: summary.brandResponsesMentioned,
      brandMentionRate: summary.brandMentionRate,
      brandMentionRateInterval: summary.brandMentionRateInterval,
      ownedCitationRate: citations.ownedCitationRate,
      informativeRate: quality.informativeRate,
    };
  });

  const first = points.find((p) => p.brandResponsesMentioned > 0);
  return {
    projectId,
    brandName: project.brand_name,
    points,
    firstMentionAt: first?.createdAt ?? null,
    everMentioned: Boolean(first),
  };
}

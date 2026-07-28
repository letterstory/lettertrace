import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActivityLog } from "@/lib/types";

// Read side of the activity log, shared by the dashboard Logs screen (cookie /
// RLS client) and the programmatic surface (/api/v1/logs, MCP — service-role
// client). Every query scopes by user_id EXPLICITLY so it is correct on the
// service-role client too, where RLS is bypassed.

export interface LogQuery {
  /** Free text, matched against summary / action / path / actor / target. */
  q?: string;
  channel?: string;
  category?: string;
  status?: string;
  actorType?: string;
  projectId?: string;
  /** Only events within the last N days (0 / undefined = all time). */
  days?: number;
  /** 1-based page. */
  page?: number;
  pageSize?: number;
}

export interface LogPage {
  rows: ActivityLog[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function clampInt(value: number | undefined, lo: number, hi: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}

/** PostgREST `or=()` splits on commas and parens, and ilike treats %/_ as
 *  wildcards — strip those so a user's search text can't corrupt the filter. */
function sanitizeTerm(raw: string): string {
  return raw.replace(/[%_(),*]/g, " ").trim().slice(0, 100);
}

/** One page of a user's activity, newest first, with the total match count. */
export async function queryActivityLogs(
  supabase: SupabaseClient,
  userId: string,
  filters: LogQuery = {},
): Promise<LogPage> {
  const pageSize = clampInt(filters.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const page = clampInt(filters.page, 1, 100000, 1);

  let query = supabase
    .from("activity_logs")
    .select("*", { count: "exact" })
    .eq("user_id", userId);

  if (filters.channel) query = query.eq("channel", filters.channel);
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.actorType) query = query.eq("actor_type", filters.actorType);
  if (filters.projectId) query = query.eq("project_id", filters.projectId);
  if (filters.days && filters.days > 0) {
    const since = new Date(Date.now() - filters.days * 86_400_000).toISOString();
    query = query.gte("created_at", since);
  }

  const term = filters.q ? sanitizeTerm(filters.q) : "";
  if (term) {
    const like = `%${term}%`;
    query = query.or(
      [
        `summary.ilike.${like}`,
        `action.ilike.${like}`,
        `path.ilike.${like}`,
        `actor_label.ilike.${like}`,
        `target_id.ilike.${like}`,
      ].join(","),
    );
  }

  const from = (page - 1) * pageSize;
  const { data, count } = await query
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);

  const total = count ?? 0;
  return {
    rows: (data as ActivityLog[] | null) ?? [],
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export interface ActivityStats {
  total: number;
  last24h: number;
  failures7d: number;
  /** API + MCP + CLI events all-time — "programmatic calls". */
  programmatic: number;
}

/** Top-line counts for the Logs header. Independent of the active filters so the
 *  cards always describe the whole account. Four cheap head-count queries. */
export async function activityStats(
  supabase: SupabaseClient,
  userId: string,
): Promise<ActivityStats> {
  const base = () =>
    supabase
      .from("activity_logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);

  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [total, last24h, failures7d, programmatic] = await Promise.all([
    base(),
    base().gte("created_at", since24h),
    base().eq("status", "failure").gte("created_at", since7d),
    base().in("channel", ["api", "mcp", "cli"]),
  ]);

  return {
    total: total.count ?? 0,
    last24h: last24h.count ?? 0,
    failures7d: failures7d.count ?? 0,
    programmatic: programmatic.count ?? 0,
  };
}

// ---------- display metadata (pure data, safe to import anywhere) ----------

export const CHANNEL_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  api: "API",
  mcp: "MCP",
  cli: "CLI",
  cron: "Cron",
  system: "System",
};

export const CATEGORY_LABELS: Record<string, string> = {
  run: "Run",
  auth: "Auth",
  project: "Project",
  prompt: "Prompt",
  topic: "Topic",
  competitor: "Competitor",
  provider_key: "Provider key",
  api_key: "API key",
  oauth: "OAuth",
  onboarding: "Onboarding",
  settings: "Settings",
  mcp_tool: "MCP tool",
  system: "System",
};

export const ACTOR_LABELS: Record<string, string> = {
  user: "User",
  api_key: "API key",
  oauth: "OAuth app",
  mcp: "MCP",
  cron: "Scheduler",
  system: "System",
};

export const STATUS_LABELS: Record<string, string> = {
  success: "Success",
  failure: "Failure",
  info: "Info",
  pending: "Pending",
};

/** The filter dropdown option lists (value + label), in display order. */
export const CHANNEL_OPTIONS = Object.entries(CHANNEL_LABELS);
export const CATEGORY_OPTIONS = Object.entries(CATEGORY_LABELS);
export const ACTOR_OPTIONS = Object.entries(ACTOR_LABELS);
export const STATUS_OPTIONS = Object.entries(STATUS_LABELS);

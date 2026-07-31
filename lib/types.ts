// Shared domain + database row types for LetterTrace.
// Column names mirror supabase/schema.sql exactly.

export type Provider = "anthropic" | "openai" | "google" | "perplexity";

// LLM routers are credentials, not providers, so they get their own union and
// stay out of `Provider` — which is what keeps `runs.provider` meaning "whose
// answer was this" rather than "who billed us". See lib/routers.ts.
export type RouterId = "concentrate";

export type RunStatus = "pending" | "running" | "completed" | "failed";

export type EntityType = "brand" | "competitor";

export type Sentiment = "positive" | "neutral" | "negative";

export type Schedule = "off" | "daily" | "weekly";

export type PromptSource = "ai" | "manual";

export interface Profile {
  id: string;
  email: string | null;
  created_at: string;
}

export interface ProviderKey {
  id: string;
  user_id: string;
  provider: Provider;
  label: string | null;
  encrypted_key: string; // never sent to the client
  key_hint: string; // e.g. "sk-…4a9c"
  created_at: string;
}

// An LLM router (gateway) credential: one key that reaches many providers. It
// lives in its own table rather than as another `provider_keys` row because a
// router is not a provider — see the header of lib/routers.ts. `search_verified`
// records which providers' native web search this key was actually seen to pass
// through, which is what decides whether it may serve a monitored run.
export interface RouterKey {
  id: string;
  user_id: string;
  router: RouterId;
  label: string | null;
  /** Only set for a router the user self-hosts; otherwise the registry's. */
  base_url: string | null;
  encrypted_key: string; // never sent to the client
  key_hint: string;
  search_verified: Provider[];
  created_at: string;
}

// Safe shape returned to the browser (no ciphertext).
export interface RouterKeyPublic {
  id: string;
  router: RouterId;
  label: string | null;
  base_url: string | null;
  key_hint: string;
  search_verified: Provider[];
  created_at: string;
}

/** Which router served a call, recorded on runs so a step change in a trend
 *  line can be attributed to a credential switch rather than to visibility. */
export interface RouteInfo {
  router: RouterId;
  /** Override for a self-hosted deployment of the router. */
  baseUrl?: string | null;
}

// Lettertrace API key for programmatic access (REST v1 + MCP). Only the hash
// is stored; this is the safe shape returned to the browser.
export interface ApiKeyPublic {
  id: string;
  name: string;
  key_hint: string;
  last_used_at: string | null;
  created_at: string;
}

// Safe shape returned to the browser (no ciphertext).
export interface ProviderKeyPublic {
  id: string;
  provider: Provider;
  label: string | null;
  key_hint: string;
  created_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  brand_name: string;
  brand_aliases: string[];
  /** All domains for the brand; index 0 is the primary (main TLD), the rest are phantom sites. */
  brand_domains: string[];
  description: string | null;
  default_provider: Provider;
  default_model: string;
  schedule: Schedule;
  use_web_search: boolean;
  /** Times each active prompt is asked per run (1–10). >1 buys confidence in a "no mention". */
  replicates: number;
  last_run_at: string | null;
  /** When the owner last opened this project's results. Null = never. */
  results_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Competitor {
  id: string;
  project_id: string;
  name: string;
  aliases: string[];
  domain: string | null;
  created_at: string;
}

export interface Topic {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface Prompt {
  id: string;
  project_id: string;
  topic_id: string;
  text: string;
  source: PromptSource;
  is_active: boolean;
  /** The page this prompt was written to surface, when the caller mapped one. */
  target_url: string | null;
  created_at: string;
}

export interface Run {
  id: string;
  project_id: string;
  status: RunStatus;
  provider: Provider;
  model: string;
  /** The LLM router that carried this run, or null for a direct provider key.
   *  `provider` above is still the engine that answered — see lib/routers.ts. */
  route: RouterId | null;
  /** Planned answers for this run: active prompts x replicates. */
  prompt_count: number;
  completed_count: number;
  /** Replicates this run actually used, kept so old runs read correctly. */
  replicates: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface Response {
  id: string;
  run_id: string;
  project_id: string;
  prompt_id: string;
  topic_id: string | null;
  provider: Provider;
  model: string;
  response_text: string;
  created_at: string;
}

// A web source the model cited while answering a monitored prompt (native
// provider web search). `is_owned` marks sources on the brand's own domain, so
// you can see when your site influences an answer even without a mention.
export interface Source {
  id: string;
  response_id: string;
  run_id: string;
  project_id: string;
  url: string;
  domain: string;
  title: string | null;
  snippet: string | null;
  is_owned: boolean;
  created_at: string;
}

export interface Mention {
  id: string;
  response_id: string;
  run_id: string;
  project_id: string;
  topic_id: string | null;
  entity_type: EntityType;
  competitor_id: string | null;
  entity_name: string;
  mentioned: boolean;
  mention_count: number;
  first_position: number; // 0..1 normalized prominence; -1 if not mentioned
  sentiment: Sentiment | null;
  recommended: boolean;
  created_at: string;
}

// ---------- activity logs (telemetry) --------------------------------
// The kind of principal behind an event, and the surface it arrived through.
// See lib/activity.ts for how these are derived and supabase/schema.sql for the
// column definitions they mirror.
export type ActorType = "user" | "api_key" | "oauth" | "mcp" | "cron" | "system";

export type LogChannel = "dashboard" | "api" | "mcp" | "cli" | "cron" | "system";

// Grouping bucket for the feed. Kept as an open string in the DB (any verb can
// be logged) but this union documents the ones the app emits and drives the UI.
export type LogCategory =
  | "run"
  | "auth"
  | "project"
  | "prompt"
  | "topic"
  | "competitor"
  | "provider_key"
  // An LLM router credential. Its own bucket rather than provider_key: the two
  // are different objects with different failure modes, and a feed that merged
  // them would make "which credential did I change" unanswerable.
  | "router_key"
  | "api_key"
  | "oauth"
  | "onboarding"
  | "settings"
  | "mcp_tool"
  | "system";

export type LogStatus = "success" | "failure" | "info" | "pending";

// One telemetry event. Mirrors public.activity_logs exactly. Read-only to the
// client; written only through the service-role logger.
export interface ActivityLog {
  id: string;
  user_id: string | null;
  project_id: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  actor_label: string | null;
  channel: LogChannel;
  category: string;
  action: string;
  status: LogStatus;
  target_type: string | null;
  target_id: string | null;
  summary: string;
  method: string | null;
  path: string | null;
  status_code: number | null;
  ip: string | null;
  user_agent: string | null;
  duration_ms: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

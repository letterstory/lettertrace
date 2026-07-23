// Shared domain + database row types for LetterTrace.
// Column names mirror supabase/schema.sql exactly.

export type Provider = "anthropic" | "openai";

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
  brand_domain: string | null;
  description: string | null;
  default_provider: Provider;
  default_model: string;
  schedule: Schedule;
  use_web_search: boolean;
  last_run_at: string | null;
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
  created_at: string;
}

export interface Run {
  id: string;
  project_id: string;
  status: RunStatus;
  provider: Provider;
  model: string;
  prompt_count: number;
  completed_count: number;
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

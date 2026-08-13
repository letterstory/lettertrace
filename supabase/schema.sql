-- ==================================================================
-- LetterTrace database schema
-- Run this in the Supabase SQL editor (or `supabase db push`).
-- Safe to re-run: uses IF NOT EXISTS / DROP POLICY IF EXISTS.
-- ==================================================================

create extension if not exists pgcrypto;

-- ---------- profiles -------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

-- Auto-create a profile row when a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Stamped the first time an operator alert goes out for this account, and used
-- as the lock that makes it go out exactly once. A confirmation link that gets
-- double-clicked, or a user who signs in from two devices at once, must not mail
-- the operator twice. See alertNewSignup in lib/notify-signup.
alter table public.profiles
  add column if not exists admin_alerted_at timestamptz;

-- Free-trial usage: tokens a user has consumed against the operator's shared
-- (trial) keys before bringing their own. Safe to re-run.
alter table public.profiles
  add column if not exists trial_tokens_used bigint not null default 0;

-- Atomic increment, self-scoped to the caller via auth.uid() (so a user can
-- only ever add to their own tally). Called by the trial run/generate routes.
create or replace function public.increment_trial_tokens(amount bigint)
returns bigint
language sql
security definer set search_path = public
as $$
  update public.profiles
    set trial_tokens_used = trial_tokens_used + greatest(amount, 0)
    where id = auth.uid()
    returning trial_tokens_used;
$$;

-- What the free tier has COST, in micro-dollars, priced by lib/pricing.ts.
--
-- Tokens above are a tally; this is the ceiling. Counting runs alone bounds how
-- many times a user may start something, not how much that something spends —
-- a run is prompts x replicates calls, with no cap on prompts, and the three
-- suggest/generate endpoints spend operator money without consuming a run at
-- all. Both holes close against this column.
--
-- Micro-dollars rather than a numeric so the increment is integer arithmetic:
-- summing fractional currency across concurrent calls is how a ledger drifts.
-- Safe to re-run.
alter table public.profiles
  add column if not exists trial_spend_micros bigint not null default 0;

create or replace function public.increment_trial_spend(amount bigint)
returns bigint
language sql
security definer set search_path = public
as $$
  update public.profiles
    set trial_spend_micros = trial_spend_micros + greatest(amount, 0)
    where id = auth.uid()
    returning trial_spend_micros;
$$;

-- Free-trial gating is per RUN: monitoring runs executed on the operator's
-- shared keys before the user brings their own (tokens above are still
-- recorded so the operator can watch spend). Safe to re-run.
alter table public.profiles
  add column if not exists trial_runs_used integer not null default 0;

create or replace function public.increment_trial_runs()
returns integer
language sql
security definer set search_path = public
as $$
  update public.profiles
    set trial_runs_used = trial_runs_used + 1
    where id = auth.uid()
    returning trial_runs_used;
$$;

-- Atomic check-and-consume: takes one free run IFF the caller is still under
-- the limit, in a single UPDATE so parallel requests can't all slip past the
-- gate. Returns whether a run was granted. Self-scoped via auth.uid(); calling
-- it directly only ever spends the caller's own allowance.
create or replace function public.consume_trial_run(max_runs integer)
returns boolean
language plpgsql
security definer set search_path = public
as $$
begin
  update public.profiles
    set trial_runs_used = trial_runs_used + 1
    where id = auth.uid()
      and trial_runs_used < greatest(max_runs, 0);
  return found;
end;
$$;

-- ---------- provider_keys (BYOK, encrypted) -------------------------
create table if not exists public.provider_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'openai', 'google', 'perplexity', 'xai')),
  label text,
  encrypted_key text not null,
  key_hint text not null,
  created_at timestamptz not null default now(),
  unique (user_id, provider)
);

-- Widen the provider allow-list on existing deployments (create table above is
-- a no-op once the table exists, so the constraint must be replaced in place).
-- Safe to re-run.
alter table public.provider_keys drop constraint if exists provider_keys_provider_check;
alter table public.provider_keys
  add constraint provider_keys_provider_check check (provider in ('anthropic', 'openai', 'google', 'perplexity', 'xai'));

-- ---------- router_keys (LLM gateway credential, encrypted) ----------
-- One key that reaches many providers (OpenRouter, Concentrate). Deliberately a
-- separate table rather than more provider_keys rows: a router is a credential,
-- not an answer engine, so it must not widen the provider allow-list above and
-- must never be storable as a project's default_provider. See lib/routers.ts.
--
-- search_verified holds the providers whose NATIVE web search this key was
-- actually observed to pass through (checked when the key is saved). Monitored
-- runs with web search on are gated on it, because a gateway that accepts the
-- search params and drops them returns an ungrounded answer that still looks
-- like a measurement. Empty is the safe default: nothing verified yet.
create table if not exists public.router_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  router text not null check (router in ('concentrate', 'openrouter', 'merge')),
  label text,
  -- Only for a self-hosted deployment of a router; null uses the registry's URL.
  base_url text,
  encrypted_key text not null,
  key_hint text not null,
  search_verified text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, router)
);

-- Widen the router allow-list on existing deployments (the create above is a
-- no-op once the table exists). Safe to re-run.
alter table public.router_keys drop constraint if exists router_keys_router_check;
alter table public.router_keys
  add constraint router_keys_router_check check (router in ('concentrate', 'openrouter', 'merge'));

-- ---------- projects -------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  brand_name text not null,
  brand_aliases text[] not null default '{}',
  brand_domains text[] not null default '{}',
  description text,
  default_provider text not null default 'anthropic' check (default_provider in ('anthropic', 'openai', 'google', 'perplexity', 'xai')),
  default_model text not null default 'claude-sonnet-4-6',
  schedule text not null default 'off' check (schedule in ('off', 'daily', 'weekly')),
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Widen the default-provider allow-list on existing deployments. Safe to re-run.
alter table public.projects drop constraint if exists projects_default_provider_check;
alter table public.projects
  add constraint projects_default_provider_check check (default_provider in ('anthropic', 'openai', 'google', 'perplexity', 'xai'));

-- Query the models with their native web search on, so we can capture the
-- sources they cite. Default on. Safe to re-run.
alter table public.projects
  add column if not exists use_web_search boolean not null default true;

-- Phantomsites: a brand can have several domains — the main site plus phantom
-- sites that build rapport for the same brand. The first entry is the primary
-- (main TLD); every entry counts for source ownership. Migrates the old single
-- brand_domain into the array, then retires it. Safe to re-run.
alter table public.projects
  add column if not exists brand_domains text[] not null default '{}';
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'projects'
      and column_name = 'brand_domain'
  ) then
    update public.projects
      set brand_domains = array[btrim(brand_domain)]
      where brand_domain is not null
        and btrim(brand_domain) <> ''
        and brand_domains = '{}';
    alter table public.projects drop column brand_domain;
  end if;
end $$;

-- Multi-org: which of the user's projects (organizations) the dashboard is
-- currently showing. Falls back to the earliest project when unset. Safe to
-- re-run; lives here because it references projects, created just above.
alter table public.profiles
  add column if not exists active_project_id uuid references public.projects (id) on delete set null;

-- Backfill: every auth user MUST have a profile row. Accounts created before the
-- signup trigger existed (or provisioned out of band) can be missing one, which
-- silently breaks org switching: setActiveProject updates profiles by id, and
-- with no row that update matches zero rows (no error), so active_project_id
-- never changes and the dashboard's org switcher spins forever. Safe to re-run.
insert into public.profiles (id, email)
select u.id, u.email
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;

-- Point the dashboard at one of the caller's own organizations. SECURITY
-- DEFINER so it can guarantee a profile row exists (the client-write guard below
-- forbids client inserts) and self-scoped via auth.uid(), so a caller can only
-- move their OWN pointer, and only to a project they own. This makes switching
-- self-healing even if a profile row is somehow still missing. Safe to re-run.
create or replace function public.set_active_project(p_project_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (auth.uid())
    on conflict (id) do nothing;
  update public.profiles
    set active_project_id = p_project_id
    where id = auth.uid()
      and exists (
        select 1 from public.projects
        where id = p_project_id and user_id = auth.uid()
      );
end;
$$;

-- How many times each active prompt is asked per run. Answers vary between
-- identical calls, so a single ask can't distinguish "not mentioned" from
-- "mentioned, unlucky this time" — at a true 50% mention rate one ask reads
-- zero half the time. Replicates buy confidence at a linear cost in tokens,
-- so the default stays 1 and raising it is opt-in per project.
alter table public.projects
  add column if not exists replicates integer not null default 1
  check (replicates between 1 and 10);

-- When the owner last actually LOOKED at this project's results. A run
-- finishing is silent otherwise: the scheduler and the API both finish runs
-- while nobody is on the page, and even a manual run just appears in a list.
-- Comparing a run's finished_at against this is what decides whether to nudge.
-- Null means never looked, so the newest finished run is unseen — which is the
-- right first impression for an account that has runs but has never opened one.
alter table public.projects
  add column if not exists results_seen_at timestamptz;

-- ---------- competitors ----------------------------------------------
create table if not exists public.competitors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null,
  aliases text[] not null default '{}',
  domain text,
  created_at timestamptz not null default now()
);

-- ---------- topics ---------------------------------------------------
create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

-- ---------- prompts (topic variations) -------------------------------
create table if not exists public.prompts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  topic_id uuid not null references public.topics (id) on delete cascade,
  text text not null,
  source text not null default 'ai' check (source in ('ai', 'manual')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- The page this prompt was written to surface, when there is one. Content
-- teams map questions to pages; this records the mapping so the run report
-- can answer "when the question my page was built for gets asked, is MY page
-- the one the answer cites?" — per-URL cited-hit rates, not just brand-level.
alter table public.prompts
  add column if not exists target_url text;

-- ---------- runs -----------------------------------------------------
create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  provider text not null,
  model text not null,
  prompt_count integer not null default 0,
  completed_count integer not null default 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

-- Replicates the run was executed with, recorded so a historical run can still
-- be read correctly after the project's setting changes. prompt_count counts
-- planned ANSWERS (prompts x replicates), which is what the UI reports.
alter table public.runs
  add column if not exists replicates integer not null default 1;

-- Keep the recorded provider in the known set, in sync with provider_keys and
-- projects. Applied as an ALTER so it lands on both fresh and existing tables;
-- all historical rows only ever held 'anthropic'/'openai', so this is safe to
-- add and safe to re-run.
alter table public.runs drop constraint if exists runs_provider_check;
alter table public.runs
  add constraint runs_provider_check check (provider in ('anthropic', 'openai', 'google', 'perplexity', 'xai'));

-- Which credential carried this run: null for a direct provider key (every
-- historical row), else the router that served it. `provider` above stays the
-- engine that answered, so a client who switches from a direct key to a router
-- keeps one continuous series — and when the series does step, this column is
-- what says a credential change is the reason to suspect.
-- Split into add-column + named constraint so both halves stay re-runnable: an
-- inline check on `add column if not exists` is skipped once the column exists,
-- which would leave the allow-list unapplied on the deployments that need it.
alter table public.runs add column if not exists route text;
alter table public.runs drop constraint if exists runs_route_check;
alter table public.runs
  add constraint runs_route_check check (route is null or route in ('concentrate', 'openrouter'));

-- ---------- responses ------------------------------------------------
create table if not exists public.responses (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  prompt_id uuid references public.prompts (id) on delete set null,
  topic_id uuid references public.topics (id) on delete set null,
  provider text not null,
  model text not null,
  response_text text not null,
  created_at timestamptz not null default now()
);

-- Same provider allow-list as runs (see note above). Safe to add and re-run.
alter table public.responses drop constraint if exists responses_provider_check;
alter table public.responses
  add constraint responses_provider_check check (provider in ('anthropic', 'openai', 'google', 'perplexity', 'xai'));

-- ---------- mentions -------------------------------------------------
create table if not exists public.mentions (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references public.responses (id) on delete cascade,
  run_id uuid not null references public.runs (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  topic_id uuid references public.topics (id) on delete set null,
  entity_type text not null check (entity_type in ('brand', 'competitor')),
  competitor_id uuid references public.competitors (id) on delete set null,
  entity_name text not null,
  mentioned boolean not null default true,
  mention_count integer not null default 0,
  first_position double precision not null default -1,
  sentiment text check (sentiment in ('positive', 'neutral', 'negative')),
  recommended boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- sources (web citations behind an answer) -----------------
create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references public.responses (id) on delete cascade,
  run_id uuid not null references public.runs (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  url text not null,
  domain text not null,
  title text,
  snippet text,
  is_owned boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- competitor de-duplication --------------------------------
-- The competitor suggester could name the same company twice and nothing
-- rejected the second copy. computeEntityStats keys on competitor_id and sums
-- mention_count across every row, so a duplicate inflated the share-of-voice
-- DENOMINATOR — quietly understating the brand's own share rather than the
-- competitor's. Collapse anything already stored, then make it impossible.
--
-- Note mentions.competitor_id is ON DELETE SET NULL, so simply deleting the
-- duplicate row would orphan its mentions to the entity_name fallback in
-- entityKey() and leave the double-count in place. Re-point first, then delete.
-- Safe to re-run: every statement is a no-op once the data is clean.

-- 1. Re-point mentions from each duplicate onto the oldest copy of that name.
with canonical as (
  select project_id,
         lower(name) as lname,
         (array_agg(id order by created_at, id))[1] as keep_id
  from public.competitors
  group by project_id, lower(name)
),
dupes as (
  select c.id as dup_id, k.keep_id
  from public.competitors c
  join canonical k on k.project_id = c.project_id and k.lname = lower(c.name)
  where c.id <> k.keep_id
)
update public.mentions m
set competitor_id = d.keep_id
from dupes d
where m.competitor_id = d.dup_id;

-- 2. Drop the mention rows that re-pointing just made redundant (one entity
--    counted twice in the same response), keeping the earliest of each pair.
delete from public.mentions m
using public.mentions keep
where m.entity_type = 'competitor'
  and m.competitor_id is not null
  and m.competitor_id = keep.competitor_id
  and m.response_id = keep.response_id
  and m.id > keep.id;

-- 3. Remove the duplicate competitor rows themselves.
with canonical as (
  select project_id,
         lower(name) as lname,
         (array_agg(id order by created_at, id))[1] as keep_id
  from public.competitors
  group by project_id, lower(name)
)
delete from public.competitors c
using canonical k
where k.project_id = c.project_id
  and k.lname = lower(c.name)
  and c.id <> k.keep_id;

-- 4. One competitor name per project, case-insensitive. POST /api/competitors
--    turns the resulting 23505 into a 409.
create unique index if not exists competitors_project_name_uniq
  on public.competitors (project_id, lower(name));

-- ---------- indexes --------------------------------------------------
create index if not exists idx_projects_user on public.projects (user_id);
create index if not exists idx_competitors_project on public.competitors (project_id);
create index if not exists idx_topics_project on public.topics (project_id);
create index if not exists idx_prompts_project on public.prompts (project_id);
create index if not exists idx_prompts_topic on public.prompts (topic_id);
create index if not exists idx_runs_project on public.runs (project_id, created_at desc);
create index if not exists idx_responses_run on public.responses (run_id);
create index if not exists idx_mentions_project on public.mentions (project_id);
create index if not exists idx_mentions_run on public.mentions (run_id);
create index if not exists idx_mentions_response on public.mentions (response_id);
create index if not exists idx_sources_response on public.sources (response_id);
create index if not exists idx_sources_run on public.sources (run_id);
create index if not exists idx_sources_project on public.sources (project_id);

-- ==================================================================
-- Row Level Security
-- ==================================================================
alter table public.profiles       enable row level security;
alter table public.provider_keys  enable row level security;
alter table public.router_keys    enable row level security;
alter table public.projects       enable row level security;
alter table public.competitors    enable row level security;
alter table public.topics         enable row level security;
alter table public.prompts        enable row level security;
alter table public.runs           enable row level security;
alter table public.responses      enable row level security;
alter table public.mentions       enable row level security;
alter table public.sources        enable row level security;

-- profiles: a user sees/edits only their own row.
drop policy if exists "profiles_self" on public.profiles;
create policy "profiles_self" on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- Lock down direct writes to profiles: without this, a user could UPDATE (or
-- delete + re-insert) their own row to reset trial_runs_used / trial_tokens_used
-- and get unlimited free runs on the operator's keys.
--
-- GRANT/REVOKE alone is NOT reliable here: Supabase re-grants table privileges
-- to the `authenticated` role, so a REVOKE can silently be undone. The
-- authoritative guard is a trigger that runs for every write and can't be
-- re-granted around. We still narrow the grants as defence-in-depth.
revoke insert, update, delete on table public.profiles from anon, authenticated;
grant update (active_project_id) on table public.profiles to authenticated;

-- Trigger guard. Runs as the invoker (NOT security definer), so current_user
-- reflects who is really writing: 'authenticated'/'anon' for a client request,
-- but the table owner for our security-definer functions (signup trigger + the
-- trial RPCs), which therefore pass straight through. Clients may not delete a
-- profile row or move the trial meters; everything else (e.g. active_project_id)
-- is allowed. Safe to re-run.
create or replace function public.guard_profiles()
returns trigger
language plpgsql
as $$
begin
  -- Not a direct client session (security-definer RPC, service role, admin):
  -- allow unchanged.
  if current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'profiles rows cannot be deleted by clients';
  end if;
  if tg_op = 'INSERT' then
    raise exception 'profiles rows are created by the signup trigger only';
  end if;

  -- UPDATE from a client: trial meters are immutable, force them back to the
  -- stored values regardless of what was submitted.
  new.trial_runs_used := old.trial_runs_used;
  new.trial_tokens_used := old.trial_tokens_used;
  return new;
end;
$$;

drop trigger if exists guard_profiles_write on public.profiles;
create trigger guard_profiles_write
  before insert or update or delete on public.profiles
  for each row execute function public.guard_profiles();

-- provider_keys: owned by user.
drop policy if exists "keys_owner" on public.provider_keys;
create policy "keys_owner" on public.provider_keys
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- router_keys: owned by user, same shape as provider_keys.
drop policy if exists "router_keys_owner" on public.router_keys;
create policy "router_keys_owner" on public.router_keys
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- projects: owned by user.
drop policy if exists "projects_owner" on public.projects;
create policy "projects_owner" on public.projects
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Helper: is a project owned by the current user?
-- (Inlined as a subquery in each child policy below.)

-- Child tables: access allowed when the parent project belongs to the user.
drop policy if exists "competitors_owner" on public.competitors;
create policy "competitors_owner" on public.competitors
  for all using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "topics_owner" on public.topics;
create policy "topics_owner" on public.topics
  for all using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "prompts_owner" on public.prompts;
create policy "prompts_owner" on public.prompts
  for all using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "runs_owner" on public.runs;
create policy "runs_owner" on public.runs
  for all using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "responses_owner" on public.responses;
create policy "responses_owner" on public.responses
  for all using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "mentions_owner" on public.mentions;
create policy "mentions_owner" on public.mentions
  for all using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "sources_owner" on public.sources;
create policy "sources_owner" on public.sources
  for all using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

-- NOTE: the service-role key (used by /api/cron/run) bypasses RLS entirely,
-- which is what lets the scheduler read due projects across all users.

-- ---------- api_keys (programmatic access: REST v1 + MCP) ------------
-- Lettertrace API keys let users query their own data (and trigger runs)
-- from scripts and MCP clients. Only a SHA-256 hash is stored; the plaintext
-- is shown once at creation. Lookups by hash happen through the service-role
-- client (/api/v1 and /api/mcp requests carry no Supabase session).
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  key_hint text not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists api_keys_user_idx on public.api_keys (user_id);

alter table public.api_keys enable row level security;

drop policy if exists "api_keys_owner" on public.api_keys;
create policy "api_keys_owner" on public.api_keys
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ==================================================================
-- OAuth 2.1 Authorization Server
-- Lets a CLI or external system obtain DELEGATED, user-scoped, expiring,
-- revocable access WITHOUT the user hand-minting a static api_keys row.
-- Lettertrace is the authorization server; Supabase is the identity provider
-- (the user approves each grant from a logged-in browser session).
--
-- Every secret below is stored ONLY as a sha256 hex digest, exactly like
-- api_keys.key_hash. Access tokens issued here resolve through the very same
-- authenticateApiKey() path /api/v1 and /api/mcp already use, so those surfaces
-- keep working unchanged (see lib/api-auth.ts).
--
-- The api_keys table above is deliberately untouched: OAuth tokens live in
-- their own tables so the two credential classes never share a keyspace and so
-- revocation here can be soft (revoked_at) rather than a hard row delete.
-- All statements are idempotent. Safe to re-run.
-- ==================================================================

-- ---------- oauth_clients -------------------------------------------
-- A registered client (the CLI, an MCP host, an external server). The
-- first-party CLI is seeded below with a fixed, secret-less (public) client id;
-- it authenticates by exact redirect-URI match + PKCE, per the OAuth 2.1
-- native-app model. Confidential clients additionally hold a client_secret_hash.
create table if not exists public.oauth_clients (
  client_id                  text primary key,
  user_id                    uuid references auth.users (id) on delete cascade,   -- null = first-party / global
  is_first_party             boolean not null default false,
  client_name                text not null,
  client_type                text not null default 'public'
                               check (client_type in ('public', 'confidential')),
  client_secret_hash         text,                                                -- null for public clients
  token_endpoint_auth_method text not null default 'none'
                               check (token_endpoint_auth_method in ('none', 'client_secret_basic')),
  redirect_uris              text[] not null,
  allowed_scopes             text[] not null default '{}',
  logo_uri                   text,
  client_uri                 text,
  created_at                 timestamptz not null default now()
);
create index if not exists oauth_clients_user_idx on public.oauth_clients (user_id);

-- Seed the first-party CLI / MCP client. Loopback redirect templates: the host
-- and path must match exactly; only the port varies at authorize time (RFC
-- 8252). This is a canonical, product-owned client, so re-applying the schema
-- RESETS its fields (on conflict do UPDATE, not do nothing): that way a stale or
-- partially-seeded lt_cli row — e.g. one whose redirect_uris don't include the
-- loopback templates, which surfaces to users as "The redirect URI is not
-- registered for this client" — is repaired simply by re-running this file.
insert into public.oauth_clients
  (client_id, is_first_party, client_name, client_type, token_endpoint_auth_method, redirect_uris, allowed_scopes)
values
  ('lt_cli', true, 'Lettertrace CLI & MCP', 'public', 'none',
   array['http://127.0.0.1/callback', 'http://[::1]/callback'],
   array['projects:read', 'projects:write', 'runs:read', 'runs:trigger',
         'keys:read', 'keys:write', 'offline_access'])
on conflict (client_id) do update set
  is_first_party = excluded.is_first_party,
  client_name = excluded.client_name,
  client_type = excluded.client_type,
  token_endpoint_auth_method = excluded.token_endpoint_auth_method,
  redirect_uris = excluded.redirect_uris,
  allowed_scopes = excluded.allowed_scopes;

-- ---------- oauth_authorizations ------------------------------------
-- The standing user<->client grant. One row per (user, client, resource); it is
-- what the "Connected apps" settings screen lists and what a user revokes.
-- Revoking it cascade-revokes the access/refresh tokens minted under it.
create table if not exists public.oauth_authorizations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  client_id     text not null references public.oauth_clients (client_id) on delete cascade,
  scopes        text[] not null,
  resource      text not null,
  granted_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  unique (user_id, client_id, resource)
);
create index if not exists oauth_authorizations_user_idx on public.oauth_authorizations (user_id);

-- ---------- oauth_pending_requests ----------------------------------
-- A validated /authorize request, persisted server-side so the login bounce and
-- the consent screen round-trip only an opaque id (?req=<id>) rather than the
-- full, tamperable authorize query string. user_id is filled in only AFTER the
-- browser proves its Supabase session; consent_nonce is generated on the consent
-- page (post-login) for CSRF.
create table if not exists public.oauth_pending_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users (id) on delete cascade,   -- set only after login
  client_id      text not null references public.oauth_clients (client_id) on delete cascade,
  redirect_uri   text not null,
  scopes         text[] not null,
  resource       text not null,
  state          text,
  code_challenge text not null,
  consent_nonce  text,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now()
);
create index if not exists oauth_pending_exp_idx on public.oauth_pending_requests (expires_at);

-- ---------- oauth_authorization_codes -------------------------------
-- Single-use authorization codes (~5 min). Bound to the client, the exact
-- redirect_uri, the PKCE challenge, the granted scopes, and the resource
-- audience; every one of those is re-verified at the token endpoint.
create table if not exists public.oauth_authorization_codes (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  client_id             text not null references public.oauth_clients (client_id) on delete cascade,
  authorization_id      uuid references public.oauth_authorizations (id) on delete cascade,
  code_hash             text not null unique,
  code_challenge        text not null,
  code_challenge_method text not null check (code_challenge_method in ('S256')),  -- 'plain' is rejected
  redirect_uri          text not null,
  scopes                text[] not null,
  resource              text not null check (resource in ('v1', 'mcp')),          -- RFC 8707 audience
  expires_at            timestamptz not null,
  used_at               timestamptz,
  created_at            timestamptz not null default now()
);
create index if not exists oauth_auth_codes_hash_idx on public.oauth_authorization_codes (code_hash);
create index if not exists oauth_auth_codes_exp_idx  on public.oauth_authorization_codes (expires_at);

-- ---------- oauth_access_tokens -------------------------------------
-- The bearer tokens presented to /api/v1 and /api/mcp. Resolved by hash on the
-- hot path (see authenticateApiKey). expires_at is NOT NULL and scopes may never
-- be empty or '*' — an OAuth token is never immortal and never implicitly
-- full-access (that would silently defeat the consent screen).
create table if not exists public.oauth_access_tokens (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  client_id        text not null references public.oauth_clients (client_id) on delete cascade,
  authorization_id uuid references public.oauth_authorizations (id) on delete cascade,
  family_id        uuid not null,                                                -- shared with the refresh-token lineage
  token_hash       text not null unique,
  token_hint       text not null,
  scopes           text[] not null
                     check (array_length(scopes, 1) is not null and not ('*' = any (scopes))),
  resource         text not null,
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  last_used_at     timestamptz,
  issued_at        timestamptz not null default now()
);
create index if not exists oauth_at_hash_idx   on public.oauth_access_tokens (token_hash);
create index if not exists oauth_at_exp_idx    on public.oauth_access_tokens (expires_at);
create index if not exists oauth_at_auth_idx   on public.oauth_access_tokens (authorization_id);
create index if not exists oauth_at_family_idx on public.oauth_access_tokens (family_id);

-- ---------- oauth_refresh_tokens ------------------------------------
-- Long-lived, single-use, ROTATING. Each rotation issues a new access+refresh
-- pair sharing a family_id; presenting an already-used refresh token trips reuse
-- detection and the whole family is revoked. successor_pair records the pair a
-- consumed token minted, so a network-retried refresh within a short grace
-- window replays the same result instead of self-revoking.
create table if not exists public.oauth_refresh_tokens (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  client_id        text not null references public.oauth_clients (client_id) on delete cascade,
  authorization_id uuid references public.oauth_authorizations (id) on delete cascade,
  family_id        uuid not null,
  token_hash       text not null unique,
  scopes           text[] not null,
  resource         text not null,
  expires_at       timestamptz not null,
  used_at          timestamptz,
  rotated_to       uuid,
  successor_pair   jsonb,
  revoked_at       timestamptz,
  issued_at        timestamptz not null default now()
);
create index if not exists oauth_rt_hash_idx   on public.oauth_refresh_tokens (token_hash);
create index if not exists oauth_rt_family_idx on public.oauth_refresh_tokens (family_id);

-- ---------- oauth_device_codes (RFC 8628) ---------------------------
-- The device-authorization grant for headless CLIs. Both device_code and the
-- human-typed user_code are stored hashed and looked up by hash; user_id is set
-- ONLY when a logged-in user approves, and the token endpoint reads the user
-- from this row alone (never from the polling request).
create table if not exists public.oauth_device_codes (
  id                uuid primary key default gen_random_uuid(),
  client_id         text not null references public.oauth_clients (client_id) on delete cascade,
  user_id           uuid references auth.users (id) on delete cascade,            -- null until approved
  authorization_id  uuid references public.oauth_authorizations (id) on delete cascade,
  device_code_hash  text not null unique,
  user_code_hash    text not null unique,
  scopes            text[] not null,
  resource          text not null,
  status            text not null default 'pending'
                      check (status in ('pending', 'approved', 'denied', 'consumed', 'expired')),
  interval_seconds  int not null default 5,
  attempts          int not null default 0,
  poll_count        int not null default 0,
  last_polled_at    timestamptz,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now()
);
create index if not exists oauth_dc_dhash_idx on public.oauth_device_codes (device_code_hash);
create index if not exists oauth_dc_uhash_idx on public.oauth_device_codes (user_code_hash);

-- ---------- oauth_rate_limits ---------------------------------------
-- A tiny DB-counter limiter. express-rate-limit is Express-only and unusable in
-- App Router route handlers, and this deployment has no guaranteed Redis, so
-- abuse-prone endpoints (register, device, activate, token polling) count
-- against fixed windows here. See lib/oauth-ratelimit.ts.
create table if not exists public.oauth_rate_limits (
  bucket       text primary key,
  count        int not null default 0,
  window_start timestamptz not null default now()
);

-- Atomic fixed-window increment. Resets the window when it has elapsed, then
-- bumps the counter, and returns the count WITHIN the current window. Runs as a
-- security-definer so the service-role AS logic can call it; self-contained so a
-- burst of concurrent calls can't race past the limit.
create or replace function public.oauth_rate_touch(p_bucket text, p_window_seconds int, p_limit int)
returns table (allowed boolean, current_count int)
language plpgsql
security definer set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.oauth_rate_limits (bucket, count, window_start)
    values (p_bucket, 1, now())
  on conflict (bucket) do update
    set count = case
                  when public.oauth_rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                  then 1
                  else public.oauth_rate_limits.count + 1
                end,
        window_start = case
                  when public.oauth_rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                  then now()
                  else public.oauth_rate_limits.window_start
                end
  returning count into v_count;
  return query select (v_count <= p_limit), v_count;
end;
$$;

-- ---------- OAuth RLS -----------------------------------------------
-- All OAuth tables enable RLS (default-deny). The authorization-server logic
-- runs with the service-role client, which bypasses RLS, and ALWAYS scopes its
-- queries by the server-derived user_id. Only the two tables the settings UI
-- reads through the cookie-bound client get per-user policies.
alter table public.oauth_clients               enable row level security;
alter table public.oauth_authorizations        enable row level security;
alter table public.oauth_pending_requests      enable row level security;
alter table public.oauth_authorization_codes   enable row level security;
alter table public.oauth_access_tokens         enable row level security;
alter table public.oauth_refresh_tokens        enable row level security;
alter table public.oauth_device_codes          enable row level security;
alter table public.oauth_rate_limits           enable row level security;

-- A user may SELECT the clients they personally registered (for a future
-- management view). First-party/global clients (user_id null) are not exposed
-- to the cookie client; the AS reads them service-role.
drop policy if exists "oauth_clients_owner" on public.oauth_clients;
create policy "oauth_clients_owner" on public.oauth_clients
  for select using (user_id = auth.uid());

-- A user reads and revokes their own standing grants ("Connected apps").
drop policy if exists "oauth_authorizations_owner" on public.oauth_authorizations;
create policy "oauth_authorizations_owner" on public.oauth_authorizations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ==================================================================
-- activity_logs (telemetry)
-- One append-only event per meaningful thing that happens in a Lettertrace
-- account, whoever triggered it: a signed-in user in the dashboard, an agent
-- calling the REST/MCP API, the CLI, or the cron scheduler. This is the single
-- searchable feed behind the "Logs" screen. Every write happens through the
-- service-role client (see lib/activity.ts), so clients can only ever READ their
-- own rows — a user can neither forge nor tamper with the record.
--
-- Rows are deliberately denormalized (actor_label, summary, request metadata all
-- copied in) so the feed reads correctly forever even after the referenced
-- project / key / token is renamed or deleted. NOTHING secret is ever stored
-- here: key hints and client ids only, never plaintext keys or tokens.
-- Safe to re-run.
-- ==================================================================
create table if not exists public.activity_logs (
  id           uuid primary key default gen_random_uuid(),
  -- The account the event belongs to. Null only for operator/system events with
  -- no owning user; those are invisible to every cookie client by design.
  user_id      uuid references auth.users (id) on delete cascade,
  -- Org context, when the event has one. SET NULL (not CASCADE) so deleting a
  -- project does not erase its history — the summary still reads correctly.
  project_id   uuid references public.projects (id) on delete set null,
  -- WHO acted, and through WHAT surface. actor_type is the kind of principal;
  -- channel is how the action arrived. e.g. an OAuth token used from the CLI is
  -- actor_type 'oauth', channel 'cli'.
  actor_type   text not null check (actor_type in ('user','api_key','oauth','mcp','cron','system')),
  actor_id     text,             -- user id / api_keys.id / oauth token id / client id
  actor_label  text,             -- human friendly: email, "Lettertrace CLI", "Scheduler"
  channel      text not null check (channel in ('dashboard','api','mcp','cli','cron','system')),
  -- WHAT happened. category groups the feed; action is the specific verb.
  category     text not null,    -- 'run','auth','project','prompt','topic','competitor','provider_key','api_key','oauth','onboarding','settings','mcp_tool','system'
  action       text not null,    -- 'run.completed','project.created','oauth.token_issued',...
  status       text not null default 'success' check (status in ('success','failure','info','pending')),
  target_type  text,             -- resource the action touched ('run','project','prompt',...)
  target_id    text,
  summary      text not null,    -- one human sentence, shown as the row title
  -- Request shape, for the API/MCP/CLI surfaces (all null for internal events).
  method       text,
  path         text,
  status_code  integer,
  ip           text,
  user_agent   text,
  duration_ms  integer,
  metadata     jsonb not null default '{}'::jsonb,   -- freeform, non-secret detail
  created_at   timestamptz not null default now()
);

create index if not exists idx_activity_user      on public.activity_logs (user_id, created_at desc);
create index if not exists idx_activity_project    on public.activity_logs (project_id, created_at desc);
create index if not exists idx_activity_channel    on public.activity_logs (user_id, channel, created_at desc);
create index if not exists idx_activity_category   on public.activity_logs (user_id, category, created_at desc);
create index if not exists idx_activity_status     on public.activity_logs (user_id, status, created_at desc);
create index if not exists idx_activity_created    on public.activity_logs (created_at desc);

alter table public.activity_logs enable row level security;

-- Read-only for the owner. There is deliberately NO insert/update/delete policy:
-- with RLS on, that default-denies every client write, so the feed is
-- append-only and un-forgeable. The service-role writer bypasses RLS. We also
-- narrow the grants as defence-in-depth (Supabase may re-grant, hence the RLS
-- default-deny is the real guard).
drop policy if exists "activity_logs_owner_read" on public.activity_logs;
create policy "activity_logs_owner_read" on public.activity_logs
  for select using (user_id = auth.uid());

revoke insert, update, delete on table public.activity_logs from anon, authenticated;

-- ---------- ops_events (operational telemetry, staff-only) ----------------
--
-- What is happening in this deployment and what is failing. Runs, provider
-- calls, errors — recorded so an operator can answer "is it working, and if
-- not, where" without reading function logs.
--
-- BUCKETED BY THE HOUR, not one row per event. A failing provider throws on
-- every prompt of every run; per-event rows would turn one bad afternoon into
-- tens of thousands of them, and the interesting number is "this failed 400
-- times", not four hundred timestamps. Each row is (kind, signature, hour) with
-- a count, so volume is bounded by the number of DISTINCT problems rather than
-- by how badly they are going.
--
-- RLS ON WITH NO POLICIES. This is the same default-deny the oauth_* tables
-- use: `authenticated` can never read it, whatever the schema says, because
-- this file is public and the rows are not. Reads go through a staff-gated
-- server route using the service role.
--
-- Nothing here records customer content. Provider and model, yes; prompt text,
-- brand names, answers and domains never — the same line the phantom access
-- telemetry draws.
create table if not exists public.ops_events (
  id uuid default gen_random_uuid() primary key,

  -- 'run.completed', 'run.failed', 'provider.error', 'api.error', …
  kind text not null,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),

  -- What makes two occurrences "the same problem": for an error, the message
  -- shape plus where it was raised. Stable across occurrences, so the count is
  -- meaningful and a storm collapses into one row.
  signature text not null,
  -- The hour this falls in (UTC), truncated. The bucket.
  hour timestamp with time zone not null,

  occurrences integer not null default 0,
  -- One representative example. Enough to debug from; not a log.
  sample jsonb not null default '{}'::jsonb,

  first_seen_at timestamp with time zone default timezone('utc'::text, now()) not null,
  last_seen_at timestamp with time zone default timezone('utc'::text, now()) not null,

  unique (kind, signature, hour)
);

alter table public.ops_events enable row level security;

create index if not exists idx_ops_events_hour on public.ops_events(hour desc);
create index if not exists idx_ops_events_level_hour on public.ops_events(level, hour desc)
  where level = 'error';

-- Atomic bucket increment. Events arrive concurrently from every request, so
-- read-then-write would lose counts exactly when volume matters most.
create or replace function public.record_ops_event(
  p_kind text,
  p_level text,
  p_signature text,
  p_sample jsonb
)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.ops_events as e (kind, level, signature, hour, occurrences, sample)
  values (
    p_kind,
    coalesce(nullif(p_level, ''), 'info'),
    p_signature,
    date_trunc('hour', timezone('utc'::text, now())),
    1,
    coalesce(p_sample, '{}'::jsonb)
  )
  on conflict (kind, signature, hour)
  do update set
    occurrences = e.occurrences + 1,
    -- Keep the FIRST sample, not the latest: the earliest occurrence is the one
    -- closest to the cause, before retries and knock-on failures muddy it.
    last_seen_at = timezone('utc'::text, now());
$$;

revoke all on function public.record_ops_event(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_ops_event(text, text, text, jsonb) to service_role;

-- ---------- web mentions (fourth signal: third-party chatter) --------
-- Mentions of the brand and its topics on Reddit and other third-party
-- sites, sourced from a web-search API (Brave first, behind a provider
-- interface) — NOT the official Reddit API. Named "web mentions" throughout:
-- `mentions` above already means "brand named inside an LLM answer", and
-- overloading that word would hurt for years.
--
-- Collection is WEEKLY by design (a past-week freshness window on the search
-- side means a weekly tick loses nothing a daily one would catch), and the
-- signal is opt-in per project: it spends real search-API money.

-- One watch config per project. `sites` is the per-client watch list — any
-- third-party host is just an entry here, no per-site integrations.
-- `exclude_terms` is the name-collision guard (clients named after common
-- words). `query_budget` caps queries per collection tick: it exists to stop
-- a runaway config (100 topics x 10 sites), not to shave dollars.
create table if not exists public.web_mention_watch (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  enabled boolean not null default false,
  sites text[] not null default '{reddit.com}',
  extra_keywords text[] not null default '{}',
  exclude_terms text[] not null default '{}',
  query_budget integer not null default 60,
  -- Set by the collector on every attempt; the weekly scheduler's due check
  -- (>= 7 days) reads this, mirroring projects.last_run_at.
  last_collected_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id)
);

-- Collection events. A sibling of `runs`, not a reuse: `runs` has LLM
-- provider/model baked into NOT NULL checks that make no sense here.
-- `query_count` is the billing truth — monthly search-API spend is one
-- aggregate over it.
create table if not exists public.web_mention_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  query_count integer not null default 0,
  new_count integer not null default 0,
  seen_count integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

-- One row per (project, page). Repeated sightings UPDATE the row
-- (last_seen_at, seen_count, best rank) instead of duplicating it; the topic
-- trend is derived from first_seen_at — new mentions per day — which stays
-- honest because a re-sighting isn't new chatter. `metadata` absorbs future
-- enrichment (v2: live Reddit scores) without migrations.
create table if not exists public.web_mentions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  page_key text not null,        -- pageKey(url): host+path, the dedup identity
  url text not null,
  domain text not null,          -- e.g. 'reddit.com'
  title text,
  snippet text,                  -- search-engine capture at crawl time, goes stale
  kind text not null check (kind in ('brand', 'topic')),
  topic_id uuid references public.topics (id) on delete set null,
  matched_terms text[] not null default '{}',
  search_rank integer,
  seen_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  discovered_via text not null default 'search' check (discovered_via in ('search', 'llm_citation')),
  metadata jsonb not null default '{}'::jsonb,
  unique (project_id, page_key)
);

-- ---------- search_keys (BYOK web-search credential, encrypted) ------
-- Same contract as provider_keys: verify against the API first, encrypt
-- second, persist ciphertext + non-reversible hint only. A separate table
-- rather than more provider_keys rows for the same reason router_keys is:
-- a search engine is not an answer engine, and must never widen the LLM
-- provider allow-list or become a project's default_provider.
create table if not exists public.search_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('brave')),
  label text,
  encrypted_key text not null,
  key_hint text not null,
  created_at timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists idx_web_mention_watch_project on public.web_mention_watch (project_id);
create index if not exists idx_web_mention_runs_project on public.web_mention_runs (project_id, created_at desc);
-- The feed reads newest-activity-first; the summary groups by topic.
create index if not exists idx_web_mentions_project_seen on public.web_mentions (project_id, last_seen_at desc);
create index if not exists idx_web_mentions_project_topic on public.web_mentions (project_id, topic_id);
-- The trend derives from first_seen_at.
create index if not exists idx_web_mentions_project_first on public.web_mentions (project_id, first_seen_at desc);

alter table public.web_mention_watch enable row level security;
alter table public.web_mention_runs  enable row level security;
alter table public.web_mentions      enable row level security;
alter table public.search_keys       enable row level security;

-- Project children: access allowed when the parent project belongs to the
-- user, same shape as topics/runs/mentions above. The weekly cron uses the
-- service-role client and bypasses these, exactly like /api/cron/run.
drop policy if exists "web_mention_watch_owner" on public.web_mention_watch;
create policy "web_mention_watch_owner" on public.web_mention_watch
  for all using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "web_mention_runs_owner" on public.web_mention_runs;
create policy "web_mention_runs_owner" on public.web_mention_runs
  for all using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

drop policy if exists "web_mentions_owner" on public.web_mentions;
create policy "web_mentions_owner" on public.web_mentions
  for all using (project_id in (select id from public.projects where user_id = auth.uid()))
  with check (project_id in (select id from public.projects where user_id = auth.uid()));

-- search_keys: owned by user, same shape as provider_keys.
drop policy if exists "search_keys_owner" on public.search_keys;
create policy "search_keys_owner" on public.search_keys
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

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
  provider text not null check (provider in ('anthropic', 'openai')),
  label text,
  encrypted_key text not null,
  key_hint text not null,
  created_at timestamptz not null default now(),
  unique (user_id, provider)
);

-- ---------- projects -------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  brand_name text not null,
  brand_aliases text[] not null default '{}',
  brand_domain text,
  description text,
  default_provider text not null default 'anthropic' check (default_provider in ('anthropic', 'openai')),
  default_model text not null default 'claude-sonnet-4-6',
  schedule text not null default 'off' check (schedule in ('off', 'daily', 'weekly')),
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Multi-org: which of the user's projects (organizations) the dashboard is
-- currently showing. Falls back to the earliest project when unset. Safe to
-- re-run; lives here because it references projects, created just above.
alter table public.profiles
  add column if not exists active_project_id uuid references public.projects (id) on delete set null;

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

-- ==================================================================
-- Row Level Security
-- ==================================================================
alter table public.profiles       enable row level security;
alter table public.provider_keys  enable row level security;
alter table public.projects       enable row level security;
alter table public.competitors    enable row level security;
alter table public.topics         enable row level security;
alter table public.prompts        enable row level security;
alter table public.runs           enable row level security;
alter table public.responses      enable row level security;
alter table public.mentions       enable row level security;

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

-- NOTE: the service-role key (used by /api/cron/run) bypasses RLS entirely,
-- which is what lets the scheduler read due projects across all users.

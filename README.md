<div align="center">

<img src="./public/images/logo_black.png" alt="Lettertrace" width="320" />

**Open-source, bring-your-own-key monitoring for how your brand shows up in AI assistant answers.**

Track topics · auto-generate the questions people actually ask AI · watch trends over time · benchmark competitors' share of voice.

</div>

---

Lettertrace is a self-hostable clone of tools like Profound / AthenaHQ / AirOps, focused purely on **diagnosing and monitoring AI mentions** (a.k.a. Answer Engine Optimization / Generative Engine Optimization). You describe your brand and a few topics; Lettertrace generates realistic prompts a person might ask ChatGPT or Claude, runs them against those models **with your own API key**, detects when your brand and your competitors get mentioned, and charts how your visibility, sentiment, and share of voice move over time.

- 🔓 **Open source** (MIT) and **BYOK**, you bring your own Anthropic / OpenAI / Google keys. They're encrypted at rest and never leave your infrastructure.
- 🧠 **Multi-model**, query Claude (Anthropic), ChatGPT (OpenAI), Gemini, and Google AI Overviews (both on your Google key). Add more providers easily.
- 🧩 **Topics → variations**, auto-generate the different questions people ask AI about each topic.
- 📈 **Trends over time**, visibility, share of voice, prominence, and sentiment across runs.
- ⚔️ **Competitor benchmarking**, ingest competitors and see how often each shows up.
- 🏢 **Multiple organizations**, one account can track many brands/domains and switch between them from the sidebar.
- 🔎 **Web search + source attribution**, query the models with their native web search on and capture the exact sources they cite, so you can see which posts drove an answer, and whether your own site is being used, even when you aren't named.
- ⏱️ **Scheduled monitoring**, daily/weekly runs via a cron endpoint.

## Core concepts

| Concept | What it is |
|---|---|
| **Organization (project)** | A brand's workspace: brand name, aliases, domain, default model, schedule. An account can have several, the sidebar selector switches the whole dashboard between them, and **＋ New organization** re-opens the setup wizard. |
| **Competitors** | Brands you benchmark against (name + aliases). |
| **Topics** | Subjects you want to monitor (e.g. "project management software"). |
| **Prompts (variations)** | Natural questions generated for a topic, the queries actually sent to the model. |
| **Runs** | One execution: every active prompt → the model → detect mentions → store. |
| **Mentions** | A detected reference to your brand/competitor in an answer, with count, prominence, sentiment, and whether it was recommended. |

## How mention detection works

For each answer the model returns, Lettertrace:

1. **Deterministic detection**, matches your brand's and each competitor's name + aliases (word-boundary, case-insensitive), recording occurrence count and first position (prominence).
2. **LLM enrichment**, for the entities that were mentioned, a structured call classifies **sentiment** and whether the answer **recommended** them.
3. **Aggregation**, visibility (mention rate), **share of voice**, average prominence, and sentiment are computed per run and trended over time.

## Tech stack

- **Next.js 14** (App Router, TypeScript) · **Tailwind CSS** · **Recharts**
- **Supabase**, Postgres, Auth, and Row Level Security
- **BYOK** provider keys encrypted with **AES-256-GCM** at rest
- Anthropic (`@anthropic-ai/sdk`) + OpenAI (`openai`) SDK adapters, plus a dependency-free Google Gemini REST adapter (Gemini models + Google AI Overviews, via Google Search grounding)

## Getting started

### 1. Create a Supabase project

At [supabase.com](https://supabase.com), create a project. From **Settings → API** grab:

- `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
- `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (only needed for scheduled runs)

### 2. Apply the database schema

Open the Supabase **SQL Editor** and run the contents of [`supabase/schema.sql`](./supabase/schema.sql). It creates all tables, indexes, Row Level Security policies, and a trigger that auto-creates a profile on sign-up. It's safe to re-run.

> **Email confirmation:** for the smoothest local experience, disable "Confirm email" under **Authentication → Providers → Email**, or confirm via the link (handled by `/auth/callback`).

#### Social sign-in (optional)

The sign-in screen offers **Google** and **GitHub** alongside email + password. Both are optional — if a provider isn't enabled in Supabase, its button will simply error when clicked, so remove it from `oauthProviders` in [`app/login/auth-form.tsx`](./app/login/auth-form.tsx) if you don't plan to configure it.

No new environment variables are involved: the client secrets live in Supabase, not in this repo.

**1. Register the app with each provider.** Both point at *Supabase's* callback, not yours — which means one registration covers local development and production:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

- **GitHub** → Settings → Developer settings → OAuth Apps → New OAuth App. Leave "Enable Device Flow" unchecked.
- **Google** → Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application). Add `https://<project-ref>.supabase.co` as an authorized JavaScript origin. On the consent screen, request only the default non-sensitive scopes (`email`, `profile`, `openid`) — those need no verification review, but the app must be published to **In production** to accept more than 100 users, and any domain in your consent-screen links must be verified in Search Console.

**2. Enable the providers in Supabase.** Authentication → Providers → Google / GitHub: toggle on and paste each client ID and secret. Requires the **Owner** or **Administrator** role on the project; other roles see the fields greyed out. Leave "Allow users without an email" off — GitHub returns a `@users.noreply.github.com` address even for users with private emails, so `handle_new_user` always has something to write into `profiles`.

**3. Allowlist your own redirect URLs.** Authentication → URL Configuration → Redirect URLs. This is the second hop (Supabase → your app) and is separate from step 1; missing it is the most common cause of a sign-in that dead-ends:

```
http://localhost:3000/auth/callback
https://your-domain.com/auth/callback
```

Set **Site URL** to your production origin while you're on that screen, and make sure `NEXT_PUBLIC_SITE_URL` matches it — `/auth/callback` prefers it over the request origin, which would otherwise resolve to the internal deployment host behind a proxy.

Users who sign up with a password and later use a social provider with the same address are linked into one account by Supabase, provided the provider reports the email as verified.

### 3. Configure environment

```bash
cp .env.example .env.local
```

Fill in Supabase values and generate secrets:

```bash
# 32-byte key that encrypts BYOK provider keys at rest
openssl rand -base64 32   # -> ENCRYPTION_KEY

# shared secret for the scheduled-run endpoint
openssl rand -hex 32      # -> CRON_SECRET
```

### 4. Install & run

Use **Node 22 LTS** (see [`.nvmrc`](./.nvmrc)). Node 23+ has an `undici`
regression that intermittently drops provider connections mid-response
("Premature close"). With [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install   # picks up .nvmrc (Node 22)
nvm use
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), create an account, and you'll land on the dashboard.

### 5. First monitor

1. **Settings** → add your Anthropic, OpenAI, and/or Google API key (verified on save, encrypted at rest), then fill in your **brand & project** (name, aliases, and the answer engine to monitor with, including Gemini or Google AI Overviews).
2. **Competitors** → add the brands you want to benchmark against.
3. **Topics** → add a topic and click **Generate variations** to auto-create prompts (or add your own).
4. **Runs** → **Run monitor now**. When it finishes, the **Overview** fills in with visibility, share of voice, sentiment, and per-topic breakdowns.

## Scheduled monitoring

Set a project's schedule to **Daily** or **Weekly** in Settings, then hit the cron endpoint on an interval:

```bash
curl -X POST https://your-app.com/api/cron/run \
  -H "Authorization: Bearer $CRON_SECRET"
```

The endpoint uses the Supabase **service role** to find due projects across all users, decrypts each owner's key, and runs them. Only requests with the correct `CRON_SECRET` are accepted.

- **Vercel:** [`vercel.json`](./vercel.json) registers a daily cron. Set `CRON_SECRET` in your Vercel env, Vercel automatically sends it as the `Authorization` bearer.
- **Anything else:** a system crontab, GitHub Actions, or any scheduler that can send an authenticated HTTP request works.

## Free trial (optional)

By default Lettertrace is bring-your-own-key: a user must add a key before running anything. You can optionally let people try it on **your** shared keys first — a configurable number of free monitoring runs (default **5**) — then prompt them to add their own.

Set in your environment:

- `TRIAL_ANTHROPIC_API_KEY` / `TRIAL_OPENAI_API_KEY` / `TRIAL_GOOGLE_API_KEY`: the shared key(s) to lend out (set the provider(s) you want to offer). Leave unset to keep the app BYOK-only.
- `TRIAL_RUN_LIMIT`: free monitoring runs per user before they must add their own key (default `5`). **This is the configurable threshold.** A run counts when it starts (consumed atomically, so parallel requests can't exceed the cap).
- `TRIAL_ANTHROPIC_MODEL` / `TRIAL_OPENAI_MODEL` / `TRIAL_GOOGLE_MODEL`: optional cheaper models to cap your cost during the trial (default to the user's selected model).
- `NEXT_PUBLIC_BYOK_VIDEO_URL`: optional embeddable video URL explaining the BYOK model, shown once the free runs are used up.

While a user has free runs left and no key of their own, monitoring runs and variation generation use the shared key. Completed runs are counted on `profiles.trial_runs_used` (token spend is also recorded on `profiles.trial_tokens_used` so you can watch cost). A banner in the dashboard shows how many free runs are left; once they're gone, data collection stops with a clear prompt (and optional video) to add their own key. Adding a key removes the limit entirely. Scheduled (cron) runs always use the owner's own key, never the trial.

> After upgrading, re-run `supabase/schema.sql`. It adds the trial columns (`trial_runs_used`, `trial_tokens_used`), their increment functions, the multi-organization column `profiles.active_project_id`, and widens the `provider` allow-list on `provider_keys` and `projects` to include `google` (all safe to re-run).

## Programmatic access (REST API + MCP)

Create an API key in **Settings → API & MCP access** (shown once, stored hashed) and send it as a bearer token.

**REST v1:**

```bash
# List your organizations / create one
curl https://your-app.com/api/v1/projects \
  -H "Authorization: Bearer lt_live_..."
curl -X POST https://your-app.com/api/v1/projects \
  -H "Authorization: Bearer lt_live_..." -H "Content-Type: application/json" \
  -d '{"name": "Acme", "brand_name": "Acme", "brand_domains": ["acme.io"]}'

# A project's prompts / bulk-add prompts (topics are get-or-created by name)
curl https://your-app.com/api/v1/projects/<project-id>/prompts \
  -H "Authorization: Bearer lt_live_..."
curl -X POST https://your-app.com/api/v1/projects/<project-id>/prompts \
  -H "Authorization: Bearer lt_live_..." -H "Content-Type: application/json" \
  -d '{"prompts": [{"text": "best crm for startups", "topic": "CRM"}]}'

# Toggle a prompt on or off
curl -X PATCH https://your-app.com/api/v1/prompts/<prompt-id> \
  -H "Authorization: Bearer lt_live_..." -H "Content-Type: application/json" \
  -d '{"is_active": false}'

# Recent runs for a project / trigger a run now
# (optional body {"provider", "model"} overrides the project default for that run)
curl https://your-app.com/api/v1/projects/<project-id>/runs \
  -H "Authorization: Bearer lt_live_..."
curl -X POST https://your-app.com/api/v1/projects/<project-id>/runs \
  -H "Authorization: Bearer lt_live_..."

# Share-of-voice report for a run
curl https://your-app.com/api/v1/runs/<run-id> \
  -H "Authorization: Bearer lt_live_..."

# Brand visibility across every completed run, oldest first.
# `firstMentionAt` is the event to poll for: null until the brand is first named.
curl https://your-app.com/api/v1/projects/<project-id>/history?limit=30 \
  -H "Authorization: Bearer lt_live_..."

# Raw artifacts for a run: each response's full text + cited sources + mentions
curl https://your-app.com/api/v1/runs/<run-id>/responses \
  -H "Authorization: Bearer lt_live_..."
```

The run report carries four blocks. Read them in this order:

| Block | What it answers |
|---|---|
| `quality.informativeRate` | Did the answers name *any* company? If low, the prompts are the wrong shape and every rate below is meaningless. |
| `summary` | Brand mention rate, with `brandMentionRateInterval` and the raw numerator/denominator. A zero from 1 answer and a zero from 30 are not the same evidence. |
| `citations` | Did the models read the brand's own pages? Moves before mentions do, so it is often the only signal a young brand has. |
| `topics` | The same per topic, which is the join between what you published and what surfaced. |

Answers vary between identical calls, so a single ask cannot distinguish "not
mentioned" from "mentioned, unlucky". Set `replicates` (1–10, default 1) on a
project to ask each prompt several times per run and narrow the interval; token
cost scales linearly with it.

> **Writing prompts that measure anything** is the single biggest lever on
> whether a run is useful — bigger than model choice. See
> [`docs/prompt-playbook.md`](./docs/prompt-playbook.md) before configuring a
> client.

**MCP:** Lettertrace exposes a [Model Context Protocol](https://modelcontextprotocol.io) server (Streamable HTTP) so Claude and other MCP clients can query your share-of-voice data conversationally:

```bash
claude mcp add --transport http lettertrace https://your-app.com/api/mcp/mcp \
  -H "Authorization: Bearer lt_live_..."
```

Tools: `list_projects`, `list_runs`, `get_share_of_voice_report`, `trigger_run`. (The write endpoints above are REST-only for now.)

Notes:

- API-triggered runs are **BYOK-only** — the account must have its own provider key; free-trial runs stay dashboard-only.
- Projects created via the API start with `schedule: "off"` — trigger runs explicitly (or flip the schedule in the dashboard).
- API keys grant access to all of the account's organizations. Revoke them anytime from Settings.
- Requires `SUPABASE_SERVICE_ROLE_KEY` (the same variable scheduled runs use), since API-key requests carry no browser session.
- Upgrading an existing deployment? Re-run `supabase/schema.sql` — it adds the `api_keys` table (safe to re-run).

## Deployment

Deploy anywhere that runs Next.js. On **Vercel**: import the repo, set the env vars from `.env.example`, and deploy. Runs execute synchronously inside the API route, so for large prompt sets prefer a Node server or bump the function's `maxDuration`.

## Security notes

- Provider API keys are **encrypted with AES-256-GCM** using `ENCRYPTION_KEY` and are never returned to the browser (only a masked hint like `sk-ant-…4a9c`).
- All data is isolated per user by **Postgres Row Level Security**. The service-role key is used only by the cron endpoint and the API-key-authenticated surface (`/api/v1`, `/api/mcp`), where every query is scoped to the key's owner.
- Lettertrace API keys are stored as **SHA-256 hashes** (never recoverable); the plaintext is shown once at creation.
- Nothing is sent to any third party except the AI providers **you** configure, using **your** keys.

## Project structure

```
app/                     Next.js App Router
  page.tsx               Landing page
  login/                 Auth (email + password, Google, GitHub)
  auth/callback/         OAuth + email-confirmation code exchange
  dashboard/             Overview, topics, competitors, runs, settings
  api/                   Route handlers (keys, project, topics, prompts, competitors, runs, cron)
components/              UI primitives, logo, dashboard nav + charts
docs/
  prompt-playbook.md     What live client runs taught us about prompt shape
scripts/
  pilot-client.ts        Dry-run a client through the pipeline (no DB writes)
lib/
  supabase/              Server / browser / middleware clients
  llm/                   Anthropic + OpenAI adapters (query, variations, sentiment)
  engine.ts              Run orchestration (query → detect → analyze → store)
  mentions.ts            Deterministic mention detection
  metrics.ts             Visibility / share-of-voice / sentiment aggregation
  crypto.ts              AES-256-GCM for BYOK keys
  data.ts, types.ts, models.ts, utils.ts
supabase/schema.sql      Postgres schema + RLS
```

## License

[MIT](./LICENSE) © The Letter Company

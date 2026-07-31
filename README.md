<div align="center">

<img src="./public/images/logo_black.png" alt="Lettertrace" width="320" />

**Open-source, bring-your-own-key monitoring for how your brand shows up in AI assistant answers.**

Track topics · auto-generate the questions people actually ask AI · watch trends over time · benchmark competitors' share of voice.

</div>

---

Lettertrace is a self-hostable AEO tool, focused purely on **diagnosing and monitoring AI mentions** (a.k.a. Answer Engine Optimization / Generative Engine Optimization). You describe your brand and a few topics; Lettertrace generates realistic prompts a person might ask ChatGPT or Claude, runs them against those models **with your own API key**, detects when your brand and your competitors get mentioned, and charts how your visibility, sentiment, and share of voice move over time.

- 🔓 **Open source** (MIT) and **BYOK**, you bring your own Anthropic / OpenAI / Google / Perplexity keys — or a single **LLM router** key ([Concentrate](https://concentrate.ai/)) instead. Either way they're encrypted at rest and never leave your infrastructure.
- 🧠 **Multi-model**, query Claude (Anthropic), ChatGPT (OpenAI), Gemini and Google AI Overviews (both on your Google key), and Perplexity Sonar. Add more providers easily.
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
- Anthropic (`@anthropic-ai/sdk`) + OpenAI (`openai`) SDK adapters, plus dependency-free REST adapters for Google Gemini (Gemini models + Google AI Overviews, via Google Search grounding) and Perplexity Sonar (always search-grounded, real source URLs)

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

1. **Settings** → add your Anthropic, OpenAI, Google, and/or Perplexity API key (verified on save, encrypted at rest), **or one [LLM router key](#llm-routers-one-key-several-assistants)**, then fill in your **brand & project** (name, aliases, and the answer engine to monitor with, including Gemini or Google AI Overviews). Prefer a terminal? [`lettertrace keys set anthropic`](#setting-your-provider-key-from-the-cli-keys) does the same thing.
2. **Competitors** → add the brands you want to benchmark against.
3. **Topics** → add a topic and click **Generate variations** to auto-create prompts (or add your own).
4. **Runs** → **Run monitor now**. When it finishes, the **Overview** fills in with visibility, share of voice, sentiment, and per-topic breakdowns.

## LLM routers (one key, several assistants)

Instead of a key per provider, you can connect a single **LLM router** (gateway) credential and reach several assistants through it. The bar for adding one is a live probe, not a docs page — both entries below were corrected by probing:

| Router | Engines it serves | Notes |
|---|---|---|
| **[Concentrate](https://concentrate.ai/)** | Claude, ChatGPT — both grounded | No markup on tokens, which matters when the key is yours. Mirrors both providers' native APIs, so a routed answer is the same request a direct key sends — forced browse included. |
| **[OpenRouter](https://openrouter.ai/)** | Claude grounded; ChatGPT **ungrounded only** | 400+ models behind one key. Its Anthropic endpoint carries Claude's forced web search intact, but it cannot ask an OpenAI model for its *own* search — the alternatives route through Exa, a third-party service — so GPT here serves projects with web search off. Requests pin the upstream (`allow_fallbacks: false`) so routing changes can't move a trend line. |

Settings → **Or use one router key**, or from the terminal:

```bash
lettertrace routers                       # what's stored, and what each key can measure
lettertrace routers set concentrate       # key read from a hidden prompt / stdin / --key-file
lettertrace routers remove concentrate
```

Three things are worth understanding before you rely on one.

**A router is a credential, not an answer engine.** A run served by Concentrate against Claude still measured Claude, so it is recorded as `provider = anthropic` with `route = concentrate` alongside it. Switching from a direct key to a router (or back) keeps one continuous trend line instead of splitting your history and share of voice across two entries that are the same answer surface.

**Grounding is verified, not assumed.** Every monitored answer is supposed to come from the provider's *native* web search, forced. A gateway that normalizes requests can accept those parameters and quietly drop them, and an ungrounded answer is not a cheaper version of a grounded one — it is a different measurement that still looks like data. So saving a router key runs a real forced search per engine and stores which ones actually returned sources (`router_keys.search_verified`). An engine that didn't is allowed to serve projects with web search **off**, and refused for projects with it on, with a message naming the fix. Operators can run the same check without an account:

```bash
ROUTER_API_KEY_CONCENTRATE=... npx tsx scripts/probe-router.ts concentrate
ROUTER_API_KEY_OPENROUTER=...  npx tsx scripts/probe-router.ts openrouter
```

The distinction that matters is **forced** versus merely enabled, and it is worth testing rather than reading off a gateway's docs. Probed against Concentrate on 2026-07-30: asked "what is the capital of France?" — a question the model answers from memory — its Responses endpoint with a forced `tool_choice` still returned two cited sources, while the same request with the tool only offered returned none, and so did chat-completions with `web_search_options`. A router that permits searching but can't be made to search will drift against a direct key, since the model answers familiar questions from recall and cites nothing.

**Gemini, Google AI Overviews and Perplexity still need their own keys.** Not because the models are unreachable through a router, but because their measurement paths don't survive normalization: Gemini's grounding arrives as Google-specific chunks behind a redirect host, AI Overviews is a Gemini call plus a forced-search system prompt of ours, and Perplexity's search is the product rather than a parameter. Routed, all three would return an answer that is a different measurement wearing the same label.

Router keys are encrypted at rest exactly like provider keys, and resolution order is: your own provider key → your router key → the operator's trial key (if any) → nothing.

## Scheduled monitoring

Set a project's schedule to **Daily** or **Weekly** in Settings, then hit the cron endpoint on an interval:

```bash
curl -X POST https://your-app.com/api/cron/run \
  -H "Authorization: Bearer $CRON_SECRET"
```

The endpoint uses the Supabase **service role** to find due projects across all users, resolves each owner's own credential — a provider key or a [router key](#llm-routers-one-key-several-assistants) — and runs them. Scheduled runs are strictly self-funded: an owner on the free trial is skipped rather than spending the operator's allowance unattended. Only requests with the correct `CRON_SECRET` are accepted.

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

> After upgrading, re-run `supabase/schema.sql`. It adds the trial columns (`trial_runs_used`, `trial_tokens_used`), their increment functions, the multi-organization column `profiles.active_project_id`, the `router_keys` table and `runs.route` for [LLM routers](#llm-routers-one-key-several-assistants), and widens the `provider` allow-list on `provider_keys` and `projects` to include `google` (all safe to re-run).

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

# Read one organization / update settings (only sent fields change — fix
# aliases, replicates, or domains on a project after creation)
curl https://your-app.com/api/v1/projects/<project-id> \
  -H "Authorization: Bearer lt_live_..."
curl -X PATCH https://your-app.com/api/v1/projects/<project-id> \
  -H "Authorization: Bearer lt_live_..." -H "Content-Type: application/json" \
  -d '{"brand_aliases": ["Acme Cloud"], "replicates": 3}'

# A project's prompts / bulk-add prompts (topics are get-or-created by name)
curl https://your-app.com/api/v1/projects/<project-id>/prompts \
  -H "Authorization: Bearer lt_live_..."
curl -X POST https://your-app.com/api/v1/projects/<project-id>/prompts \
  -H "Authorization: Bearer lt_live_..." -H "Content-Type: application/json" \
  -d '{"prompts": [{"text": "best crm for startups", "topic": "CRM"}]}'

# Map a prompt to the page it was written to surface (optional target_url on
# create or PATCH; null clears it). The run report then carries per-URL
# cited-hit rates under `pages` — "when the question my page was built for
# gets asked, is MY page the one the answer cites?"
curl -X POST https://your-app.com/api/v1/projects/<project-id>/prompts \
  -H "Authorization: Bearer lt_live_..." -H "Content-Type: application/json" \
  -d '{"prompts": [{"text": "best crm for startups", "topic": "CRM", "target_url": "https://acme.io/blog/best-crm"}]}'
curl -X PATCH https://your-app.com/api/v1/prompts/<prompt-id> \
  -H "Authorization: Bearer lt_live_..." -H "Content-Type: application/json" \
  -d '{"target_url": "https://acme.io/blog/best-crm"}'

# A project's tracked competitors: list / bulk-add (already-tracked names are
# skipped, not errors) / stop tracking one. Candidates your stored answers
# named but nobody tracks come from /competitors/discovered — confirm the real
# ones via the POST; an unmatched competitor list makes informativeRate lie.
curl https://your-app.com/api/v1/projects/<project-id>/competitors \
  -H "Authorization: Bearer lt_live_..."
curl -X POST https://your-app.com/api/v1/projects/<project-id>/competitors \
  -H "Authorization: Bearer lt_live_..." -H "Content-Type: application/json" \
  -d '{"competitors": [{"name": "WEKA", "aliases": ["WekaIO"], "domain": "weka.io"}]}'
curl https://your-app.com/api/v1/projects/<project-id>/competitors/discovered \
  -H "Authorization: Bearer lt_live_..."
curl -X DELETE https://your-app.com/api/v1/competitors/<competitor-id> \
  -H "Authorization: Bearer lt_live_..."

# BYOK provider keys: list (masked hints + the supported-provider catalog),
# set/rotate, remove. Verified against the provider and encrypted before storage.
# Read the key from a file rather than inlining it — a key typed into a shell
# command is in your history and in `ps` forever after.
curl https://your-app.com/api/v1/keys \
  -H "Authorization: Bearer lt_live_..."
jq -n --arg k "$(cat ./anthropic.key)" '{api_key: $k}' | \
  curl -X PUT https://your-app.com/api/v1/keys/anthropic \
    -H "Authorization: Bearer lt_live_..." -H "Content-Type: application/json" \
    --data-binary @-
curl -X DELETE https://your-app.com/api/v1/keys/openai \
  -H "Authorization: Bearer lt_live_..."

# LLM router keys: same shape, same "keys:read"/"keys:write" scopes. The PUT
# response carries `checks` — per engine, whether this credential was actually
# observed to carry the provider's native web search.
curl https://your-app.com/api/v1/router-keys \
  -H "Authorization: Bearer lt_live_..."
jq -n --arg k "$(cat ./concentrate.key)" '{api_key: $k}' | \
  curl -X PUT https://your-app.com/api/v1/router-keys/concentrate \
    -H "Authorization: Bearer lt_live_..." -H "Content-Type: application/json" \
    --data-binary @-

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

# A run takes minutes; {"background": true} returns 202 with the run id as
# soon as the run exists, then poll the status endpoint until it settles.
curl -X POST https://your-app.com/api/v1/projects/<project-id>/runs \
  -H "Authorization: Bearer lt_live_..." -H "Content-Type: application/json" \
  -d '{"background": true}'
curl https://your-app.com/api/v1/runs/<run-id>/status \
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

### Command-line client (`cli/`)

A full CLI ships in [`cli/`](./cli/). Its only sign-in step is the OAuth flow
below (no API keys): the first command that needs access opens your browser to
**sign in or create an account**, then stores a scoped, auto-refreshing token.
Everything after that runs over the REST and MCP APIs, so an agent like Claude
Code can set up an account end to end after that one human approval.

```bash
npm run cli -- help                 # or: node cli/lettertrace.mjs help
npm run cli -- login --url https://your-app.com   # browser sign-in / create account
npm run cli -- whoami --json        # machine-readable auth status (no browser)

# Bring your own key without opening the dashboard (see below):
npm run cli -- keys                                  # what's stored, masked
npm run cli -- keys set anthropic                    # hidden prompt, key verified on save

# Set up an account over the API — the agent-drivable part:
npm run cli -- projects create --name "Acme" --brand "Acme" --domains acme.io
npm run cli -- prompts add <projectId> --text "best crm for startups" --topic CRM
npm run cli -- competitors add <projectId> Drata Secureframe   # who you're measured against
npm run cli -- runs trigger <projectId>
npm run cli -- runs get <runId>          # share-of-voice report (--json for full)

# Talk to the MCP endpoint over the real protocol (mints an mcp-audience token):
npm run cli -- mcp tools
npm run cli -- mcp call get_share_of_voice_report --project_id <projectId>
```

Every command takes `--json` for scripting, exits non-zero on error, and
resolves the deployment from `--url`, then `$LETTERTRACE_URL`, then the URL saved
at login. Tokens live in `~/.lettertrace/config.json` (one per audience). The
data commands use REST v1; the `mcp` commands speak the Model Context Protocol
directly. The mechanism underneath is:

#### Competitors from the CLI (`competitors`)

Share of voice needs something to compare against, so setting competitors is part
of standing a brand up rather than a later refinement — monitoring Vanta means
tracking Drata and Secureframe, and that should be one command:

```bash
npm run cli -- competitors add <projectId> Drata Secureframe   # several at once
npm run cli -- competitors add <projectId> --name Sprinto --domain sprinto.com --aliases "Sprinto Inc"
npm run cli -- competitors <projectId>                         # what's tracked, with ids
npm run cli -- competitors remove <competitorId>
```

Names the project already tracks are reported as skipped rather than failing, so
re-running the same setup command is safe. The brand itself is refused — it
cannot be its own competitor.

`competitors discovered <projectId>` is the other direction: companies this
project's own answers have already named that nobody is tracking. It is evidence
from runs you have already paid for, not a guess.

#### Setting your provider key from the CLI (`keys`)

Adding a BYOK key no longer requires the dashboard. `keys set` verifies the key
against the provider, encrypts it with AES-256-GCM, and stores it exactly as
Settings does — the same code path, so nothing about the stored key differs by
where you added it. Only the masked hint (`sk-ant-…4a9c`) ever comes back.

```bash
npm run cli -- keys                        # every supported provider, and which have a key
npm run cli -- keys set anthropic          # prompts, input hidden and not echoed
npm run cli -- keys set anthropic --label "team account"
npm run cli -- keys remove openai          # forget the stored key
```

**The key is never a command-line argument.** Anything in `argv` lands in your
shell history and is readable by every process on the machine, and there's no
taking that back — so `--key` is rejected outright rather than quietly accepted.

`routers` is the same command for [LLM router keys](#llm-routers-one-key-several-assistants),
with the same secret handling. It takes a few seconds longer because saving one
runs a real forced web search per engine and reports what came back:

```bash
npm run cli -- routers                     # stored keys + what each can measure
npm run cli -- routers set concentrate     # prompts, input hidden and not echoed
npm run cli -- routers remove concentrate
```
The key is read from the first of these that's available:

| Source | Use it for |
|---|---|
| `--key-file <path>` (`-` = stdin) | a secret manager writing to a file or a pipe |
| `$LETTERTRACE_PROVIDER_KEY` | CI, where a pipe is awkward |
| piped stdin (`… \| lettertrace keys set anthropic`) | scripts |
| hidden interactive prompt | a human at a terminal |

```bash
# CI
LETTERTRACE_PROVIDER_KEY="$ANTHROPIC_KEY" npm run cli -- keys set anthropic --json

# From a secret manager, without ever touching disk
op read "op://vault/anthropic/key" | npm run cli -- keys set anthropic --key-file -
```

The provider list comes from the **server**, not the CLI, so a provider added to
`lib/models.ts` shows up in `lettertrace keys` with no CLI change. Under the hood
these commands call `GET /api/v1/keys`, `PUT /api/v1/keys/<provider>`
(body `{"api_key": "…", "label": "…"}`), and `DELETE /api/v1/keys/<provider>`,
which carry the `keys:read` / `keys:write` scopes below. Saving shows up in the
activity feed as `provider_key.saved` on the **`cli`** channel, so a key added by
an agent is distinguishable from one you added in the browser.

Two failures are deliberately kept apart, because the fix is different:

- **400** — the provider rejected the key. Yours to fix; get a new one.
- **503** — the key is valid, but the deployment's `ENCRYPTION_KEY` is missing or
  malformed, so nothing was stored. The operator's to fix (see
  `openssl rand -base64 32` in [Configure environment](#3-configure-environment)).
  You are never told to rotate a key that was fine.

> Upgrading a CLI you'd already logged into? `keys:read`/`keys:write` are new
> scopes, and a token minted before they existed can't hold them. The CLI detects
> the resulting `insufficient_scope` challenge, discards the stale token, and
> relaunches the browser consent by itself — you just approve once more. Re-run
> `supabase/schema.sql` first so the `lt_cli` client is allowed to request them.

### OAuth: delegated access for CLIs and external systems

Rather than hand-minting an API key and pasting it around, a CLI or external
system can obtain a **scoped, expiring, revocable** token through Lettertrace's
built-in **OAuth 2.1 Authorization Server**. Supabase stays the identity
provider: the user approves the grant from a normal logged-in browser session,
and the token that comes back flows through the same bearer path as an API key —
so `/api/v1` and `/api/mcp` accept it unchanged.

The full CLI above is the everyday tool; [`scripts/oauth-login.mjs`](./scripts/oauth-login.mjs)
is a minimal, single-file login example if you want to see just the token
exchange (Authorization Code + PKCE over a 127.0.0.1 loopback, no key pasted):

```bash
node scripts/oauth-login.mjs --url https://your-app.com
node scripts/oauth-login.mjs --resource mcp     # bind the token to the MCP surface
node scripts/oauth-login.mjs --refresh          # silently rotate using the refresh token
```

The flow: the client opens `/api/oauth/authorize`, you approve on the consent
screen (which lists exactly what's being granted and where the code is
delivered), and the CLI exchanges the code at `/api/oauth/token` for an access
token (+ a refresh token when `offline_access` is requested).

- **Scopes** — `projects:read`, `projects:write`, `runs:read`, `runs:trigger`,
  `keys:read`, `keys:write`, and `offline_access` (asks for a refresh token).
  Enforced on **every** REST route and MCP tool, reads included; a classic
  `lt_live_` key implicitly holds all of them, so nothing about existing keys
  changes. The `keys:*` pair is deliberately separate from `projects:write`:
  swapping the provider key every run is billed to is a different decision from
  adding a prompt, and the consent screen is where a user gets to make it.
- **Audience** — pass `resource=v1` (default) or `resource=mcp`. A token is
  bound to one surface: an MCP token can't call the REST API, and vice versa.
- **Discovery** — MCP/OAuth clients can auto-configure from
  `/.well-known/oauth-authorization-server` (RFC 8414). Device-code and dynamic
  client registration (for MCP hosts that self-register) are the next phase.
- **Revoke** — `POST /api/oauth/revoke` with a token, or (soon) from Settings →
  Connected apps.

Self-hosting a **confidential** external server? Register it with a hashed
secret via SQL (public/loopback clients like the CLI need no secret):

```sql
insert into public.oauth_clients
  (client_id, client_name, client_type, token_endpoint_auth_method,
   redirect_uris, allowed_scopes, client_secret_hash)
values
  ('my-service', 'My Service', 'confidential', 'client_secret_basic',
   array['https://my-service.example.com/oauth/callback'],
   array['projects:read','runs:read','offline_access'],
   encode(digest('THE_PLAINTEXT_SECRET', 'sha256'), 'hex'));
```

Notes:

- API-triggered runs are **BYOK-only** — the account must hold its own credential, either a provider key or a [router key](#llm-routers-one-key-several-assistants); free-trial runs stay dashboard-only. Either can be set over the API too (`PUT /api/v1/keys/<provider>`, `PUT /api/v1/router-keys/<router>`, or `lettertrace keys set` / `routers set`), so an agent never has to hand the user back to the browser mid-setup.
- Projects created via the API start with `schedule: "off"` — trigger runs explicitly (or flip the schedule in the dashboard).
- API keys grant access to all of the account's organizations. Revoke them anytime from Settings.
- Requires `SUPABASE_SERVICE_ROLE_KEY` (the same variable scheduled runs use), since API-key requests carry no browser session.
- OAuth tokens are scoped and audience-bound; a classic `lt_live_` API key stays full-access across all of the account's organizations. Revoke either anytime (API keys from Settings; OAuth grants via `/api/oauth/revoke`).
- Upgrading an existing deployment? Re-run `supabase/schema.sql` — it adds the `api_keys` table and the OAuth tables (`oauth_clients`, `oauth_access_tokens`, …) plus the seeded `lt_cli` client, and widens that client's `allowed_scopes` to include `keys:read` / `keys:write` (all safe to re-run). Without the re-run, `lettertrace keys` fails at consent with `invalid_scope`.

## Tests

```bash
npm test          # unit + route tests, all mocked, no network, no keys spent
npm run typecheck
```

Two harnesses go further than `npm test` and are deliberately excluded from it,
because they need a live server and spend real provider tokens:

```bash
# End-to-end BYOK key management: drives the real cli/lettertrace.mjs binary
# against a running deployment and asserts on what lands in Postgres.
npx next dev -p 3200 &
npx tsx scripts/harness-provider-keys.ts --url http://localhost:3200

# Measurement pilot: runs a real brand through scrape → topics → prompts →
# query → mention detection, without writing to the database.
npx tsx scripts/pilot-client.ts cloudflare --providers google,anthropic
```

The key harness needs `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, and
`TRIAL_ANTHROPIC_API_KEY` in `.env.local`. It creates one throwaway user and
deletes it in a `finally`, so a failed assertion still cleans up. What it covers
that mocks can't: that a key entered at the CLI decrypts back byte-for-byte at
run time, that `keys:read` can't write, that a plaintext key reaches neither
stdout nor the activity log, and that the deployment advertises the origin it
was actually reached on.

## Deployment

Deploy anywhere that runs Next.js. On **Vercel**: import the repo, set the env vars from `.env.example`, and deploy. Runs execute synchronously inside the API route, so for large prompt sets prefer a Node server or bump the function's `maxDuration`.

## Security notes

- Provider API keys are **encrypted with AES-256-GCM** using `ENCRYPTION_KEY` and are never returned to any client — browser, REST, or CLI (only a masked hint like `sk-ant-…4a9c`). Whichever surface stores one, it goes through the same verify → encrypt → store path in `lib/provider-keys.ts` (`lib/router-keys.ts` for router credentials), and the CLI refuses to take a key as a command-line argument so it can't leak through shell history or `ps`.
- A self-hosted router base URL must be **https**: that value is where your API key gets sent, so a plain-http or malformed URL is rejected rather than stored.
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
  probe-router.ts        Does a router really pass native web search through?
lib/
  supabase/              Server / browser / middleware clients
  llm/                   Anthropic + OpenAI adapters (query, variations, sentiment)
  engine.ts              Run orchestration (query → detect → analyze → store)
  mentions.ts            Deterministic mention detection
  metrics.ts             Visibility / share-of-voice / sentiment aggregation
  crypto.ts              AES-256-GCM for BYOK keys
  provider-keys.ts       Verify → encrypt → store, shared by the dashboard + CLI
  routers.ts             LLM router registry: engines served, how search travels
  router-keys.ts         Verify → probe grounding → encrypt → store
  data.ts, types.ts, models.ts, utils.ts
supabase/schema.sql      Postgres schema + RLS
```

## License

[MIT](./LICENSE) © The Letter Company

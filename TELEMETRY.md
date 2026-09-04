# Telemetry

This codebase uses OnePatch for telemetry. Query it at app.onepatch.dev/mcp;
manual at docs.onepatch.dev.

**Since 2026-08-19 this application exports OpenTelemetry traces, metrics and
logs over OTLP/HTTP.** `instrumentation.ts` starts the SDK; `lib/otel/` holds
the wiring and the hand-instrumentation helpers.

**It exports nothing unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.** No
endpoint, no SDK, no outbound connection — the same default OPS_TELEMETRY
takes, and for the same reason: this repository is public and ships a prebuilt
image, so a self-hosted install reports to nobody until its operator says so.
The consequence for reading this store is worth stating plainly: **an absence
of spans is only evidence of an outage on a deployment where the endpoint is
known to be set.**

On this org's Vercel **Production** deployment it *is* set, and has been since
**15:43 UTC on 2026-08-19** — traces, metrics and logs have flowed continuously
since. **Preview is not configured**, so PR builds still report nothing; that is
a deliberate gap, not a fault, but it does mean a change cannot be observed
until it reaches Production.

## What monitoring also exists

Three in-house surfaces. The first now feeds the exported log stream; the other
two remain product features and do not reach OnePatch:

- **`lib/ops.ts`** — operational events (provider failures, run outcomes)
  bucketed by `(kind, signature, hour)` into Supabase. Never throws, never
  blocks, never records content. Read back through `lib/ops-report.ts` and the
  admin screens. **`recordOps` now also emits an OTel log record**, so the same
  already-scrubbed signature reaches OnePatch — see Logs below. The two
  destinations are gated separately: the Supabase bucket on `OPS_TELEMETRY`,
  the log record on the exporter being configured.
- **`lib/activity.ts` / `lib/logs.ts`** — the per-user activity log shown on the
  dashboard Logs screen and served by `/api/v1/logs` and MCP. A product feature
  that happens to be auditable, not an operations log.
- **PostHog** (`components/posthog.tsx`) and **Letterprove**
  (`lib/letterprove.ts`) — product analytics and signup/usage reporting from the
  browser.

None of these answer latency, error-rate or dependency questions, and none of
them see the Vercel cron runs that do the actual work.

## Service map

### lettertrace — the whole product, one Next.js 14 app

- **Deployed by:** Vercel, from `master`. Environments: `Production` (and
  per-PR Preview builds).
- **Environments:** Vercel reports the *deploy* environment as `Production`
  (capitalised) in the CI/CD stream. The app's own resource attribute is set by
  `@vercel/otel` from `VERCEL_ENV` and is **lowercase** — `env = 'production'`
  on spans, metrics and logs, `'preview'` on a PR build. Two different
  spellings of the same idea; use the lowercase one when filtering telemetry
  and the capitalised one only against `cicd.environment`.
- **Wiring:** `instrumentation.ts` → `lib/otel/register.ts`, on `@vercel/otel`
  over the OTLP/HTTP proto exporters. Node runtime only (the edge runtime
  cannot run the Node SDK, so the exporters sit behind a dynamic import).
  - `service.name` — `OTEL_SERVICE_NAME`, defaulting to `lettertrace`.
  - `service.version` — **the deploying commit sha** (`VERCEL_GIT_COMMIT_SHA`),
    overriding `@vercel/otel`'s default of the Vercel deployment id. So "did
    that change do it?" is a `GROUP BY service.version`, not a timeline guess.
  - Outbound `fetch` is instrumented by default, which covers Supabase and
    every provider call as client spans and propagates W3C trace context.
    `lib/otel/redact-fetch.ts` renames those spans before export: the query
    string is dropped and uuid / long hex / numeric path segments collapse to
    `:id`, so a Supabase call arrives as
    `fetch GET https://<ref>.supabase.co/rest/v1/api_keys` rather than carrying
    row ids and key hashes in its name. Hostnames stay — including the brand
    and competitor sites the onboarding suggester fetches — so group outbound
    traffic by host, never by span name.
- **Incoming (server):** Next.js App Router route handlers under `app/api/**` —
  the dashboard's own CRUD (`/api/runs`, `/api/topics`, `/api/prompts`,
  `/api/competitors`, `/api/keys`), the public programmatic API under
  `/api/v1/**`, an OAuth 2.0 server under `/api/oauth/**`, and an MCP endpoint
  at `/api/mcp/[transport]`.
- **Scheduled (`vercel.json`):** `/api/cron/run` daily at 08:00 UTC — the
  monitoring run that fans every active prompt out to the answer engines — and
  `/api/cron/letterprove-health` every 6 hours. These are the longest and most
  failure-prone paths in the system and the least observed.
- **Outgoing (client):** Supabase (Postgres, Auth, RLS) via `lib/supabase/**`;
  answer-engine providers via `lib/llm/**` — Anthropic and OpenAI SDKs, plus
  dependency-free REST adapters for Google Gemini, Google AI Overviews and
  Perplexity Sonar, and the Concentrate LLM router; outbound HTTP is routed
  through undici (`#129`). Provider calls are BYOK, per-tenant keys decrypted
  at use.

**Spans.** Next.js emits the request spans itself once the SDK is registered —
`GET /api/v1/runs/[id]/route` and friends, named by **route template** rather
than by URL, so they are already low-cardinality. Three hand-placed spans sit
underneath them, and they are the ones that describe the work:

| span | where | scope | attributes |
|---|---|---|---|
| `cron.run` | `app/api/cron/run/route.ts` | one scheduler tick, parenting every run it starts | `cron.projects.scheduled` / `.processed` / `.skipped` / `.failed`, `cron.runs.swept` |
| `run.execute` | `lib/engine.ts` (`resumeRun`) | one monitoring run, parenting its provider calls | `run.id`, `run.provider`, `run.model`, `run.route`, `run.channel`, `run.status`, `run.responses`, `run.prompts`, `run.tokens` |
| `llm.query` | `lib/llm/index.ts` (`runQuery`) | one answer-engine call | `llm.provider`, `llm.model`, `llm.web_search`, `llm.route`, `llm.tokens`, `llm.sources` |

`run.route` / `llm.route` is the router id (`concentrate`) or the literal
`direct` for a direct provider key — the split that made #136 diagnosable.
A failed call sets span status Error and records the exception.

**Metrics.** Emitted every 15s (short enough that a long cron run reports more
than once before Vercel freezes the function).

| metric | type | unit | attributes |
|---|---|---|---|
| `lettertrace.provider.request.duration` | histogram | ms | `llm.provider`, `llm.model`, `llm.web_search`, `llm.route`, `llm.outcome` |
| `lettertrace.provider.tokens` | counter | `{token}` | same |
| `lettertrace.run.duration` | histogram | ms | `run.provider`, `run.model`, `run.route`, `run.channel`, `run.status` |
| `lettertrace.run.responses` | counter | `{response}` | same |

`llm.outcome` is `success` or `error` and is recorded on **both** — a failed
call still costs time, so an engine that has stopped answering appears as a
rate rather than as an absence. The two histograms land in `otel.histograms`,
the two counters in `otel.metrics` as `sum`.

**Logs.** Every `recordOps` / `recordOpsError` call in the app also emits an
OTel log record: body `<kind>: <signature>`, severity from the ops level, and
the sample fields flattened under `ops.*` (`ops.kind`, `ops.signature`,
`ops.provider`, …). The signature is the one `signatureOf()` already scrubbed,
so ids and numbers are collapsed and no content rides along. `run.failed` and
`error` records are the error stream worth alerting on.

**Content rule — carried through.** Provider, model, route, counts, durations
and outcomes are recorded. Prompt text, answers, brand names and customer
domains are not, on any span attribute, metric attribute or log body. Span
status messages carry the error *class*, never its message. This is a public
repository and an operator's data, and the rule is the same one `lib/ops.ts`
has always stated.

## Configuration

Four standard OTLP variables, read by the exporters themselves — so pointing
this app at a different backend is a deployment change, never a code change.
Set them in Vercel (Production, and Preview if you want PR builds reporting);
they are deliberately absent from the repository.

```
OTEL_EXPORTER_OTLP_ENDPOINT   root URL — the exporter appends /v1/traces,
                              /v1/metrics and /v1/logs itself
OTEL_EXPORTER_OTLP_HEADERS    Authorization=Bearer <ingest token>
OTEL_EXPORTER_OTLP_PROTOCOL   http/protobuf
OTEL_SERVICE_NAME             lettertrace
```

Two things that cost time when they are wrong: the endpoint takes **no
`/v1/...` suffix** (a 404 on export means one was added), and the headers value
contains a space, so it needs quoting anywhere a shell will read it. A 401 on
export means the token, not the wiring.

`experimental.instrumentationHook` in `next.config.mjs` is what makes Next 14
load `instrumentation.ts` at all — it became the default in Next 15, and
removing it before that upgrade silently stops all export.

## RUM

None. The dashboard is a React app and emits no browser spans, so page-load and
in-app navigation timings are not visible.

## Deploy signal

**Vercel deploys this repo, and its GitHub deployment status is the deploy.**

Four things report into the CI/CD stream for `letterstory/lettertrace`, and only
one of them means "this code is now in front of users":

| Reported by | Trigger | What it actually means |
|---|---|---|
| Vercel | `deployment_status`, `environment = Production` | **the deploy** |
| Vercel | `status`, `context = Vercel` | the same deploy, without the environment |
| GitHub Actions | `workflow_run` / `workflow_job`, workflow `CI` | typecheck, test, lint, build |
| GitHub Actions | `workflow_run` / `workflow_job`, workflow `Publish container image` | pushes `ghcr.io/letterstory/lettertrace` |

The deployment status is pinned over the commit status because it carries the
environment, which is what keeps a Preview build from reading as a Production
ship. The container-image workflow publishes an artifact for self-hosters; it
does not deploy this org's instance, so it is deliberately not part of the
signal.

Pinned expression:

```
toString(attrs.`cicd.trigger`) = 'deployment_status' AND toString(attrs.`cicd.environment`) = 'Production'
```

Sanity check, re-run 2026-08-19 over 90 days: 8 matches against 106 CI/CD
events. The busy day since this was pinned is what confirmed the `environment`
clause rather than merely justifying it — the stream now also carries **11
`deployment_status` rows for `Preview`**, one per PR build, and the pin excludes
every one of them. Without that clause a Preview build would read as a
Production ship, which is the failure mode the choice was made against; on
2026-08-18 there were no Preview rows yet to demonstrate it.

**Confidence: high, re-verified 2026-08-19.** No escalation PR is needed; the platform
already reports deploys through GitHub, which is the strongest signal this
doctrine asks for. Caveats worth knowing: Vercel sends no deploy duration, so
"how long does a deploy take" is unanswerable from this stream, and the actor on
every deploy is `vercel[bot]` rather than the person who merged — the merging
author is in the push/pull-request events instead.

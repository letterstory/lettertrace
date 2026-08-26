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

One property of this deployment shapes how you read the stream, and it is not a
bug: the app is serverless, so it emits only while a function instance is alive.
Idle stretches produce real gaps, and they are wider than the first day
suggested. Over the first 18 hours the longest was 12.5 minutes; four more days
showed the actual rhythm. Traffic is dominated by an API client that polls
`/api/v1/**` in a burst during the second half of every hour, so **the stream
has an hourly heartbeat, not a continuous one**. Between bursts only sparse
organic traffic fills the gap, and on a quiet day it does not: measured silences
reached **33 minutes** with the app fully healthy. A short silence is the app
being idle, not the app being down, and any telemetry-down alarm here has to be
wider than that client's own period.

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

Six things the live stream makes clear that the design didn't. The first two
change how every query over this data has to be written:

- **Every span arrives exactly twice.** The Vercel OTLP export delivers each
  span as two identical rows, same `span_id`, and it has done so for every span
  since export went live. So `count()` reports double the truth everywhere:
  requests, provider calls, cron ticks. Count `uniqExact(span_id)` instead (or
  `uniqExact(trace_id)` when the unit is a whole trace). A ratio built from two
  `count()`s survives, because the doubling cancels — but any absolute number,
  any rate per second, and any "at least N samples" floor does not.
- **HTTP failure is an attribute here, never a span status.** `status_code = 2`
  has not once appeared on a Next.js server span in the whole history of this
  store, not even for a 5xx; the only Error-status spans anywhere are
  `llm.query`. The request outcome lives on `attrs.http.status_code`, so a
  check written the obvious way — `kind = 2 AND status_code = 2` — reads a flat
  zero straight through a total outage. Every error panel and every request-path
  alarm reads the attribute.

- **The outbound `fetch` spans are named with the full URL**, query string
  included — `@vercel/otel`'s default. So a Supabase PostgREST call arrives as
  `fetch GET https://<ref>.supabase.co/rest/v1/api_keys?select=id,user_id&key_hash=eq.<sha256>`.
  Two consequences. `name` is effectively unique per call, so never group or
  chart outbound traffic by it — group by host. And row ids, the Supabase
  project ref and API-key *hashes* ride along in span names; none of that is
  content under the rule below, but it is more identifier than the hand-placed
  spans carry, and it is worth a deliberate decision rather than a default.
  PR #152 is that decision: it drops the query string and collapses uuid and
  long hex/numeric path segments to `:id` before export. Once it merges the
  example above arrives as `fetch GET https://<ref>.supabase.co/rest/v1/api_keys`
  and the identifiers are gone — but `name` stays high-cardinality enough that
  grouping outbound traffic by host, not by name, remains the rule.
- **A provider 429 does not fail the fetch span.** The rate-limited call still
  records span status Unset at the HTTP layer; only `llm.query` sets status
  Error. So engine health is an `llm.query` question — a dependency error rate
  computed from client spans reads zero straight through a rate-limit storm.
- **Engine health is a per-*model* question, not a per-provider one.** Provider
  quota is enforced per model, so one model on a key can be refusing every call
  while its siblings on the same key answer normally. Grouped by
  `llm.provider` alone that reads as a mild elevation and hides underneath the
  healthy siblings; grouped by (`llm.provider`, `llm.model`) it reads as the
  100% outage it is. Incident #103 was exactly this shape, and it has recurred
  since.

  `llm.route` is the third half of the same lesson, learned 2026-08-26. A router
  is a credential, not an engine, so the same (provider, model) can be reached
  two ways and only one of them need be broken: that morning every
  `claude-haiku-4-5` call through the Concentrate router failed on a gateway
  `400` (`does not support inference_geo`) while direct Anthropic traffic in the
  same window was clean. Grouped without the route, the alarm named Anthropic
  for a fault that was the gateway's. **Group engine health by
  (`llm.provider`, `llm.model`, `llm.route`).**
- **Four routes run a whole job inside the HTTP request, and they wreck any
  latency read that includes them.** Measured over the seven days since export
  went live: `/api/runs/route` p95 **556 s**, `/api/cron/run/route` **151 s**,
  `/api/onboarding/complete/route` **63 s**,
  `/api/cron/letterprove-health/route` **2.2 s** — against 4–500 ms for every
  route a human waits on. One cron tick landing in a window is enough to drag
  an all-routes p95 into the seconds and flatten an interactive latency chart
  to a baseline of zero. So the interactive question and the job question are
  two different questions: exclude those four route values (verbatim, `/route`
  suffix and all) when asking the first, and read the second per-route. Across
  the 150 fifteen-minute buckets carrying at least 20 interactive requests, the
  interactive p95 ran a median of **457 ms** and never exceeded **1.4 s**.

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
`error` records are the error stream worth alerting on. Unlike spans, log
records arrive **once** — the double delivery above is a span artifact, so
`count()` is the right counting form here.

Two cautions before alerting on either kind. A `run.failed` record is **not**
always a fault: `lib/engine.ts` derives the run status from `succeeded === 0`,
so a trial-funded run that halts at the free-usage limit having stored nothing
lands under the same kind as a run the engines killed. `ops.budget_stopped`
separates the pricing event from the outage and is carried on every record. And
an `error` record is **not** a failed call: each retry inside `runQuery` writes
its own row while the surrounding `llm.query` span stays open, so a transient
fault the next attempt fixes still reaches the log stream — on 2026-08-20,
"OpenAI returned an empty answer." appeared 26 times against zero failed OpenAI
spans. Count spans to judge whether the engines are working; read the logs to
learn what they are struggling with.

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

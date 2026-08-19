# Telemetry

This codebase uses OnePatch for telemetry. Query it at app.onepatch.dev/mcp;
manual at docs.onepatch.dev.

**As of 2026-08-18 this application exports no OpenTelemetry.** There is no
`@opentelemetry/*` dependency, no `instrumentation.ts`, and no OTLP exporter.
Every signal in the OnePatch store for this org is derived from GitHub webhooks
— deploys, workflow runs, pushes and merges. So a question of the form "is
lettertrace up", "which route is slow", "what is the error rate", or "did that
deploy break anything" currently has no data behind it, and the answer is
"unknown", not "fine".

That gap is the reason this section leads. Everything below describes the
system as it is deployed, and marks what each part would emit once it is
instrumented, so the map is ready when the data is.

## What monitoring does exist today

Three in-house surfaces, none of which reach OnePatch and none of which are a
substitute for traces:

- **`lib/ops.ts`** — operational events (provider failures, run outcomes)
  bucketed by `(kind, signature, hour)` into Supabase. Never throws, never
  blocks, never records content. Read back through `lib/ops-report.ts` and the
  admin screens.
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
- **Environments:** Vercel reports the deploy environment as `Production`
  (capitalised). Nothing sets `deployment.environment.name` yet, so the `env`
  column on OnePatch spans/logs is empty for this service.
- **Wiring:** none. No SDK, no exporter, no `service.name`, no
  `service.version`. Instrumenting it would want `service.version` set to the
  deploying commit sha so a regression can be grouped by version rather than
  guessed from a timeline.
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

**Spans** — none emitted. The boundaries worth a span when this is
instrumented: the route handler, the cron run, each provider call in
`lib/engine.ts` (attributes: provider, model, whether search grounding was on;
never prompt or answer text), and the Supabase calls.

**Metrics** — none emitted.

**Logs** — none exported to OnePatch.

**Content rule:** whatever gets instrumented inherits `lib/ops.ts`'s third
rule — provider and model may be recorded, prompt text, answers, brand names
and customer domains may not. This is a public repository.

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

Sanity check over 90 days: 1 match, against 8 total CI/CD events — the one real
Production deploy (`c288b80`, 2026-08-18 18:57 UTC) and none of the six CI
events or the duplicate commit status.

**Confidence: high, 2026-08-18.** No escalation PR is needed; the platform
already reports deploys through GitHub, which is the strongest signal this
doctrine asks for. Caveats worth knowing: Vercel sends no deploy duration, so
"how long does a deploy take" is unanswerable from this stream, and the actor on
every deploy is `vercel[bot]` rather than the person who merged — the merging
author is in the push/pull-request events instead.

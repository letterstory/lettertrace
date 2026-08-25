import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * The content rule, applied to the spans we did NOT write by hand.
 *
 * `lib/otel/index.ts` states it for the hand-placed spans: provider, model,
 * route, counts and durations may be recorded; identifiers and content may
 * not. The outbound `fetch` spans `@vercel/otel` creates for us have been
 * quietly exempt, because it names them and tags them with the *whole* request
 * URL, query string included. On this app that means a Supabase PostgREST call
 * arrives looking like:
 *
 *   fetch GET https://<ref>.supabase.co/rest/v1/api_keys
 *     ?select=id,user_id&key_hash=eq.c0340221…3439348c
 *
 * so an API-key sha256, the Supabase project ref, row ids and user ids ride out
 * of the deployment on `span.name` and `http.url`. Nobody chose that; it is the
 * instrumentation's default.
 *
 * It is also expensive. The full URL in the name makes `name` near-unique per
 * call — 5,500 distinct outbound span names in three days against 68 server
 * ones — and `name` is a sort key in the telemetry store, so a near-unique
 * value there defeats the pruning that makes queries over this data cheap. It
 * makes the name useless for grouping too: "how much traffic to Supabase" has
 * to be asked by host, because every call is its own name.
 *
 * This processor rewrites both at span start, before anything is exported:
 * the query string is dropped and identifier-shaped path segments collapse to
 * `:id`. Nothing is lost that we were entitled to keep — the host, method,
 * path shape, status and duration all survive on their own attributes, and the
 * full URL was never something we should have been shipping.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{24,}$/i;
const LONG_DIGITS = /^\d{6,}$/;

/**
 * `https://host/rest/v1/runs/<uuid>?select=*` → `https://host/rest/v1/runs/:id`.
 * Returns the input unchanged if it is not a URL we can parse.
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const path = url.pathname
    .split("/")
    .map((segment) =>
      UUID.test(segment) || LONG_HEX.test(segment) || LONG_DIGITS.test(segment) ? ":id" : segment,
    )
    .join("/");
  return `${url.origin}${path}`;
}

/**
 * `fetch GET https://host/rest/v1/api_keys?key_hash=eq.<sha256>`
 *   → `fetch GET https://host/rest/v1/api_keys`
 *
 * Only touches names of the `fetch <METHOD> <url>` shape, so a hand-placed span
 * (`llm.query`, `run.execute`, `cron.run`) or a next.js route span is returned
 * untouched.
 */
export function redactSpanName(name: string): string {
  const match = /^fetch ([A-Z]+) (\S+)$/.exec(name);
  if (!match) return name;
  return `fetch ${match[1]} ${redactUrl(match[2])}`;
}

// Attributes carrying a URL. `http.url` is the full request URL; `resource.name`
// is @vercel/otel's own already-query-stripped copy, which still keeps id path
// segments.
const URL_ATTRIBUTES = ["http.url", "resource.name"] as const;

/**
 * Runs at span start, so the redaction is in place long before the batch
 * processor serialises anything. Register it ahead of the default processors:
 *
 *   spanProcessors: [new RedactFetchUrls(), "auto"]
 */
export class RedactFetchUrls implements SpanProcessor {
  onStart(span: Span): void {
    const name = redactSpanName(span.name);
    if (name !== span.name) span.updateName(name);

    for (const key of URL_ATTRIBUTES) {
      const value = span.attributes[key];
      if (typeof value !== "string") continue;
      const clean = redactUrl(value);
      if (clean !== value) span.setAttribute(key, clean);
    }
  }

  onEnd(): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

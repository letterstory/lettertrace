// Reporter for owned-site page-access telemetry on lettertrace.com/blog.
//
// The blog has no Lettersprite proxy, so we capture our own access signal and
// forward it to app.letterstory.com's owned-access ingest — the same telemetry
// the Letterstory phantom fleet collects (which AI agents fetch a page, which
// crawlers index it, which humans read it), surfaced alongside GSC + AI
// visibility.
//
//   - middleware.ts reports each REQUEST to /blog (raw UA; the app classifies
//     it) so bots that never run JS are seen.
//   - the in-page beacon reports ENGAGEMENT (dwell/scroll/referrer) for humans.
//
// Both are fire-and-forget: a telemetry failure must never affect a page. Env-
// gated — no-op unless both vars are set, so this is inert on forks / self-
// hosted deployments (same posture as the RB2B marketing pixel).
//
//   LETTERBRACE_OWNED_ACCESS_URL   e.g. https://app.letterstory.com/api/integrations/owned-access
//   LETTERBRACE_OWNED_ACCESS_KEY   the reporting key from the app's scripts/provision-owned-site.ts

const INGEST_URL = process.env.LETTERBRACE_OWNED_ACCESS_URL ?? "";
const INGEST_KEY = process.env.LETTERBRACE_OWNED_ACCESS_KEY ?? "";

export function isAccessReportingConfigured(): boolean {
  return Boolean(INGEST_URL && INGEST_KEY);
}

async function post(body: unknown): Promise<void> {
  if (!isAccessReportingConfigured()) return;
  try {
    await fetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-integrations-key": INGEST_KEY },
      body: JSON.stringify(body),
      // Never let the CDN cache a telemetry POST or hang a render on it.
      cache: "no-store",
    });
  } catch {
    // Swallowed by design — losing a telemetry beat is cheaper than a page error.
  }
}

/** Report one request. The app classifies the UA server-side via the shared registry. */
export function reportAccess(input: { path: string; userAgent: string | null }): Promise<void> {
  return post({ path: input.path, user_agent: input.userAgent ?? "" });
}

/** Report a confirmed page view's engagement (beacon). `from` is the referrer source. */
export function reportEngagement(input: {
  path: string;
  from?: string | null;
  seconds?: number;
  scroll?: number;
}): Promise<void> {
  return post({
    path: input.path,
    engagement: {
      from: input.from ?? "",
      seconds: input.seconds ?? 0,
      scroll: input.scroll ?? 0,
    },
  });
}

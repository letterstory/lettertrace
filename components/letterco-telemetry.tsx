"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

/**
 * Company-funnel telemetry — deliberately separate from PostHogAnalytics,
 * which is lettertrace's own product-analytics project and stays untouched.
 *
 * This boots a second, named PostHog instance pointed at the company-wide
 * funnel project (shared with the app and the marketing sites; the token is a
 * public ingest key) and captures exactly one marketing pageview tagged
 * marketing_site: "lettertrace" — the row key on the staff Telemetry tab at
 * app.letterstory.com/fleet. Mount it ONLY on public marketing pages, never
 * in the app layout: authed product usage must not count as marketing
 * traffic. Event names follow the letterstory repo's docs/analytics-events.md.
 */
const LETTERCO_KEY = "phc_zVtjM42jzNFtDtNFfohun7qct7pg9Zs9Z9kYyZEnsw3z";

// One capture per page load (StrictMode double-mounts effects in dev).
let fired = false;

export function LetterCoTelemetry() {
  useEffect(() => {
    if (fired) return;
    fired = true;
    const letterco = posthog.init(
      LETTERCO_KEY,
      {
        api_host: "https://us.i.posthog.com",
        capture_pageview: false,
        autocapture: false,
        disable_session_recording: true,
      },
      "letterco"
    );
    letterco?.capture("$pageview", { marketing_site: "lettertrace" });
  }, []);

  return null;
}

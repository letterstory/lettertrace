"use client";

import { useEffect } from "react";
import posthog, { type BeforeSendFn } from "posthog-js";
import { isShareLinkPath } from "@/lib/analytics-filter";

/**
 * PostHog product analytics.
 *
 * Renders nothing and does nothing unless NEXT_PUBLIC_POSTHOG_KEY is set, so it
 * is inert in local dev and in self-hosted container images (which are built
 * without the key — operators' deployments are never tracked). The key is the
 * project API key (phc_...), which is public by design, NOT a secret.
 *
 * Unlike the RB2B pixel this runs on every route, authenticated product
 * included — product analytics is the point. The `defaults` date opts into
 * PostHog's current recommended behavior, which includes automatic pageview
 * capture across client-side navigations.
 *
 * A share link's token lives in its URL path (see lib/share-links.ts), so
 * the auto-captured $current_url on that one route IS the credential.
 * before_send is the current, non-deprecated hook for this (sanitize_properties
 * is deprecated in the installed posthog-js) — drop the event outright rather
 * than scrub it, since there's no analytics value in a share view worth the risk
 * of a scrubbing bug leaving a token in half-redacted.
 */
const beforeSend: BeforeSendFn = (cr) => {
  if (!cr) return cr;
  let pathname = "";
  try {
    pathname = new URL(String(cr.properties?.$current_url ?? ""), window.location.origin).pathname;
  } catch {
    return cr; // Unparseable URL: fail open rather than silently drop unrelated events.
  }
  return isShareLinkPath(pathname) ? null : cr;
};

export function PostHogAnalytics() {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

  useEffect(() => {
    if (!key || posthog.__loaded) return;
    posthog.init(key, {
      api_host: host,
      defaults: "2025-05-24",
      before_send: beforeSend,
    });
  }, [key, host]);

  return null;
}

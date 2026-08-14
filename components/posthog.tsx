"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

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
 */
export function PostHogAnalytics() {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

  useEffect(() => {
    if (!key || posthog.__loaded) return;
    posthog.init(key, {
      api_host: host,
      defaults: "2025-05-24",
    });
  }, [key, host]);

  return null;
}

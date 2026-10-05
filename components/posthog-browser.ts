"use client";

import posthog from "posthog-js";

/**
 * The product snippet in components/posthog.tsx boots from the root layout,
 * whose effect runs AFTER this dashboard's. Calling identify first would
 * drop the call on a cold load, so this brings the same project up if the
 * layout hasn't yet. Same key, same host, same defaults — a second project
 * here would split the person the funnel is trying to join.
 */
export function ensureProductPosthog(): boolean {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return false;
  if (!posthog.__loaded) {
    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      defaults: "2025-05-24",
    });
  }
  return true;
}

export function resetProductPosthog(): void {
  try {
    if (posthog.__loaded) posthog.reset();
  } catch {
    // Signing out must not depend on analytics being reachable.
  }
}

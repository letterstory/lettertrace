"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { reportViewedProperties } from "@/lib/posthog-client-events";
import { ensureProductPosthog } from "@/components/posthog-browser";

/**
 * Opening a run's report IS checking the results, so it clears the nudge —
 * whether the user got here from the banner, the Runs list, or a bookmark.
 *
 * Renders nothing. The write is fire-and-forget: a failed mark just means the
 * banner is still there next time, which is the harmless direction to fail in.
 */
export function MarkResultsSeen({
  runId,
  orgId,
  billingOwnerId,
}: {
  runId: string;
  orgId: string;
  billingOwnerId: string;
}) {
  const router = useRouter();
  // React 18 mounts effects twice in dev StrictMode, and this posts a write.
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;

    if (ensureProductPosthog()) {
      posthog.capture(
        "report_viewed",
        reportViewedProperties({ orgId, billingOwnerId, runId }),
      );
    }

    let active = true;
    void (async () => {
      try {
        const res = await fetch("/api/runs/seen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId }),
        });
        const data = (await res.json().catch(() => ({}))) as { changed?: boolean };
        // Only re-render when the mark actually moved: refreshing on every view
        // would remount this component and post again, forever.
        if (active && res.ok && data.changed) router.refresh();
      } catch {
        // Ignored on purpose — see the note above.
      }
    })();

    return () => {
      active = false;
    };
  }, [runId, orgId, billingOwnerId, router]);

  return null;
}

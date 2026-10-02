"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Refresh while a batch is still outstanding, so finished engines appear
 * without the reader doing anything.
 *
 * Bounded deliberately. Each tick is a full server render of this page, and an
 * unfinished batch is exactly the state a closed tab leaves behind — so an
 * unbounded version would have a page left open overnight re-rendering every
 * fifteen seconds for a batch nothing was ever going to advance. The cron
 * closes those out; this only has to cover the window until it does.
 */
const INTERVAL_MS = 15_000;
const MAX_TICKS = 160; // 40 minutes, comfortably past the abandon sweep.

export function GroupProgressRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks++;
      if (ticks > MAX_TICKS) {
        window.clearInterval(timer);
        return;
      }
      router.refresh();
    }, INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, router]);
  return null;
}

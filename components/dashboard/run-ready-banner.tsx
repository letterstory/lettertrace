"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BarChart3, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

// Shown at the top of the dashboard when a monitoring run has finished that the
// owner hasn't opened yet — the counterpart to TrialBanner, which nudges toward
// BYOK. Until this existed a finished run announced itself nowhere: the
// scheduler completes runs while nobody is watching, and a manual run just
// appears as another row in the Runs list.
//
// Clearing it is a real write (projects.results_seen_at), not local state, so
// the nudge doesn't reappear on the next device or the next navigation.
export function RunReadyBanner({
  runId,
  status,
  answers,
  plannedAnswers,
  modelName,
  finishedAgo,
  error,
}: {
  runId: string;
  status: "completed" | "failed";
  answers: number;
  plannedAnswers: number;
  modelName: string;
  /** Pre-formatted on the server so this stays a pure render. */
  finishedAgo: string;
  error: string | null;
}) {
  const router = useRouter();
  const [dismissing, setDismissing] = useState(false);
  const [hidden, setHidden] = useState(false);

  const failed = status === "failed";

  // Dismiss acknowledges everything finished so far, so it sends no run id.
  async function dismiss() {
    setDismissing(true);
    setHidden(true); // optimistic: the nudge should feel instant
    try {
      await fetch("/api/runs/seen", { method: "POST" });
      router.refresh();
    } catch {
      // The mark didn't land, so put it back rather than pretending it cleared.
      setHidden(false);
    } finally {
      setDismissing(false);
    }
  }

  if (hidden) return null;

  return (
    <div
      className={cn(
        "mb-6 rounded border px-5 py-4",
        failed
          ? "border-terracotta/30 bg-terracotta/[0.07]"
          : "border-mint/30 bg-mint/[0.07]",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded",
              failed
                ? "bg-terracotta/15 text-terracotta-dark"
                : "bg-mint/20 text-mint-ink",
            )}
          >
            {failed ? (
              <TriangleAlert className="h-4 w-4" />
            ) : (
              <BarChart3 className="h-4 w-4" />
            )}
          </span>
          <div>
            <p className="text-sm font-medium text-ink">
              {failed ? "Your latest report failed" : "Your report is ready"}
            </p>
            <p className="mt-0.5 text-xs text-ink-faint">
              {failed
                ? error ??
                  `No answers were stored on ${modelName}. Monitoring is not collecting data until this is fixed.`
                : `${answers} of ${plannedAnswers} ${
                    plannedAnswers === 1 ? "answer" : "answers"
                  } collected on ${modelName}, ${finishedAgo}. See where your brand showed up.`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            href={`/dashboard/runs/${runId}`}
            size="sm"
            variant={failed ? "secondary" : "primary"}
          >
            {failed ? "See what happened" : "View results"}
          </Button>
          <button
            type="button"
            onClick={dismiss}
            disabled={dismissing}
            aria-label="Dismiss"
            className="rounded p-1.5 text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

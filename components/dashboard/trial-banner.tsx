import { KeyRound, Sparkles } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

// Shown in the dashboard when a user is running on the operator's shared (trial)
// keys instead of their own. Nudges them toward BYOK, and hard-stops the message
// once they've crossed the configurable token threshold.
export function TrialBanner({
  used,
  limit,
  exhausted,
}: {
  used: number;
  limit: number;
  exhausted: boolean;
}) {
  const remaining = Math.max(0, limit - used);
  const pctUsed = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;

  return (
    <div
      className={cn(
        "mb-6 flex flex-col gap-3 rounded-2xl border px-5 py-4 sm:flex-row sm:items-center sm:justify-between",
        exhausted ? "border-terracotta/30 bg-terracotta/[0.07]" : "border-teal/25 bg-teal/[0.06]",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            exhausted ? "bg-terracotta/15 text-terracotta-dark" : "bg-teal/15 text-teal-900",
          )}
        >
          {exhausted ? <KeyRound className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
        </span>
        <div>
          <p className="text-sm font-medium text-ink">
            {exhausted ? "Free trial used up" : "You're on the free trial"}
          </p>
          <p className="mt-0.5 text-xs text-ink-faint">
            {exhausted
              ? "Add your own API key to keep running searches and generating variations."
              : `Running on shared keys. ${remaining.toLocaleString()} of ${limit.toLocaleString()} trial tokens left. Add your own key to scale.`}
          </p>
          {!exhausted && (
            <div className="mt-2 h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-ink/[0.08]">
              <div className="h-full rounded-full bg-teal" style={{ width: `${pctUsed}%` }} />
            </div>
          )}
        </div>
      </div>
      <Button
        href="/dashboard/settings"
        size="sm"
        variant={exhausted ? "primary" : "secondary"}
        className="shrink-0"
      >
        Add your key
      </Button>
    </div>
  );
}

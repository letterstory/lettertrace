import { KeyRound, Sparkles } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

// Shown in the dashboard when a user is running on the operator's shared (trial)
// keys instead of their own. Nudges them toward BYOK, and hard-stops the message
// once their free runs are used up. `used`/`limit` are monitoring runs.
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
  // Optional walkthrough explaining the BYOK model, shown once the free runs
  // are gone. Any embeddable player URL (e.g. a YouTube embed link).
  const videoUrl = process.env.NEXT_PUBLIC_BYOK_VIDEO_URL;

  return (
    <div
      className={cn(
        "mb-6 rounded border px-5 py-4",
        exhausted ? "border-terracotta/30 bg-terracotta/[0.07]" : "border-teal/25 bg-teal/[0.06]",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded",
              exhausted ? "bg-terracotta/15 text-terracotta-dark" : "bg-teal/15 text-teal-dark",
            )}
          >
            {exhausted ? <KeyRound className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
          </span>
          <div>
            <p className="text-sm font-medium text-ink">
              {exhausted ? "Your free runs are used up" : "You're currently on complimentary tokens"}
            </p>
            <p className="mt-0.5 text-xs text-ink-faint">
              {exhausted
                ? "Monitoring is paused. Add your own API key to keep collecting data."
                : `Running on our keys, on the house. ${remaining} of ${limit} free ${
                    limit === 1 ? "run" : "runs"
                  } left, then you bring your own key.`}
            </p>
            {!exhausted && limit <= 12 && (
              <div className="mt-2 flex items-center gap-1.5">
                {Array.from({ length: limit }, (_, i) => (
                  <span
                    key={i}
                    className={cn(
                      "h-1.5 w-6 rounded-sm",
                      i < used ? "bg-teal" : "bg-ink/[0.08]",
                    )}
                  />
                ))}
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

      {exhausted && videoUrl && (
        <div className="mt-4 overflow-hidden rounded border border-ink/10">
          <iframe
            src={videoUrl}
            title="Why you bring your own key"
            className="aspect-video w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      )}
    </div>
  );
}

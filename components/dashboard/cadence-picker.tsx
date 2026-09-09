"use client";

import { Clock } from "lucide-react";
import { cn, CUSTOM_INTERVAL_MAX, CUSTOM_INTERVAL_MIN } from "@/lib/utils";

/**
 * Controlled cadence control: a schedule on/off switch plus a
 * Daily/Weekly/Custom pill row, with a day-count input when Custom is picked.
 * No fetching — the caller owns the state and decides what to do with it.
 * Used at the end of onboarding (app/dashboard/onboarding.tsx), pre-submit,
 * so the schedule is chosen before the project row is created rather than
 * defaulting to one and hiding in Settings.
 */

export type OnboardingCadence = "daily" | "weekly" | "custom";

const PILLS: { value: OnboardingCadence; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom" },
];

export function CadencePicker({
  enabled,
  onEnabledChange,
  cadence,
  onCadenceChange,
  customDays,
  onCustomDaysChange,
  disabled = false,
}: {
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  cadence: OnboardingCadence;
  onCadenceChange: (value: OnboardingCadence) => void;
  customDays: number;
  onCustomDaysChange: (value: number) => void;
  disabled?: boolean;
}) {
  const pillsDisabled = disabled || !enabled;

  return (
    <div className="rounded border border-ink/10 bg-paper-shade/40 p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-2">
          <Clock className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
          <span className="text-sm font-medium text-ink">Keep this report up to date</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Keep this report up to date"
          disabled={disabled}
          onClick={() => onEnabledChange(!enabled)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded transition disabled:opacity-50",
            enabled ? "bg-terracotta" : "bg-ink/15",
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 transform rounded-sm bg-white transition",
              enabled ? "translate-x-6" : "translate-x-1",
            )}
          />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 pl-6">
        <div className="flex items-center gap-1 rounded border border-ink/10 bg-surface p-1">
          {PILLS.map((p) => (
            <button
              key={p.value}
              type="button"
              aria-pressed={cadence === p.value}
              disabled={pillsDisabled}
              onClick={() => onCadenceChange(p.value)}
              className={cn(
                "rounded-sm px-2.5 py-1 text-xs transition disabled:opacity-50",
                cadence === p.value
                  ? "bg-ink/[0.08] font-medium text-ink"
                  : "text-ink-faint hover:text-ink-soft",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        {cadence === "custom" && (
          <span className="flex items-center gap-1.5 text-sm text-ink-faint">
            every
            <input
              type="number"
              aria-label="Days between runs"
              min={CUSTOM_INTERVAL_MIN}
              max={CUSTOM_INTERVAL_MAX}
              value={customDays}
              disabled={pillsDisabled}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next)) onCustomDaysChange(next);
              }}
              className="w-16 rounded border border-ink/15 bg-paper px-2 py-1.5 text-sm text-ink disabled:opacity-50"
            />
            days
          </span>
        )}
      </div>
    </div>
  );
}

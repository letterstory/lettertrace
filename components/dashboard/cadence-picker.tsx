"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Input } from "@/components/ui";
import {
  cn,
  CUSTOM_INTERVAL_MAX,
  CUSTOM_INTERVAL_MIN,
  normalizeCustomInterval,
  SCHEDULE_LABELS,
  SCHEDULES,
} from "@/lib/utils";
import type { Schedule } from "@/lib/types";

/**
 * Controlled cadence control: a schedule on/off switch plus a
 * Daily/Weekly/Custom pill row, with a day-count input when Custom is picked.
 * No fetching — the caller owns the state and decides what to do with it.
 * Used at the end of onboarding (app/dashboard/onboarding.tsx), pre-submit,
 * so the schedule is chosen before the project row is created rather than
 * defaulting to one and hiding in Settings.
 */

export type OnboardingCadence = Exclude<Schedule, "off">;

const ONBOARDING_CADENCES = SCHEDULES.filter(
  (schedule): schedule is OnboardingCadence => schedule !== "off",
);

const SHORT_LABELS: Record<OnboardingCadence, string> = {
  daily: SCHEDULE_LABELS.daily,
  weekly: SCHEDULE_LABELS.weekly,
  custom: "Custom",
};

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
  // Keep the editable string local so clearing the field is a harmless draft,
  // not Number("") = 0 leaking into the parent's valid numeric state.
  const [customDraft, setCustomDraft] = useState(String(customDays));

  useEffect(() => {
    setCustomDraft(String(customDays));
  }, [customDays]);

  function commitCustomDraft() {
    const normalized = normalizeCustomInterval(customDraft, customDays);
    setCustomDraft(String(normalized));
    if (normalized !== customDays) onCustomDaysChange(normalized);
  }

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
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
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
          {ONBOARDING_CADENCES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={cadence === value}
              disabled={pillsDisabled}
              onClick={() => onCadenceChange(value)}
              className={cn(
                "rounded-sm px-2.5 py-1 text-xs transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40",
                cadence === value
                  ? "bg-ink/[0.08] font-medium text-ink"
                  : "text-ink-faint hover:text-ink-soft",
              )}
            >
              {SHORT_LABELS[value]}
            </button>
          ))}
        </div>
        {cadence === "custom" && (
          <span className="flex items-center gap-1.5 text-sm text-ink-faint">
            every
            <Input
              type="number"
              aria-label="Days between runs"
              min={CUSTOM_INTERVAL_MIN}
              max={CUSTOM_INTERVAL_MAX}
              step={1}
              value={customDraft}
              disabled={pillsDisabled}
              onChange={(e) => setCustomDraft(e.target.value)}
              onBlur={commitCustomDraft}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              className="w-16 bg-paper px-2 py-1.5 disabled:opacity-50"
            />
            days
          </span>
        )}
      </div>
    </div>
  );
}

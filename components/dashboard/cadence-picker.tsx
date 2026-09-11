"use client";

import { SchedulePicker, type ActiveSchedule } from "@/components/dashboard/schedule-picker";

/**
 * Controlled cadence control: the same on/off switch and Run daily/Run
 * weekly/Set a schedule pills as the Reports page, with a day-count input
 * when 'Set a schedule' is picked. No fetching — the caller owns the state
 * and decides what to do with it. Used at the end of onboarding
 * (app/dashboard/onboarding.tsx), pre-submit, so the schedule is chosen
 * before the project row is created rather than defaulting to one and
 * hiding in Settings.
 */

export type OnboardingCadence = ActiveSchedule;

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
  return (
    <div className="rounded border border-ink/10 bg-paper-shade/40 p-4">
      <SchedulePicker
        header="Keep this report up to date"
        switchAriaLabel="Keep this report up to date"
        enabled={enabled}
        cadence={cadence}
        intervalDays={cadence === "custom" ? customDays : null}
        disabled={disabled}
        onCommit={(nextEnabled, nextCadence, nextDays) => {
          onEnabledChange(nextEnabled);
          onCadenceChange(nextCadence);
          if (nextCadence === "custom") onCustomDaysChange(nextDays);
        }}
      />
    </div>
  );
}

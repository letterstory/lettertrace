"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CalendarClock } from "lucide-react";
import { Input } from "@/components/ui";
import {
  cn,
  CUSTOM_INTERVAL_DEFAULT,
  CUSTOM_INTERVAL_MAX,
  CUSTOM_INTERVAL_MIN,
  normalizeCustomInterval,
  SCHEDULES,
} from "@/lib/utils";
import type { Schedule } from "@/lib/types";

/**
 * Shared on/off + cadence control behind both the Reports page's
 * ScheduleControl and onboarding's CadencePicker. Optimistic: a change
 * applies to the display immediately and is handed to `onCommit`; a `false`
 * (or a promise resolving to `false`) rolls the display back, for a caller
 * that persists over the network and can fail. A caller that can't fail
 * (onboarding, no network) just updates its own state and returns nothing.
 *
 * Cadence is remembered independently of on/off, same as onboarding's
 * pre-existing behavior: switching off then back on restores whatever
 * cadence was last picked. Each caller decides what "cadence" to feed in
 * while off — onboarding just passes its own persistent state; the Reports
 * page has no server column for this so it tracks the last-active cadence 
 * locally instead.
 */

export type ActiveSchedule = Exclude<Schedule, "off">;

export const ACTIVE_SCHEDULES = SCHEDULES.filter(
  (schedule): schedule is ActiveSchedule => schedule !== "off",
);

const PILL_LABELS: Record<ActiveSchedule, string> = {
  daily: "Run daily",
  weekly: "Run weekly",
  custom: "Set a schedule",
};

interface Confirmed {
  enabled: boolean;
  cadence: ActiveSchedule;
  intervalDays: number;
}

export function SchedulePicker({
  header,
  description,
  switchAriaLabel,
  enabled,
  cadence,
  intervalDays,
  onCommit,
  disabled = false,
}: {
  header: string;
  /** Rendered with the live (optimistic, not-yet-committed) state, so text
   *  like "runs weekly" updates the moment a pill is clicked. */
  description?: (state: { enabled: boolean; cadence: ActiveSchedule; intervalDays: number }) => ReactNode;
  switchAriaLabel: string;
  enabled: boolean;
  cadence: ActiveSchedule;
  /** Days between runs when cadence is 'custom'; ignored otherwise. */
  intervalDays: number | null;
  onCommit: (
    enabled: boolean,
    cadence: ActiveSchedule,
    intervalDays: number,
  ) => void | boolean | Promise<void | boolean>;
  disabled?: boolean;
}) {
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localCadence, setLocalCadence] = useState(cadence);
  const initialInterval = intervalDays ?? CUSTOM_INTERVAL_DEFAULT;
  // A string draft lets the user clear and replace the number without turning
  // the transient empty field into a one-day schedule.
  const [intervalDraft, setIntervalDraft] = useState(String(initialInterval));
  // Guards the resync effect below against a slow caller (a PATCH in flight)
  // clobbering an edit made while it was pending.
  const pendingRef = useRef(false);
  const confirmed = useRef<Confirmed>({ enabled, cadence, intervalDays: initialInterval });
  const intervalInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pendingRef.current) return;
    const days = intervalDays ?? CUSTOM_INTERVAL_DEFAULT;
    confirmed.current = { enabled, cadence, intervalDays: days };
    setLocalEnabled(enabled);
    setLocalCadence(cadence);
    setIntervalDraft(String(days));
  }, [enabled, cadence, intervalDays]);

  async function commit(nextEnabled: boolean, nextCadence: ActiveSchedule, days: number) {
    const previous = confirmed.current;
    const unchanged =
      nextEnabled === previous.enabled &&
      nextCadence === previous.cadence &&
      (nextCadence !== "custom" || days === previous.intervalDays);

    setLocalEnabled(nextEnabled);
    setLocalCadence(nextCadence);
    if (nextCadence === "custom") setIntervalDraft(String(days));
    if (unchanged) return;

    const committedDays = nextCadence === "custom" ? days : CUSTOM_INTERVAL_DEFAULT;
    pendingRef.current = true;
    try {
      const result = await onCommit(nextEnabled, nextCadence, committedDays);
      if (result === false) {
        setLocalEnabled(previous.enabled);
        setLocalCadence(previous.cadence);
        setIntervalDraft(String(previous.intervalDays));
        return;
      }
      confirmed.current = { enabled: nextEnabled, cadence: nextCadence, intervalDays: committedDays };
    } finally {
      pendingRef.current = false;
    }
  }

  function commitCustom() {
    if (localCadence !== "custom") return;
    const normalized = normalizeCustomInterval(intervalDraft, confirmed.current.intervalDays);
    setIntervalDraft(String(normalized));
    void commit(localEnabled, "custom", normalized);
  }

  const days = normalizeCustomInterval(intervalDraft, confirmed.current.intervalDays);

  return (
    <div
      onBlur={(event) => {
        // The switch, cadence buttons and number input are one edit. Moving
        // among them must not commit custom before the click the user was
        // actually making can run.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        commitCustom();
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-ink-faint" />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-ink">{header}</p>
            {description?.({ enabled: localEnabled, cadence: localCadence, intervalDays: days })}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs font-medium text-ink-soft">
            Schedule {localEnabled ? "on" : "off"}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={localEnabled}
            aria-label={switchAriaLabel}
            disabled={disabled}
            onClick={() => void commit(!localEnabled, localCadence, days)}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
              localEnabled ? "bg-terracotta" : "bg-ink/15",
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-sm bg-white transition",
                localEnabled ? "translate-x-6" : "translate-x-1",
              )}
            />
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 sm:pl-8">
        <div
          className="grid w-full grid-cols-3 items-stretch gap-1 rounded border border-ink/10 bg-paper-shade/40 p-1 sm:flex sm:w-auto sm:items-center"
          role="group"
          aria-label="Report schedule cadence"
        >
          {ACTIVE_SCHEDULES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={localCadence === value}
              disabled={disabled || !localEnabled}
              onClick={() => {
                if (value === "custom") {
                  setLocalCadence("custom");
                  requestAnimationFrame(() => {
                    intervalInput.current?.focus();
                    intervalInput.current?.select();
                  });
                  return;
                }
                void commit(localEnabled, value, days);
              }}
              className={cn(
                "rounded-sm px-2 py-1.5 text-xs transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 sm:px-3 sm:text-sm",
                localCadence === value
                  ? "bg-surface font-medium text-ink shadow-sm"
                  : "text-ink-faint hover:text-ink-soft",
              )}
            >
              {PILL_LABELS[value]}
            </button>
          ))}
        </div>
        {localCadence === "custom" && (
          <span className="flex items-center gap-1.5 text-sm text-ink-faint">
            every
            <Input
              ref={intervalInput}
              type="number"
              aria-label="Days between runs"
              min={CUSTOM_INTERVAL_MIN}
              max={CUSTOM_INTERVAL_MAX}
              step={1}
              value={intervalDraft}
              disabled={disabled || !localEnabled}
              onChange={(e) => setIntervalDraft(e.target.value)}
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

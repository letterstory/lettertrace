"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CalendarClock } from "lucide-react";
import { Input, SegmentedControl, Switch } from "@/components/ui";
import {
  CUSTOM_INTERVAL_DEFAULT,
  CUSTOM_INTERVAL_MAX,
  CUSTOM_INTERVAL_MIN,
  normalizeCustomInterval,
  SCHEDULES,
} from "@/lib/utils";
import type { Schedule } from "@/lib/types";

/**
 * Shared on/off + cadence control behind both the Reports page's
 * ScheduleControl and onboarding's CadencePicker. Optimistic: a change applies
 * to the display immediately and is handed to `onCommit`; a `false` (or a
 * promise resolving to `false`) rolls the display back, for a caller that
 * persists over the network and can fail. A caller that can't fail
 * (onboarding, no network) just updates its own state and returns nothing.
 *
 * THE CADENCE PILLS ARE THE ACTIVATION CONTROL. Clicking one turns the
 * schedule on at that cadence — there is no flip-the-switch-then-choose
 * two-step, and no separate "activate" CTA to keep in sync with the switch.
 * The switch is how you turn it back off, and how you resume without
 * re-picking.
 *
 * `cadence` is nullable because "off, and we don't know what you'd pick" is a
 * real state: a schedule that is off stores no cadence, so after a reload
 * nothing is pressed rather than "Run daily" sitting pressed-but-disabled,
 * which reads as a choice nobody made. Turning the switch on from there
 * applies DEFAULT_CADENCE and says so by moving the pill.
 */

export type ActiveSchedule = Exclude<Schedule, "off">;

export const ACTIVE_SCHEDULES = SCHEDULES.filter(
  (schedule): schedule is ActiveSchedule => schedule !== "off",
);

/** What the switch turns on when there's no cadence to resume. Weekly, not
 *  daily: the trial is a lifetime allowance of runs, and a daily default
 *  spends it in a fortnight. Anyone who wants daily has a pill for it. */
export const DEFAULT_CADENCE: ActiveSchedule = "weekly";

const PILL_LABELS: Record<ActiveSchedule, string> = {
  daily: "Run daily",
  weekly: "Run weekly",
  custom: "Set a schedule",
};

const PILL_OPTIONS = ACTIVE_SCHEDULES.map((value) => ({ value, label: PILL_LABELS[value] }));

interface Confirmed {
  enabled: boolean;
  cadence: ActiveSchedule | null;
  intervalDays: number;
}

/** What the switch turns on: the cadence on screen, or the default when there
 *  is none to resume. Pulled out so the component and its tests can't
 *  disagree about which cadence an un-chosen schedule starts at. */
export function cadenceForSwitch(cadence: ActiveSchedule | null): ActiveSchedule {
  return cadence ?? DEFAULT_CADENCE;
}

/**
 * What a click actually writes, and whether it is worth writing at all.
 *
 * `intervalDays` only means anything for 'custom', so every other cadence
 * commits the default rather than carrying a number the schedule ignores —
 * that's what keeps a stale interval from resurfacing when someone goes
 * custom, back to weekly, and back to custom. `unchanged` exists because the
 * pills are clickable at all times now: clicking the cadence you already have
 * must not fire a PATCH (or, for onboarding, a re-render loop).
 */
export function resolveScheduleCommit(
  confirmed: Confirmed,
  intent: { enabled: boolean; cadence: ActiveSchedule; intervalDays: number },
): { enabled: boolean; cadence: ActiveSchedule; intervalDays: number; unchanged: boolean } {
  const intervalDays =
    intent.cadence === "custom" ? intent.intervalDays : CUSTOM_INTERVAL_DEFAULT;
  const unchanged =
    intent.enabled === confirmed.enabled &&
    intent.cadence === confirmed.cadence &&
    (intent.cadence !== "custom" || intervalDays === confirmed.intervalDays);
  return { enabled: intent.enabled, cadence: intent.cadence, intervalDays, unchanged };
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
  description?: (state: {
    enabled: boolean;
    cadence: ActiveSchedule | null;
    intervalDays: number;
  }) => ReactNode;
  switchAriaLabel: string;
  enabled: boolean;
  /** Null when nothing is scheduled and no previous choice is known. */
  cadence: ActiveSchedule | null;
  /** Days between runs for the 'custom' cadence. Kept across cadence changes
   *  by the caller, so picking Run daily and coming back doesn't forget the
   *  number that was typed. */
  intervalDays: number | null;
  onCommit: (
    enabled: boolean,
    cadence: ActiveSchedule,
    intervalDays: number,
  ) => void | boolean | Promise<void | boolean>;
  disabled?: boolean;
}) {
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localCadence, setLocalCadence] = useState<ActiveSchedule | null>(cadence);
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
    const { intervalDays: committedDays, unchanged } = resolveScheduleCommit(previous, {
      enabled: nextEnabled,
      cadence: nextCadence,
      intervalDays: days,
    });

    setLocalEnabled(nextEnabled);
    setLocalCadence(nextCadence);
    if (nextCadence === "custom") setIntervalDraft(String(days));
    if (unchanged) return;

    pendingRef.current = true;
    try {
      const result = await onCommit(nextEnabled, nextCadence, committedDays);
      if (result === false) {
        setLocalEnabled(previous.enabled);
        setLocalCadence(previous.cadence);
        setIntervalDraft(String(previous.intervalDays));
        return;
      }
      confirmed.current = {
        enabled: nextEnabled,
        cadence: nextCadence,
        intervalDays: committedDays,
      };
    } finally {
      pendingRef.current = false;
    }
  }

  /** 'Set a schedule' is the one pill that does NOT commit on click: it wants
   *  a number first, so it selects, focuses the box, and waits. The single
   *  save happens here on the way out — which is also what turns the schedule
   *  on, so picking it is one decision and one write, not two. */
  function commitCustom() {
    if (localCadence !== "custom") return;
    const normalized = normalizeCustomInterval(intervalDraft, confirmed.current.intervalDays);
    setIntervalDraft(String(normalized));
    void commit(true, "custom", normalized);
  }

  const days = normalizeCustomInterval(intervalDraft, confirmed.current.intervalDays);

  return (
    <div
      onBlur={(event) => {
        // The switch, cadence pills and number input are one edit. Moving
        // among them must not commit custom before the click the user was
        // actually making can run.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        commitCustom();
      }}
    >
      {/* Header and switch share a row from `sm` up; on a phone the switch
          drops under the title rather than squeezing the description into a
          column three words wide. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-ink-faint" aria-hidden />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-ink">{header}</p>
            {description?.({
              enabled: localEnabled,
              cadence: localCadence,
              intervalDays: days,
            })}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 pl-8 sm:pl-0">
          <span className="text-xs font-medium text-ink-soft">
            Schedule {localEnabled ? "on" : "off"}
          </span>
          <Switch
            checked={localEnabled}
            label={switchAriaLabel}
            disabled={disabled}
            onChange={(next) => void commit(next, cadenceForSwitch(localCadence), days)}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 sm:pl-8">
        <SegmentedControl
          label="Report schedule cadence"
          options={PILL_OPTIONS}
          value={localCadence}
          disabled={disabled}
          onChange={(value) => {
            if (value === "custom") {
              setLocalCadence("custom");
              requestAnimationFrame(() => {
                intervalInput.current?.focus();
                intervalInput.current?.select();
              });
              return;
            }
            // Picking a cadence IS turning the schedule on.
            void commit(true, value, days);
          }}
        />
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
              disabled={disabled}
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

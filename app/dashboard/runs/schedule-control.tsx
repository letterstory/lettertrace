"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { Card, CardBody, Input, Select } from "@/components/ui";
import {
  CUSTOM_INTERVAL_DEFAULT,
  CUSTOM_INTERVAL_MAX,
  CUSTOM_INTERVAL_MIN,
  normalizeCustomInterval,
  SCHEDULE_LABELS,
  SCHEDULES,
  scheduleLabel,
} from "@/lib/utils";
import type { KeySource } from "@/lib/trial";
import type { Schedule } from "@/lib/types";

export function ScheduleControl({
  schedule: saved,
  scheduleIntervalDays: savedIntervalDays,
  keySource,
  providerLabel,
}: {
  schedule: Schedule;
  /** Days between runs when schedule is 'custom'; ignored otherwise. */
  scheduleIntervalDays: number | null;
  /** Whose key the next run would use. Scheduled runs are strictly self-funded
   *  (the cron skips anything but 'own'), so any other source means a schedule
   *  set here silently never fires — the exact state this control exists to
   *  make visible instead of silent. */
  keySource: KeySource;
  providerLabel: string;
}) {
  const router = useRouter();
  const [schedule, setSchedule] = useState<Schedule>(saved);
  const initialInterval = savedIntervalDays ?? CUSTOM_INTERVAL_DEFAULT;
  // A string draft lets the user clear and replace the number without turning
  // the transient empty field into a one-day schedule.
  const [intervalDraft, setIntervalDraft] = useState(String(initialInterval));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalInput = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const confirmed = useRef({ schedule: saved, intervalDays: initialInterval });

  useEffect(() => {
    if (savingRef.current) return;
    const intervalDays = savedIntervalDays ?? CUSTOM_INTERVAL_DEFAULT;
    confirmed.current = { schedule: saved, intervalDays };
    setSchedule(saved);
    setIntervalDraft(String(intervalDays));
  }, [saved, savedIntervalDays]);

  async function save(next: Schedule, nextIntervalDays: number) {
    if (savingRef.current) return;
    const previous = confirmed.current;
    const unchanged =
      next === previous.schedule &&
      (next !== "custom" || nextIntervalDays === previous.intervalDays);

    setSchedule(next);
    if (next === "custom") setIntervalDraft(String(nextIntervalDays));
    if (unchanged) return;

    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/project/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schedule: next,
          // Only meaningful for 'custom' - the route nulls this column for
          // every other schedule, so a stale interval can't resurface later.
          intervalDays: next === "custom" ? nextIntervalDays : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        setSchedule(previous.schedule);
        setIntervalDraft(String(previous.intervalDays));
        setError(data?.error ?? "Couldn't save the schedule.");
        return;
      }
      confirmed.current = {
        schedule: next,
        intervalDays: next === "custom" ? nextIntervalDays : CUSTOM_INTERVAL_DEFAULT,
      };
      router.refresh();
    } catch {
      setSchedule(previous.schedule);
      setIntervalDraft(String(previous.intervalDays));
      setError("Network error, please try again.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function commitCustom() {
    if (savingRef.current || schedule !== "custom") return;
    const normalized = normalizeCustomInterval(
      intervalDraft,
      confirmed.current.intervalDays,
    );
    setIntervalDraft(String(normalized));
    void save("custom", normalized);
  }

  const scheduled = schedule !== "off";
  const intervalDays = normalizeCustomInterval(
    intervalDraft,
    confirmed.current.intervalDays,
  );
  // The cron runs own-key projects, and trial projects while the allowance
  // lasts ("cadence from the onset"). Everything else it skips — that's the
  // state worth shouting about.
  const willFire = keySource === "own" || keySource === "trial";

  return (
    <Card>
      <CardBody className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex min-w-0 items-start gap-3">
          <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-ink-faint" />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-ink">Scheduled reports</p>
            {!scheduled && (
              <p className="text-xs text-ink-faint">
                Run a report on a schedule (around 8:00 UTC) instead of by
                hand, and build a trend over time.
              </p>
            )}
            {scheduled && keySource === "own" && (
              <p className="text-xs text-ink-faint">
                Runs {scheduleLabel(schedule, intervalDays).toLowerCase()} around 8:00 UTC on your
                own key.
              </p>
            )}
            {scheduled && keySource === "trial" && (
              <p className="text-xs text-ink-faint">
                Runs {scheduleLabel(schedule, intervalDays).toLowerCase()} around 8:00 UTC on
                complimentary tokens while they last. Add your {providerLabel} key in{" "}
                <Link
                  href="/dashboard/settings"
                  className="text-terracotta-dark hover:text-terracotta"
                >
                  Settings
                </Link>{" "}
                to keep it going after that.
              </p>
            )}
            {/* The schedule is set but the cron will skip it. Without this line
                the skip has no surface at all: the cron's "skipped" lands only
                in its own JSON response and a span attribute. */}
            {scheduled && !willFire && (
              <p className="text-xs text-terracotta">
                This {scheduleLabel(schedule, intervalDays).toLowerCase()} schedule won&apos;t run
                {keySource === "exhausted"
                  ? ": your free runs are used up. "
                  : ": no usable key for your answer engine. "}
                Add your {providerLabel} key in{" "}
                <Link
                  href="/dashboard/settings"
                  className="text-terracotta-dark underline hover:text-terracotta"
                >
                  Settings
                </Link>{" "}
                to turn it {keySource === "exhausted" ? "back on" : "on"}.
              </p>
            )}
            {error && <p className="text-xs text-terracotta">{error}</p>}
          </div>
        </div>
        <div
          className="flex items-center gap-2"
          onBlur={(event) => {
            // Moving between the select and number input stays within one edit.
            // Commit only when focus leaves the whole control.
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            commitCustom();
          }}
        >
          <Select
            aria-label="Monitoring schedule"
            value={schedule}
            disabled={saving}
            onChange={(e) => {
              const next = e.target.value as Schedule;
              if (next === "custom") {
                setSchedule(next);
                setError(null);
                requestAnimationFrame(() => {
                  intervalInput.current?.focus();
                  intervalInput.current?.select();
                });
                return;
              }
              void save(next, intervalDays);
            }}
            // w-auto doesn't reliably grow a select styled with
            // appearance-none to fit its longest option; "Every N days" (the
            // 'custom' label) was clipped. Sized to the longest label plus
            // the arrow padding fieldBase reserves.
            className="w-auto min-w-[10rem]"
          >
            {SCHEDULES.map((s) => (
              <option key={s} value={s}>
                {SCHEDULE_LABELS[s]}
              </option>
            ))}
          </Select>
          {schedule === "custom" && (
            <Input
              ref={intervalInput}
              type="number"
              aria-label="Days between runs"
              min={CUSTOM_INTERVAL_MIN}
              max={CUSTOM_INTERVAL_MAX}
              step={1}
              value={intervalDraft}
              disabled={saving}
              onChange={(e) => setIntervalDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              className="w-16 bg-paper px-2 py-1.5"
            />
          )}
        </div>
      </CardBody>
    </Card>
  );
}

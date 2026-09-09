"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { Card, CardBody, Select } from "@/components/ui";
import {
  CUSTOM_INTERVAL_MAX,
  CUSTOM_INTERVAL_MIN,
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
  // Kept separately from `schedule` because picking 'custom' in the select and
  // typing its interval are two different edits, made in either order, and
  // only one of them should trigger the save.
  const [intervalDays, setIntervalDays] = useState<number>(savedIntervalDays ?? 14);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: Schedule, nextIntervalDays: number) {
    const previous = schedule;
    const previousIntervalDays = intervalDays;
    setSchedule(next);
    if (next === "custom") setIntervalDays(nextIntervalDays);
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
        setSchedule(previous);
        setIntervalDays(previousIntervalDays);
        setError(data?.error ?? "Couldn't save the schedule.");
        return;
      }
      router.refresh();
    } catch {
      setSchedule(previous);
      setIntervalDays(previousIntervalDays);
      setError("Network error, please try again.");
    } finally {
      setSaving(false);
    }
  }

  const scheduled = schedule !== "off";
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
        <div className="flex items-center gap-2">
          <Select
            aria-label="Monitoring schedule"
            value={schedule}
            disabled={saving}
            onChange={(e) => save(e.target.value as Schedule, intervalDays)}
            className="w-auto"
          >
            {SCHEDULES.map((s) => (
              <option key={s} value={s}>
                {SCHEDULE_LABELS[s]}
              </option>
            ))}
          </Select>
          {schedule === "custom" && (
            <input
              type="number"
              aria-label="Days between runs"
              min={CUSTOM_INTERVAL_MIN}
              max={CUSTOM_INTERVAL_MAX}
              value={intervalDays}
              disabled={saving}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next)) setIntervalDays(next);
              }}
              // Saved on blur, not per keystroke: typing "14" would otherwise
              // PATCH "1" first and schedule a daily run for a moment.
              onBlur={(e) => {
                const clamped = Math.min(
                  CUSTOM_INTERVAL_MAX,
                  Math.max(CUSTOM_INTERVAL_MIN, Number(e.target.value) || CUSTOM_INTERVAL_MIN),
                );
                save("custom", clamped);
              }}
              className="w-16 rounded border border-ink/15 bg-paper px-2 py-1.5 text-sm text-ink"
            />
          )}
        </div>
      </CardBody>
    </Card>
  );
}

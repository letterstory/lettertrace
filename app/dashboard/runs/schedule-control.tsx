"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { Card, CardBody, Select } from "@/components/ui";
import { SCHEDULE_LABELS } from "@/lib/utils";
import type { KeySource } from "@/lib/trial";
import type { Schedule } from "@/lib/types";

export function ScheduleControl({
  schedule: saved,
  keySource,
  providerLabel,
}: {
  schedule: Schedule;
  /** Whose key the next run would use. Scheduled runs are strictly self-funded
   *  (the cron skips anything but 'own'), so any other source means a schedule
   *  set here silently never fires — the exact state this control exists to
   *  make visible instead of silent. */
  keySource: KeySource;
  providerLabel: string;
}) {
  const router = useRouter();
  const [schedule, setSchedule] = useState<Schedule>(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: Schedule) {
    const previous = schedule;
    setSchedule(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/project/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        setSchedule(previous);
        setError(data?.error ?? "Couldn't save the schedule.");
        return;
      }
      router.refresh();
    } catch {
      setSchedule(previous);
      setError("Network error, please try again.");
    } finally {
      setSaving(false);
    }
  }

  const scheduled = schedule !== "off";
  // Trial users can press "Run monitor now", so canRun doesn't capture this —
  // only an own key lets the cron actually run the project.
  const willFire = keySource === "own";

  return (
    <Card>
      <CardBody className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex min-w-0 items-start gap-3">
          <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-ink-faint" />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-ink">Automatic runs</p>
            {!scheduled && (
              <p className="text-xs text-ink-faint">
                Run your prompts on a schedule — around 8:00 UTC — instead of by
                hand, and build a trend over time.
              </p>
            )}
            {scheduled && willFire && (
              <p className="text-xs text-ink-faint">
                Runs {schedule} around 8:00 UTC on your own key.
              </p>
            )}
            {/* The schedule is set but the cron will skip it. Without this line
                the skip has no surface at all: the cron's "skipped" lands only
                in its own JSON response and a span attribute. */}
            {scheduled && !willFire && (
              <p className="text-xs text-terracotta">
                Scheduled runs use your own key, so this {SCHEDULE_LABELS[schedule].toLowerCase()}{" "}
                schedule won&apos;t run yet. Add your {providerLabel} key in{" "}
                <Link
                  href="/dashboard/settings"
                  className="text-terracotta-dark underline hover:text-terracotta"
                >
                  Settings
                </Link>{" "}
                to turn it on.
              </p>
            )}
            {error && <p className="text-xs text-terracotta">{error}</p>}
          </div>
        </div>
        <Select
          aria-label="Monitoring schedule"
          value={schedule}
          disabled={saving}
          onChange={(e) => save(e.target.value as Schedule)}
          className="w-auto"
        >
          {(["off", "daily", "weekly"] as Schedule[]).map((s) => (
            <option key={s} value={s}>
              {SCHEDULE_LABELS[s]}
            </option>
          ))}
        </Select>
      </CardBody>
    </Card>
  );
}

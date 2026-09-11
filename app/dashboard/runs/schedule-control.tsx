"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardBody } from "@/components/ui";
import { scheduleLabel } from "@/lib/utils";
import { SchedulePicker, type ActiveSchedule } from "@/components/dashboard/schedule-picker";
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // There's no 'projects' column for "last active cadence" — a schema change
  // considered and deliberately dropped for this page — so the cadence to
  // restore on re-activation is remembered here in local state instead.
  // Resynced from the server whenever it reports an active schedule; left
  // alone while off, since 'off' carries no cadence of its own. A hard
  // reload while off still forgets, same limitation onboarding's cadence
  // step already has.
  const [rememberedCadence, setRememberedCadence] = useState<ActiveSchedule>(
    saved === "off" ? "daily" : saved,
  );
  const [rememberedIntervalDays, setRememberedIntervalDays] = useState<number | null>(
    saved === "custom" ? savedIntervalDays : null,
  );

  useEffect(() => {
    if (saved === "off") return;
    setRememberedCadence(saved);
    setRememberedIntervalDays(saved === "custom" ? savedIntervalDays : null);
  }, [saved, savedIntervalDays]);

  async function handleCommit(enabled: boolean, cadence: ActiveSchedule, intervalDays: number) {
    const schedule: Schedule = enabled ? cadence : "off";
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/project/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schedule,
          // Only meaningful for 'custom' - the route nulls this column for
          // every other schedule, so a stale interval can't resurface later.
          intervalDays: schedule === "custom" ? intervalDays : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        setError(data?.error ?? "Couldn't save the schedule.");
        return false;
      }
      if (enabled) {
        setRememberedCadence(cadence);
        setRememberedIntervalDays(cadence === "custom" ? intervalDays : null);
      }
      router.refresh();
      return true;
    } catch {
      setError("Network error, please try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  // The cron runs own-key projects, and trial projects while the allowance
  // lasts ("cadence from the onset"). Everything else it skips — that's the
  // state worth shouting about.
  const willFire = keySource === "own" || keySource === "trial";

  return (
    <Card>
      <CardBody className="p-5">
        <SchedulePicker
          header="Schedule a Report"
          switchAriaLabel="Automatic report schedule"
          enabled={saved !== "off"}
          cadence={rememberedCadence}
          intervalDays={rememberedIntervalDays}
          disabled={saving}
          onCommit={handleCommit}
          description={({ enabled, cadence, intervalDays }) => {
            const activeSchedule: Schedule = enabled ? cadence : "off";
            return (
              <>
                {!enabled && (
                  <p className="text-xs text-ink-faint">
                    Run a report on a schedule (around 8:00 UTC) instead of by
                    hand, and build a trend over time.
                  </p>
                )}
                {enabled && keySource === "own" && (
                  <p className="text-xs text-ink-faint">
                    Runs {scheduleLabel(activeSchedule, intervalDays).toLowerCase()} around 8:00 UTC
                    on your own key.
                  </p>
                )}
                {enabled && keySource === "trial" && (
                  <p className="text-xs text-ink-faint">
                    Runs {scheduleLabel(activeSchedule, intervalDays).toLowerCase()} around 8:00 UTC
                    on complimentary tokens while they last. Add your {providerLabel} key in{" "}
                    <Link
                      href="/dashboard/settings"
                      className="text-terracotta-dark hover:text-terracotta"
                    >
                      Settings
                    </Link>{" "}
                    to keep it going after that.
                  </p>
                )}
                {/* The schedule is set but the cron will skip it. Without this
                    line the skip has no surface at all: the cron's "skipped"
                    lands only in its own JSON response and a span attribute. */}
                {enabled && !willFire && (
                  <p className="text-xs text-terracotta">
                    This {scheduleLabel(activeSchedule, intervalDays).toLowerCase()} schedule won&apos;t run
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
                    so scheduled reports can run.
                  </p>
                )}
                {error && <p className="text-xs text-terracotta">{error}</p>}
              </>
            );
          }}
        />
      </CardBody>
    </Card>
  );
}

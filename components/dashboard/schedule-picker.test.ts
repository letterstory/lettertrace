import { describe, expect, it } from "vitest";
import { CUSTOM_INTERVAL_DEFAULT } from "@/lib/utils";
import {
  cadenceForSwitch,
  DEFAULT_CADENCE,
  resolveScheduleCommit,
} from "./schedule-picker";

const OFF_UNKNOWN = { enabled: false, cadence: null, intervalDays: CUSTOM_INTERVAL_DEFAULT };

describe("cadenceForSwitch", () => {
  it("resumes the cadence on screen", () => {
    expect(cadenceForSwitch("daily")).toBe("daily");
    expect(cadenceForSwitch("custom")).toBe("custom");
  });

  it("starts an un-chosen schedule at the default, which is not daily", () => {
    // The free trial is a lifetime allowance of runs; a daily default spends
    // it in a fortnight. If this ever goes back to daily, that is a product
    // decision and this assertion should be the thing that argues with it.
    expect(cadenceForSwitch(null)).toBe(DEFAULT_CADENCE);
    expect(DEFAULT_CADENCE).toBe("weekly");
  });
});

describe("resolveScheduleCommit", () => {
  it("turns the schedule on at the cadence that was clicked", () => {
    expect(
      resolveScheduleCommit(OFF_UNKNOWN, { enabled: true, cadence: "daily", intervalDays: 14 }),
    ).toEqual({
      enabled: true,
      cadence: "daily",
      intervalDays: CUSTOM_INTERVAL_DEFAULT,
      unchanged: false,
    });
  });

  it("carries the day count only for 'custom'", () => {
    const custom = resolveScheduleCommit(OFF_UNKNOWN, {
      enabled: true,
      cadence: "custom",
      intervalDays: 21,
    });
    expect(custom.intervalDays).toBe(21);

    // Weekly ignores the number rather than storing it, so going custom ->
    // weekly -> custom can't resurface a stale interval.
    const weekly = resolveScheduleCommit(OFF_UNKNOWN, {
      enabled: true,
      cadence: "weekly",
      intervalDays: 21,
    });
    expect(weekly.intervalDays).toBe(CUSTOM_INTERVAL_DEFAULT);
  });

  it("reports no change when the pill you clicked is the one already set", () => {
    const confirmed = { enabled: true, cadence: "weekly" as const, intervalDays: 14 };
    expect(
      resolveScheduleCommit(confirmed, { enabled: true, cadence: "weekly", intervalDays: 14 })
        .unchanged,
    ).toBe(true);
  });

  it("treats a different day count on the same cadence as a change", () => {
    const confirmed = { enabled: true, cadence: "custom" as const, intervalDays: 14 };
    expect(
      resolveScheduleCommit(confirmed, { enabled: true, cadence: "custom", intervalDays: 21 })
        .unchanged,
    ).toBe(false);
    expect(
      resolveScheduleCommit(confirmed, { enabled: true, cadence: "custom", intervalDays: 14 })
        .unchanged,
    ).toBe(true);
  });

  it("treats switching off as a change even when the cadence is untouched", () => {
    const confirmed = { enabled: true, cadence: "daily" as const, intervalDays: 14 };
    expect(
      resolveScheduleCommit(confirmed, { enabled: false, cadence: "daily", intervalDays: 14 })
        .unchanged,
    ).toBe(false);
  });

  it("never resumes at a cadence nobody picked", () => {
    // The whole off -> on path: nothing remembered, so the switch applies the
    // default rather than silently reinstating daily.
    const resumed = resolveScheduleCommit(OFF_UNKNOWN, {
      enabled: true,
      cadence: cadenceForSwitch(OFF_UNKNOWN.cadence),
      intervalDays: CUSTOM_INTERVAL_DEFAULT,
    });
    expect(resumed).toMatchObject({ enabled: true, cadence: "weekly", unchanged: false });
  });
});

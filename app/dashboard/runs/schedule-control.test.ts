import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Next injects the JSX runtime for app components; Vitest's node transform
// does not, so provide the same global before importing the component.
Object.assign(globalThis, { React });
const { ScheduleControl } = await import("./schedule-control");

describe("ScheduleControl", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("presses no pill and disables none while scheduling is off", () => {
    const html = renderToStaticMarkup(
      React.createElement(ScheduleControl, {
        schedule: "off",
        scheduleIntervalDays: null,
        lastRunAt: null,
        keySource: "own",
        providerLabel: "Claude",
      }),
    );

    expect(html).toContain("Schedule a Report");
    expect(html).toContain("Turn on");
    // The accessible name repeats the visible word, so speech input can act on
    // what it reads, and still names what the switch governs.
    expect(html).toContain(
      'role="switch" aria-checked="false" aria-label="Turn on: Automatic report schedule"',
    );
    // Nothing pressed: an off schedule stores no cadence, and showing "Run
    // daily" selected read as a choice the user never made — then turning the
    // switch on quietly scheduled daily.
    expect(html).not.toContain('aria-pressed="true"');
    // And the pills are live, because clicking one is how you turn it on.
    expect(html).not.toMatch(/aria-pressed="false" disabled=""/);
    for (const label of ["Run daily", "Run weekly", "Set a schedule"]) {
      expect(html).toContain(label);
    }
    // Nothing is coming, so the card does not invent a date.
    expect(html).not.toContain("Your next report is scheduled");
  });

  it("shows the saved day count beside an active custom schedule", () => {
    const html = renderToStaticMarkup(
      React.createElement(ScheduleControl, {
        schedule: "custom",
        scheduleIntervalDays: 21,
        lastRunAt: "2026-09-01T08:00:00Z",
        keySource: "trial",
        providerLabel: "Claude",
      }),
    );

    expect(html).toContain("Turn off");
    expect(html).toContain(
      'role="switch" aria-checked="true" aria-label="Turn off: Automatic report schedule"',
    );
    expect(html).toContain("Runs every 21 days");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Set a schedule/);
    expect(html).toContain('aria-label="Days between runs"');
    expect(html).toContain('value="21"');
    expect(html).toContain("every");
    expect(html).toContain("days");
  });

  it("names the next report date under an active schedule that will run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    const html = renderToStaticMarkup(
      React.createElement(ScheduleControl, {
        schedule: "weekly",
        scheduleIntervalDays: null,
        lastRunAt: "2026-09-22T08:06:30Z",
        keySource: "own",
        providerLabel: "Claude",
      }),
    );

    expect(html).toContain(
      "Your next report is scheduled for September 29, 2026, around 8:00 UTC.",
    );
  });

  it("does not promise a date when the cron will skip the schedule", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    const html = renderToStaticMarkup(
      React.createElement(ScheduleControl, {
        schedule: "weekly",
        scheduleIntervalDays: null,
        lastRunAt: "2026-09-22T08:06:30Z",
        keySource: "exhausted",
        providerLabel: "Claude",
      }),
    );

    expect(html).toContain("your free runs are used up");
    expect(html).not.toContain("Your next report is scheduled");
  });
});

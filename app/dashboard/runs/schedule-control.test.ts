import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Next injects the JSX runtime for app components; Vitest's node transform
// does not, so provide the same global before importing the component.
Object.assign(globalThis, { React });
const { ScheduleControl } = await import("./schedule-control");

describe("ScheduleControl", () => {
  it("presses no pill and disables none while scheduling is off", () => {
    const html = renderToStaticMarkup(
      React.createElement(ScheduleControl, {
        schedule: "off",
        scheduleIntervalDays: null,
        keySource: "own",
        providerLabel: "Claude",
      }),
    );

    expect(html).toContain("Schedule a Report");
    expect(html).toContain("Schedule off");
    expect(html).toContain('role="switch" aria-checked="false"');
    // Nothing pressed: an off schedule stores no cadence, and showing "Run
    // daily" selected read as a choice the user never made — then turning the
    // switch on quietly scheduled daily.
    expect(html).not.toContain('aria-pressed="true"');
    // And the pills are live, because clicking one is how you turn it on.
    expect(html).not.toMatch(/aria-pressed="false" disabled=""/);
    for (const label of ["Run daily", "Run weekly", "Set a schedule"]) {
      expect(html).toContain(label);
    }
  });

  it("shows the saved day count beside an active custom schedule", () => {
    const html = renderToStaticMarkup(
      React.createElement(ScheduleControl, {
        schedule: "custom",
        scheduleIntervalDays: 21,
        keySource: "trial",
        providerLabel: "Claude",
      }),
    );

    expect(html).toContain("Schedule on");
    expect(html).toContain('role="switch" aria-checked="true"');
    expect(html).toContain("Runs every 21 days");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Set a schedule/);
    expect(html).toContain('aria-label="Days between runs"');
    expect(html).toContain('value="21"');
    expect(html).toContain("every");
    expect(html).toContain("days");
  });
});

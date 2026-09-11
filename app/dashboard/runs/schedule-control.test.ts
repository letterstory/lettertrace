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
  it("defaults the disabled pill row to 'Run daily' while scheduling is off", () => {
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
    expect(html).toMatch(/aria-pressed="true" disabled=""[^>]*>Run daily/);
    expect(html).toContain("Run weekly");
    expect(html).toContain("Set a schedule");
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
    expect(html).toMatch(/aria-pressed="true"[^>]*>Set a schedule/);
    expect(html).toContain('aria-label="Days between runs"');
    expect(html).toContain('value="21"');
    expect(html).toContain("every");
    expect(html).toContain("days");
  });
});

import { describe, it, expect } from "vitest";
import {
  article,
  duration,
  isScheduleDue,
  resolveRedirectBase,
  safePath,
  SCHEDULE_LABELS,
  SCHEDULES,
  scheduleIntervalDays,
  scheduleLabel,
} from "@/lib/utils";

describe("resolveRedirectBase", () => {
  const PROD = "https://lettertrace.com";
  const LOCAL = "http://localhost:3000";

  // The outage this exists to prevent: NEXT_PUBLIC_SITE_URL left at localhost
  // in production sent every signed-in user to their own machine, where the
  // cookies just set on the real domain don't exist. Silent, and it looks
  // exactly like "sign-in doesn't work".
  it("ignores a loopback site URL when the request came from a real domain", () => {
    expect(resolveRedirectBase(LOCAL, PROD)).toBe(PROD);
    expect(resolveRedirectBase("http://127.0.0.1:3000", PROD)).toBe(PROD);
    expect(resolveRedirectBase("http://localhost", PROD)).toBe(PROD);
  });

  it("keeps a loopback site URL when it already agrees with the request", () => {
    expect(resolveRedirectBase(LOCAL, LOCAL)).toBe(LOCAL);
  });

  // The second outage: the port is part of the origin, so a dev server on any
  // port other than the configured one stamped the wrong `iss` on its OAuth
  // callback and every CLI login died on "Issuer mismatch" (RFC 9207 requires
  // the client to reject that). A loopback config value can never be the
  // deployment's public identity, so it must never override the real origin.
  it("defers to the actual origin for a loopback request on another port", () => {
    expect(resolveRedirectBase(LOCAL, "http://localhost:3100")).toBe("http://localhost:3100");
    expect(resolveRedirectBase(LOCAL, "http://localhost:3200")).toBe("http://localhost:3200");
    expect(resolveRedirectBase(LOCAL, "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it("keeps the configured value when the request origin is unusable", () => {
    expect(resolveRedirectBase(LOCAL, "")).toBe(LOCAL);
  });

  it("prefers the configured URL over the request origin behind a proxy", () => {
    // The case the configured value exists for: Vercel's internal host.
    expect(resolveRedirectBase(PROD, "https://lettertrace-abc123.vercel.app")).toBe(PROD);
  });

  it("falls back to the origin when nothing is configured", () => {
    expect(resolveRedirectBase(undefined, PROD)).toBe(PROD);
    expect(resolveRedirectBase(null, PROD)).toBe(PROD);
    expect(resolveRedirectBase("", PROD)).toBe(PROD);
    expect(resolveRedirectBase("   ", PROD)).toBe(PROD);
  });

  it("falls back to the origin rather than breaking on a malformed value", () => {
    expect(resolveRedirectBase("lettertrace.com", PROD)).toBe(PROD); // no scheme
    expect(resolveRedirectBase("not a url", PROD)).toBe(PROD);
  });

  it("tolerates surrounding whitespace in the env var", () => {
    expect(resolveRedirectBase(`  ${PROD}  `, "https://internal.vercel.app")).toBe(PROD);
  });

  it("treats ::1 as loopback too", () => {
    expect(resolveRedirectBase("http://[::1]:3000", PROD)).toBe(PROD);
  });

  it("does not mistake a hostname that merely contains 'localhost'", () => {
    const lookalike = "https://localhost.evil.com";
    expect(resolveRedirectBase(lookalike, PROD)).toBe(lookalike);
  });
});

describe("safePath", () => {
  it("allows same-origin paths", () => {
    expect(safePath("/dashboard/runs")).toBe("/dashboard/runs");
  });

  it("rejects protocol-relative and backslash open-redirect tricks", () => {
    expect(safePath("//evil.com")).toBe("/dashboard");
    expect(safePath("/\\evil.com")).toBe("/dashboard");
    expect(safePath("https://evil.com")).toBe("/dashboard");
  });

  it("falls back for non-strings", () => {
    expect(safePath(null)).toBe("/dashboard");
    expect(safePath(undefined)).toBe("/dashboard");
    expect(safePath("", "/somewhere")).toBe("/somewhere");
  });
});

describe("article", () => {
  // Every provider label we ship, since these are what the copy interpolates.
  it("matches the article to each provider label", () => {
    expect(article("Anthropic (Claude)")).toBe("an");
    expect(article("OpenAI (ChatGPT)")).toBe("an");
    expect(article("Google (Gemini)")).toBe("a");
    expect(article("Perplexity (Sonar)")).toBe("a");
  });

  it("ignores case and leading space", () => {
    expect(article("  openai")).toBe("an");
    expect(article("GOOGLE")).toBe("a");
  });
});

describe("duration", () => {
  it("picks one unit and rounds to it", () => {
    expect(duration(30_000)).toBe("<1m");
    expect(duration(9 * 60_000)).toBe("9m");
    expect(duration(3 * 3_600_000)).toBe("3h");
    expect(duration(5 * 86_400_000)).toBe("5d");
    expect(duration(120 * 86_400_000)).toBe("4mo");
  });

  it("crosses over at 48h and 60d rather than at the unit boundary", () => {
    // 36 hours is more legibly "36h" than "2d"; 47 days than "2mo".
    expect(duration(36 * 3_600_000)).toBe("36h");
    expect(duration(47 * 86_400_000)).toBe("47d");
  });

  it("renders an em dash for nothing to measure", () => {
    expect(duration(null)).toBe("—");
    expect(duration(-1)).toBe("—");
    expect(duration(Number.NaN)).toBe("—");
  });
});

describe("SCHEDULES", () => {
  // SCHEDULES used to be a separate array, hand-copied into several files. A
  // schedule value added to the Schedule union but missed in one of those
  // copies would validate on some surfaces and 400 on others, or reach the
  // database with no cron branch that knows how to run it. Deriving it from
  // SCHEDULE_LABELS instead means the only way to add a schedule is to add
  // its label, and every surface picks it up from there.
  it("is derived from SCHEDULE_LABELS, not written out separately", () => {
    expect(SCHEDULES).toEqual(Object.keys(SCHEDULE_LABELS));
  });

  it("lists exactly the four schedules in use, in display order", () => {
    expect(SCHEDULES).toEqual(["off", "daily", "weekly", "custom"]);
  });
});

describe("scheduleIntervalDays", () => {
  it("reads the interval out of the schedule's own name", () => {
    expect(scheduleIntervalDays("off", null)).toBeNull();
    expect(scheduleIntervalDays("daily", null)).toBe(1);
    expect(scheduleIntervalDays("weekly", null)).toBe(7);
  });

  it("only 'custom' reads the stored number", () => {
    expect(scheduleIntervalDays("custom", 14)).toBe(14);
    // The named schedules ignore a stray interval rather than preferring it.
    expect(scheduleIntervalDays("weekly", 3)).toBe(7);
  });

  // The database refuses to store this row (projects_custom_needs_interval),
  // so null here means a bug upstream, not a case to paper over with a default.
  it("returns null for 'custom' with no interval", () => {
    expect(scheduleIntervalDays("custom", null)).toBeNull();
  });
});

describe("scheduleLabel", () => {
  it("names the real interval for 'custom'", () => {
    expect(scheduleLabel("custom", 14)).toBe("Every 14 days");
    expect(scheduleLabel("custom", 1)).toBe("Every 1 days");
  });

  it("falls back to the label when there's no number to name", () => {
    expect(scheduleLabel("custom", null)).toBe("Every N days");
  });

  it("passes the other schedules through to their labels", () => {
    expect(scheduleLabel("off", null)).toBe("Manual only");
    expect(scheduleLabel("daily", null)).toBe("Daily");
    expect(scheduleLabel("weekly", 3)).toBe("Weekly");
  });
});

describe("isScheduleDue", () => {
  const NOW = new Date("2026-09-09T08:00:00Z").getTime();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  const project = (
    schedule: "off" | "daily" | "weekly" | "custom",
    last_run_at: string | null,
    schedule_interval_days: number | null = null,
  ) => ({ schedule, last_run_at, schedule_interval_days });

  it("never fires an 'off' schedule, however long it has been", () => {
    expect(isScheduleDue(project("off", null), NOW)).toBe(false);
    expect(isScheduleDue(project("off", ago(30 * DAY)), NOW)).toBe(false);
  });

  it("is due when a scheduled project has never run", () => {
    expect(isScheduleDue(project("daily", null), NOW)).toBe(true);
    expect(isScheduleDue(project("custom", null, 30), NOW)).toBe(true);
  });

  it("waits out the interval it was given", () => {
    expect(isScheduleDue(project("daily", ago(2 * HOUR)), NOW)).toBe(false);
    expect(isScheduleDue(project("weekly", ago(3 * DAY)), NOW)).toBe(false);
    expect(isScheduleDue(project("weekly", ago(7 * DAY)), NOW)).toBe(true);
    expect(isScheduleDue(project("custom", ago(2 * DAY), 3), NOW)).toBe(false);
    expect(isScheduleDue(project("custom", ago(3 * DAY), 3), NOW)).toBe(true);
  });

  // The bug the grace window fixes: last_run_at is stamped at run FINISH, so a
  // run that took a few minutes is that many minutes short of a full interval
  // at the next 08:00 tick — it missed that tick, then missed the day after too
  // because last_run_at hadn't moved. Six hours is well under the 24h tick
  // spacing, so it can only pull a due date earlier, never fire twice.
  it("still fires a daily schedule whose last run finished just under a day ago", () => {
    expect(isScheduleDue(project("daily", ago(DAY - 5 * 60 * 1000)), NOW)).toBe(true);
    expect(isScheduleDue(project("weekly", ago(7 * DAY - 20 * 60 * 1000)), NOW)).toBe(true);
  });

  it("does not let the grace window fire the same interval twice", () => {
    // A run that finished at this tick must not be due again 2h later; the
    // grace only reaches back 6h from a full interval, not into one.
    expect(isScheduleDue(project("daily", ago(HOUR)), NOW)).toBe(false);
    expect(isScheduleDue(project("daily", ago(6 * HOUR)), NOW)).toBe(false);
    expect(isScheduleDue(project("daily", ago(18 * HOUR)), NOW)).toBe(true);
  });

  it("refuses a 'custom' row with no interval rather than guessing one", () => {
    expect(isScheduleDue(project("custom", ago(90 * DAY), null), NOW)).toBe(false);
  });
});

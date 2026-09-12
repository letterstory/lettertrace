import { describe, it, expect } from "vitest";
import {
  article,
  CUSTOM_INTERVAL_DEFAULT,
  duration,
  isScheduleDue,
  normalizeCustomInterval,
  parseCustomInterval,
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

describe("custom interval input", () => {
  it("strictly accepts only whole numeric days inside the API range", () => {
    expect(parseCustomInterval(1)).toBe(1);
    expect(parseCustomInterval(90)).toBe(90);
    expect(parseCustomInterval(14)).toBe(14);
  });

  it("rejects missing, coerced, fractional, non-finite, and out-of-range values", () => {
    for (const value of [undefined, null, "14", "", 1.5, 0, -1, 91, NaN, Infinity]) {
      expect(parseCustomInterval(value)).toBeNull();
    }
  });

  it("normalises editable drafts without turning an empty field into one day", () => {
    expect(normalizeCustomInterval("", 30)).toBe(30);
    expect(normalizeCustomInterval("nope", 30)).toBe(30);
    expect(normalizeCustomInterval("1.9", 30)).toBe(1);
    expect(normalizeCustomInterval("0", 30)).toBe(1);
    expect(normalizeCustomInterval("120", 30)).toBe(90);
    expect(normalizeCustomInterval("14")).toBe(CUSTOM_INTERVAL_DEFAULT);
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

  // The cron reads the clock once before a sequential sweep
  // (app/api/cron/run/route.ts), so a run starts minutes after the `now` the
  // NEXT tick is judged against; an exact 24h check was short by the
  // project's queue position and halved every daily project's cadence except
  // the first in the sweep. Day granularity fixes this without a grace
  // constant: whatever time a project's run started, it's due again the
  // moment the calendar has turned over `intervalDays` times.
  it("fires at the next day's tick however late in the sweep the last run started", () => {
    expect(isScheduleDue(project("daily", "2026-09-08T08:06:30Z"), NOW)).toBe(true);
    expect(isScheduleDue(project("daily", "2026-09-08T23:59:00Z"), NOW)).toBe(true);
    expect(isScheduleDue(project("weekly", "2026-09-02T08:06:30Z"), NOW)).toBe(true);
    expect(isScheduleDue(project("custom", "2026-09-06T08:06:30Z", 3), NOW)).toBe(true);
  });

  it("cannot fire the same schedule twice in one UTC day", () => {
    expect(isScheduleDue(project("daily", "2026-09-09T00:00:00Z"), NOW)).toBe(false);
    expect(isScheduleDue(project("daily", "2026-09-09T08:00:00Z"), NOW)).toBe(false);
  });

  it("counts the day boundary crossed, not the hours elapsed", () => {
    expect(isScheduleDue(project("weekly", "2026-09-03T00:01:00Z"), NOW)).toBe(false);
    expect(isScheduleDue(project("custom", "2026-09-07T23:59:00Z", 3), NOW)).toBe(false);
  });

  it("refuses a 'custom' row with no interval rather than guessing one", () => {
    expect(isScheduleDue(project("custom", ago(90 * DAY), null), NOW)).toBe(false);
  });
});

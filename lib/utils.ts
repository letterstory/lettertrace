import type { Project, Schedule } from "@/lib/types";

// Tiny className combiner (no external deps). Filters falsy, joins with spaces.
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// Percentage formatter: 0.4231 -> "42%"
export function pct(value: number, digits = 0): string {
  if (!isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(digits)}%`;
}

// Short relative-time string, e.g. "3h ago".
export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * A span of time as a rounded, single-unit phrase: "3d", "14h", "6m".
 *
 * For durations that are ANSWERS rather than timestamps — how long something
 * took — where timeAgo's "ago" would be wrong and a second decimal would be
 * false precision. One unit only: a median of "2d 7h 14m" reads as a
 * measurement of something it isn't.
 */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return "<1m";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 60) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * The absolute base to build post-auth redirects and OAuth `iss` stamps on.
 *
 * Prefers the configured site URL, because behind a proxy the origin parsed off
 * the request can be the internal deployment host rather than the public
 * domain. It falls back to the request origin when the configured value is
 * unset or unparseable — and, more importantly, whenever it points at loopback.
 *
 * A loopback value can never be the deployment's public identity, so it tells
 * us nothing the request origin doesn't already say. When the two disagree it
 * does active harm, in two ways we have both actually shipped:
 *
 *   - NEXT_PUBLIC_SITE_URL left at http://localhost:3000 in production. Every
 *     OAuth sign-in exchanged its code, set cookies on the real domain, and
 *     then redirected the user to their own machine, where those cookies don't
 *     exist. It presents as "signing in silently dumps me back on the login
 *     page", with no error anywhere.
 *   - The same value against a dev server on any other port. The port is part
 *     of the origin, so a server on :3100 stamped `iss: http://localhost:3000`
 *     and every CLI login died on "Issuer mismatch" (RFC 9207 requires the
 *     client to reject exactly that).
 *
 * Hence: loopback never overrides the origin. A deploy, or a second dev server,
 * should simply not be able to do either of those.
 */
export function resolveRedirectBase(
  configured: string | null | undefined,
  origin: string,
): string {
  const value = typeof configured === "string" ? configured.trim() : "";
  if (!value) return origin;
  try {
    new URL(value);
  } catch {
    return origin; // malformed env var shouldn't break sign-in
  }
  // `origin` is empty only when the request URL itself was unparseable; in that
  // case even a loopback configured value beats returning nothing.
  if (isLoopback(value) && origin) return origin;
  return value;
}

// Guard against open redirects: only allow a same-origin path target.
// Rejects protocol-relative ("//evil.com") and backslash ("/\\evil.com") tricks.
export function safePath(
  next: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (typeof next !== "string") return fallback;
  return /^\/(?![/\\])/.test(next) ? next : fallback;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "n/a";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * "a" or "an" for a following word. Provider labels are user-visible and vary
 * ("OpenAI (ChatGPT)" vs "Google (Gemini)"), so the copy that names them can't
 * hardcode the article — "Add a OpenAI key" reads as a typo in the exact
 * message that's asking someone to go and do something.
 *
 * Vowel-letter test only: these are product names, not arbitrary prose, and
 * none of the ones we ship hit the awkward cases (a "user", an "hour").
 */
export function article(word: string): "a" | "an" {
  return /^[aeiou]/i.test(word.trim()) ? "an" : "a";
}

/** The one wording of each schedule option, shared by every surface that
 *  offers the setting (Settings form, Runs page, onboarding) so the same
 *  choice can't be called two different things. Order here is display order:
 *  off first as the baseline, then increasing interval, 'custom' last as the
 *  pick-your-own-number escape hatch. */
export const SCHEDULE_LABELS: Record<Schedule, string> = {
  off: "Manual only",
  daily: "Daily",
  weekly: "Weekly",
  custom: "Every N days",
};

// Derived from the labels rather than written out again: this used to be a
// separate hand-copied array in four different files, which is exactly the
// shape of bug this repo's own conventions warn about — a schedule value
// added to the union but missed in one of those copies would validate on some
// surfaces and 400 on others, or reach the database with no cron branch that
// knows how to run it.
export const SCHEDULES = Object.keys(SCHEDULE_LABELS) as Schedule[];

// 0 would make isScheduleDue() true on every cron tick; a project should
// re-pick a preset (or 90+ days) rather than lean on an unbounded custom
// interval that reads as scheduled and effectively never fires.
export const CUSTOM_INTERVAL_MIN = 1;
export const CUSTOM_INTERVAL_MAX = 90;

/**
 * Days between runs, or null when nothing is scheduled. The single place a
 * schedule becomes a duration, so the cron's due-check and every bit of UI
 * copy that names an interval read the same arithmetic.
 *
 * 'custom' is the only schedule whose interval isn't implied by its own name,
 * so it's the only one that reads `intervalDays` — and it MUST have one: a
 * 'custom' row with a null interval is rejected at the database (see
 * projects_custom_needs_interval in supabase/schema.sql), so falling back to
 * 1 here would only mask a bug that should already be impossible.
 */
export function scheduleIntervalDays(
  schedule: Schedule,
  intervalDays: number | null,
): number | null {
  switch (schedule) {
    case "off":
      return null;
    case "daily":
      return 1;
    case "weekly":
      return 7;
    case "custom":
      return intervalDays;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// last_run_at is stamped at run FINISH (lib/engine.ts), not at the tick that
// started it, so a run that took even a few minutes is that many minutes
// short of a full interval at the next 08:00 tick - and misses it, then misses
// the day after too since last_run_at still hasn't moved. Six hours is well
// under a day (the cron's tick spacing), so this can only ever pull a due
// date earlier - it can never make the same interval fire twice in one cycle.
const SCHEDULE_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * Whether a project's schedule has come due, as of `now`. The cron's whole
 * due-check, pulled out of app/api/cron/run/route.ts so it's a pure function
 * this repo's node-env tests can call directly — that route imports
 * lib/supabase/server, which pulls in React's cache() and can't be imported
 * outside a Next.js runtime.
 */
export function isScheduleDue(
  project: Pick<Project, "schedule" | "schedule_interval_days" | "last_run_at">,
  now: number,
): boolean {
  if (project.schedule === "off") return false;
  if (!project.last_run_at) return true;
  const intervalDays = scheduleIntervalDays(project.schedule, project.schedule_interval_days);
  // Only reachable for a 'custom' row with a null interval, which the
  // database itself refuses to store (projects_custom_needs_interval) - this
  // is a belt on top of that suspenders, not the primary guard.
  if (!intervalDays) return false;
  const last = new Date(project.last_run_at).getTime();
  return now - last >= intervalDays * DAY_MS - SCHEDULE_GRACE_MS;
}

/** SCHEDULE_LABELS plus the actual number for 'custom' (e.g. "Every 14 days"),
 *  since "Every N days" on its own names a shape, not a schedule. */
export function scheduleLabel(schedule: Schedule, intervalDays: number | null): string {
  if (schedule === "custom" && intervalDays) return `Every ${intervalDays} days`;
  return SCHEDULE_LABELS[schedule];
}

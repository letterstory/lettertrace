import type { Schedule } from "@/lib/types";

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
 *  offers the setting (Settings form, Runs page) so the same choice can't be
 *  called two different things. */
export const SCHEDULE_LABELS: Record<Schedule, string> = {
  off: "Manual only",
  daily: "Daily",
  weekly: "Weekly",
};

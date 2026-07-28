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

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * The absolute base to build post-auth redirects on.
 *
 * Prefers the configured site URL, because behind a proxy the origin parsed off
 * the request can be the internal deployment host rather than the public
 * domain. Two cases fall back to the request origin instead:
 *
 *   - the configured value is unset or unparseable
 *   - it points at loopback while the request didn't
 *
 * That second case is a real outage we shipped: NEXT_PUBLIC_SITE_URL was left
 * at http://localhost:3000 in production, so every OAuth sign-in exchanged its
 * code correctly, set cookies on the real domain, and then redirected the user
 * to their own machine — where those cookies don't exist. It presents as
 * "signing in silently dumps me back on the login page" with no error anywhere,
 * and a deploy should simply not be able to do it.
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
  if (isLoopback(value) && !isLoopback(origin)) return origin;
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

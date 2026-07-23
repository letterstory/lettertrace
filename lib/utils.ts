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

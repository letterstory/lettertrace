/**
 * The time windows the /admin pages filter by.
 *
 * Deliberately dependency-free — it imports nothing at all. Two things need
 * that: lib/conversions.ts and lib/growth.ts pull in the service-role client
 * and must never reach a client bundle, while the dropdown that offers these
 * options IS a client component. Keeping the vocabulary here lets both sides
 * name the same windows without either dragging the other across the boundary.
 *
 * One shared list rather than one per page, because two admin pages offering
 * "last 7 days" and "past week" as separate ideas is how a dashboard stops
 * being readable.
 */

export type Period = "7d" | "30d" | "ytd" | "all";

export function isPeriod(value: unknown): value is Period {
  return value === "7d" || value === "30d" || value === "ytd" || value === "all";
}

const DAY_MS = 86_400_000;

/** When the period opens, as a ms timestamp — null means all-time. YTD is
 *  Jan 1 UTC, matching the UTC day-bucketing everywhere else on /admin. */
export function periodStart(period: Period, now: number): number | null {
  switch (period) {
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "ytd":
      return Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
    case "all":
      return null;
  }
}

/** The dropdown's options. Order is oldest-window-last, so the list reads as
 *  widening rather than as an arbitrary set. */
export const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "ytd", label: "Year to date" },
  { value: "all", label: "All time" },
];

/** The label as it reads mid-sentence in a card hint ("… · last 7 days"). */
export function periodLabel(period: Period): string {
  return (PERIOD_OPTIONS.find((o) => o.value === period)?.label ?? period).toLowerCase();
}

/** Read a period out of a searchParams bag, falling back when it's absent or
 *  junk — an unknown ?p= must render the default page, never throw. */
export function periodFrom(
  raw: string | string[] | undefined,
  fallback: Period = "30d",
): Period {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isPeriod(value) ? value : fallback;
}

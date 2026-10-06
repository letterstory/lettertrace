import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

/**
 * The "vs 18 the previous 30 days" line under an /admin stat card.
 *
 * The previous figure is always printed in full, because a bare "+12%" with no
 * base is how a dashboard starts flattering itself. The change beside it is in
 * percent for counts and in POINTS for figures that are already percentages —
 * 2% → 3% is "+1 pt", not "+50%". No change is drawn when either side is
 * missing, or when the base is zero ("up from nothing" is not a percentage).
 *
 * Tone follows `better`: which way is good news for this figure. "neutral"
 * for figures where neither direction is (an average cadence, a destination).
 */
export function VsPrevious({
  current,
  previous,
  display,
  phrase,
  unit = "count",
  better = "up",
}: {
  /** This window's figure, null when the card shows "—". */
  current: number | null;
  /** The previous window's figure, null when it had none. */
  previous: number | null;
  /** How the previous figure reads, already formatted ("18", "2.4%", "3d"). */
  display: string;
  /** "the previous 30 days", "on 2026-09-06". */
  phrase: string;
  unit?: "count" | "points";
  better?: "up" | "down" | "neutral";
}) {
  let change: string | null = null;
  let direction: "up" | "down" | "flat" = "flat";
  if (current !== null && previous !== null) {
    const diff = current - previous;
    direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
    if (unit === "points") {
      const pts = Math.round(diff * 10) / 10;
      change = diff === 0 ? "no change" : `${pts > 0 ? "+" : ""}${pts} pt${Math.abs(pts) === 1 ? "" : "s"}`;
    } else if (previous > 0) {
      const pct = Math.round((diff / previous) * 100);
      // Past ten-fold a percentage stops being readable (17m → 8d is
      // "+69814%"), so say it as a multiple instead.
      change =
        diff === 0
          ? "no change"
          : pct >= 1000
            ? `${Math.round(current / previous)}×`
            : `${pct > 0 ? "+" : ""}${pct}%`;
    } else if (diff === 0) {
      change = "no change";
    }
  }

  const good =
    better === "neutral" || direction === "flat" ? null : (direction === better) as boolean;
  const tone =
    good === null ? "text-ink-soft" : good ? "text-teal-dark" : "text-terracotta-dark";
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;

  return (
    <p className="flex items-baseline gap-1.5 text-xs text-ink-faint">
      {change !== null && (
        <span className={`inline-flex shrink-0 items-center gap-0.5 self-center whitespace-nowrap font-medium tabular-nums ${tone}`}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {change}
        </span>
      )}
      <span className="min-w-0">
        vs <span className="tabular-nums text-ink-soft">{display}</span> {phrase}
      </span>
    </p>
  );
}

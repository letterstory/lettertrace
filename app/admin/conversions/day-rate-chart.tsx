"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/**
 * A percentage per day, drawn as one filled line, read by moving along it.
 *
 * The numbers used to live in native <title> tooltips: they waited half a
 * second, floated over the chart they were describing, and covered the very
 * marks you were pointing at. So the readout is INLINE instead — one line
 * directly under the chart that swaps to the day you are on and swaps back
 * when you leave, plus a guide and a dot marking which day that is. Nothing
 * overlaps the data, and nothing appears on a delay.
 *
 * The line is SVG (stretched, so a whole month fits) but the guide and dot are
 * HTML positioned in percentages on top of it: preserveAspectRatio="none"
 * scales x and y differently, which would squash a real <circle> into an
 * ellipse of an aspect ratio that changes with the browser window.
 *
 * Points arrive already filtered of their null days: a day with nothing to
 * divide by is a gap in the data, and interpolating across it would invent a
 * number. `tint` is a color token name — both charts on this page are the same
 * shape and differ only in hue.
 */

export interface DayRatePoint {
  day: string;
  rate: number;
  /** The sentence shown under the chart while this day is the one being read. */
  detail: string;
}

const W = 600;
const H = 110;
const PAD_TOP = 8;
/** Where 0% sits, leaving the line room to be seen when it rests there. */
const BASE = H - 4;

export function DayRateChart({
  points,
  tint,
  ariaLabel,
  caption,
}: {
  points: DayRatePoint[];
  tint: string;
  ariaLabel: string;
  /** What the readout says when nobody is pointing at a day — the summary of
   *  the whole series. */
  caption: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  if (points.length === 0) return null;

  const max = Math.max(0.1, ...points.map((p) => p.rate));
  const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (rate: number) => BASE - (rate / max) * (BASE - PAD_TOP);
  // One point can't make a line, so it becomes a flat one edge to edge — and
  // the fill reuses these same coordinates so it always sits under the line.
  const linePoints =
    points.length === 1
      ? [`0,${y(points[0].rate).toFixed(1)}`, `${W},${y(points[0].rate).toFixed(1)}`]
      : points.map((p, i) => `${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`);
  const line = linePoints.join(" ");

  /** Nearest day to a screen x. Points are evenly spaced by index, so this is
   *  a fraction of the width and needs none of the SVG's own geometry. */
  function read(clientX: number) {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const fraction = (clientX - rect.left) / rect.width;
    const nearest = Math.round(fraction * (points.length - 1));
    setActive(Math.min(points.length - 1, Math.max(0, nearest)));
  }

  function step(event: KeyboardEvent) {
    const keys: Record<string, number | undefined> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      Home: -points.length,
      End: points.length,
    };
    if (event.key === "Escape") {
      setActive(null);
      return;
    }
    const delta = keys[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    // Arriving by keyboard starts at the latest day, which is the one the
    // caption is already talking about.
    const from = active ?? points.length - 1;
    setActive(Math.min(points.length - 1, Math.max(0, from + delta)));
  }

  const current = active === null ? null : points[active];
  const markerLeft = current === null ? 0 : (x(active as number) / W) * 100;
  const markerTop = current === null ? 0 : (y(current.rate) / H) * 100;

  return (
    <div className="mt-3">
      <div
        ref={frame}
        tabIndex={0}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={(event: PointerEvent<HTMLDivElement>) => read(event.clientX)}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={step}
        className="relative touch-none rounded-sm outline-none ring-offset-2 ring-offset-surface focus-visible:ring-1 focus-visible:ring-ink/30"
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-36 w-full"
          aria-hidden
        >
          {/* Baseline at 0% — the one recessive gridline this needs. */}
          <line
            x1={0}
            y1={BASE}
            x2={W}
            y2={BASE}
            style={{ stroke: "rgb(var(--c-ink) / 0.12)", strokeWidth: 1 }}
            vectorEffect="non-scaling-stroke"
          />
          <polygon
            points={`0,${BASE} ${line} ${W},${BASE}`}
            style={{ fill: `rgb(var(--c-${tint}) / 0.12)` }}
          />
          <polyline
            points={line}
            style={{ fill: "none", stroke: `rgb(var(--c-${tint}))`, strokeWidth: 2 }}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {current && (
          <>
            {/* Guide down to the baseline, and the dot on the line itself. */}
            <span
              aria-hidden
              className="pointer-events-none absolute w-px bg-ink/20"
              style={{
                left: `${markerLeft}%`,
                top: `${(PAD_TOP / H) * 100}%`,
                bottom: `${((H - BASE) / H) * 100}%`,
              }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-surface"
              style={{
                left: `${markerLeft}%`,
                top: `${markerTop}%`,
                backgroundColor: `rgb(var(--c-${tint}))`,
              }}
            />
          </>
        )}
      </div>

      {/* One fixed-height line so swapping the summary for a day's numbers
          never nudges the rest of the card, and polite so a screen reader
          hears the day it lands on rather than every day it passes over. */}
      <p
        aria-live="polite"
        className="mt-3 flex min-h-[2.25rem] items-start text-xs tabular-nums text-ink-faint"
      >
        {current ? (
          <span className="text-ink-soft">{current.detail}</span>
        ) : (
          <span>{caption}</span>
        )}
      </p>
    </div>
  );
}

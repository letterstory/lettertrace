"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { EVENTS, SHARE, WEEKS, point, ribbonEdge, ribbonPath, stack, type Box } from "./series";
import { useCompact } from "./use-compact";

// Share of voice as a part-to-whole: every week's answers split 100% between
// the brand and its competitors, stacked with the brand on the baseline so
// its growth reads against a fixed edge. Bands reveal left to right when the
// chart scrolls into view; hovering scrubs a crosshair; hovering a legend
// chip spotlights its band; pins mark what moved the line. Illustrative data.

const WIDE: Box = { w: 1000, h: 400, max: 100, padX: 44, padR: 150, padY: 14 };
// Phones: no right-edge labels (the legend above carries identity) so the
// bands get the full width.
const COMPACT: Box = { w: 360, h: 300, max: 100, padX: 34, padR: 6, padY: 14 };
const TOPS = stack(SHARE);
const GAP = 6; // px between ribbons

// Ribbon fills: translucent, brightest at the top edge and fading down, so the
// chart reads as light rather than blocks. The brand is a little richer.
const FILL: Record<string, [number, number]> = {
  acme: [0.62, 0.16],
  notion: [0.4, 0.07],
  linear: [0.36, 0.06],
  others: [0.16, 0.03],
};
const ZERO = SHARE[0].values.map(() => 0);

export function TraceChart() {
  const wrap = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const [week, setWeek] = useState<number | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const compact = useCompact();
  const BOX = compact ? COMPACT : WIDE;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOn(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setOn(true);
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const plotL = BOX.padX!;
  const plotR = BOX.w - BOX.padR!;
  const top = BOX.padY!;
  const base = BOX.h - BOX.padY!;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * BOX.w;
    const i = Math.round(((x - plotL) / (plotR - plotL)) * (WEEKS - 1));
    setWeek(Math.min(WEEKS - 1, Math.max(0, i)));
  };

  const [cx] = week === null ? [0] : point(week, 0, WEEKS, BOX);
  const event = week === null ? undefined : EVENTS.find((ev) => ev.week === week);
  const dim = (key: string) => (focus && focus !== key ? 0.22 : 1);

  return (
    <section id="trace" className="relative overflow-hidden">
      <div className="mx-auto max-w-6xl px-5 py-24">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <p className="mono-eyebrow">share of voice</p>
            <h2 className="mt-3 text-4xl font-normal tracking-tight text-ink sm:text-6xl">
              Every run is a <em className="italic text-terracotta-dark">datapoint</em>.
            </h2>
            <p className="mt-4 text-lg text-ink-soft">
              Every answer in your category, split between you and the brands you track. Watch
              your share grow, and see what moved it.
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">acme, 12 weeks</p>
            <p className="mt-1 font-serif text-4xl text-ink">
              22% <span className="text-ink-faint">→</span> 41%
            </p>
            <p className="font-mono text-xs text-mint-ink">▲ +19 pts share of voice</p>
          </div>
        </div>

        {/* Legend: always present; hover or focus a chip to spotlight its band. */}
        <ul className="mt-10 flex flex-wrap gap-2" onMouseLeave={() => setFocus(null)}>
          {SHARE.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                onMouseEnter={() => setFocus(s.key)}
                onFocus={() => setFocus(s.key)}
                onBlur={() => setFocus(null)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition",
                  focus === s.key ? "border-ink/40 text-ink" : "border-ink/15 text-ink-soft hover:text-ink",
                )}
              >
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </button>
            </li>
          ))}
        </ul>

        <div ref={wrap} className="relative mt-5 select-none rounded-2xl border border-ink/[0.07] bg-[radial-gradient(ellipse_80%_70%_at_30%_100%,rgb(var(--c-chart-1)/0.07),transparent_70%)] p-3 sm:p-6">
          <svg viewBox={`0 0 ${BOX.w} ${BOX.h + 24}`} className="h-auto w-full overflow-visible" role="img" aria-label="Share of voice, stacked to 100% over twelve weeks. Acme grows from 22% to 41%; Notion falls from 38% to 28%; Linear from 24% to 19%; others from 16% to 12%.">
            <defs>
              {SHARE.map((s) => (
                <linearGradient key={s.key} id={`band-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" style={{ stopColor: s.color, stopOpacity: FILL[s.key][0] }} />
                  <stop offset="100%" style={{ stopColor: s.color, stopOpacity: FILL[s.key][1] }} />
                </linearGradient>
              ))}
              <filter id="edge-glow" x="-5%" y="-50%" width="110%" height="200%">
                <feGaussianBlur stdDeviation="6" />
              </filter>
              <clipPath id="trace-reveal">
                <rect
                  x={plotL}
                  y={top - 4}
                  width={plotR - plotL + 2}
                  height={base - top + 8}
                  rx={14}
                  style={{
                    transformBox: "fill-box",
                    transformOrigin: "left",
                    transform: on ? "scaleX(1)" : "scaleX(0)",
                    transition: "transform 1.8s cubic-bezier(0.45, 0, 0.2, 1)",
                  }}
                />
              </clipPath>
            </defs>

            {/* y ticks, with faint hairlines behind the ribbons */}
            {[0, 25, 50, 75, 100].map((g) => {
              const [, y] = point(0, g, WEEKS, BOX);
              return (
                <g key={g}>
                <line x1={plotL} x2={plotR} y1={y} y2={y} style={{ stroke: "rgb(var(--c-ink) / 0.05)" }} />
                <text key={g} x={plotL - 12} y={y + 4} textAnchor="end" className="fill-ink-faint font-mono text-[11px]" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {g}%
                </text>
                </g>
              );
            })}

            {/* Bands. The surface-coloured stroke on each upper edge is the 2px
                gap between segments. */}
            <g clipPath="url(#trace-reveal)">
              {SHARE.map((s, k) => (
                <path
                  key={s.key}
                  d={ribbonPath(TOPS[k], k ? TOPS[k - 1] : ZERO, BOX, GAP)}
                  fill={`url(#band-${s.key})`}
                  style={{ opacity: dim(s.key), transition: "opacity 0.3s ease" }}
                />
              ))}
              {/* Glow under the brand's edge, then a crisp edge on every ribbon. */}
              <path
                d={ribbonEdge(TOPS[0], BOX, GAP)}
                fill="none"
                filter="url(#edge-glow)"
                style={{ stroke: SHARE[0].color, strokeWidth: 6, opacity: 0.7 * dim("acme"), transition: "opacity 0.3s ease" }}
              />
              {SHARE.map((s, k) =>
                s.key === "others" ? null : (
                  <path
                    key={s.key}
                    d={ribbonEdge(TOPS[k], BOX, GAP)}
                    fill="none"
                    strokeLinecap="round"
                    style={{
                      stroke: s.color,
                      strokeWidth: k === 0 ? 2.5 : 1.75,
                      opacity: dim(s.key),
                      transition: "opacity 0.3s ease",
                    }}
                  />
                ),
              )}
            </g>

            {/* Event pins: neutral ink, so they never read as a series. */}
            {EVENTS.map((ev, i) => {
              const [x] = point(ev.week, 0, WEEKS, BOX);
              return (
                <g key={ev.week} className={cn("transition-opacity duration-700", on ? "opacity-100" : "opacity-0")} style={{ transitionDelay: `${1.6 + i * 0.2}s` }}>
                  <line x1={x} x2={x} y1={top + 10} y2={base} style={{ stroke: "rgb(var(--c-ink) / 0.28)", strokeWidth: 1 }} strokeDasharray="1 5" strokeLinecap="round" />
                  <circle cx={x} cy={top - 2} r={9} style={{ fill: "rgb(var(--c-surface))", stroke: "rgb(var(--c-ink) / 0.45)", strokeWidth: 1 }} />
                  <text x={x} y={top + 2} textAnchor="middle" className="font-mono text-[10px]" style={{ fill: "rgb(var(--c-ink) / 0.8)" }}>
                    {i + 1}
                  </text>
                </g>
              );
            })}

            {/* Direct labels at the right edge, in text tokens beside a key. */}
            {!compact && SHARE.map((s, k) => {
              const last = WEEKS - 1;
              const mid = (TOPS[k][last] + (k ? TOPS[k - 1][last] : 0)) / 2;
              const [, y] = point(last, mid, WEEKS, BOX);
              return (
                <g key={s.key} className={cn("transition-opacity duration-500", on ? "opacity-100" : "opacity-0")} style={{ transitionDelay: "1.7s", opacity: on ? dim(s.key) : 0 }}>
                  <rect x={plotR + 14} y={y - 5} width={10} height={10} rx={2} style={{ fill: s.color }} />
                  <text x={plotR + 32} y={y + 4} className="fill-ink text-[13px] font-medium">
                    {s.label.replace(" (you)", "")}
                    <tspan dx={6} className="fill-ink-soft font-normal">{s.values[last]}%</tspan>
                  </text>
                </g>
              );
            })}

            {/* x-axis */}
            {(compact ? [0, 11] : [0, 3, 7, 11]).map((i) => {
              const [x] = point(i, 0, WEEKS, BOX);
              return (
                <text key={i} x={x} y={BOX.h + 18} textAnchor={compact && i === WEEKS - 1 ? "end" : "middle"} className="fill-ink-faint font-mono text-[11px]">
                  {i === WEEKS - 1 ? "this week" : `wk ${i + 1}`}
                </text>
              );
            })}

            {/* Hover layer */}
            {week !== null && (
              <g>
                <line x1={cx} x2={cx} y1={top} y2={base} style={{ stroke: "rgb(var(--c-ink) / 0.4)", strokeWidth: 1 }} />
                {SHARE.map((s, k) => {
                  const [x, py] = point(week, TOPS[k][week], WEEKS, BOX);
                  const y = py + GAP / 2;
                  return k === SHARE.length - 1 ? null : <circle key={s.key} cx={x} cy={y} r={4.5} style={{ fill: s.color, stroke: "rgb(var(--c-surface))", strokeWidth: 2 }} />;
                })}
              </g>
            )}
            <rect
              x={plotL}
              y={0}
              width={plotR - plotL}
              height={BOX.h}
              fill="transparent"
              className="cursor-crosshair"
              style={{ touchAction: "pan-y" }}
              onPointerMove={onMove}
              onPointerLeave={() => setWeek(null)}
            />
          </svg>

          {week !== null && (
            <div
              className="pointer-events-none absolute top-6 w-48 rounded-lg sm:w-56 border border-ink/10 bg-paper/95 p-3 shadow-lift backdrop-blur"
              style={{ left: `calc(${(cx / BOX.w) * 100}% ${week > WEEKS / 2 ? (compact ? "- 12.75rem" : "- 15rem") : "+ 1.25rem"})` }}
            >
              <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                week {week + 1}
                {week === WEEKS - 1 ? " · latest" : ""}
              </p>
              <ul className="mt-2 space-y-1">
                {[...SHARE].reverse().map((s) => (
                  <li key={s.key} className="flex items-center gap-2 text-sm">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                    <span className="flex-1 text-ink-soft">{s.label}</span>
                    <span className="font-medium text-ink" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {s.values[week]}%
                    </span>
                  </li>
                ))}
              </ul>
              {event && (
                <p className="mt-2 border-t border-ink/10 pt-2 text-xs text-ink-soft">
                  <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-ink/40 font-mono text-[9px] text-ink/80">
                    {EVENTS.indexOf(event) + 1}
                  </span>
                  {event.label}
                </p>
              )}
            </div>
          )}
        </div>


        {/* The same data as a table, for screen readers. */}
        <table className="sr-only">
          <caption>Share of voice by brand, weekly</caption>
          <thead>
            <tr>
              <th scope="col">Week</th>
              {SHARE.map((s) => (
                <th key={s.key} scope="col">{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: WEEKS }, (_, i) => (
              <tr key={i}>
                <th scope="row">Week {i + 1}</th>
                {SHARE.map((s) => (
                  <td key={s.key}>{s.values[i]}%</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Event key */}
        <ol className="mt-5 flex flex-wrap gap-x-8 gap-y-2 text-sm text-ink-soft">
          {EVENTS.map((ev, i) => (
            <li key={ev.week} className="flex items-center gap-2">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-ink/40 font-mono text-[10px] text-ink/80">{i + 1}</span>
              Week {ev.week + 1}: {ev.label}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

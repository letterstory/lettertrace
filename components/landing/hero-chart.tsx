"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { BY_MODEL, WEEKS, areaPath, point, smoothPath, type Box } from "./series";
import { useCompact } from "./use-compact";

// Visibility by model, the hero's main plot. Depth comes from layering, not
// decoration: a soft wash under every series (the lead one a little richer),
// a blurred copy of the lead line for glow, hairline week grid, and labels
// riding the line ends. Hover scrubs a crosshair with a readout.

const WIDE: Box = { w: 760, h: 290, max: 80, padX: 34, padR: 104, padY: 16 };
const COMPACT: Box = { w: 360, h: 230, max: 80, padX: 30, padR: 100, padY: 12 };
const TICKS = [0, 20, 40, 60, 80];

export function HeroChart() {
  const [week, setWeek] = useState<number | null>(null);
  const BOX = useCompact() ? COMPACT : WIDE;
  const plotL = BOX.padX!;
  const plotR = BOX.w - BOX.padR!;
  const base = BOX.h - BOX.padY!;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement!;
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * BOX.w;
    const i = Math.round(((x - plotL) / (plotR - plotL)) * (WEEKS - 1));
    setWeek(Math.min(WEEKS - 1, Math.max(0, i)));
  };

  const [cx] = week === null ? [0] : point(week, 0, WEEKS, BOX);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${BOX.w} ${BOX.h}`} className="h-auto w-full overflow-visible" role="img" aria-label="Visibility by model over 12 weeks: Claude 40% to 70%, ChatGPT 28% to 54%, Gemini 20% to 41%">
        <defs>
          {BY_MODEL.map((m, i) => (
            <linearGradient key={m.key} id={`wash-${m.key}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" style={{ stopColor: m.color, stopOpacity: i === 0 ? 0.3 : 0.14 }} />
              <stop offset="100%" style={{ stopColor: m.color, stopOpacity: 0 }} />
            </linearGradient>
          ))}
          <filter id="hero-glow" x="-10%" y="-40%" width="120%" height="180%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
        </defs>

        {/* Grid: solid hairlines, recessive. */}
        {TICKS.map((g) => {
          const [, y] = point(0, g, WEEKS, BOX);
          return (
            <g key={g}>
              <line x1={plotL} x2={plotR} y1={y} y2={y} style={{ stroke: `rgb(var(--c-ink) / ${g === 0 ? 0.14 : 0.06})` }} />
              <text x={plotL - 10} y={y + 3.5} textAnchor="end" className="fill-ink-faint font-mono text-[10px]" style={{ fontVariantNumeric: "tabular-nums" }}>
                {g}%
              </text>
            </g>
          );
        })}
        {Array.from({ length: WEEKS }, (_, i) => {
          const [x] = point(i, 0, WEEKS, BOX);
          return <line key={i} x1={x} x2={x} y1={BOX.padY} y2={base} style={{ stroke: "rgb(var(--c-ink) / 0.03)" }} />;
        })}

        {/* Washes, back to front so the lead series sits on top. */}
        {[...BY_MODEL].reverse().map((m) => (
          <path key={m.key} d={areaPath(m.values, BOX)} fill={`url(#wash-${m.key})`} className="animate-fade-up [animation-delay:1.3s]" />
        ))}

        {/* Glow under the lead line. */}
        <path
          d={smoothPath(BY_MODEL[0].values, BOX)}
          fill="none"
          strokeWidth={6}
          filter="url(#hero-glow)"
          className="trace-line"
          style={{ stroke: BY_MODEL[0].color, opacity: 0.55, ["--len" as string]: 900, animationDelay: "0.4s" }}
        />

        {[...BY_MODEL].reverse().map((m) => {
          const i = BY_MODEL.indexOf(m);
          return (
            <path
              key={m.key}
              d={smoothPath(m.values, BOX)}
              fill="none"
              strokeWidth={i === 0 ? 2.5 : 2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="trace-line"
              style={{ stroke: m.color, ["--len" as string]: 900, animationDelay: `${0.4 + i * 0.25}s` }}
            />
          );
        })}

        {/* End dots with a surface ring, and direct labels in text tokens. */}
        {BY_MODEL.map((m, i) => {
          const [x, y] = point(WEEKS - 1, m.values[WEEKS - 1], WEEKS, BOX);
          return (
            <g key={m.key} className="animate-fade-up" style={{ animationDelay: `${2.2 + i * 0.12}s` }}>
              {i === 0 && <circle cx={x} cy={y} r={5} className="pulse-ring" style={{ fill: m.color }} />}
              <circle cx={x} cy={y} r={5} style={{ fill: m.color, stroke: "rgb(var(--c-surface))", strokeWidth: 2 }} />
              <text x={x + 12} y={y + 4} className="fill-ink text-[13px] font-medium">
                {m.label}
                <tspan className="fill-ink-soft font-normal" dx={6}>{m.values[WEEKS - 1]}%</tspan>
              </text>
            </g>
          );
        })}

        {/* x-axis */}
        {(BOX === COMPACT ? [0, 11] : [0, 3, 7, 11]).map((i) => {
          const [x] = point(i, 0, WEEKS, BOX);
          return (
            <text key={i} x={x} y={BOX.h + 4} textAnchor="middle" className="fill-ink-faint font-mono text-[10px]">
              {i === WEEKS - 1 ? "this week" : `wk ${i + 1}`}
            </text>
          );
        })}

        {/* Hover layer */}
        {week !== null && (
          <g>
            <line x1={cx} x2={cx} y1={BOX.padY} y2={base} style={{ stroke: "rgb(var(--c-ink) / 0.3)" }} />
            {BY_MODEL.map((m) => {
              const [x, y] = point(week, m.values[week], WEEKS, BOX);
              return <circle key={m.key} cx={x} cy={y} r={4.5} style={{ fill: m.color, stroke: "rgb(var(--c-surface))", strokeWidth: 2 }} />;
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
          onPointerMove={onMove}
          onPointerLeave={() => setWeek(null)}
        />
      </svg>

      {week !== null && (
        <div
          className="pointer-events-none absolute top-2 w-40 rounded-lg border border-ink/10 bg-paper/95 p-2.5 text-left shadow-lift backdrop-blur"
          style={{ left: `calc(${(cx / BOX.w) * 100}% ${week > WEEKS / 2 ? "- 10.75rem" : "+ 0.75rem"})` }}
        >
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">week {week + 1}</p>
          <ul className="mt-1.5 space-y-1">
            {BY_MODEL.map((m) => (
              <li key={m.key} className="flex items-center gap-2 text-xs">
                <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
                <span className="flex-1 text-ink-soft">{m.label}</span>
                <span className={cn("font-medium text-ink")} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {m.values[week]}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The same data as a table, for screen readers. */}
      <table className="sr-only">
        <caption>Visibility by model, weekly</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            {BY_MODEL.map((s) => (
              <th key={s.key} scope="col">{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: WEEKS }, (_, i) => (
            <tr key={i}>
              <th scope="row">Week {i + 1}</th>
              {BY_MODEL.map((s) => (
                <td key={s.key}>{s.values[i]}%</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

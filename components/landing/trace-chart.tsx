"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { EVENTS, SHARE, WEEKS, areaPath, point, smoothPath, type Box } from "./series";

// The trace itself: share of voice against competitors over twelve weekly
// runs. Lines draw in when the chart scrolls into view; hovering (or dragging
// on touch) scrubs a cursor across the weeks; the chips toggle competitors;
// pins mark what moved the line. Illustrative data (brand "Acme").

const BOX: Box = { w: 1000, h: 380, max: 50, padX: 24, padY: 24 };

export function TraceChart() {
  const wrap = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const [week, setWeek] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
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

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * BOX.w;
    const inner = BOX.w - (BOX.padX ?? 0) * 2;
    const i = Math.round(((x - (BOX.padX ?? 0)) / inner) * (WEEKS - 1));
    setWeek(Math.min(WEEKS - 1, Math.max(0, i)));
  };

  // With no cursor on the chart, the readout rests on the latest run.
  const active = week ?? WEEKS - 1;
  const [ax] = point(active, 0, WEEKS, BOX);
  const series = SHARE.filter((s) => !hidden[s.key]);
  const event = EVENTS.find((ev) => ev.week === active);

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
              Watch your share of the answer move against every competitor you track, and see
              what moved it. Hover to scrub through the weeks.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {SHARE.map((s, i) => {
              const off = !!hidden[s.key];
              return (
                <button
                  key={s.key}
                  type="button"
                  disabled={i === 0}
                  onClick={() => setHidden((h) => ({ ...h, [s.key]: !h[s.key] }))}
                  aria-pressed={!off}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition",
                    off ? "border-ink/10 text-ink-faint" : "border-ink/20 text-ink",
                    i === 0 ? "cursor-default" : "hover:border-ink/40",
                  )}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: off ? "transparent" : s.color, boxShadow: `inset 0 0 0 1.5px ${s.color}` }} />
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          ref={wrap}
          onPointerMove={onMove}
          onPointerLeave={() => setWeek(null)}
          className="relative mt-12 cursor-crosshair touch-pan-y select-none rounded-xl border border-ink/10 bg-surface/60 p-4 sm:p-6"
        >
          <svg viewBox={`0 0 ${BOX.w} ${BOX.h}`} className="h-auto w-full overflow-visible" role="img" aria-label="Share of voice by brand over twelve weeks; Acme rises from 22% to 41%">
            <defs>
              <linearGradient id="trace-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="rgb(224 120 80)" stopOpacity="0.22" />
                <stop offset="100%" stopColor="rgb(224 120 80)" stopOpacity="0" />
              </linearGradient>
            </defs>

            {[10, 20, 30, 40].map((g) => {
              const [, y] = point(0, g, WEEKS, BOX);
              return (
                <g key={g}>
                  <line x1={BOX.padX} x2={BOX.w - (BOX.padX ?? 0)} y1={y} y2={y} strokeDasharray="3 6" style={{ stroke: "rgb(var(--c-ink) / 0.08)" }} />
                  <text x={0} y={y + 4} className="fill-ink-faint font-mono text-[11px]">{g}%</text>
                </g>
              );
            })}

            {/* Event pins */}
            {EVENTS.map((ev, i) => {
              const [x] = point(ev.week, 0, WEEKS, BOX);
              return (
                <g key={ev.week} className={cn("transition-opacity duration-700", on ? "opacity-100" : "opacity-0")} style={{ transitionDelay: `${1.8 + i * 0.25}s` }}>
                  <line x1={x} x2={x} y1={BOX.padY} y2={BOX.h - (BOX.padY ?? 0)} strokeDasharray="2 4" style={{ stroke: "rgb(var(--c-butter) / 0.6)" }} />
                  <circle cx={x} cy={BOX.padY} r={9} style={{ fill: "rgb(var(--c-butter))" }} />
                  <text x={x} y={(BOX.padY ?? 0) + 4} textAnchor="middle" className="font-mono text-[11px] font-medium" style={{ fill: "#1A1917" }}>
                    {i + 1}
                  </text>
                </g>
              );
            })}

            {!hidden.acme && on && <path d={areaPath(SHARE[0].values, BOX)} fill="url(#trace-area)" className="animate-fade-up [animation-delay:1.2s]" />}

            {SHARE.map((s, i) =>
              hidden[s.key] ? null : (
                <path
                  key={s.key}
                  d={smoothPath(s.values, BOX)}
                  fill="none"
                  strokeWidth={i === 0 ? 3.5 : 2}
                  strokeLinecap="round"
                  className={on ? "trace-line" : ""}
                  style={{
                    stroke: s.color,
                    opacity: on ? (i === 0 ? 1 : 0.75) : 0,
                    ["--len" as string]: 1300,
                    animationDelay: `${i * 0.2}s`,
                  }}
                />
              ),
            )}

            {/* Scrub cursor */}
            <line x1={ax} x2={ax} y1={BOX.padY} y2={BOX.h - (BOX.padY ?? 0)} style={{ stroke: "rgb(var(--c-ink) / 0.25)" }} className={cn("transition-opacity", on ? "opacity-100" : "opacity-0")} />
            {series.map((s) => {
              const [x, y] = point(active, s.values[active], WEEKS, BOX);
              return <circle key={s.key} cx={x} cy={y} r={5} className={cn("transition-opacity", on ? "opacity-100" : "opacity-0")} style={{ fill: s.color, stroke: "rgb(var(--c-surface))", strokeWidth: 2 }} />;
            })}
          </svg>

          {/* Readout */}
          <div
            className={cn(
              "pointer-events-none absolute top-6 w-52 rounded-lg border border-ink/10 bg-paper/95 p-3 shadow-lift backdrop-blur transition-opacity",
              on ? "opacity-100" : "opacity-0",
              /* Phones: the chart is narrow, so the readout only shows while scrubbing. */
              week === null && "max-sm:hidden",
            )}
            style={{
              left: `calc(${(ax / BOX.w) * 100}% ${active > WEEKS / 2 ? "- 13.5rem" : "+ 1rem"})`,
            }}
          >
            <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
              week {active + 1}
              {active === WEEKS - 1 ? " · latest" : ""}
            </p>
            <ul className="mt-2 space-y-1">
              {series.map((s) => (
                <li key={s.key} className="flex items-center gap-2 text-sm">
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  <span className="flex-1 text-ink-soft">{s.label}</span>
                  <span className="font-medium text-ink">{s.values[active]}%</span>
                </li>
              ))}
            </ul>
            {event && (
              <p className="mt-2 border-t border-ink/10 pt-2 text-xs text-ink-soft">
                <span className="mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-butter font-mono text-[10px] text-[#1A1917]">
                  {EVENTS.indexOf(event) + 1}
                </span>
                {event.label}
              </p>
            )}
          </div>
        </div>

        {/* Event key */}
        <ol className="mt-5 flex flex-wrap gap-x-8 gap-y-2 text-sm text-ink-soft">
          {EVENTS.map((ev, i) => (
            <li key={ev.week} className="flex items-center gap-2">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-butter font-mono text-[11px] text-[#1A1917]">{i + 1}</span>
              Week {ev.week + 1}: {ev.label}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

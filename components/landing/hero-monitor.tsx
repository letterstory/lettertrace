import type { ReactNode } from "react";
import { BY_MODEL, WEEKS, areaPath, point, smoothPath, type Box } from "./series";
import { ProviderLogo, type Provider } from "./provider-logo";

// The hero's product shot: the monitor as a customer sees it. Visibility by
// model traces itself in on load, the newest point pulses, and the CLI run
// that produced it floats over the corner.

const BOX: Box = { w: 760, h: 250, max: 80, padX: 8, padY: 14 };

const STATS = [
  { label: "Visibility", value: "62%", delta: "+4 pts", dot: "bg-terracotta" },
  { label: "Share of voice", value: "41%", delta: "+1 pt", dot: "bg-mint-bright" },
  { label: "Sentiment", value: "+0.34", delta: "positive", dot: "bg-butter" },
  { label: "Avg. position", value: "#2.1", delta: "▲ 0.4", dot: "bg-teal" },
];

export function HeroMonitor({ terminal }: { terminal: ReactNode }) {
  return (
    <div className="relative mx-auto mt-16 w-full max-w-5xl animate-fade-up [animation-delay:250ms] lg:mt-20">
      {/* A pool of light under the card so it sits in the glow. */}
      <div className="pointer-events-none absolute inset-x-10 -top-10 bottom-10 rounded-full bg-terracotta/25 blur-[90px]" />

      <div className="relative overflow-hidden rounded-xl border border-ink/10 bg-surface/95 shadow-lift backdrop-blur">
        {/* Top bar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-ink/10 px-5 py-3.5">
          <span className="font-mono text-xs text-ink-soft">acme · AI visibility · last 12 weeks</span>
          <div className="ml-auto flex items-center gap-2">
            {BY_MODEL.map((m) => (
              <span
                key={m.key}
                className="hidden items-center gap-1.5 rounded-full border border-ink/10 px-2.5 py-1 text-xs text-ink-soft sm:inline-flex"
              >
                <ProviderLogo provider={m.key as Provider} className="h-3.5 w-3.5" />
                {m.label}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-mint-ink">
              <span className="relative flex h-2 w-2">
                <span className="absolute inset-0 animate-ping rounded-full bg-mint-bright/70" />
                <span className="relative h-2 w-2 rounded-full bg-mint-bright" />
              </span>
              live
            </span>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 border-b border-ink/10 md:grid-cols-4">
          {STATS.map((s, i) => (
            <div
              key={s.label}
              className={`px-5 py-4 ${i % 2 ? "border-l" : ""} ${i >= 2 ? "border-t md:border-t-0" : ""} ${i === 2 ? "md:border-l" : ""} border-ink/10`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-sm ${s.dot}`} />
                <span className="text-xs text-ink-faint">{s.label}</span>
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-serif text-3xl text-ink">{s.value}</span>
                <span className="font-mono text-[11px] text-mint-ink">{s.delta}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Chart */}
        <div className="relative px-4 pb-10 pt-6 sm:px-6">
          <svg viewBox={`0 0 ${BOX.w} ${BOX.h}`} className="h-auto w-full overflow-visible" aria-label="Visibility by model, trending up over 12 weeks" role="img">
            <defs>
              <linearGradient id="hero-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="rgb(224 120 80)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="rgb(224 120 80)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[20, 40, 60].map((g) => {
              const [, y] = point(0, g, WEEKS, BOX);
              return (
                <g key={g}>
                  <line x1={0} x2={BOX.w} y1={y} y2={y} style={{ stroke: "rgb(var(--c-ink) / 0.07)" }} strokeDasharray="3 5" />
                  <text x={BOX.w} y={y - 5} textAnchor="end" className="fill-ink-faint font-mono text-[10px]">
                    {g}%
                  </text>
                </g>
              );
            })}
            <path d={areaPath(BY_MODEL[0].values, BOX)} fill="url(#hero-area)" className="animate-fade-up [animation-delay:1.4s]" />
            {BY_MODEL.map((m, i) => (
              <path
                key={m.key}
                d={smoothPath(m.values, BOX)}
                fill="none"
                strokeWidth={i === 0 ? 3 : 2}
                strokeLinecap="round"
                className="trace-line"
                style={{ stroke: m.color, ["--len" as string]: 1000, animationDelay: `${0.4 + i * 0.25}s`, opacity: i === 0 ? 1 : 0.8 }}
              />
            ))}
            {(() => {
              const [x, y] = point(WEEKS - 1, BY_MODEL[0].values[WEEKS - 1], WEEKS, BOX);
              return (
                <g className="animate-fade-up [animation-delay:2.6s]">
                  <circle cx={x} cy={y} r={5} className="pulse-ring" style={{ fill: "rgb(var(--c-terracotta))" }} />
                  <circle cx={x} cy={y} r={5} style={{ fill: "rgb(var(--c-terracotta))", stroke: "rgb(var(--c-surface))" }} strokeWidth={2} />
                </g>
              );
            })()}
          </svg>
          <div className="mt-2 flex justify-between px-1 font-mono text-[10px] text-ink-faint">
            <span>12 weeks ago</span>
            <span>this week</span>
          </div>
        </div>
      </div>

      {/* The CLI run behind the numbers, floating over the corner. */}
      <div className="relative z-10 mx-auto -mt-8 w-full max-w-md text-left animate-fade-up [animation-delay:900ms] sm:absolute sm:-bottom-24 sm:-left-8 sm:mt-0 sm:max-w-[430px] lg:-left-20">
        {terminal}
      </div>
    </div>
  );
}

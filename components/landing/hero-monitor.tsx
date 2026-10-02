import type { ReactNode } from "react";
import { BY_MODEL } from "./series";
import { ProviderLogo, type Provider } from "./provider-logo";
import { HeroChart } from "./hero-chart";

// The hero's product shot: the monitor as a customer sees it. Visibility by
// model traces itself in on load, the newest point pulses, and the CLI run
// that produced it floats over the corner.

// Positions across the 15 answers (of 24) that mention the brand: the
// average is #2.1 and 15/24 is the 62% visibility above.
const POSITIONS = [
  { label: "#1", n: 6 },
  { label: "#2", n: 4 },
  { label: "#3", n: 3 },
  { label: "#4", n: 1 },
  { label: "#5+", n: 1 },
];
const MAX_POS = 6;

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

        {/* Chart + rail */}
        <div className="grid lg:grid-cols-[1fr_280px]">
          <div className="px-3 pb-8 pt-6 sm:px-5">
            <p className="mb-3 px-1 text-left text-sm font-medium text-ink">
              Visibility by model <span className="font-normal text-ink-faint">· share of answers that mention you</span>
            </p>
            <HeroChart />
          </div>

          <aside className="border-t border-ink/10 p-5 text-left lg:border-l lg:border-t-0">
            <p className="text-sm font-medium text-ink">Mentioned by</p>
            <p className="text-xs text-ink-faint">this week, of 24 answers each</p>
            <ul className="mt-4 space-y-3.5">
              {BY_MODEL.map((m) => {
                const v = m.values[m.values.length - 1];
                return (
                  <li key={m.key}>
                    <div className="flex items-center gap-2 text-sm">
                      <ProviderLogo provider={m.key as Provider} className="h-3.5 w-3.5" />
                      <span className="flex-1 text-ink-soft">{m.label}</span>
                      <span className="font-medium text-ink">{v}%</span>
                    </div>
                    {/* Track is a lighter step of the same hue; 4px rounded data end. */}
                    <div className="mt-1.5 h-2 overflow-hidden rounded-sm" style={{ background: `${m.color.slice(0, -1)} / 0.14)` }}>
                      <div className="h-full origin-left animate-[grow_1.2s_cubic-bezier(0.2,0.7,0.2,1)_both] rounded-r" style={{ width: `${v}%`, background: m.color, animationDelay: "1.2s" }} />
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="mt-6 border-t border-ink/10 pt-5">
              <p className="text-sm font-medium text-ink">Where you rank</p>
              <p className="text-xs text-ink-faint">position in the 15 answers that mention you</p>
              <div className="mt-4 flex h-28 items-end gap-[2px]">
                {POSITIONS.map((p, i) => (
                  <div key={p.label} className="flex flex-1 flex-col items-center justify-end gap-1.5">
                    <span className="text-xs font-medium text-ink-soft">{p.n}</span>
                    <div
                      className="w-full max-w-[24px] origin-bottom animate-[rise_1s_cubic-bezier(0.2,0.7,0.2,1)_both] rounded-t"
                      style={{
                        height: `${(p.n / MAX_POS) * 72}px`,
                        background: `rgb(var(--c-chart-1) / ${1 - i * 0.17})`,
                        animationDelay: `${1.3 + i * 0.08}s`,
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex gap-[2px] border-t border-ink/15 pt-1.5">
                {POSITIONS.map((p) => (
                  <span key={p.label} className="flex-1 text-center font-mono text-[10px] text-ink-faint">
                    {p.label}
                  </span>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* The CLI run behind the numbers, floating over the corner. */}
      <div className="relative z-10 mx-auto -mt-8 w-full max-w-md text-left animate-fade-up [animation-delay:900ms] sm:absolute sm:-bottom-44 sm:-left-8 sm:mt-0 sm:max-w-[430px] lg:-left-20">
        {terminal}
      </div>
    </div>
  );
}

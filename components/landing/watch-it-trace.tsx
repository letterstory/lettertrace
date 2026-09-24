"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ProviderLogo, type Provider } from "./provider-logo";
import { point, smoothThrough, type Box } from "./series";

// "Watch it trace": one run of Lettertrace in ~12 seconds. It plays on its own
// when it scrolls into view (a topic typed, questions generated, three models
// answering, a new point landing on the trend line), holds the ending, then
// loops. It pauses off-screen, and clicking a step jumps to it. The sibling of
// phantomstory.com's "Watch it work", on purpose.

const DURATION = 12000;
const HOLD = 3500;
const STEP_STARTS = [0, 0.13, 0.35, 0.75];

const TOPIC = "best CRM for startups";

const VARIATIONS = [
  "What CRM should a 10-person startup use?",
  "Best CRM for a seed-stage B2B team",
  "HubSpot alternatives for early-stage startups",
  "Cheapest CRM with a good API",
  "Which CRM works best with Slack?",
];

type Engine = {
  key: Provider;
  label: string;
  answer: { t: string; brand?: boolean }[];
  result: { hit: boolean; text: string };
  offset: number;
};

const ENGINES: Engine[] = [
  {
    key: "claude",
    label: "Claude",
    answer: [
      { t: "For an early-stage team the shortlist is usually " },
      { t: "Acme", brand: true },
      { t: " and HubSpot. Acme wins on setup time and a cleaner API." },
    ],
    result: { hit: true, text: "Mentioned · #1 · positive" },
    offset: 0,
  },
  {
    key: "chatgpt",
    label: "ChatGPT",
    answer: [
      { t: "Popular picks include HubSpot, Pipedrive, and " },
      { t: "Acme", brand: true },
      { t: ", depending on how much automation you need." },
    ],
    result: { hit: true, text: "Mentioned · #3 · neutral" },
    offset: 0.03,
  },
  {
    key: "gemini",
    label: "Gemini",
    answer: [{ t: "HubSpot's free tier and Pipedrive are strong starting points for small sales teams." }],
    result: { hit: false, text: "Not mentioned" },
    offset: 0.06,
  },
];

const STEPS = [
  { title: <>Track a <em className="italic">topic</em>.</>, body: "Add what your buyers ask about. One line is enough." },
  { title: <>Generate the questions.</>, body: "Lettertrace writes the real prompts people put to assistants, dozens per topic." },
  { title: <>Ask every <em className="italic">model</em>.</>, body: "Claude, ChatGPT and Gemini answer. Each answer is read for mentions, position and sentiment." },
  { title: <>Trace the <em className="italic">trend</em>.</>, body: "Every run is a datapoint. The line tells you whether it’s working." },
];

const TREND = [38, 40, 41, 42, 45, 48, 49, 52, 54, 56, 58, 62];
const TBOX: Box = { w: 520, h: 90, max: 70, padX: 6, padY: 8 };

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const span = (v: number, a: number, b: number) => clamp((v - a) / (b - a));

function streamed(parts: Engine["answer"], n: number) {
  let left = n;
  return parts.map((p, i) => {
    const take = Math.max(0, Math.min(p.t.length, left));
    left -= take;
    if (!take) return null;
    const text = p.t.slice(0, take);
    return p.brand ? (
      <mark key={i} className="rounded-sm bg-butter px-1 text-[#1A1917]">
        {text}
      </mark>
    ) : (
      <span key={i}>{text}</span>
    );
  });
}

export function WatchItTrace() {
  const ref = useRef<HTMLElement>(null);
  const elapsed = useRef(0);
  const [t, setT] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setT(1);
      return;
    }
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (last) {
        elapsed.current += now - last;
        if (elapsed.current > DURATION + HOLD) elapsed.current = 0;
        setT(clamp(elapsed.current / DURATION));
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !raf) {
          last = 0;
          raf = requestAnimationFrame(tick);
        } else if (!e.isIntersecting && raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  const jump = (i: number) => {
    elapsed.current = STEP_STARTS[i] * DURATION;
    setT(STEP_STARTS[i]);
  };

  const step = t < STEP_STARTS[1] ? 0 : t < STEP_STARTS[2] ? 1 : t < STEP_STARTS[3] ? 2 : 3;
  const typed = Math.round(TOPIC.length * span(t, 0.01, 0.11));
  const shownVariations = Math.floor(VARIATIONS.length * span(t, 0.14, 0.32) + 0.001);
  const trendOn = t > 0.78;
  const visibility = Math.round(58 + 4 * span(t, 0.8, 0.95));
  const pts = TREND.map((v, i) => point(i, v, TREND.length, TBOX));
  const [px, py] = pts[pts.length - 2];
  const [lx, ly] = pts[pts.length - 1];

  return (
    <section ref={ref} id="how" className="relative border-y border-ink/10 bg-paper-shade/40">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-24 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
        {/* Steps */}
        <div>
          <p className="mono-eyebrow">watch it trace</p>
          <p className="mt-3 hidden font-serif text-lg text-ink-soft lg:block">One run, start to finish</p>
          <ol className="mt-8 space-y-6">
            {STEPS.map((s, i) => {
              const state = i === step ? "active" : i < step ? "past" : "future";
              return (
                <li
                  key={i}
                  onClick={() => jump(i)}
                  className={cn(
                    "grid cursor-pointer grid-cols-[2.25rem_1fr] gap-x-3 transition-opacity duration-300",
                    state === "active" ? "opacity-100" : state === "past" ? "opacity-40 hover:opacity-70" : "opacity-20 hover:opacity-60",
                    state !== "active" && "max-lg:hidden",
                  )}
                >
                  <span className={cn("pt-3 font-mono text-xs", state === "active" ? "text-terracotta-dark" : "text-ink-faint")}>
                    0{i + 1}
                  </span>
                  <div>
                    <h3 className="text-3xl font-normal leading-tight tracking-tight text-ink sm:text-4xl [&_em]:text-terracotta-dark">
                      {s.title}
                    </h3>
                    <p
                      className={cn(
                        "overflow-hidden text-ink-soft transition-all duration-500",
                        state === "active" ? "mt-2 max-h-24 opacity-100" : "max-h-0 opacity-0",
                      )}
                    >
                      {s.body}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        {/* The run */}
        <div className="relative overflow-hidden rounded-xl border border-ink/10 bg-surface shadow-lift lg:min-h-[600px]">
          <div
            className="absolute left-0 top-0 h-0.5 bg-gradient-to-r from-terracotta to-mint-bright"
            style={{ width: `${t * 100}%` }}
          />
          <div className="flex items-center gap-3 border-b border-ink/10 px-5 py-3">
            <span className="font-mono text-xs text-ink-faint">lettertrace · run</span>
            <span className="ml-auto font-mono text-[11px] text-ink-faint">project: acme</span>
          </div>

          <div className="space-y-5 p-5">
            {/* Topic */}
            <div>
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-faint">topic</p>
              <div className="flex h-11 items-center rounded-lg border border-ink/15 bg-paper px-3.5 text-[15px] text-ink">
                {TOPIC.slice(0, typed)}
                {typed < TOPIC.length && <span className="ml-0.5 inline-block h-5 w-0.5 animate-blink bg-terracotta" />}
              </div>
            </div>

            {/* Variations */}
            <div className={cn("transition-opacity duration-300", t > 0.13 ? "opacity-100" : "opacity-0")}>
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                {shownVariations < VARIATIONS.length ? "generating questions…" : "24 questions · showing 5"}
              </p>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {VARIATIONS.map((v, i) => (
                  <li
                    key={v}
                    className={cn(
                      "truncate rounded-md border border-ink/10 bg-paper/60 px-3 py-1.5 text-[13px] text-ink-soft transition-all duration-500",
                      i < shownVariations ? "translate-y-0 opacity-100 blur-0" : "translate-y-1 opacity-0 blur-sm",
                      i >= 3 && "max-sm:hidden",
                    )}
                  >
                    {v}
                  </li>
                ))}
              </ul>
            </div>

            {/* Engines */}
            <div className={cn("grid gap-2.5 transition-opacity duration-300 md:grid-cols-3", t > 0.35 ? "opacity-100" : "opacity-0")}>
              {ENGINES.map((e) => {
                const total = e.answer.reduce((n, p) => n + p.t.length, 0);
                const p = span(t, 0.37 + e.offset, 0.66 + e.offset);
                const done = p >= 1;
                return (
                  <div key={e.key} className="flex flex-col rounded-lg border border-ink/10 bg-paper/60 p-3">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
                      <ProviderLogo provider={e.key} className="h-3.5 w-3.5" />
                      {e.label}
                    </div>
                    <p className="mt-2 min-h-[3.75rem] font-serif text-[14px] leading-snug text-ink-soft max-md:min-h-0">
                      {streamed(e.answer, Math.round(total * p))}
                    </p>
                    <span
                      className={cn(
                        "mt-2 inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10.5px] transition-all duration-500",
                        done ? "opacity-100" : "opacity-0",
                        e.result.hit ? "bg-mint-tint text-mint-ink" : "bg-ink/[0.06] text-ink-faint",
                      )}
                    >
                      {e.result.hit ? "✓" : "✗"} {e.result.text}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Trend */}
            <div className={cn("rounded-lg border border-ink/10 bg-paper/60 p-3 transition-opacity duration-300", t > 0.75 ? "opacity-100" : "opacity-0")}>
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">visibility · this run</span>
                <span className="flex items-baseline gap-2">
                  <span className="font-serif text-2xl text-ink">{visibility}%</span>
                  <span className={cn("font-mono text-[11px] text-mint-ink transition-opacity", visibility > 58 ? "opacity-100" : "opacity-0")}>
                    ▲ +{visibility - 58} pts
                  </span>
                </span>
              </div>
              <svg viewBox={`0 0 ${TBOX.w} ${TBOX.h}`} className="mt-1 h-auto w-full overflow-visible" aria-hidden>
                <path
                  d={smoothThrough(pts.slice(0, -1))}
                  fill="none"
                  strokeWidth={2}
                  strokeLinecap="round"
                  style={{ stroke: "rgb(var(--c-ink) / 0.35)" }}
                />
                {trendOn && (
                  <>
                    <path
                      d={`M${px} ${py} L${lx} ${ly}`}
                      fill="none"
                      strokeWidth={3}
                      strokeLinecap="round"
                      className="trace-line"
                      style={{ stroke: "rgb(var(--c-terracotta))", ["--len" as string]: 120, animationDuration: "0.9s" }}
                    />
                    <circle cx={lx} cy={ly} r={4.5} className="pulse-ring" style={{ fill: "rgb(var(--c-terracotta))" }} />
                    <circle cx={lx} cy={ly} r={4.5} style={{ fill: "rgb(var(--c-terracotta))" }} />
                  </>
                )}
              </svg>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

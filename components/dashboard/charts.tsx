"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SENTIMENT_COLORS } from "@/lib/metrics";
import type { Sentiment } from "@/lib/types";
import { useTheme } from "@/components/theme";

// ------------------------------------------------------------------
// Recharts wrappers for the overview dashboard. All numeric inputs are
// plain values already scaled 0..100 where noted. Each chart degrades to
// a muted placeholder instead of crashing on empty data.
//
// Recharts takes colors as literal props/attributes (CSS variables don't
// resolve inside SVG presentation attributes), so we resolve the palette
// from the active theme here and re-render when the user flips it.
// ------------------------------------------------------------------

const BRAND = "#E07850"; // terracotta (you) — pops on both themes
const TEAL = "#129C82"; // aqua (share / competitors)

// `label` is the colour of every bit of text Recharts draws: axis ticks, the
// value printed at the end of a bar, legends. It used to be --c-ink-faint,
// which measured 4.63:1 on the card surface in dark mode — the dimmest token in
// the system, and the reason the chart read as greyed-out next to its own
// heading. These are the --c-ink-soft values, ~9:1, i.e. secondary text rather
// than disabled text.
const PALETTE = {
  light: {
    ink: "#1A1917",
    label: "#45423C",
    faint: "#7C786F",
    grid: "rgba(26,25,23,0.08)",
    surface: "#FFFFFF",
    cursor: "rgba(26,25,23,0.04)",
  },
  dark: {
    ink: "#F4F3EF",
    label: "#BEBAB2",
    faint: "#8A867D",
    grid: "rgba(255,255,255,0.10)",
    surface: "#1F1D1A",
    cursor: "rgba(255,255,255,0.05)",
  },
} as const;

function useChartTheme() {
  const { theme } = useTheme();
  const p = PALETTE[theme];
  return {
    ...p,
    axisTick: { fill: p.label, fontSize: 12 },
    tooltipStyle: {
      borderRadius: 4,
      border: `1px solid ${p.grid}`,
      background: p.surface,
      boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      fontSize: 12,
      color: p.ink,
    } as const,
    legendStyle: { fontSize: 12, color: p.label },
  };
}

function Placeholder({ label, height }: { label: string; height: number }) {
  return (
    <div
      className="flex items-center justify-center rounded border border-dashed border-ink/10 bg-paper-shade/40 text-sm text-ink-faint"
      style={{ height }}
    >
      {label}
    </div>
  );
}

export function TrendChart({
  data,
}: {
  data: { date: string; visibility: number; share: number }[];
}) {
  const t = useChartTheme();
  if (!data || data.length === 0) {
    return <Placeholder label="No reports to chart yet" height={280} />;
  }
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid stroke={t.grid} vertical={false} />
        <XAxis dataKey="date" tick={t.axisTick} tickLine={false} axisLine={{ stroke: t.grid }} />
        <YAxis
          domain={[0, 100]}
          tick={t.axisTick}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v}%`}
          width={44}
        />
        <Tooltip
          contentStyle={t.tooltipStyle}
          formatter={(value: number, name: string) => [
            `${Math.round(value)}%`,
            name === "visibility" ? "Visibility" : "Share of voice",
          ]}
        />
        <Legend
          iconType="plainline"
          wrapperStyle={t.legendStyle}
          formatter={(value: string) =>
            value === "visibility" ? "Visibility" : "Share of voice"
          }
        />
        <Line
          type="monotone"
          dataKey="visibility"
          stroke={BRAND}
          strokeWidth={2.5}
          dot={{ r: 3, fill: BRAND, strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
        <Line
          type="monotone"
          dataKey="share"
          stroke={TEAL}
          strokeWidth={2.5}
          dot={{ r: 3, fill: TEAL, strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// One color per answer engine, stable across renders so Claude is always the
// same line week to week. Terracotta stays the brand's color on the
// single-engine chart, so the engine palette starts elsewhere.
const ENGINE_COLORS = ["#129C82", "#E07850", "#6F87C8", "#C8A24A", "#B06FC8"];

/**
 * Visibility over time, one line per answer engine. Replaces the blended
 * single-line trend whenever runs span engines: Claude's 40% and Gemini's 12%
 * aren't points on one series, and a line that zigzags between them reads as
 * volatility that never happened. Each run extends only its own engine's line
 * (connectNulls bridges the gaps where other engines ran).
 */
export function EngineTrendChart({
  data,
  series,
}: {
  /** Chronological rows: { date, [engineKey]: visibility 0..100 } */
  data: Record<string, string | number | null>[];
  series: { key: string; label: string }[];
}) {
  const t = useChartTheme();
  if (!data || data.length === 0 || series.length === 0) {
    return <Placeholder label="No reports to chart yet" height={280} />;
  }
  const labelOf = new Map(series.map((s) => [s.key, s.label]));
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid stroke={t.grid} vertical={false} />
        <XAxis dataKey="date" tick={t.axisTick} tickLine={false} axisLine={{ stroke: t.grid }} />
        <YAxis
          domain={[0, 100]}
          tick={t.axisTick}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v}%`}
          width={44}
        />
        <Tooltip
          contentStyle={t.tooltipStyle}
          formatter={(value: number, name: string) => [
            `${Math.round(value)}%`,
            labelOf.get(name) ?? name,
          ]}
        />
        <Legend
          iconType="plainline"
          wrapperStyle={t.legendStyle}
          formatter={(value: string) => labelOf.get(value) ?? value}
        />
        {series.map((s, i) => {
          const color = ENGINE_COLORS[i % ENGINE_COLORS.length];
          return (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={color}
              strokeWidth={2.5}
              connectNulls
              dot={{ r: 3, fill: color, strokeWidth: 0 }}
              activeDot={{ r: 5 }}
            />
          );
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function ShareBars({
  data,
}: {
  data: { name: string; value: number; isBrand: boolean }[];
}) {
  const t = useChartTheme();
  if (!data || data.length === 0) {
    return <Placeholder label="No share of voice yet" height={180} />;
  }
  // Competitor names are real company names ("AWS Elastic Beanstalk", "Google
  // Cloud Run"), and a fixed 110px axis truncated them to initials. Size the
  // label gutter to the longest name actually present, capped so one very long
  // name can't squeeze the bars out of existence.
  const longest = data.reduce((n, d) => Math.max(n, d.name.length), 0);
  const axisWidth = Math.min(200, Math.max(96, longest * 7.2));
  // Share of voice splits 100% across every tracked brand, so with a handful of
  // competitors nobody is near 100 and a fixed 0-100 axis spent three quarters
  // of the width on empty space — the bars ended up too short to compare, which
  // is the one thing this chart is for. Scale to the data, rounded up to a
  // quarter so the gridlines stay meaningful, and let the printed values keep a
  // short axis from reading as "almost everything".
  const maxValue = data.reduce((n, d) => Math.max(n, d.value || 0), 0);
  const ceiling = Math.min(100, Math.max(25, Math.ceil(maxValue / 25) * 25));
  const height = Math.max(160, data.length * 44 + 24);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        // Room on the right for the value label that used to require a hover.
        margin={{ top: 4, right: 44, bottom: 4, left: 8 }}
        barCategoryGap={12}
      >
        <CartesianGrid stroke={t.grid} horizontal={false} />
        <XAxis
          type="number"
          domain={[0, ceiling]}
          tick={t.axisTick}
          tickLine={false}
          axisLine={{ stroke: t.grid }}
          tickFormatter={(v: number) => `${v}%`}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={t.axisTick}
          tickLine={false}
          axisLine={false}
          width={axisWidth}
        />
        <Tooltip
          cursor={{ fill: t.cursor }}
          contentStyle={t.tooltipStyle}
          formatter={(value: number) => [`${Math.round(value)}%`, "Share of voice"]}
        />
        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.isBrand ? BRAND : TEAL} />
          ))}
          {/* The number is the point of the chart; reading it shouldn't need a
              mouse, and doesn't work at all on touch. */}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(v: number) => `${Math.round(v)}%`}
            fill={t.axisTick.fill}
            fontSize={12}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function SentimentDonut({
  data,
}: {
  data: { name: string; value: number }[];
}) {
  const t = useChartTheme();
  const total = (data ?? []).reduce((s, d) => s + (d.value || 0), 0);
  if (total === 0) {
    return <Placeholder label="No sentiment yet" height={240} />;
  }
  const colorFor = (name: string): string => {
    const key = name.toLowerCase() as Sentiment;
    return SENTIMENT_COLORS[key] ?? t.faint;
  };
  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={54}
          outerRadius={84}
          paddingAngle={2}
          stroke={t.surface}
          strokeWidth={2}
        >
          {data.map((entry, i) => (
            <Cell key={i} fill={colorFor(entry.name)} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={t.tooltipStyle}
          formatter={(value: number, name: string) => [`${value}`, name]}
        />
        <Legend
          iconType="circle"
          wrapperStyle={t.legendStyle}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

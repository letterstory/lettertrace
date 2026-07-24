"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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

const PALETTE = {
  light: {
    ink: "#1A1917",
    faint: "#7C786F",
    grid: "rgba(26,25,23,0.08)",
    surface: "#FFFFFF",
    cursor: "rgba(26,25,23,0.04)",
  },
  dark: {
    ink: "#F4F3EF",
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
    axisTick: { fill: p.faint, fontSize: 12 },
    tooltipStyle: {
      borderRadius: 12,
      border: `1px solid ${p.grid}`,
      background: p.surface,
      boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      fontSize: 12,
      color: p.ink,
    } as const,
    legendStyle: { fontSize: 12, color: p.faint },
  };
}

function Placeholder({ label, height }: { label: string; height: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-2xl border border-dashed border-ink/10 bg-paper-shade/40 text-sm text-ink-faint"
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
    return <Placeholder label="No runs to chart yet" height={280} />;
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

export function ShareBars({
  data,
}: {
  data: { name: string; value: number; isBrand: boolean }[];
}) {
  const t = useChartTheme();
  if (!data || data.length === 0) {
    return <Placeholder label="No share of voice yet" height={180} />;
  }
  const height = Math.max(160, data.length * 44 + 24);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
        barCategoryGap={12}
      >
        <CartesianGrid stroke={t.grid} horizontal={false} />
        <XAxis
          type="number"
          domain={[0, 100]}
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
          width={110}
        />
        <Tooltip
          cursor={{ fill: t.cursor }}
          contentStyle={t.tooltipStyle}
          formatter={(value: number) => [`${Math.round(value)}%`, "Share of voice"]}
        />
        <Bar dataKey="value" radius={[0, 8, 8, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.isBrand ? BRAND : TEAL} />
          ))}
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

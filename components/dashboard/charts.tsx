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

// ------------------------------------------------------------------
// Recharts wrappers for the overview dashboard. All numeric inputs are
// plain values already scaled 0..100 where noted. Each chart degrades to
// a muted placeholder instead of crashing on empty data.
// ------------------------------------------------------------------

const INK = "#1A1917";
const INK_FAINT = "#7C786F";
const GRID = "rgba(26,25,23,0.08)";
const BRAND = "#E07850"; // terracotta (you)
const TEAL = "#129C82"; // aqua (share / competitors)

const axisTick = { fill: INK_FAINT, fontSize: 12 };

const tooltipStyle = {
  borderRadius: 12,
  border: "1px solid rgba(26,25,23,0.10)",
  background: "#FFFFFF",
  boxShadow: "0 8px 24px rgba(26,25,23,0.10)",
  fontSize: 12,
  color: INK,
} as const;

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
  if (!data || data.length === 0) {
    return <Placeholder label="No runs to chart yet" height={280} />;
  }
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tick={axisTick} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis
          domain={[0, 100]}
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v}%`}
          width={44}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value: number, name: string) => [
            `${Math.round(value)}%`,
            name === "visibility" ? "Visibility" : "Share of voice",
          ]}
        />
        <Legend
          iconType="plainline"
          wrapperStyle={{ fontSize: 12, color: INK_FAINT }}
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
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis
          type="number"
          domain={[0, 100]}
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          tickFormatter={(v: number) => `${v}%`}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={110}
        />
        <Tooltip
          cursor={{ fill: "rgba(26,25,23,0.04)" }}
          contentStyle={tooltipStyle}
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
  const total = (data ?? []).reduce((s, d) => s + (d.value || 0), 0);
  if (total === 0) {
    return <Placeholder label="No sentiment yet" height={240} />;
  }
  const colorFor = (name: string): string => {
    const key = name.toLowerCase() as Sentiment;
    return SENTIMENT_COLORS[key] ?? INK_FAINT;
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
          stroke="#FFFFFF"
          strokeWidth={2}
        >
          {data.map((entry, i) => (
            <Cell key={i} fill={colorFor(entry.name)} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value: number, name: string) => [`${value}`, name]}
        />
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: 12, color: INK_FAINT }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

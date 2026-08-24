"use client";

import { useRouter } from "next/navigation";
import type { Period } from "@/lib/conversions";
import { PERIOD_OPTIONS } from "./periods";

/**
 * The page-level time filter. It writes the period into the URL (?p=) rather
 * than holding state, so the server component re-renders every number, the
 * chart and the table from the same window — and a reloaded or shared URL
 * keeps its period. Labels live in ./periods.ts, importable from both sides
 * of the client boundary.
 */
export function PeriodSelect({ value }: { value: Period }) {
  const router = useRouter();
  return (
    <select
      value={value}
      aria-label="Time period"
      onChange={(event) => router.push(`/admin/conversions?p=${event.target.value}`)}
      className="rounded border border-ink/10 bg-surface px-2.5 py-1.5 text-xs text-ink transition hover:border-ink/25 focus:outline-none focus:ring-1 focus:ring-ink/30"
    >
      {PERIOD_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

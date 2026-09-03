"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PERIOD_OPTIONS, type Period } from "@/lib/periods";

/**
 * The time filter shared by the /admin pages.
 *
 * It writes the period into the URL rather than holding state, so the server
 * component re-renders every number it governs from the same window — and a
 * reloaded or shared URL keeps its period.
 *
 * `param` exists because a page can carry more than one of these: Growth's
 * lead-list filter already lives in ?f=, and its signup window is ?g=, so the
 * two never collide. Every OTHER query param is preserved on change for the
 * same reason — changing the period should not silently reset the filter
 * someone set two clicks ago.
 */
export function PeriodSelect({
  value,
  param = "p",
  label = "Time period",
}: {
  value: Period;
  param?: string;
  label?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <select
      value={value}
      aria-label={label}
      onChange={(event) => {
        const next = new URLSearchParams(searchParams?.toString() ?? "");
        next.set(param, event.target.value);
        router.push(`${pathname}?${next.toString()}`, { scroll: false });
      }}
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

"use client";

import { useMemo, useState } from "react";
import { Activity, CheckCircle2, Clock, Search, XCircle } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import type { StuckRun, FailureGroup } from "@/lib/ops-live";
import type { Problem } from "@/lib/ops-report";
import { timeAgo } from "@/lib/utils";

/**
 * The searchable half of the dashboard: stuck runs, run failures, recorded
 * issues.
 *
 * Three decisions shape this, all of them about what a long list does to a
 * page you open during an incident.
 *
 * SCROLL, DON'T GROW. Each list is bounded and scrolls inside itself. A bad
 * afternoon can produce dozens of distinct failures, and a page that grows to
 * match buries the summary figures under them — the moment you most need the
 * headline is the moment the page is least able to show it. Bounded lists mean
 * the shape of the page never changes, however bad things get.
 *
 * ONE SEARCH, NOT THREE. The question is "what do I know about X", where X is
 * a model, an error phrase or a route — and you rarely know which list holds
 * the answer. A single box filters all of them at once, and each section says
 * how many of its rows survived, so an empty section reads as "nothing here
 * matched" rather than "nothing here".
 *
 * COUNTS STAY HONEST. Section headings show the unfiltered total; the filtered
 * count appears beside it only while a filter is active. A heading that
 * silently reported the filtered number would let someone conclude an incident
 * had shrunk when they had merely typed something.
 */

type LevelFilter = "all" | "error" | "warn";

const matches = (needle: string, ...fields: (string | number | null | undefined)[]) =>
  fields.some((f) => String(f ?? "").toLowerCase().includes(needle));

export function Telemetry({
  stuck,
  failures,
  problems,
  telemetryOn,
}: {
  stuck: StuckRun[];
  failures: FailureGroup[];
  problems: Problem[];
  telemetryOn: boolean;
}) {
  const [q, setQ] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");
  const needle = q.trim().toLowerCase();
  const filtering = needle.length > 0;

  const shownStuck = useMemo(
    () =>
      !filtering ? stuck : stuck.filter((r) => matches(needle, r.provider, r.model, r.id)),
    [stuck, needle, filtering],
  );
  const shownFailures = useMemo(
    () =>
      !filtering
        ? failures
        : failures.filter((f) => matches(needle, f.example, f.signature, f.engines.join(" "))),
    [failures, needle, filtering],
  );
  const shownProblems = useMemo(() => {
    const byLevel = level === "all" ? problems : problems.filter((p) => p.level === level);
    return !filtering
      ? byLevel
      : byLevel.filter((p) => matches(needle, p.signature, p.source, JSON.stringify(p.sample)));
  }, [problems, needle, filtering, level]);

  const totalShown = shownStuck.length + shownFailures.length + shownProblems.length;
  const errorCount = problems.filter((p) => p.level === "error").length;
  const warnCount = problems.filter((p) => p.level === "warn").length;

  return (
    <div className="space-y-4">
      {/* ---- Toolbar ------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search failures, engines, routes…"
            aria-label="Search telemetry"
            className="w-full rounded border border-ink/15 bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-ink/30 focus:outline-none"
          />
        </div>
        {problems.length > 0 && (
          <div className="flex shrink-0 items-center gap-1 rounded border border-ink/10 bg-surface p-1">
            {(
              [
                ["all", `All ${problems.length}`],
                ["error", `Errors ${errorCount}`],
                ["warn", `Warnings ${warnCount}`],
              ] as [LevelFilter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setLevel(value)}
                aria-pressed={level === value}
                className={`rounded-sm px-2.5 py-1 text-xs tabular-nums transition ${
                  level === value
                    ? "bg-ink/[0.08] font-medium text-ink"
                    : "text-ink-faint hover:text-ink-soft"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {filtering && (
        <p className="text-xs text-ink-faint">
          {totalShown === 0
            ? `Nothing matches “${q}”.`
            : `${totalShown} match${totalShown === 1 ? "" : "es"} for “${q}”.`}
        </p>
      )}

      {/* ---- Stuck runs ---------------------------------------------------- */}
      {stuck.length > 0 && (
        <Section
          icon={<Clock className="h-4 w-4 text-terracotta" aria-hidden />}
          title="Stuck runs"
          total={stuck.length}
          shown={shownStuck.length}
          filtering={filtering}
          hint="Still running after 30 minutes: an invocation that died without writing a status. These never finish on their own."
        >
          {shownStuck.map((r) => (
            <Row key={r.id} accent>
              <div className="min-w-0">
                <p className="truncate font-mono text-sm text-ink">
                  {r.provider}/{r.model}
                </p>
                <p className="truncate font-mono text-xs text-ink-faint">{r.id.slice(0, 8)}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-medium tabular-nums text-terracotta-dark">{r.minutes}m</p>
                <p className="text-xs tabular-nums text-ink-faint">
                  {r.done}/{r.planned} answers
                </p>
              </div>
            </Row>
          ))}
        </Section>
      )}

      {/* ---- Run failures --------------------------------------------------- */}
      <Section
        icon={<XCircle className="h-4 w-4 text-terracotta" aria-hidden />}
        title="Run failures"
        total={failures.length}
        shown={shownFailures.length}
        filtering={filtering}
        empty={
          failures.length === 0 ? "No failed runs in the window." : `Nothing matches “${q}”.`
        }
      >
        {shownFailures.map((f) => (
          <Row key={f.signature} accent>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">{f.example}</p>
              <p className="mt-0.5 truncate font-mono text-xs text-ink-faint">
                {f.engines.join(", ")} · {timeAgo(f.lastSeen)}
              </p>
            </div>
            <Badge tone="terracotta">
              <span className="tabular-nums">{f.count}</span>
            </Badge>
          </Row>
        ))}
      </Section>

      {/* ---- Recorded issues ------------------------------------------------ */}
      <Section
        icon={<Activity className="h-4 w-4 text-ink-faint" aria-hidden />}
        title="Recorded issues"
        total={problems.length}
        shown={shownProblems.length}
        filtering={filtering || level !== "all"}
        empty={
          problems.length === 0
            ? telemetryOn
              ? "Nothing recorded in the window."
              : // Only when the list is empty. Printed above a populated list it
                // contradicted the rows directly beneath it.
                "Telemetry is off, so errors outside the run lifecycle are not recorded. Set OPS_TELEMETRY=1 and redeploy. Everything else on this page comes from run history and does not depend on it."
            : "Nothing matches the current filter."
        }
      >
        {shownProblems.map((p) => (
          <Row key={p.signature} accent={p.level === "error"}>
            <div className="min-w-0 flex-1">
              <p className="break-words font-mono text-sm text-ink">{p.signature}</p>
              <p className="mt-0.5 truncate text-xs text-ink-faint">
                {p.source} · {timeAgo(p.lastSeen)}
              </p>
            </div>
            <Badge tone={p.level === "error" ? "terracotta" : "butter"}>
              <span className="tabular-nums">{p.occurrences}×</span>
            </Badge>
          </Row>
        ))}
      </Section>
    </div>
  );
}

/**
 * A bounded list. The scroll container is the body only, so the heading and its
 * counts stay put while the rows move — during an incident you want to keep
 * seeing how many there are while you read them.
 */
function Section({
  icon,
  title,
  total,
  shown,
  filtering,
  hint,
  empty,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  total: number;
  shown: number;
  filtering: boolean;
  hint?: string;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-ink">
          {icon}
          {title}
        </h3>
        <span className="text-sm tabular-nums text-ink-faint">
          {/* The unfiltered total is the truth; the filtered count is a view of
              it, and is labelled as such rather than replacing it. */}
          {filtering && shown !== total ? `${shown} of ${total}` : total}
        </span>
      </div>
      {hint && <p className="max-w-3xl text-sm text-ink-faint">{hint}</p>}
      <Card>
        {shown === 0 ? (
          <div className="flex items-center gap-2 px-6 py-4 text-sm text-ink-faint">
            <CheckCircle2 className="h-4 w-4 text-mint-ink" aria-hidden />
            {empty}
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">{children}</div>
        )}
      </Card>
    </section>
  );
}

function Row({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <div
      className={`flex items-start justify-between gap-4 border-t border-t-ink/5 px-6 py-3 transition first:border-t-0 hover:bg-ink/[0.02] ${
        // A severity stripe, so scanning the list does not depend on reading it.
        //
        // Deliberately NOT inside a `divide-y divide-ink/5` parent: that emits
        // `border-color` (all four sides) on every child after the first, which
        // repainted this stripe and left only the first row marked. Separating
        // the row rule into border-t-* and border-l-* keeps them independent.
        accent ? "border-l-2 border-l-terracotta/60" : "border-l-2 border-l-transparent"
      }`}
    >
      {children}
    </div>
  );
}

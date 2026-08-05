import { createServiceClient } from "@/lib/supabase/service";
import { signatureOf } from "@/lib/ops";
import { sweepAbandonedRuns } from "@/lib/engine";

/**
 * The half of the operations picture that does not need telemetry.
 *
 * `ops_events` only knows what has happened since it was switched on, which on
 * the first night is nothing — and a dashboard that renders empty is read as
 * "all healthy", the single most dangerous thing an operations page can say by
 * accident.
 *
 * These numbers come from tables that already carry history: `runs`,
 * `activity_logs`, `profiles`. They are authoritative rather than sampled — a
 * failed run is a row, not a report of a row — so where the two disagree,
 * this side is right and the telemetry has a gap.
 *
 * Service role, because it deliberately crosses every user boundary: the
 * question is "is the deployment working", which no single account can answer.
 * The caller is responsible for the admin gate.
 */

export interface StuckRun {
  id: string;
  provider: string;
  model: string;
  startedAt: string | null;
  minutes: number;
  done: number;
  planned: number;
}

export interface FailureGroup {
  signature: string;
  count: number;
  lastSeen: string;
  example: string;
  engines: string[];
}

export interface LiveHealth {
  runs24h: { completed: number; failed: number; running: number; pending: number; total: number };
  successRate: number | null;
  /** Runs that say "running" but have not moved in a long time — the failure
   *  mode where an invocation dies without ever writing a status. */
  stuck: StuckRun[];
  failures: FailureGroup[];
  engines: { engine: string; completed: number; failed: number; rate: number | null }[];
  signups24h: number;
  totalUsers: number;
  apiErrors24h: number;
  lastRunAt: string | null;
  /** Set when a query failed, so the page can say "unknown" instead of "zero". */
  degraded: string | null;
}

/** A run still "running" past this is not slow, it is gone. Long, because a big
 *  prompt set against a slow provider is legitimately a multi-minute job. */
const STUCK_MINUTES = 30;

interface RunRow {
  id: string;
  status: string;
  provider: string;
  model: string;
  error: string | null;
  prompt_count: number;
  completed_count: number;
  started_at: string | null;
  created_at: string;
}

export function shapeLive(
  runs: RunRow[],
  now: number,
  signups24h: number,
  totalUsers: number,
  apiErrors24h: number,
  degraded: string | null = null,
): LiveHealth {
  const counts = { completed: 0, failed: 0, running: 0, pending: 0, total: runs.length };
  const failures = new Map<string, FailureGroup>();
  const engines = new Map<string, { completed: number; failed: number }>();
  const stuck: StuckRun[] = [];
  let lastRunAt: string | null = null;

  for (const r of runs) {
    if (!lastRunAt || r.created_at > lastRunAt) lastRunAt = r.created_at;
    if (r.status === "completed") counts.completed += 1;
    else if (r.status === "failed") counts.failed += 1;
    else if (r.status === "running") counts.running += 1;
    else counts.pending += 1;

    const engine = `${r.provider}/${r.model}`;
    const e = engines.get(engine) ?? { completed: 0, failed: 0 };
    if (r.status === "completed") e.completed += 1;
    if (r.status === "failed") e.failed += 1;
    engines.set(engine, e);

    if (r.status === "failed" && r.error) {
      // Group by the SHAPE of the message, so one provider outage is one line
      // with a count rather than fifty near-identical rows.
      const sig = signatureOf(r.error);
      const g = failures.get(sig);
      if (g) {
        g.count += 1;
        if (r.created_at > g.lastSeen) g.lastSeen = r.created_at;
        if (!g.engines.includes(engine)) g.engines.push(engine);
      } else {
        failures.set(sig, {
          signature: sig,
          count: 1,
          lastSeen: r.created_at,
          example: r.error.slice(0, 300),
          engines: [engine],
        });
      }
    }

    if (r.status === "running" || r.status === "pending") {
      const started = r.started_at ?? r.created_at;
      const minutes = Math.floor((now - new Date(started).getTime()) / 60000);
      if (minutes >= STUCK_MINUTES) {
        stuck.push({
          id: r.id,
          provider: r.provider,
          model: r.model,
          startedAt: r.started_at,
          minutes,
          done: r.completed_count,
          planned: r.prompt_count,
        });
      }
    }
  }

  const settled = counts.completed + counts.failed;
  return {
    runs24h: counts,
    // Null, not 100, when nothing settled — see ops-report for why that
    // distinction is the whole point of this number.
    successRate: settled > 0 ? Math.round((counts.completed / settled) * 100) : null,
    stuck: stuck.sort((a, b) => b.minutes - a.minutes),
    failures: [...failures.values()].sort(
      (a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen),
    ),
    engines: [...engines.entries()]
      // Only engines that have actually settled something. A row of zeroes says
      // nothing about health and pushes the real rows down.
      .filter(([, v]) => v.completed + v.failed > 0)
      .map(([engine, v]) => ({
        engine,
        ...v,
        rate: v.completed + v.failed > 0 ? Math.round((v.completed / (v.completed + v.failed)) * 100) : null,
      }))
      .sort((a, b) => b.failed - a.failed || b.completed - a.completed),
    signups24h,
    totalUsers,
    apiErrors24h,
    lastRunAt,
    degraded,
  };
}

export async function liveHealth(hours = 24): Promise<LiveHealth> {
  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  try {
    const admin = createServiceClient();
    // Settle provably-dead runs before reading. The cron tick does the same,
    // but it fires once a day — an operator looking at this page right now
    // should see a dead run as the failure it is, not as "running" for up to
    // 24 hours. Guarded and idempotent, so racing the cron (or another admin
    // tab) is harmless. Failure to sweep must not cost the page: the numbers
    // are the product here, the sweep is a courtesy.
    await sweepAbandonedRuns(admin).catch(() => {});
    const [runsRes, signupRes, usersRes, apiErrRes] = await Promise.all([
      admin
        .from("runs")
        .select("id, status, provider, model, error, prompt_count, completed_count, started_at, created_at")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(2000),
      admin.from("profiles").select("id", { count: "exact", head: true }).gte("created_at", sinceIso),
      admin.from("profiles").select("id", { count: "exact", head: true }),
      admin
        .from("activity_logs")
        .select("id", { count: "exact", head: true })
        .eq("status", "failure")
        .gte("created_at", sinceIso),
    ]);

    // Runs are the load-bearing query: without them every number below is a
    // lie of omission, so a failure there degrades the whole card rather than
    // quietly reporting zero runs and a clean bill of health.
    if (runsRes.error) throw runsRes.error;

    return shapeLive(
      (runsRes.data ?? []) as RunRow[],
      Date.now(),
      signupRes.count ?? 0,
      usersRes.count ?? 0,
      apiErrRes.count ?? 0,
    );
  } catch (err) {
    return shapeLive([], Date.now(), 0, 0, 0, err instanceof Error ? err.message : "query failed");
  }
}

/** Runs still in flight right now, regardless of age — "what is happening". */
export async function inFlightCount(): Promise<number> {
  try {
    const admin = createServiceClient();
    const { count } = await admin
      .from("runs")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "running"]);
    return count ?? 0;
  } catch {
    return 0;
  }
}

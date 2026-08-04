import { createServiceClient } from "@/lib/supabase/service";

/**
 * Reading operational telemetry back.
 *
 * Service-role only, because `ops_events` has RLS on and no policies —
 * `authenticated` cannot read it at all. The gate is the caller's, and it is
 * the admin allowlist; this module assumes it has already been passed.
 *
 * The shaping lives here rather than in the page so it can be tested without
 * rendering anything, and so the numbers behind "is it healthy" are inspectable
 * on their own.
 */

export interface OpsRow {
  kind: string;
  level: "info" | "warn" | "error";
  signature: string;
  hour: string;
  occurrences: number;
  sample: Record<string, unknown>;
  last_seen_at: string;
}

export interface Problem {
  signature: string;
  kind: string;
  /** Carried through so the view can separate "broken" from "worth knowing". */
  level: "warn" | "error";
  occurrences: number;
  lastSeen: string;
  source: string;
  sample: Record<string, unknown>;
}

export interface OpsReport {
  /** Whether telemetry is switched on at all. Without this, an empty dashboard
   *  reads as "everything is fine" when it means "nothing is being recorded". */
  enabled: boolean;
  windowHours: number;
  runs: { completed: number; failed: number; abandoned: number; successRate: number | null };
  errors: number;
  problems: Problem[];
  engines: { engine: string; completed: number; failed: number }[];
  quietSince: string | null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Roll the last `hours` of buckets into the answers an operator wants first:
 * is it working, what is failing, and where.
 */
export function shapeOps(rows: OpsRow[], hours: number, enabled: boolean): OpsReport {
  let completed = 0;
  let failed = 0;
  let abandoned = 0;
  let errors = 0;
  const problems = new Map<string, Problem>();
  const engines = new Map<string, { completed: number; failed: number }>();
  let latest: string | null = null;

  for (const r of rows) {
    const n = r.occurrences ?? 0;
    if (!latest || r.last_seen_at > latest) latest = r.last_seen_at;

    if (r.kind === "run.completed") completed += n;
    else if (r.kind === "run.failed") failed += n;
    else if (r.kind === "run.abandoned") abandoned += n;

    // Warnings are included, not just errors. A warn is something the code
    // deliberately chose to report; dropping it here would mean it could never
    // be seen anywhere, which makes recording it pointless. Only `errors`
    // counts strictly errors, since that is what the headline figure means.
    if (r.level === "error" || r.level === "warn") {
      if (r.level === "error") errors += n;
      const existing = problems.get(r.signature);
      const sample = asRecord(r.sample);
      const source = String(sample.source ?? r.kind);
      if (existing) {
        existing.occurrences += n;
        if (r.last_seen_at > existing.lastSeen) existing.lastSeen = r.last_seen_at;
      } else {
        problems.set(r.signature, {
          signature: r.signature,
          kind: r.kind,
          level: r.level === "error" ? "error" : "warn",
          occurrences: n,
          lastSeen: r.last_seen_at,
          source,
          sample,
        });
      }
    }

    if (r.kind === "run.completed" || r.kind === "run.failed") {
      const sample = asRecord(r.sample);
      const engine = `${sample.provider ?? "?"}/${sample.model ?? "?"}`;
      const e = engines.get(engine) ?? { completed: 0, failed: 0 };
      if (r.kind === "run.completed") e.completed += n;
      else e.failed += n;
      engines.set(engine, e);
    }
  }

  const attempted = completed + failed;
  return {
    enabled,
    windowHours: hours,
    runs: {
      completed,
      failed,
      abandoned,
      // Null rather than 100% when nothing ran: a success rate computed from
      // zero runs is not a healthy deployment, it is an idle one, and showing
      // "100%" for it is the most reassuring possible lie.
      successRate: attempted > 0 ? Math.round((completed / attempted) * 100) : null,
    },
    errors,
    problems: [...problems.values()].sort(
      (a, b) =>
        Number(b.level === "error") - Number(a.level === "error") ||
        b.occurrences - a.occurrences ||
        b.lastSeen.localeCompare(a.lastSeen),
    ),
    engines: [...engines.entries()]
      .map(([engine, v]) => ({ engine, ...v }))
      .sort((a, b) => b.failed - a.failed || b.completed - a.completed),
    quietSince: latest,
  };
}

/** Load and shape the last `hours` of operational telemetry. */
export async function opsReport(hours = 24): Promise<OpsReport> {
  const enabled = process.env.OPS_TELEMETRY === "1" || process.env.OPS_TELEMETRY === "true";
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from("ops_events")
      .select("kind, level, signature, hour, occurrences, sample, last_seen_at")
      .gte("hour", since)
      .order("last_seen_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    return shapeOps((data ?? []) as OpsRow[], hours, enabled);
  } catch {
    // A dashboard that 500s when its own storage is unhappy is a dashboard you
    // cannot use during an incident, which is the only time it matters.
    return shapeOps([], hours, enabled);
  }
}

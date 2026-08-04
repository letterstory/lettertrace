import { createServiceClient } from "@/lib/supabase/service";
import { fireAndForget } from "@/lib/notify";

/**
 * Operational telemetry: what this deployment is doing, and what is failing.
 *
 * Three rules, in priority order, and they are the same ones the alerting
 * follows — a monitoring system that can break the thing it monitors is worse
 * than no monitoring at all:
 *
 *   1. NEVER THROW. Every function here swallows its own failures. A run must
 *      not fail because recording that it succeeded failed.
 *   2. NEVER BLOCK. Callers hand these to `fireAndForget`; nothing waits.
 *   3. NEVER RECORD CONTENT. Provider and model, yes. Prompt text, brand
 *      names, answers, customer domains — never. The same line the phantom
 *      access telemetry draws, for the same reason: this is a public
 *      repository and an operator's database, not a log of what customers
 *      asked.
 *
 * Events are bucketed by (kind, signature, hour), so a provider failing on
 * every prompt of every run produces ONE row with a count rather than
 * thousands. The interesting fact is "this failed 400 times since 14:00", and
 * that is exactly what a bucket says.
 */

export type OpsLevel = "info" | "warn" | "error";

/** Sample payloads are debugging aids, not logs — keep them small and shapely. */
export type OpsSample = Record<string, string | number | boolean | null>;

/**
 * Reduce an error to something that identifies the PROBLEM rather than the
 * occurrence.
 *
 * Numbers, uuids and quoted strings are stripped, because a message like
 * `run 4f3c… failed after 12s` is the same problem every time it happens and
 * would otherwise create a new bucket per occurrence — which is precisely the
 * flood this design exists to prevent.
 */
export function signatureOf(input: string): string {
  return input
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    // No \b anchors: a digit followed by a letter has no word boundary, so
    // `\b\d+\b` silently fails to match "30s", "12ms", "5m" — exactly the
    // retry-after and duration values that differ on every occurrence of the
    // same error. With them, one rate limit would open a new row per retry.
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/'[^']*'|"[^"]*"/g, "<s>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Is operational telemetry switched on for this deployment? */
export function opsEnabled(): boolean {
  // Off unless asked for. A self-hosted install records nothing by default —
  // this repository is public, and someone running it did not sign up to be
  // measured. Set OPS_TELEMETRY=1 on a deployment you own.
  const v = process.env.OPS_TELEMETRY;
  return v === "1" || v === "true";
}

async function write(kind: string, level: OpsLevel, signature: string, sample: OpsSample) {
  if (!opsEnabled()) return;
  try {
    const admin = createServiceClient();
    await admin.rpc("record_ops_event", {
      p_kind: kind,
      p_level: level,
      p_signature: signature,
      p_sample: sample as never,
    });
  } catch (err) {
    // Deliberately swallowed, and deliberately still logged: if telemetry is
    // broken, the console is the only place left to say so.
    console.error(
      `[ops] could not record ${kind}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Record something that happened. Fire-and-forget; returns immediately.
 *
 * `signature` should describe the CLASS of event — an engine, a route, a
 * failure mode — never a specific id, or every occurrence becomes its own row.
 */
export function recordOps(
  kind: string,
  opts: { level?: OpsLevel; signature?: string; sample?: OpsSample } = {},
): void {
  fireAndForget(
    write(kind, opts.level ?? "info", signatureOf(opts.signature ?? kind), opts.sample ?? {}),
  );
}

/**
 * Record an error, with where it came from.
 *
 * `source` is the thing a person would need in order to start looking — a
 * route, a module, a job. It is part of the signature, so the same message
 * raised in two places stays two problems rather than one confusing one.
 */
export function recordOpsError(
  source: string,
  error: unknown,
  sample: OpsSample = {},
): void {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "Error";
  recordOps("error", {
    level: "error",
    signature: `${source}: ${message}`,
    sample: { ...sample, source, name, message: message.slice(0, 300) },
  });
}

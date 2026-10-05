import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { continueRun } from "@/lib/run-continuation";
import { fireAndForget } from "@/lib/notify";
import { recordOpsError } from "@/lib/ops";

// A leg gets a whole invocation, exactly like the run routes that start runs:
// RUN_TIME_BUDGET_MS is derived from this ceiling.
export const maxDuration = 800;

/**
 * POST /api/internal/runs/:id/continue — run the next leg of a run that reached
 * its time budget (lib/run-continuation.ts). Called only by the finishing leg,
 * with CRON_SECRET. Answers 202 as soon as the leg is accepted and executes it
 * after the response, so the caller can settle its own invocation in time.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isCronAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { leg?: unknown } | null;
  const leg = typeof body?.leg === "number" ? body.leg : NaN;
  if (!Number.isInteger(leg) || leg < 1) {
    return NextResponse.json({ error: "leg must be a positive integer" }, { status: 400 });
  }

  const supabase = createServiceClient();
  fireAndForget(
    continueRun(supabase, id, leg).catch((err) => {
      // continueRun settles the run itself on every path it foresees; a throw
      // here leaves the row "running" for the abandoned-run sweeper, which
      // measures from this leg's start.
      recordOpsError("run.continue", err, { run_id: id, leg });
    }),
  );
  return NextResponse.json({ accepted: true, runId: id, leg }, { status: 202 });
}

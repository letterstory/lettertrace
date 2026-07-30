import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { getRunStatus } from "@/lib/api-service";
import { logApiRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

// GET /api/v1/runs/:id/status — the bare run row, for polling background runs.
// The report route recomputes aggregate math over every response; this one is
// a single row read, cheap enough to hit every few seconds.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "runs:read", "v1");
  if (auth instanceof Response) return auth;

  const run = await getRunStatus(auth.supabase, auth.userId, params.id);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  await logApiRequest(auth, request, "v1", {
    category: "run",
    action: "api.read_status",
    summary: `Polled run ${params.id} (${run.status}) via the API`,
    statusCode: 200,
    projectId: run.project_id,
    targetType: "run",
    targetId: params.id,
  });
  return NextResponse.json({
    run: {
      id: run.id,
      project_id: run.project_id,
      status: run.status,
      provider: run.provider,
      model: run.model,
      prompt_count: run.prompt_count,
      completed_count: run.completed_count,
      replicates: run.replicates,
      error: run.error,
      started_at: run.started_at,
      finished_at: run.finished_at,
    },
  });
}

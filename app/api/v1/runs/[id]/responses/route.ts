import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { getRunResponses } from "@/lib/api-service";
import { logApiRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

// GET /api/v1/runs/:id/responses — the run's raw artifacts: each response's
// full text plus the cited sources and detected mentions.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "runs:read", "v1");
  if (auth instanceof Response) return auth;

  const result = await getRunResponses(auth.supabase, auth.userId, params.id);
  if (!result) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  await logApiRequest(auth, request, "v1", {
    category: "run",
    action: "api.read_responses",
    summary: `Read ${result.responses.length} raw response${result.responses.length === 1 ? "" : "s"} for run ${params.id} via the API`,
    statusCode: 200,
    projectId: result.run.project_id,
    targetType: "run",
    targetId: params.id,
  });
  return NextResponse.json(result);
}

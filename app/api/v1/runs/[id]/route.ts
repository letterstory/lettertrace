import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { getRunReport } from "@/lib/api-service";
import { logApiRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

// GET /api/v1/runs/:id — share-of-voice report for one run.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "runs:read", "v1");
  if (auth instanceof Response) return auth;

  const report = await getRunReport(auth.supabase, auth.userId, params.id);
  if (!report) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  await logApiRequest(auth, request, "v1", {
    category: "run",
    action: "api.read_report",
    summary: `Read the share-of-voice report for run ${params.id} via the API`,
    statusCode: 200,
    projectId: report.run.project_id,
    targetType: "run",
    targetId: params.id,
  });
  return NextResponse.json(report);
}

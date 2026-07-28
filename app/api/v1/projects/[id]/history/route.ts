import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { getProjectHistory } from "@/lib/api-service";
import { logApiRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

// GET /api/v1/projects/:id/history?limit=30
//
// Brand visibility across the project's completed runs, oldest first. A single
// run can't answer "is this working yet" — for a client with no mentions, which
// is the normal state for months, the question is whether the rate is inching
// up, whether their own pages have started being cited, and whether the first
// mention has landed. `firstMentionAt` is that event.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "projects:read", "v1");
  if (auth instanceof Response) return auth;

  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 30;
  if (limitParam && (!Number.isFinite(limit) || limit < 1)) {
    return NextResponse.json(
      { error: "limit must be a positive number (max 100)." },
      { status: 400 },
    );
  }

  const history = await getProjectHistory(auth.supabase, auth.userId, params.id, limit);
  if (!history) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  await logApiRequest(auth, request, "v1", {
    category: "run",
    action: "api.read_history",
    summary: `Read brand-visibility history (${history.points.length} runs) via the API`,
    statusCode: 200,
    projectId: params.id,
    targetType: "project",
    targetId: params.id,
  });
  return NextResponse.json(history);
}

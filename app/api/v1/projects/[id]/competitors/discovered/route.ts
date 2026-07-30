import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { discoverProjectCompetitors } from "@/lib/api-service";
import { logApiRequest } from "@/lib/activity";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// GET /api/v1/projects/:id/competitors/discovered — companies the stored
// answers named that this project doesn't track. Candidates, not truth: the
// caller confirms which become tracked competitors (POST ../competitors).
// Reads text already in the database — no provider call, no key needed.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "projects:read", "v1");
  if (auth instanceof Response) return auth;

  try {
    const discovered = await discoverProjectCompetitors(auth.supabase, auth.userId, params.id);
    if (!discovered) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    await logApiRequest(auth, request, "v1", {
      category: "competitor",
      action: "api.discover_competitors",
      summary: `Discovered ${discovered.companies.length} untracked compan${discovered.companies.length === 1 ? "y" : "ies"} via the API`,
      statusCode: 200,
      projectId: params.id,
      targetType: "project",
      targetId: params.id,
      metadata: { answers_scanned: discovered.answersScanned },
    });
    return NextResponse.json(discovered);
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}

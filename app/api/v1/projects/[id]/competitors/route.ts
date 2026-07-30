import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { listProjectCompetitors, createCompetitors } from "@/lib/api-service";
import { logApiRequest } from "@/lib/activity";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// GET /api/v1/projects/:id/competitors — the project's tracked competitors.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "projects:read", "v1");
  if (auth instanceof Response) return auth;

  const competitors = await listProjectCompetitors(auth.supabase, auth.userId, params.id);
  if (!competitors) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  await logApiRequest(auth, request, "v1", {
    category: "competitor",
    action: "api.list_competitors",
    summary: `Listed ${competitors.length} competitor${competitors.length === 1 ? "" : "s"} via the API`,
    statusCode: 200,
    projectId: params.id,
    targetType: "project",
    targetId: params.id,
  });
  return NextResponse.json({ competitors });
}

// POST /api/v1/projects/:id/competitors — add tracked competitors.
// Body: { competitors: [{ name, aliases?, domain? }] }. Names the project
// already tracks are skipped (counted), not errors.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "projects:write", "v1");
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const outcome = await createCompetitors(
      auth.supabase,
      auth.userId,
      params.id,
      (body as Record<string, unknown> | null)?.competitors,
    );
    if (!outcome.ok) {
      const status = outcome.code === "not_found" ? 404 : 400;
      await logApiRequest(auth, request, "v1", {
        category: "competitor",
        action: "api.create_competitors",
        status: "failure",
        statusCode: status,
        projectId: params.id,
        targetType: "project",
        targetId: params.id,
        summary: `Competitors not added via the API: ${outcome.message}`,
        metadata: { reason: outcome.code },
      });
      return NextResponse.json({ error: outcome.message }, { status });
    }
    await logApiRequest(auth, request, "v1", {
      category: "competitor",
      action: "api.create_competitors",
      statusCode: 201,
      projectId: params.id,
      targetType: "project",
      targetId: params.id,
      summary: `Added ${outcome.created.length} competitor${outcome.created.length === 1 ? "" : "s"} via the API (${outcome.skipped} skipped)`,
      metadata: { created: outcome.created.length, skipped: outcome.skipped },
    });
    return NextResponse.json(
      { competitors: outcome.created, skipped: outcome.skipped },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { getOwnedProject, projectSummary, updateProject } from "@/lib/api-service";
import { logApiRequest } from "@/lib/activity";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// GET /api/v1/projects/:id — one project's settings (the list route trims the
// same way; this is the single-project read that was oddly missing).
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "projects:read", "v1");
  if (auth instanceof Response) return auth;

  const project = await getOwnedProject(auth.supabase, auth.userId, params.id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  await logApiRequest(auth, request, "v1", {
    category: "project",
    action: "api.read_project",
    summary: `Read organization "${project.name}" via the API`,
    statusCode: 200,
    projectId: params.id,
    targetType: "project",
    targetId: params.id,
  });
  return NextResponse.json({ project: projectSummary(project) });
}

// PATCH /api/v1/projects/:id — update settings; only sent fields change.
// Updatable: name, brand_name, brand_aliases, brand_domains, description,
// use_web_search, replicates, default_provider, default_model. Replicates
// apply from the NEXT run; schedule is not accepted (API callers orchestrate
// their own cadence).
export async function PATCH(
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
    const outcome = await updateProject(
      auth.supabase,
      auth.userId,
      params.id,
      (body ?? {}) as Record<string, unknown>,
    );
    if (!outcome.ok) {
      const status = outcome.code === "not_found" ? 404 : 400;
      await logApiRequest(auth, request, "v1", {
        category: "project",
        action: "api.update_project",
        status: "failure",
        statusCode: status,
        projectId: params.id,
        targetType: "project",
        targetId: params.id,
        summary: `Organization not updated via the API: ${outcome.message}`,
        metadata: { reason: outcome.code },
      });
      return NextResponse.json({ error: outcome.message }, { status });
    }
    await logApiRequest(auth, request, "v1", {
      category: "project",
      action: "api.update_project",
      statusCode: 200,
      projectId: params.id,
      targetType: "project",
      targetId: params.id,
      summary: `Updated organization "${outcome.project.name}" via the API`,
      metadata: { fields: Object.keys((body ?? {}) as Record<string, unknown>) },
    });
    return NextResponse.json({ project: projectSummary(outcome.project) });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}

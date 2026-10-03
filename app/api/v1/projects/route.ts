import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { getProjects } from "@/lib/data";
import { createProject, projectSummary } from "@/lib/api-service";
import { deriveChannel, logApiRequest } from "@/lib/activity";
import { captureServerEvent } from "@/lib/posthog-server";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// GET /api/v1/projects — list the caller's organizations.
// Auth: Authorization: Bearer <lettertrace api key>
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "projects:read", "v1");
  if (auth instanceof Response) return auth;

  const projects = await getProjects(auth.supabase, auth.userId);
  await logApiRequest(auth, request, "v1", {
    category: "project",
    action: "api.list_projects",
    summary: `Listed ${projects.length} organization${projects.length === 1 ? "" : "s"} via the API`,
    statusCode: 200,
    metadata: { count: projects.length },
  });
  return NextResponse.json({ projects: projects.map(projectSummary) });
}

// POST /api/v1/projects — create an organization for the caller.
// Body: { name, brand_name, brand_aliases?, brand_domains?, description?,
//         default_provider?, default_model?, use_web_search? }
export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "projects:write", "v1");
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const outcome = await createProject(
      auth.supabase,
      auth.userId,
      (body ?? {}) as Record<string, unknown>,
    );
    if (!outcome.ok) {
      await logApiRequest(auth, request, "v1", {
        category: "project",
        action: "api.create_project",
        status: "failure",
        statusCode: 400,
        summary: `Organization not created via the API: ${outcome.message}`,
      });
      return NextResponse.json({ error: outcome.message }, { status: 400 });
    }
    await logApiRequest(auth, request, "v1", {
      category: "project",
      action: "project.created",
      statusCode: 201,
      projectId: outcome.project.id,
      targetType: "project",
      targetId: outcome.project.id,
      summary: `Created organization "${outcome.project.name}" via the API`,
    });
    const channel = deriveChannel({
      tokenType: auth.tokenType,
      clientId: auth.clientId,
      surface: "v1",
    });
    await captureServerEvent(auth.userId, "org_created", {
      org_id: outcome.project.id,
      billing_owner_id: outcome.project.user_id,
      channel,
      source: "manual",
    }).catch(() => {});
    if (outcome.project.schedule && outcome.project.schedule !== "off") {
      await captureServerEvent(auth.userId, "schedule_enabled", {
        org_id: outcome.project.id,
        billing_owner_id: outcome.project.user_id,
        channel,
        schedule: outcome.project.schedule,
      }).catch(() => {});
    }
    return NextResponse.json(
      { project: projectSummary(outcome.project) },
      { status: 201 },
    );
  } catch (e) {
    await logApiRequest(auth, request, "v1", {
      category: "project",
      action: "api.create_project",
      status: "failure",
      statusCode: 500,
      summary: `Organization creation failed via the API: ${humanError(e)}`,
    });
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}

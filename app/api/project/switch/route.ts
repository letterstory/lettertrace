import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setActiveProject } from "@/lib/data";
import { logDashboard } from "@/lib/activity";

// POST /api/project/switch { projectId }
// Point the dashboard at another of the signed-in user's organizations.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const projectId = (body as { projectId?: unknown })?.projectId;
  if (typeof projectId !== "string" || !projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  // Only switch to an organization the user can actually reach — one they own
  // or one a teammate invited them into. The cookie client's RLS already only
  // returns those, so the lookup succeeding IS the check; a miss is
  // indistinguishable from "no such project", which is the right answer to
  // give someone who can't see it either way.
  const { data: project } = await supabase
    .from("projects")
    .select("id, name")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  await setActiveProject(supabase, user.id, projectId);
  await logDashboard(user, request, {
    category: "project",
    action: "project.switched",
    summary: `Switched to organization "${(project as { name?: string }).name ?? projectId}"`,
    projectId,
    targetType: "project",
    targetId: projectId,
  });
  return NextResponse.json({ ok: true, projectId });
}

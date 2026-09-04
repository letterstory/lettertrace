import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getProject } from "@/lib/data";
import { logDashboard } from "@/lib/activity";
import { removeMember } from "@/lib/team";

export const dynamic = "force-dynamic";

// DELETE /api/team/members?userId=… — take somebody off the team.
//
// One route for two actions that are the same write: the OWNER removing a
// member, and a MEMBER removing themselves (leaving). Splitting them would
// duplicate the write and invite the two copies to disagree about clearing the
// dashboard pointer.
//
// The owner cannot be removed by anyone, including themselves, and that falls
// out of the model rather than being enforced: they have no membership row to
// delete. Handing an organization to someone else is a different feature
// (transfer), and pretending "remove the owner" means that would be a way to
// orphan a project's data.
export async function DELETE(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await getProject(supabase, user.id);
  if (!project) {
    return NextResponse.json({ error: "Create a project first" }, { status: 400 });
  }

  const userId = new URL(request.url).searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const leaving = userId === user.id;
  if (!leaving && project.user_id !== user.id) {
    return NextResponse.json(
      { error: "Only the owner of this organization can remove people from it." },
      { status: 403 },
    );
  }
  if (userId === project.user_id) {
    return NextResponse.json(
      {
        error:
          "The owner can't be removed from their own organization. Delete it instead, or hand it over first.",
      },
      { status: 400 },
    );
  }

  const svc = createServiceClient();
  const removed = await removeMember(svc, project.id, userId);
  if (!removed) {
    return NextResponse.json({ error: "They're not on this team." }, { status: 404 });
  }

  const organization = project.brand_name || project.name;
  await logDashboard(user, request, {
    category: "team",
    action: leaving ? "team.left" : "team.removed",
    summary: leaving
      ? `Left "${organization}"`
      : `Removed a member from "${organization}"`,
    projectId: project.id,
    targetType: "member",
    targetId: userId,
  });
  return NextResponse.json({ ok: true, left: leaving });
}

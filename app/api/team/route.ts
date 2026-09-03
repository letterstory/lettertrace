import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getProject } from "@/lib/data";
import { loadTeam } from "@/lib/team";

export const dynamic = "force-dynamic";

// GET /api/team — who is on the active organization.
//
// The Settings card renders this on the server for its first paint; this route
// exists so the card can refresh itself after an invite or a removal without a
// full page reload.
export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // getProject is already membership-aware, so a teammate reading their own
  // team gets it — the project they can see is the project they can ask about.
  const project = await getProject(supabase, user.id);
  if (!project) {
    return NextResponse.json({ error: "Create a project first" }, { status: 400 });
  }

  const team = await loadTeam(createServiceClient(), project);
  const isOwner = project.user_id === user.id;
  return NextResponse.json({
    isOwner,
    members: team.members,
    // Outstanding invitations are the owner's list of who they have asked, and
    // name addresses that may not have accounts. Members see the team, not the
    // asking.
    invites: isOwner ? team.invites : [],
  });
}

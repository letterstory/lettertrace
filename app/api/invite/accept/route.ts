import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { setActiveProject } from "@/lib/data";
import { logDashboard } from "@/lib/activity";
import { acceptInvite } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Each refusal gets its own sentence: "expired" and "this was for someone
 *  else" send the reader to completely different fixes, and collapsing them
 *  into "invalid invitation" is how support tickets are made. */
const REFUSALS: Record<string, { message: string; status: number }> = {
  unknown: { message: "That invitation link isn't valid.", status: 404 },
  expired: {
    message: "That invitation has expired. Ask for a new one.",
    status: 410,
  },
  revoked: {
    message: "That invitation was withdrawn.",
    status: 410,
  },
  spent: {
    message: "That invitation has already been used by someone else.",
    status: 409,
  },
  "wrong-email": {
    message:
      "That invitation was sent to a different address. Sign in as the address it was sent to, then open the link again.",
    status: 403,
  },
  failed: { message: "Could not accept the invitation. Try again.", status: 500 },
};

// POST /api/invite/accept { token } — join an organization.
//
// A POST behind a button, never a GET on the link itself: mail scanners and
// link previewers fetch every URL in an incoming message, and an invitation
// that could be accepted by fetching it would routinely be spent by a security
// appliance before its recipient ever saw it.
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
  const token = (body as { token?: unknown })?.token;
  if (typeof token !== "string" || !token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  const svc = createServiceClient();
  const result = await acceptInvite(svc, {
    token,
    userId: user.id,
    userEmail: user.email ?? null,
  });
  if (!result.ok) {
    const refusal = REFUSALS[result.reason] ?? REFUSALS.failed;
    return NextResponse.json({ error: refusal.message }, { status: refusal.status });
  }

  // Land them IN the organization they just joined rather than in whichever
  // one they last looked at. Accepting an invitation and then having to hunt
  // for it in a switcher is the moment the feature feels broken.
  await setActiveProject(supabase, user.id, result.projectId);

  if (!result.alreadyMember) {
    await logDashboard(user, request, {
      category: "team",
      action: "team.joined",
      summary: "Joined an organization by invitation",
      projectId: result.projectId,
      targetType: "project",
      targetId: result.projectId,
    });
  }

  return NextResponse.json({ ok: true, projectId: result.projectId });
}

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getProject } from "@/lib/data";
import { logDashboard } from "@/lib/activity";
import { inviteEmail, sendMail } from "@/lib/notify";
import { createInvite, inviteUrl, normalizeInviteEmail, revokeInvite } from "@/lib/team";
import { resolveRedirectBase } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Reasons createInvite can decline, as sentences a person can act on. */
const REFUSALS: Record<string, { message: string; status: number }> = {
  self: { message: "You're already on this team — that's your own address.", status: 400 },
  "already-member": { message: "They're already on this team.", status: 409 },
  "already-invited": {
    message: "They already have an invitation open. Revoke it first to send a new one.",
    status: 409,
  },
  failed: { message: "Could not create the invitation. Try again.", status: 500 },
};

// POST /api/team/invites { email } — invite somebody into the active organization.
//
// Owner-only. A member can see the team but cannot grow it: handing out access
// to the owner's data and the owner's API spend is the owner's decision.
export async function POST(request: Request) {
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
  if (project.user_id !== user.id) {
    return NextResponse.json(
      { error: "Only the owner of this organization can invite people to it." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const email = normalizeInviteEmail((body as { email?: unknown })?.email);
  if (!email) {
    return NextResponse.json({ error: "Enter an email address to invite." }, { status: 400 });
  }

  const svc = createServiceClient();
  const result = await createInvite(svc, {
    projectId: project.id,
    email,
    invitedBy: user.id,
    inviterEmail: user.email ?? null,
  });
  if (!result.ok) {
    const refusal = REFUSALS[result.reason] ?? REFUSALS.failed;
    return NextResponse.json({ error: refusal.message }, { status: refusal.status });
  }

  // The plaintext token exists only here, in this request, for this send.
  const base = resolveRedirectBase(process.env.NEXT_PUBLIC_SITE_URL, new URL(request.url).origin);
  const url = inviteUrl(base, result.token);
  const outcome = await sendMail(
    inviteEmail({
      to: email,
      url,
      inviterEmail: user.email ?? null,
      organization: project.brand_name || project.name,
      expiresAt: result.invite.expiresAt,
    }),
  );

  // Unlike an operator alert, an unsent invitation is a failure and must say
  // so: the invitee is waiting for a link that will never arrive, and the
  // inviter is the only person who can notice. The row stays — revoking it is
  // one click, and deleting it here would race a mail that did in fact go out.
  if (outcome !== "sent") {
    await logDashboard(user, request, {
      category: "team",
      action: "team.invite_send_failed",
      status: "failure",
      summary: `Could not email an invitation to ${email}`,
      projectId: project.id,
      targetType: "invite",
      targetId: result.invite.id,
      metadata: { email, outcome },
    });
    return NextResponse.json(
      {
        error:
          outcome === "not-configured"
            ? "Email isn't configured on this deployment, so the invitation couldn't be sent. Set RESEND_API_KEY, then revoke and re-send."
            : "The invitation was created but the email failed to send. Revoke it and try again.",
        invite: result.invite,
      },
      { status: 502 },
    );
  }

  await logDashboard(user, request, {
    category: "team",
    action: "team.invited",
    summary: `Invited ${email} to "${project.brand_name || project.name}"`,
    projectId: project.id,
    targetType: "invite",
    targetId: result.invite.id,
    // The email, never the token: a log is a place a credential must not be.
    metadata: { email },
  });

  return NextResponse.json({ invite: result.invite });
}

// DELETE /api/team/invites?id=… — withdraw an outstanding invitation.
//
// A query param rather than a nested route because the id identifies a row on
// the active project, which the route already resolves — and the token, which
// is what the invitee holds, is deliberately never a thing the owner can name.
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
  if (project.user_id !== user.id) {
    return NextResponse.json(
      { error: "Only the owner of this organization can manage its invitations." },
      { status: 403 },
    );
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // Scoped to this project inside revokeInvite, so an id from somebody else's
  // organization simply isn't found.
  const revoked = await revokeInvite(createServiceClient(), project.id, id);
  if (!revoked) {
    return NextResponse.json(
      { error: "That invitation is already accepted, revoked, or gone." },
      { status: 404 },
    );
  }

  await logDashboard(user, request, {
    category: "team",
    action: "team.invite_revoked",
    summary: `Revoked an invitation to "${project.brand_name || project.name}"`,
    projectId: project.id,
    targetType: "invite",
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}

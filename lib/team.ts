import type { SupabaseClient } from "@supabase/supabase-js";
import { generateInviteToken, sha256Hex } from "@/lib/crypto";
// Re-exported so "who is on what" has one import site, even though the query
// itself has to live somewhere a client bundle can safely reach.
export { memberProjectIds } from "@/lib/project-access";

/**
 * Team collaboration: letting more than one person into an organization.
 *
 * A project is what the dashboard calls an organization, and its owner is
 * still projects.user_id — membership is additive, so nothing that already
 * reasons about "the owner" (billing, key resolution, the scheduler, /admin)
 * changes meaning. See the schema's team section for why.
 *
 * The invitation itself is modelled on the OAuth device code, because it is
 * the same object: an opaque high-entropy secret, stored only as its SHA-256
 * digest, spendable once, expiring on its own. Mail is not a secure channel,
 * so the link is treated as a bearer credential throughout — including the
 * part people find surprising, that the invited ADDRESS is checked at
 * acceptance. A forwarded link does not admit the person it was forwarded to.
 *
 * Everything above the loaders is pure and unit-tested; the loaders take a
 * service-role client and do the writes. Service-role rather than the caller's
 * cookie client on purpose: acceptance is performed by somebody who, by
 * definition, cannot yet see the project they are joining, so RLS can't be the
 * boundary there. Every function below re-checks the caller explicitly.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type TeamRole = "owner" | "member";

export interface TeamMemberRow {
  project_id: string;
  user_id: string;
  role: string;
  invited_by: string | null;
  created_at: string;
}

export interface InviteRow {
  id: string;
  project_id: string;
  email: string;
  invited_by: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
}

/** One row of the team list: the owner and everyone invited in. */
export interface TeamMember {
  userId: string;
  email: string | null;
  role: TeamRole;
  /** Owner: when they created the project. Member: when they accepted. */
  joinedAt: string;
  /** Null for the owner, and for a member whose inviter's account is gone. */
  invitedByEmail: string | null;
}

export interface PendingInvite {
  id: string;
  email: string;
  invitedAt: string;
  expiresAt: string;
  /** Expired invites still list — "it lapsed" is a different fix from "they
   *  never got it", and the operator of the team needs to tell them apart. */
  expired: boolean;
}

export interface Team {
  members: TeamMember[];
  invites: PendingInvite[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** How long an invitation stays live. A week: long enough to survive a holiday
 *  or a full inbox, short enough that a link leaked from a mailbox archive a
 *  year later is already dead. */
export const INVITE_TTL_MS = 7 * DAY_MS;

/** The stored/compared form of an invited address: trimmed and lowercased.
 *  Null when the string isn't shaped like an address at all, which is the
 *  signal the route turns into a 400 rather than mailing into the void. */
export function normalizeInviteEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  // Deliberately loose. Address syntax is famously more permissive than any
  // regex worth writing, and the real validation is that a human has to
  // receive the mail and click the link — so this only rejects the shapes that
  // are certainly not addresses.
  if (email.length < 3 || email.length > 320) return null;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return null;
  const domain = email.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  if (/\s/.test(email)) return null;
  return email;
}

export type InviteState = "pending" | "expired" | "accepted" | "revoked";

/** What an invite row currently is. Order matters: a revoked invite is revoked
 *  even if it also happens to have expired, because that is the answer the
 *  person who revoked it expects to see. */
export function inviteState(invite: InviteRow, now: number): InviteState {
  if (invite.revoked_at) return "revoked";
  if (invite.accepted_at) return "accepted";
  return Date.parse(invite.expires_at) <= now ? "expired" : "pending";
}

/** The owner plus the accepted members, owner first and then oldest-joined —
 *  the order a team list reads best in, and stable across renders. */
export function shapeTeam(
  project: { user_id: string; created_at: string },
  members: TeamMemberRow[],
  invites: InviteRow[],
  emails: Map<string, string | null>,
  now: number,
): Team {
  const owner: TeamMember = {
    userId: project.user_id,
    email: emails.get(project.user_id) ?? null,
    role: "owner",
    joinedAt: project.created_at,
    invitedByEmail: null,
  };

  const rest: TeamMember[] = members
    // The owner has no membership row by design, but a row that named them
    // would be a duplicate rather than a second person — drop it defensively.
    .filter((m) => m.user_id !== project.user_id)
    .map((m) => ({
      userId: m.user_id,
      email: emails.get(m.user_id) ?? null,
      role: "member" as const,
      joinedAt: m.created_at,
      invitedByEmail: m.invited_by ? (emails.get(m.invited_by) ?? null) : null,
    }))
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));

  const pending: PendingInvite[] = invites
    .filter((i) => {
      const state = inviteState(i, now);
      return state === "pending" || state === "expired";
    })
    .map((i) => ({
      id: i.id,
      email: i.email,
      invitedAt: i.created_at,
      expiresAt: i.expires_at,
      expired: inviteState(i, now) === "expired",
    }))
    .sort((a, b) => b.invitedAt.localeCompare(a.invitedAt));

  return { members: [owner, ...rest], invites: pending };
}

/** The URL that goes in the email. Its own function so the route, the mail
 *  body, and the tests can never disagree about the shape. */
export function inviteUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/invite/${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The invited members of a project — NOT the owner, who has no membership
 *  row. Used by the API surface, where the service-role client bypasses RLS
 *  and an explicit check IS the boundary. */
export async function projectMemberIds(
  svc: SupabaseClient,
  projectId: string,
): Promise<string[]> {
  const { data } = await svc
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId);
  return ((data as { user_id: string }[] | null) ?? []).map((r) => r.user_id);
}

/** The team behind /dashboard/settings: members and outstanding invites. */
export async function loadTeam(
  svc: SupabaseClient,
  project: { id: string; user_id: string; created_at: string },
  now = Date.now(),
): Promise<Team> {
  const [membersQ, invitesQ] = await Promise.all([
    svc.from("project_members").select("*").eq("project_id", project.id),
    svc.from("project_invites").select("*").eq("project_id", project.id),
  ]);
  const members = (membersQ.data as TeamMemberRow[] | null) ?? [];
  const invites = (invitesQ.data as InviteRow[] | null) ?? [];

  // One lookup for every id the list will show: members, and whoever invited
  // them. Profiles are readable here because svc is service-role.
  const ids = new Set<string>([project.user_id]);
  for (const m of members) {
    ids.add(m.user_id);
    if (m.invited_by) ids.add(m.invited_by);
  }
  const { data: profiles } = await svc
    .from("profiles")
    .select("id, email")
    .in("id", [...ids]);
  const emails = new Map(
    ((profiles as { id: string; email: string | null }[] | null) ?? []).map((p) => [p.id, p.email]),
  );

  return shapeTeam(project, members, invites, emails, now);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type InviteResult =
  | { ok: true; token: string; invite: PendingInvite }
  | { ok: false; reason: "already-member" | "already-invited" | "self" | "failed" };

/**
 * Create an invitation and return its plaintext token exactly once.
 *
 * The caller must already have been checked as the project's owner — this
 * function is the mechanism, not the gate. It refuses the three cases that are
 * mistakes rather than errors (inviting yourself, someone already on the team,
 * someone already invited) with reasons the route turns into readable text.
 */
export async function createInvite(
  svc: SupabaseClient,
  args: { projectId: string; email: string; invitedBy: string; inviterEmail: string | null },
  now = Date.now(),
): Promise<InviteResult> {
  const email = args.email;
  if (args.inviterEmail && args.inviterEmail.trim().toLowerCase() === email) {
    return { ok: false, reason: "self" };
  }

  // Already on the team? Matched by address rather than user id, because the
  // person inviting knows an address and nothing else.
  const memberIds = await projectMemberIds(svc, args.projectId);
  if (memberIds.length > 0) {
    const { data: existing } = await svc
      .from("profiles")
      .select("id, email")
      .in("id", memberIds);
    const emails = ((existing as { email: string | null }[] | null) ?? []).map((p) =>
      (p.email ?? "").trim().toLowerCase(),
    );
    if (emails.includes(email)) return { ok: false, reason: "already-member" };
  }

  const token = generateInviteToken();
  const expiresAt = new Date(now + INVITE_TTL_MS).toISOString();
  const { data, error } = await svc
    .from("project_invites")
    .insert({
      project_id: args.projectId,
      email,
      token_hash: sha256Hex(token),
      invited_by: args.invitedBy,
      expires_at: expiresAt,
    })
    .select("*")
    .maybeSingle();

  if (error) {
    // The partial unique index is the race-proof version of "already invited":
    // two people inviting the same address at once both get here, and exactly
    // one of them created the row.
    return { ok: false, reason: error.code === "23505" ? "already-invited" : "failed" };
  }
  const row = data as InviteRow;
  return {
    ok: true,
    token,
    invite: {
      id: row.id,
      email: row.email,
      invitedAt: row.created_at,
      expiresAt: row.expires_at,
      expired: false,
    },
  };
}

export interface InvitePreview {
  /** What the page should say. "ready" is the only one with an Accept button. */
  state: InviteState | "unknown" | "wrong-email" | "ready";
  /** The organization being joined, when the token resolved to one. */
  organization: string | null;
  /** Who sent it, for "is this expected?". */
  invitedByEmail: string | null;
  /** The address the invitation was sent to — shown on the wrong-email screen,
   *  because "sign in as someone else" is useless advice without the someone. */
  email: string | null;
  expiresAt: string | null;
  /** They are already on this team, so the page can send them straight in. */
  alreadyMember: boolean;
}

/**
 * What an invitation link is, WITHOUT spending it.
 *
 * A separate read from acceptInvite because acceptance must be a POST behind a
 * button, not a GET. Corporate mail scanners and link previewers fetch every
 * URL in an incoming message; if opening the link were enough to join, an
 * invitation would routinely be accepted by a security appliance before its
 * recipient ever saw it, and the row would be spent with nobody on the team.
 */
export async function previewInvite(
  svc: SupabaseClient,
  token: string,
  viewer: { userId: string; email: string | null },
  now = Date.now(),
): Promise<InvitePreview> {
  const empty = {
    organization: null,
    invitedByEmail: null,
    email: null,
    expiresAt: null,
    alreadyMember: false,
  };

  const { data } = await svc
    .from("project_invites")
    .select("*")
    .eq("token_hash", sha256Hex(token))
    .maybeSingle();
  const invite = data as InviteRow | null;
  if (!invite) return { state: "unknown", ...empty };

  const [projectQ, inviterQ, membershipQ] = await Promise.all([
    svc.from("projects").select("name, brand_name, user_id").eq("id", invite.project_id).maybeSingle(),
    svc.from("profiles").select("email").eq("id", invite.invited_by).maybeSingle(),
    svc
      .from("project_members")
      .select("user_id")
      .eq("project_id", invite.project_id)
      .eq("user_id", viewer.userId)
      .maybeSingle(),
  ]);
  const project = projectQ.data as { name: string; brand_name: string; user_id: string } | null;
  const details = {
    organization: project ? project.brand_name || project.name : null,
    invitedByEmail: (inviterQ.data as { email: string | null } | null)?.email ?? null,
    email: invite.email,
    expiresAt: invite.expires_at,
    alreadyMember: Boolean(membershipQ.data) || project?.user_id === viewer.userId,
  };

  // Already in? Say so and let the page offer the way in, whatever the token's
  // own state is — an accepted invite re-opened from an inbox is the common
  // case, and "this link is used up" is a strange thing to tell someone about
  // a team they are on.
  if (details.alreadyMember) return { state: "ready", ...details };

  const state = inviteState(invite, now);
  if (state !== "pending") return { state, ...details };

  const signedInAs = (viewer.email ?? "").trim().toLowerCase();
  if (signedInAs !== invite.email.trim().toLowerCase()) {
    return { state: "wrong-email", ...details };
  }
  return { state: "ready", ...details };
}

export type AcceptResult =
  | { ok: true; projectId: string; alreadyMember: boolean }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "spent" | "wrong-email" | "failed" };

/**
 * Redeem an invitation token.
 *
 * Every refusal is a distinct reason because the page says different things
 * for each: "this link has expired" and "this invite was for someone else" send
 * the reader to different fixes, and collapsing them into "invalid" is how
 * support tickets are made.
 *
 * The address check is the deliberate one. An invite names a person, so signing
 * in as somebody else and clicking their link does not work — even though the
 * token is valid. That is the difference between an invitation and a shared
 * password.
 */
export async function acceptInvite(
  svc: SupabaseClient,
  args: { token: string; userId: string; userEmail: string | null },
  now = Date.now(),
): Promise<AcceptResult> {
  const { data } = await svc
    .from("project_invites")
    .select("*")
    .eq("token_hash", sha256Hex(args.token))
    .maybeSingle();
  const invite = data as InviteRow | null;
  if (!invite) return { ok: false, reason: "unknown" };

  switch (inviteState(invite, now)) {
    case "revoked":
      return { ok: false, reason: "revoked" };
    case "accepted":
      // Someone re-opening the link they already used should land in the
      // project, not on an error — but only if they are the one who used it.
      return invite.accepted_by === args.userId
        ? { ok: true, projectId: invite.project_id, alreadyMember: true }
        : { ok: false, reason: "spent" };
    case "expired":
      return { ok: false, reason: "expired" };
    case "pending":
      break;
  }

  const signedInAs = (args.userEmail ?? "").trim().toLowerCase();
  if (signedInAs !== invite.email.trim().toLowerCase()) {
    return { ok: false, reason: "wrong-email" };
  }

  // The owner clicking their own invite is a no-op rather than a demotion:
  // never write a membership row for the person who already owns the project.
  const { data: project } = await svc
    .from("projects")
    .select("user_id")
    .eq("id", invite.project_id)
    .maybeSingle();
  const ownerId = (project as { user_id: string } | null)?.user_id;
  if (!ownerId) return { ok: false, reason: "failed" };
  if (ownerId === args.userId) {
    await claimInvite(svc, invite.id, args.userId, now);
    return { ok: true, projectId: invite.project_id, alreadyMember: true };
  }

  const { error: memberError } = await svc.from("project_members").upsert(
    {
      project_id: invite.project_id,
      user_id: args.userId,
      role: "member",
      invited_by: invite.invited_by,
    },
    { onConflict: "project_id,user_id", ignoreDuplicates: true },
  );
  if (memberError) return { ok: false, reason: "failed" };

  // Stamp the invite as spent only once, and only if it is still unspent —
  // the same guarded-update idiom as alertNewSignup, so two clicks in flight
  // at once can't both claim it.
  const claimed = await claimInvite(svc, invite.id, args.userId, now);
  return { ok: true, projectId: invite.project_id, alreadyMember: !claimed };
}

/** Mark an invite spent, returning whether THIS call is the one that did it. */
async function claimInvite(
  svc: SupabaseClient,
  inviteId: string,
  userId: string,
  now: number,
): Promise<boolean> {
  const { data } = await svc
    .from("project_invites")
    .update({ accepted_at: new Date(now).toISOString(), accepted_by: userId })
    .eq("id", inviteId)
    .is("accepted_at", null)
    .select("id");
  return ((data as unknown[] | null) ?? []).length > 0;
}

/** Withdraw an outstanding invitation. Revoked rather than deleted so the
 *  token can never be redeemed later and the owner keeps the record. */
export async function revokeInvite(
  svc: SupabaseClient,
  projectId: string,
  inviteId: string,
  now = Date.now(),
): Promise<boolean> {
  const { data } = await svc
    .from("project_invites")
    .update({ revoked_at: new Date(now).toISOString() })
    .eq("id", inviteId)
    .eq("project_id", projectId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id");
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * Take somebody off a team — the owner removing a member, or a member leaving.
 *
 * Also clears their dashboard pointer if it was aimed here, because the
 * alternative is a teammate who was just removed watching getProject fall
 * through on their next page load. Removing the OWNER is impossible by
 * construction: they have no membership row to delete.
 */
export async function removeMember(
  svc: SupabaseClient,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const { data } = await svc
    .from("project_members")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .select("user_id");
  const removed = ((data as unknown[] | null) ?? []).length > 0;
  if (removed) {
    await svc
      .from("profiles")
      .update({ active_project_id: null })
      .eq("id", userId)
      .eq("active_project_id", projectId);
  }
  return removed;
}

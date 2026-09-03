"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, Crown, LogOut, Mail, Send, Trash2 } from "lucide-react";
import { Badge, Button, Input } from "@/components/ui";
import { formatDate, timeAgo } from "@/lib/utils";
import type { PendingInvite, TeamMember } from "@/lib/team";

/**
 * Who is on this organization, and the one form that grows it.
 *
 * Two audiences in one component, because they are looking at the same list:
 * the OWNER sees the invite form, the outstanding invitations, and a remove
 * button on each member; a MEMBER sees the people and a way to leave. Building
 * two components would mean two renderings of the same table drifting apart.
 */
export default function TeamManager({
  members,
  invites,
  isOwner,
  viewerId,
  organization,
}: {
  members: TeamMember[];
  invites: PendingInvite[];
  isOwner: boolean;
  viewerId: string;
  organization: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (inviting) return;
    setError(null);
    setSentTo(null);
    setInviting(true);
    try {
      const res = await fetch("/api/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || "Could not send that invitation.");
        // A 502 means the row exists but the mail didn't go: refresh so the
        // invitation the owner now has to revoke is actually on screen.
        if (res.status === 502) router.refresh();
        return;
      }
      setSentTo(email);
      setEmail("");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setInviting(false);
    }
  }

  async function revoke(id: string) {
    if (busyId) return;
    setError(null);
    setBusyId(id);
    try {
      const res = await fetch(`/api/team/invites?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error || "Could not revoke that invitation.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(userId: string, leaving: boolean) {
    if (busyId) return;
    // Both of these are one-click and hard to undo — leaving costs a fresh
    // invitation to reverse — so they get the browser's confirm rather than a
    // custom modal this card doesn't otherwise need.
    const ok = window.confirm(
      leaving
        ? `Leave "${organization}"? You'll lose access until someone invites you back.`
        : "Remove this person from the organization? They lose access immediately.",
    );
    if (!ok) return;
    setError(null);
    setBusyId(userId);
    try {
      const res = await fetch(`/api/team/members?userId=${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || "Could not do that.");
        return;
      }
      // Someone who just left can't stay on a settings page for an
      // organization they no longer belong to.
      if (leaving) {
        router.push("/dashboard");
        router.refresh();
        return;
      }
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      {isOwner && (
        <form onSubmit={invite} className="flex flex-wrap items-start gap-2">
          <div className="min-w-[16rem] flex-1">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              aria-label="Email address to invite"
              required
            />
          </div>
          {/* loading rather than a swapped label: the shared Button keeps its
              width across the two states, so the form doesn't jump on submit. */}
          <Button type="submit" disabled={!email.trim()} loading={inviting} loadingText="Sending…">
            <Send className="h-4 w-4" aria-hidden /> Send invite
          </Button>
        </form>
      )}

      {error && (
        <p className="rounded border border-terracotta/40 bg-terracotta/[0.06] px-3 py-2 text-sm text-terracotta-dark">
          {error}
        </p>
      )}
      {sentTo && (
        <p className="rounded border border-mint-bright/40 bg-mint-tint/50 px-3 py-2 text-sm text-mint-ink">
          Invitation sent to {sentTo}. The link works once and expires in a week.
        </p>
      )}

      <div className="divide-y divide-ink/5 rounded border border-ink/10">
        {members.map((member) => {
          const isYou = member.userId === viewerId;
          return (
            <div key={member.userId} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">
                  {member.email ?? "(no email on the account)"}
                  {isYou && <span className="ml-1.5 text-ink-faint">— you</span>}
                </p>
                <p className="truncate text-xs text-ink-faint">
                  {member.role === "owner"
                    ? `Created this organization ${timeAgo(member.joinedAt)}`
                    : `Joined ${timeAgo(member.joinedAt)}${
                        member.invitedByEmail ? ` · invited by ${member.invitedByEmail}` : ""
                      }`}
                </p>
              </div>
              {member.role === "owner" ? (
                <Badge tone="butter">
                  <Crown className="h-3 w-3" aria-hidden /> Owner
                </Badge>
              ) : (
                <Badge tone="neutral">Member</Badge>
              )}
              {member.role === "member" && (isOwner || isYou) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(member.userId, isYou)}
                  loading={busyId === member.userId}
                  aria-label={isYou ? "Leave this organization" : `Remove ${member.email ?? "member"}`}
                >
                  {isYou ? (
                    <LogOut className="h-4 w-4" aria-hidden />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden />
                  )}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {isOwner && invites.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
            Waiting to be accepted
          </p>
          <div className="mt-2 divide-y divide-ink/5 rounded border border-dashed border-ink/15">
            {invites.map((invite) => (
              <div key={invite.id} className="flex items-center gap-3 px-4 py-3">
                <Mail className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{invite.email}</p>
                  <p className="flex items-center gap-1 truncate text-xs text-ink-faint">
                    <Clock className="h-3 w-3" aria-hidden />
                    {invite.expired
                      ? `Expired ${formatDate(invite.expiresAt)} — revoke it to send a new one`
                      : `Sent ${timeAgo(invite.invitedAt)} · expires ${formatDate(invite.expiresAt)}`}
                  </p>
                </div>
                {invite.expired && <Badge tone="terracotta">Expired</Badge>}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => revoke(invite.id)}
                  loading={busyId === invite.id}
                  aria-label={`Revoke the invitation to ${invite.email}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-ink-faint">
        {isOwner
          ? "Members can see this organization's prompts, competitors, and results, edit what gets monitored, and start runs — which are paid for by your keys. They can't see your API keys, invite anyone else, or delete the organization."
          : "You can see and edit what this organization monitors and start runs, which are paid for by the owner's keys. Your own API keys are yours alone and are not used here."}
      </p>
    </div>
  );
}

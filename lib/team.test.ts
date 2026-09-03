import { describe, expect, it } from "vitest";
import {
  INVITE_TTL_MS,
  acceptInvite,
  inviteState,
  inviteUrl,
  normalizeInviteEmail,
  shapeTeam,
  type InviteRow,
  type TeamMemberRow,
} from "./team";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-09-03T12:00:00.000Z");

function iso(daysAgo: number, hoursAgo = 0): string {
  return new Date(NOW - daysAgo * DAY_MS - hoursAgo * 3_600_000).toISOString();
}

function invite(overrides: Partial<InviteRow>): InviteRow {
  return {
    id: "inv-1",
    project_id: "proj-1",
    email: "sam@acme.io",
    invited_by: "owner",
    created_at: iso(1),
    expires_at: new Date(NOW + 6 * DAY_MS).toISOString(),
    accepted_at: null,
    accepted_by: null,
    revoked_at: null,
    ...overrides,
  };
}

function member(overrides: Partial<TeamMemberRow>): TeamMemberRow {
  return {
    project_id: "proj-1",
    user_id: "u2",
    role: "member",
    invited_by: "owner",
    created_at: iso(2),
    ...overrides,
  };
}

describe("normalizeInviteEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeInviteEmail("  Sam@Acme.IO ")).toBe("sam@acme.io");
  });

  it("rejects what is certainly not an address", () => {
    for (const bad of [
      "",
      "sam",
      "@acme.io",
      "sam@",
      "sam@acme",
      "sam@.io",
      "sam@acme.",
      "sam@@acme.io",
      "sam acme@acme.io",
      "a@b.c" + "x".repeat(400),
      42,
      null,
      undefined,
    ]) {
      expect(normalizeInviteEmail(bad)).toBeNull();
    }
  });

  it("accepts the shapes a stricter regex would wrongly reject", () => {
    // Plus-addressing, subdomains, and long TLDs are all real addresses that
    // half the regexes on the internet refuse.
    expect(normalizeInviteEmail("sam+lettertrace@mail.corp.acme.technology")).toBe(
      "sam+lettertrace@mail.corp.acme.technology",
    );
  });
});

describe("inviteState", () => {
  it("reads pending, expired, accepted and revoked", () => {
    expect(inviteState(invite({}), NOW)).toBe("pending");
    expect(inviteState(invite({ expires_at: iso(1) }), NOW)).toBe("expired");
    expect(inviteState(invite({ accepted_at: iso(0, 1), accepted_by: "u2" }), NOW)).toBe(
      "accepted",
    );
    expect(inviteState(invite({ revoked_at: iso(0, 1) }), NOW)).toBe("revoked");
  });

  it("calls a revoked-and-expired invite revoked", () => {
    // The person who withdrew it expects to be told they withdrew it, not that
    // it lapsed on its own.
    const both = invite({ revoked_at: iso(2), expires_at: iso(1) });
    expect(inviteState(both, NOW)).toBe("revoked");
  });

  it("expires exactly at the deadline, not after it", () => {
    const atDeadline = invite({ expires_at: new Date(NOW).toISOString() });
    expect(inviteState(atDeadline, NOW)).toBe("expired");
  });

  it("keeps an invitation live for a week", () => {
    const fresh = invite({ expires_at: new Date(NOW + INVITE_TTL_MS).toISOString() });
    expect(inviteState(fresh, NOW + INVITE_TTL_MS - 1)).toBe("pending");
    expect(inviteState(fresh, NOW + INVITE_TTL_MS)).toBe("expired");
  });
});

describe("shapeTeam", () => {
  const project = { user_id: "owner", created_at: iso(30) };
  const emails = new Map<string, string | null>([
    ["owner", "jo@acme.io"],
    ["u2", "sam@acme.io"],
    ["u3", "kit@acme.io"],
  ]);

  it("puts the owner first and then members oldest-joined", () => {
    const team = shapeTeam(
      project,
      [member({ user_id: "u3", created_at: iso(1) }), member({ user_id: "u2", created_at: iso(5) })],
      [],
      emails,
      NOW,
    );
    expect(team.members.map((m) => m.email)).toEqual(["jo@acme.io", "sam@acme.io", "kit@acme.io"]);
    expect(team.members[0].role).toBe("owner");
    expect(team.members[0].joinedAt).toBe(project.created_at);
    expect(team.members[1].invitedByEmail).toBe("jo@acme.io");
  });

  it("never lists the owner twice, even if a membership row names them", () => {
    // Can't happen by construction — the owner gets no row — but a duplicate
    // owner in a team list is a confusing enough thing to defend against.
    const team = shapeTeam(project, [member({ user_id: "owner" })], [], emails, NOW);
    expect(team.members).toHaveLength(1);
    expect(team.members[0].role).toBe("owner");
  });

  it("shows pending and expired invitations, newest first, and hides spent ones", () => {
    const team = shapeTeam(
      project,
      [],
      [
        invite({ id: "a", email: "a@acme.io", created_at: iso(3) }),
        invite({ id: "b", email: "b@acme.io", created_at: iso(1) }),
        invite({ id: "c", email: "c@acme.io", created_at: iso(2), expires_at: iso(1) }),
        invite({ id: "d", email: "d@acme.io", accepted_at: iso(1), accepted_by: "u2" }),
        invite({ id: "e", email: "e@acme.io", revoked_at: iso(1) }),
      ],
      emails,
      NOW,
    );
    expect(team.invites.map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(team.invites.find((i) => i.id === "c")?.expired).toBe(true);
    expect(team.invites.find((i) => i.id === "b")?.expired).toBe(false);
  });

  it("survives an account whose profile is gone", () => {
    const team = shapeTeam(project, [member({ user_id: "ghost", invited_by: "ghost" })], [], emails, NOW);
    expect(team.members[1].email).toBeNull();
    expect(team.members[1].invitedByEmail).toBeNull();
  });
});

describe("inviteUrl", () => {
  it("puts the token in the path, not the query", () => {
    // Load-bearing: the login redirect strips url.search, so a token in a
    // query param would not survive a signed-out invitee signing up.
    expect(inviteUrl("https://lettertrace.com", "lt_inv_abc")).toBe(
      "https://lettertrace.com/invite/lt_inv_abc",
    );
  });

  it("tolerates a trailing slash on the base and escapes the token", () => {
    expect(inviteUrl("https://lettertrace.com/", "a/b")).toBe("https://lettertrace.com/invite/a%2Fb");
  });
});

// ---------------------------------------------------------------------------
// acceptInvite carries the security decisions, so it gets a real (if tiny)
// fake of the query builder rather than a mocked module: what matters is which
// rows it reads and which it writes, and a mock of itself proves neither.
// ---------------------------------------------------------------------------

interface Op {
  table: string;
  verb: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  filters: [string, string, unknown][];
}

function fakeDb(rows: {
  invite?: InviteRow | null;
  project?: { user_id: string } | null;
  /** Rows the guarded "claim" update matches — empty means somebody beat us. */
  claim?: unknown[];
  memberError?: unknown;
}) {
  const ops: Op[] = [];
  const db = {
    ops,
    from(table: string) {
      const op: Op = { table, verb: "select", filters: [] };
      ops.push(op);
      const chain: Record<string, unknown> = {};
      const settle = () => {
        if (table === "project_invites" && op.verb === "select") {
          return { data: rows.invite ?? null, error: null };
        }
        if (table === "project_invites" && op.verb === "update") {
          return { data: rows.claim ?? [{ id: "inv-1" }], error: null };
        }
        if (table === "projects") return { data: rows.project ?? null, error: null };
        if (table === "project_members") return { data: null, error: rows.memberError ?? null };
        return { data: null, error: null };
      };
      for (const verb of ["select", "insert", "update", "upsert", "delete"] as const) {
        chain[verb] = (payload?: unknown) => {
          // A trailing .select("id") on an update is PostgREST asking for the
          // affected rows back, not a read — the verb must stay the write.
          if (verb !== "select" || op.verb === "select") op.verb = verb;
          if (verb !== "select") op.payload = payload;
          return chain;
        };
      }
      for (const f of ["eq", "is", "in", "neq"]) {
        chain[f] = (col: string, value: unknown) => {
          op.filters.push([f, col, value]);
          return chain;
        };
      }
      chain.maybeSingle = () => Promise.resolve(settle());
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve);
      return chain;
    },
  };
  return db;
}

describe("acceptInvite", () => {
  const viewer = { userId: "u2", userEmail: "sam@acme.io" };

  it("adds the member and spends the invitation exactly once", async () => {
    const db = fakeDb({ invite: invite({}), project: { user_id: "owner" } });
    const result = await acceptInvite(db as never, { token: "lt_inv_x", ...viewer }, NOW);
    expect(result).toEqual({ ok: true, projectId: "proj-1", alreadyMember: false });

    const upsert = db.ops.find((o) => o.table === "project_members" && o.verb === "upsert");
    expect(upsert?.payload).toMatchObject({
      project_id: "proj-1",
      user_id: "u2",
      role: "member",
      invited_by: "owner",
    });
    // The claim is guarded on accepted_at being null, which is what stops two
    // clicks in flight from both counting as the acceptance.
    const claim = db.ops.find((o) => o.table === "project_invites" && o.verb === "update");
    expect(claim?.filters).toContainEqual(["is", "accepted_at", null]);
  });

  it("looks the invite up by digest, never by the token itself", async () => {
    const db = fakeDb({ invite: invite({}), project: { user_id: "owner" } });
    await acceptInvite(db as never, { token: "lt_inv_x", ...viewer }, NOW);
    const [, , value] = db.ops[0].filters[0];
    expect(db.ops[0].filters[0][1]).toBe("token_hash");
    expect(value).not.toBe("lt_inv_x");
    expect(value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a link opened by somebody other than the person invited", async () => {
    const db = fakeDb({ invite: invite({}), project: { user_id: "owner" } });
    const result = await acceptInvite(
      db as never,
      { token: "lt_inv_x", userId: "u9", userEmail: "stranger@evil.com" },
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "wrong-email" });
    // Nothing was written: a forwarded link must not create a membership.
    expect(db.ops.some((o) => o.table === "project_members" && o.verb === "upsert")).toBe(false);
  });

  it("matches the invited address case-insensitively", async () => {
    const db = fakeDb({ invite: invite({ email: "Sam@Acme.IO" }), project: { user_id: "owner" } });
    const result = await acceptInvite(db as never, { token: "lt_inv_x", ...viewer }, NOW);
    expect(result.ok).toBe(true);
  });

  it("names each refusal, because each one has a different fix", async () => {
    const cases: [Partial<InviteRow>, string][] = [
      [{ expires_at: iso(1) }, "expired"],
      [{ revoked_at: iso(1) }, "revoked"],
      [{ accepted_at: iso(1), accepted_by: "someone-else" }, "spent"],
    ];
    for (const [overrides, reason] of cases) {
      const db = fakeDb({ invite: invite(overrides), project: { user_id: "owner" } });
      expect(await acceptInvite(db as never, { token: "t", ...viewer }, NOW)).toEqual({
        ok: false,
        reason,
      });
    }
  });

  it("sends the person who already used the link back in, rather than erroring", async () => {
    const db = fakeDb({
      invite: invite({ accepted_at: iso(1), accepted_by: "u2" }),
      project: { user_id: "owner" },
    });
    expect(await acceptInvite(db as never, { token: "t", ...viewer }, NOW)).toEqual({
      ok: true,
      projectId: "proj-1",
      alreadyMember: true,
    });
  });

  it("returns unknown for a token that matches nothing", async () => {
    const db = fakeDb({ invite: null });
    expect(await acceptInvite(db as never, { token: "nope", ...viewer }, NOW)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("never demotes the owner to a member of their own project", async () => {
    const db = fakeDb({
      invite: invite({ email: "jo@acme.io" }),
      project: { user_id: "owner" },
    });
    const result = await acceptInvite(
      db as never,
      { token: "t", userId: "owner", userEmail: "jo@acme.io" },
      NOW,
    );
    expect(result).toEqual({ ok: true, projectId: "proj-1", alreadyMember: true });
    expect(db.ops.some((o) => o.table === "project_members" && o.verb === "upsert")).toBe(false);
  });

  it("reports the loser of a two-click race as already a member", async () => {
    const db = fakeDb({ invite: invite({}), project: { user_id: "owner" }, claim: [] });
    expect(await acceptInvite(db as never, { token: "t", ...viewer }, NOW)).toEqual({
      ok: true,
      projectId: "proj-1",
      alreadyMember: true,
    });
  });

  it("fails rather than half-joining when the membership write errors", async () => {
    const db = fakeDb({
      invite: invite({}),
      project: { user_id: "owner" },
      memberError: { code: "42501" },
    });
    expect(await acceptInvite(db as never, { token: "t", ...viewer }, NOW)).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});

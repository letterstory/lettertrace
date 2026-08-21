import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/crypto";
import { createShareLink, resolveShareToken, SHARE_LINK_TTL_MS } from "@/lib/share-links";
import { getOwnedProject } from "@/lib/api-service";

// lib/api-service pulls in lib/trial -> lib/data, whose getProjects uses
// React's cache() outside a request context, which throws under Vitest.
// Stub lib/data the same way app/api/v1/v1-routes.test.ts does so
// importOriginal below doesn't touch it, and mock only getOwnedProject.
vi.mock("@/lib/data", () => ({ getProjects: vi.fn() }));
vi.mock("@/lib/api-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-service")>()),
  getOwnedProject: vi.fn(),
}));

// A minimal stand-in covering the exact chains share-links.ts uses: for
// runs, select().eq().maybeSingle(); for share_links, either
// select().eq().maybeSingle() (resolve) or upsert() (create). upsertCalls
// records every payload so a test can assert an update targeted the same
// row rather than inserting a second one.
function fakeSupabase(opts: {
  runRow?: { id: string; project_id: string } | null;
  shareLinkRow?: { run_id: string; expires_at: string } | null;
}) {
  const upsertCalls: { payload: unknown; options: unknown }[] = [];
  const client = {
    upsertCalls,
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (table === "runs") {
                return { data: opts.runRow ?? null, error: null };
              }
              if (table === "share_links") {
                return { data: opts.shareLinkRow ?? null, error: null };
              }
              return { data: null, error: null };
            },
          }),
        }),
        upsert: async (payload: unknown, options: unknown) => {
          upsertCalls.push({ payload, options });
          return { error: null };
        },
      };
    },
  };
  return client;
}

describe("createShareLink", () => {
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    vi.mocked(getOwnedProject).mockReset();
    // Every test below exercises the ownership/minting logic, not the
    // configuration guard -- stub the key present unless a test says
    // otherwise, matching how the deployment is expected to be configured.
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  });

  afterEach(() => {
    if (originalServiceRoleKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey;
  });

  it("returns not_configured when SUPABASE_SERVICE_ROLE_KEY is unset, without touching the database", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const client = fakeSupabase({ runRow: { id: "run-1", project_id: "project-1" } });
    const fromSpy = vi.spyOn(client, "from");

    const outcome = await createShareLink(client as never, "user-1", "run-1");

    expect(outcome).toEqual({ ok: false, code: "not_configured" });
    expect(fromSpy).not.toHaveBeenCalled();
    expect(getOwnedProject).not.toHaveBeenCalled();
  });

  it("returns not_found when the run doesn't exist", async () => {
    const client = fakeSupabase({ runRow: null });
    const outcome = await createShareLink(client as never, "user-1", "run-1");
    expect(outcome).toEqual({ ok: false, code: "not_found" });
  });

  it("returns the same not_found when the run belongs to another user's project", async () => {
    const client = fakeSupabase({ runRow: { id: "run-1", project_id: "project-2" } });
    vi.mocked(getOwnedProject).mockResolvedValueOnce(null);

    const outcome = await createShareLink(client as never, "user-1", "run-1");

    // Indistinguishable from "doesn't exist" -- never gives an existence
    // oracle on someone else's run.
    expect(outcome).toEqual({ ok: false, code: "not_found" });
  });

  it("mints a fresh token and only stores its hash", async () => {
    const client = fakeSupabase({ runRow: { id: "run-1", project_id: "project-1" } });
    vi.mocked(getOwnedProject).mockResolvedValueOnce({ id: "project-1" } as never);

    const outcome = await createShareLink(client as never, "user-1", "run-1");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.token).toMatch(/^lt_share_[A-Za-z0-9_-]+$/);

    const expiresAtMs = new Date(outcome.expiresAt).getTime();
    expect(expiresAtMs - Date.now()).toBeGreaterThan(SHARE_LINK_TTL_MS - 5000);
    expect(expiresAtMs - Date.now()).toBeLessThanOrEqual(SHARE_LINK_TTL_MS);

    expect(client.upsertCalls).toHaveLength(1);
    const payload = client.upsertCalls[0].payload as Record<string, unknown>;
    expect(payload.token_hash).toBe(sha256Hex(outcome.token));
    expect(JSON.stringify(payload)).not.toContain(outcome.token);
    expect(client.upsertCalls[0].options).toEqual({ onConflict: "run_id" });
  });

  it("rotates in place on a second call, never inserting a second row", async () => {
    const client = fakeSupabase({ runRow: { id: "run-1", project_id: "project-1" } });
    vi.mocked(getOwnedProject).mockResolvedValue({ id: "project-1" } as never);

    const first = await createShareLink(client as never, "user-1", "run-1");
    const second = await createShareLink(client as never, "user-1", "run-1");

    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) throw new Error("expected both to succeed");
    expect(first.token).not.toBe(second.token);

    // Both calls upsert on the same conflict target (run_id) -- the second
    // one replaces the first row rather than adding a sibling.
    expect(client.upsertCalls).toHaveLength(2);
    for (const call of client.upsertCalls) {
      expect(call.options).toEqual({ onConflict: "run_id" });
      expect((call.payload as { run_id: string }).run_id).toBe("run-1");
    }
  });
});

describe("resolveShareToken", () => {
  it("returns null for an empty or whitespace-only token without querying", async () => {
    const client = fakeSupabase({});
    const fromSpy = vi.spyOn(client, "from");

    expect(await resolveShareToken(client as never, "")).toBeNull();
    expect(await resolveShareToken(client as never, "   ")).toBeNull();
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("returns null for a token with no matching hash", async () => {
    const client = fakeSupabase({ shareLinkRow: null });
    expect(await resolveShareToken(client as never, "lt_share_unknown")).toBeNull();
  });

  it("returns null for a token whose expires_at is in the past", async () => {
    const client = fakeSupabase({
      shareLinkRow: { run_id: "run-1", expires_at: new Date(Date.now() - 1000).toISOString() },
    });
    expect(await resolveShareToken(client as never, "lt_share_expired")).toBeNull();
  });

  it("returns the run id for a token whose expires_at is still in the future", async () => {
    const client = fakeSupabase({
      shareLinkRow: { run_id: "run-1", expires_at: new Date(Date.now() + 1000).toISOString() },
    });
    expect(await resolveShareToken(client as never, "lt_share_live")).toEqual({ runId: "run-1" });
  });
});

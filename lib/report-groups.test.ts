import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "./types";

const mail = vi.hoisted(() => ({
  build: vi.fn(async () => ({ subject: "Acme update", html: "<p>done</p>", text: "done" })),
  send: vi.fn(async () => "sent" as const),
  baseUrl: vi.fn(() => "https://lettertrace.example"),
}));
vi.mock("./report-email-delivery", () => ({
  buildStoredReportEmail: mail.build,
  sendOwnerReportEmail: mail.send,
  reportBaseUrl: mail.baseUrl,
}));

import { RUN_TIME_BUDGET_MS } from "./engine";
import {
  GROUP_ABANDON_MS,
  finalizeGroupIfComplete,
  finishGroup,
  outstandingProviders,
  recordGroupSkip,
  sweepAbandonedGroups,
  type ReportGroup,
} from "./report-groups";

function makeGroup(overrides: Partial<ReportGroup> = {}): ReportGroup {
  return {
    id: "group-1",
    project_id: "project-1",
    requested_providers: ["anthropic", "openai"],
    skipped: {},
    email_status: "pending",
    last_activity_at: "2026-09-18T00:00:00Z",
    finished_at: null,
    created_at: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

function makeRun(provider: Run["provider"], overrides: Partial<Run> = {}): Run {
  return {
    id: `run-${provider}`, project_id: "project-1", report_group_id: "group-1",
    status: "completed", provider, model: "m", route: null, key_source: "own",
    prompt_count: 4, completed_count: 4, replicates: 1, error: null,
    started_at: null, finished_at: null, created_at: "2026-09-18T00:00:00Z",
    ...overrides,
  } as Run;
}

type Filter = { op: "eq" | "lt" | "is"; col: string; value: unknown };

function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "lt") return String(row[f.col]) < String(f.value);
    return row[f.col] === f.value;
  });
}

/**
 * A fake that actually applies the .eq() filters, because the filters ARE the
 * mechanism under test: finishGroup's "only if still pending" claim is a
 * conditional UPDATE, and a fake that ignored the condition would pass whether
 * or not the condition was there.
 *
 * What it still cannot show is a genuine race — these calls interleave at
 * awaits, not in two Postgres backends — so the two-finalizer test below pins
 * that ONE claim wins given serialised execution, not that the database would
 * serialise them. That part is the conditional UPDATE's job and is only really
 * proven against a real database.
 */
function fakeDb(groups: ReportGroup[], runs: Run[]) {
  const state = { groups, runs };

  function builder(exec: (filters: Filter[]) => { rows: Record<string, unknown>[] }) {
    const filters: Filter[] = [];
    const api = {
      eq: (col: string, value: unknown) => { filters.push({ op: "eq", col, value }); return api; },
      lt: (col: string, value: unknown) => { filters.push({ op: "lt", col, value }); return api; },
      is: (col: string, value: unknown) => { filters.push({ op: "is", col, value }); return api; },
      not: () => api,
      order: () => api,
      limit: () => api,
      select: () => api,
      range: async () => ({ data: exec(filters).rows, error: null }),
      single: async () => ({ data: exec(filters).rows[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: exec(filters).rows[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => void) =>
        resolve({ data: exec(filters).rows, error: null }),
    };
    return api;
  }

  const db = {
    from: (table: string) => {
      if (table === "report_groups") {
        return {
          select: () => builder((filters) => ({
            rows: state.groups.filter((g) => matches(g as never, filters)) as never,
          })),
          update: (values: Record<string, unknown>) => builder((filters) => {
            const hit = state.groups.filter((g) => matches(g as never, filters));
            for (const group of hit) Object.assign(group, values);
            return { rows: hit.map((g) => ({ id: g.id })) };
          }),
        };
      }
      if (table === "runs") {
        return {
          select: () => builder((filters) => ({
            rows: state.runs.filter((r) => matches(r as never, filters)) as never,
          })),
        };
      }
      if (table === "projects") {
        return {
          select: () => builder(() => ({
            rows: [{ id: "project-1", user_id: "owner-1", brand_name: "Acme" }],
          })),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  } as never;
  return { db, state };
}

beforeEach(() => {
  mail.build.mockClear();
  mail.send.mockClear();
  mail.send.mockResolvedValue("sent");
  mail.baseUrl.mockReturnValue("https://lettertrace.example");
});

describe("accounting for a batch's engines", () => {
  // A refused engine produces no run row at all. Before the skip was recorded,
  // the batch waited for an engine that was never coming, and the only thing
  // that ever closed it was the abandon sweep — twenty minutes later, on a
  // batch that had actually finished.
  it("treats a recorded skip as an accounted-for engine", () => {
    const group = makeGroup({ skipped: { openai: "No OpenAI key saved." } });
    expect(outstandingProviders(group, [makeRun("anthropic")])).toEqual([]);
  });

  it("counts a failed run as accounted for, so one bad engine can't stall the batch", () => {
    const group = makeGroup();
    const runs = [makeRun("anthropic"), makeRun("openai", { status: "failed", completed_count: 0 })];
    expect(outstandingProviders(group, runs)).toEqual([]);
  });

  it("still waits while an engine has neither a run nor a reason", () => {
    expect(outstandingProviders(makeGroup(), [makeRun("anthropic")])).toEqual(["openai"]);
  });
});

describe("finalizing a batch", () => {
  it("sends nothing while an engine is still outstanding", async () => {
    const { db, state } = fakeDb([makeGroup()], [makeRun("anthropic")]);
    expect(await finalizeGroupIfComplete(db, "group-1")).toBe(false);
    expect(mail.send).not.toHaveBeenCalled();
    expect(state.groups[0].email_status).toBe("pending");
  });

  it("sends once the last engine reports", async () => {
    const { db, state } = fakeDb([makeGroup()], [makeRun("anthropic"), makeRun("openai")]);
    expect(await finalizeGroupIfComplete(db, "group-1")).toBe(true);
    expect(mail.send).toHaveBeenCalledOnce();
    expect(state.groups[0].email_status).toBe("sent");
  });

  // Live-tested 2026-09-18: the trial forces claude-haiku-4-5, that run's key
  // was invalid and it failed — the run row correctly said "Claude Haiku 4.5"
  // failed, but resolveEngine(provider, undefined) fell back to the catalog
  // default and the OWNER'S EMAIL said "Claude Opus 4.8" didn't finish. A
  // failed run still has a real model on its row; only a genuinely skipped
  // engine (no row at all) has no real model to read.
  it("names a FAILED run's actual model, not the project's catalog default", async () => {
    const { db } = fakeDb(
      [makeGroup()],
      [makeRun("anthropic", { status: "failed", completed_count: 0, model: "claude-haiku-4-5" }), makeRun("openai")],
    );
    await finalizeGroupIfComplete(db, "group-1");
    const requested = (mail.build.mock.calls.at(-1) as unknown as [unknown, unknown, { provider: string; model?: string }[]] | undefined)?.[2];
    expect(requested).toContainEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  // The counterpart: an engine that never got a run row at all (no key, ever)
  // has no real model to read, so the best-effort catalog default is correct
  // there — this must keep working alongside the fix above.
  it("still falls back to the catalog default for a SKIPPED engine with no run row", async () => {
    const { db } = fakeDb([makeGroup()], [makeRun("anthropic")]);
    await recordGroupSkip(db, "group-1", "openai", "No OpenAI key saved.");
    await finalizeGroupIfComplete(db, "group-1");
    const requested = (mail.build.mock.calls.at(-1) as unknown as [unknown, unknown, { provider: string; model?: string }[]] | undefined)?.[2];
    const openai = requested?.find((r) => r.provider === "openai");
    expect(openai?.model).toBeTruthy();
    expect(openai?.model).not.toBe("claude-haiku-4-5");
  });

  it("claims once when two finalizers meet the same finished batch", async () => {
    const group = makeGroup();
    const { db, state } = fakeDb([group], [makeRun("anthropic"), makeRun("openai")]);
    await Promise.all([finishGroup(db, group), finishGroup(db, group)]);
    expect(state.groups[0].email_status).toBe("sent");
    expect(mail.send).toHaveBeenCalledOnce();
  });

  it("does not retry a failed send", async () => {
    mail.send.mockResolvedValue("failed" as never);
    const group = makeGroup();
    const { db, state } = fakeDb([group], [makeRun("anthropic"), makeRun("openai")]);
    await finishGroup(db, group);
    await finishGroup(db, { ...group, email_status: "failed" });
    expect(state.groups[0].email_status).toBe("failed");
    expect(mail.send).toHaveBeenCalledOnce();
  });

  // Without a link base every URL in the message points somewhere wrong. That
  // is a configuration problem, not a report that failed, and recording it as
  // "failed" sent an operator looking for a Resend outage that never happened.
  it("records a missing link base as suppressed, not failed", async () => {
    mail.baseUrl.mockReturnValue(null as never);
    const group = makeGroup();
    const { db, state } = fakeDb([group], [makeRun("anthropic"), makeRun("openai")]);
    await finishGroup(db, group);
    expect(state.groups[0].email_status).toBe("suppressed");
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("does not record a skip for an engine on a batch that already mailed", async () => {
    const { db, state } = fakeDb([makeGroup({ email_status: "sent" })], []);
    await recordGroupSkip(db, "group-1", "openai", "No OpenAI key saved.");
    expect(state.groups[0].skipped).toEqual({});
  });
});

describe("abandoned batches", () => {
  // Closing the tab is the ordinary way a batch ends early: nothing else drives
  // the remaining engines, so without this the row stays pending for ever and
  // the Reports page polls for progress that is never coming.
  it("closes out a stale batch and names the engines that never started", async () => {
    const stale = makeGroup({ last_activity_at: new Date(Date.now() - GROUP_ABANDON_MS - 1000).toISOString() });
    const { db, state } = fakeDb([stale], [makeRun("anthropic")]);
    expect(await sweepAbandonedGroups(db)).toBe(1);
    expect(state.groups[0].skipped.openai).toMatch(/page was closed/);
    expect(state.groups[0].email_status).toBe("sent");
  });

  it("leaves a batch alone while it is still being driven", async () => {
    const fresh = makeGroup({ last_activity_at: new Date().toISOString() });
    const { db, state } = fakeDb([fresh], [makeRun("anthropic")]);
    expect(await sweepAbandonedGroups(db)).toBe(0);
    expect(state.groups[0].email_status).toBe("pending");
    expect(mail.send).not.toHaveBeenCalled();
  });

  // A single run may legitimately occupy the whole run budget without reporting
  // anything. A timeout below that would close out batches that are still
  // working and mail "this never started" about a run in progress.
  it("waits longer than a single run is allowed to take", () => {
    expect(GROUP_ABANDON_MS).toBeGreaterThan(RUN_TIME_BUDGET_MS);
  });
});

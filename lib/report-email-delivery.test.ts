import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mention, Run } from "./types";
import {
  alertScheduleSkip,
  buildStoredReportEmail,
  clearScheduleSkipAlert,
  sendOwnerReportEmail,
} from "./report-email-delivery";

const project = { id: "project-1", user_id: "owner-1", brand_name: "Acme" };
const run = (id: string, provider: Run["provider"], count: number): Run => ({
  id, project_id: project.id, report_group_id: "group-1", status: count ? "completed" : "failed",
  provider, model: provider === "anthropic" ? "claude-haiku-4-5" : "gpt-4o-mini",
  route: null, key_source: "own", prompt_count: 4, completed_count: count,
  replicates: 1, error: null, started_at: null, finished_at: null, created_at: "2026-09-18T00:00:00Z",
});

function mention(runId: string, responseId: string): Mention {
  return {
    id: `${runId}-${responseId}`, response_id: responseId, run_id: runId,
    project_id: project.id, topic_id: null, entity_type: "brand", competitor_id: null,
    entity_name: "Acme", mentioned: true, mention_count: 1, first_position: 0.2,
    sentiment: "positive", recommended: true, created_at: "2026-09-18T00:00:00Z",
  };
}

function metricsDb(mentions: Mention[]) {
  return {
    from: () => ({
      select: () => ({
        eq: (_column: string, runId: string) => ({
          range: (from: number, to: number) => Promise.resolve({
            data: mentions.filter((item) => item.run_id === runId).slice(from, to + 1), error: null,
          }),
        }),
      }),
    }),
  } as never;
}

const original = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  ADMIN_ALERT_FROM: process.env.ADMIN_ALERT_FROM,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
};
beforeEach(() => { process.env.NEXT_PUBLIC_SITE_URL = "https://lettertrace.example"; });
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe("stored report email delivery", () => {
  it("maps one stored successful run to its own report and real answer rate", async () => {
    const content = await buildStoredReportEmail(
      metricsDb([mention("r1", "a1")]), project,
      [{ provider: "anthropic", model: "claude-haiku-4-5" }], [run("r1", "anthropic", 4)],
    );
    expect(content.subject).toContain("25% brand visibility");
    expect(content.html).toContain("/dashboard/runs/r1");
    expect(content.text).toContain("Brand visibility: 25%");
  });

  it("uses only completed engines and lists a failed engine without a fake 0%", async () => {
    const content = await buildStoredReportEmail(
      metricsDb([mention("r1", "a1")]), project,
      [
        { provider: "anthropic", model: "claude-haiku-4-5" },
        { provider: "openai", model: "gpt-4o-mini" },
      ],
      [run("r1", "anthropic", 4), run("r2", "openai", 0)],
    );
    expect(content.subject).toContain("25% overall AI visibility across 1 engine");
    expect(content.text).toContain("1 completed engine; 1 engine didn’t finish");
    expect(content.text).toContain("OpenAI (ChatGPT)");
    expect(content.text).not.toContain("0% overall");
  });

  it("uses the existing alert style for one failed report without percentages", async () => {
    const content = await buildStoredReportEmail(
      metricsDb([]), project, [{ provider: "anthropic", model: "claude-haiku-4-5" }], [],
    );
    expect(content.subject).toBe("Acme: your report didn't finish");
    expect(content.text).toContain("Review reports and try again: https://lettertrace.example/dashboard/runs");
    expect(content.text).not.toContain("0%");
    expect(content.html).not.toMatch(/>0%<|: 0%/);
  });

  it("sends nothing when the current organization toggle is off", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const db = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { report_emails_enabled: false }, error: null }) }) }) }),
      auth: { admin: { getUserById: vi.fn() } },
    } as never;
    process.env.RESEND_API_KEY = "re_test";
    process.env.ADMIN_ALERT_FROM = "Lettertrace <reports@example.com>";
    expect(await sendOwnerReportEmail(db, project, { subject: "x", text: "plain", html: "<p>x</p>" })).toBe("suppressed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("addresses only the current owner, with HTML and plain text", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const db = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { report_emails_enabled: true }, error: null }) }) }) }),
      auth: { admin: { getUserById: async () => ({ data: { user: { email: "owner@example.com" } }, error: null }) } },
    } as never;
    process.env.RESEND_API_KEY = "re_test";
    process.env.ADMIN_ALERT_FROM = "Lettertrace <reports@example.com>";
    expect(await sendOwnerReportEmail(db, project, { subject: "x", text: "plain", html: "<p>x</p>" })).toBe("sent");
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(sent).toMatchObject({ to: ["owner@example.com"], text: "plain", html: "<p>x</p>" });
  });
});

/** Tracks projects.schedule_skip_alerted_at the way the claim depends on it:
 *  the UPDATE only takes when the column is still null. */
function scheduleDb(alerted: string | null) {
  const state = { alerted, delivery_enabled: false };
  const db = {
    from: (table: string) => {
      if (table !== "projects") throw new Error(`Unexpected table ${table}`);
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: {
            schedule_skip_alerted_at: state.alerted,
            report_emails_enabled: state.delivery_enabled,
          },
          error: null,
        }) }) }),
        update: (values: { schedule_skip_alerted_at: string | null }) => {
          const chain = {
            eq: () => chain,
            is: () => chain,
            not: () => chain,
            select: () => chain,
            maybeSingle: async () => {
              if (state.alerted !== null) return { data: null, error: null };
              state.alerted = values.schedule_skip_alerted_at;
              return { data: { id: project.id }, error: null };
            },
            then: (resolve: (value: unknown) => void) => {
              state.alerted = values.schedule_skip_alerted_at;
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
    },
  } as never;
  return { db, state };
}

const scheduled = { ...project, default_provider: "anthropic" as const, default_model: "claude-haiku-4-5" };

describe("alerting a scheduled run that could not start", () => {
  // The cause is a missing key or a spent allowance: the sweep meets the same
  // project in the same state every interval, so mailing on each pass turned
  // the one failure guaranteed to recur into the one that fills an inbox.
  it("says it once, however many sweeps meet the same broken project", async () => {
    const { db, state } = scheduleDb(null);
    expect(await alertScheduleSkip(db, scheduled, "no key")).not.toBe("already-alerted");
    expect(state.alerted).not.toBeNull();
    expect(await alertScheduleSkip(db, scheduled, "no key")).toBe("already-alerted");
    expect(await alertScheduleSkip(db, scheduled, "no key")).toBe("already-alerted");
  });

  it("claims before sending, so two sweeps at once still alert once", async () => {
    const { db } = scheduleDb(null);
    const outcomes = await Promise.all([
      alertScheduleSkip(db, scheduled, "exhausted"),
      alertScheduleSkip(db, scheduled, "exhausted"),
    ]);
    expect(outcomes.filter((outcome) => outcome === "already-alerted")).toHaveLength(1);
  });

  // A schedule that starts working again makes the NEXT breakage news, rather
  // than one silenced for ever by a failure the owner already fixed.
  it("reports a new breakage after a run gets through", async () => {
    const { db, state } = scheduleDb("2026-09-01T00:00:00Z");
    expect(await alertScheduleSkip(db, scheduled, "no key")).toBe("already-alerted");
    await clearScheduleSkipAlert(db, scheduled);
    expect(state.alerted).toBeNull();
    expect(await alertScheduleSkip(db, scheduled, "no key")).not.toBe("already-alerted");
  });
});

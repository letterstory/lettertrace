import { describe, expect, it } from "vitest";
import {
  classifyEmail,
  emailDomain,
  shapeActivity,
  shapeLeads,
  shapeRecentRuns,
  shapeTopAccounts,
  type GrowthProfileRow,
  type GrowthProjectRow,
  type GrowthRunRow,
} from "./growth";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function iso(daysAgo: number, hoursAgo = 0): string {
  return new Date(NOW - daysAgo * DAY_MS - hoursAgo * 3_600_000).toISOString();
}

function run(overrides: Partial<GrowthRunRow>): GrowthRunRow {
  return {
    id: "r-" + Math.abs(JSON.stringify(overrides).length + (overrides.created_at?.length ?? 0)),
    project_id: "proj-a",
    status: "completed",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    prompt_count: 10,
    completed_count: 10,
    created_at: iso(0, 1),
    ...overrides,
  };
}

const PROJECTS: GrowthProjectRow[] = [
  { id: "proj-a", user_id: "u1", name: "Acme", brand_name: "Acme", last_run_at: iso(0, 1) },
  { id: "proj-b", user_id: "u2", name: "Beta", brand_name: "BetaCo", last_run_at: iso(2) },
  { id: "proj-c", user_id: "u2", name: "Beta EU", brand_name: "BetaCo", last_run_at: iso(40) },
];

const PROFILES: GrowthProfileRow[] = [
  { id: "u1", email: "jo@acme.io", created_at: iso(60) },
  { id: "u2", email: "sam@gmail.com", created_at: iso(20) },
  { id: "u3", email: "eval@mailinator.com", created_at: iso(3) },
];

describe("emailDomain", () => {
  it("lowercases and takes the part after the last @", () => {
    expect(emailDomain("Jo@Acme.IO")).toBe("acme.io");
    expect(emailDomain('"odd@local"@corp.com')).toBe("corp.com");
  });

  it("returns null for things that are not addresses", () => {
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain("")).toBeNull();
    expect(emailDomain("@nolocal.com")).toBeNull();
    expect(emailDomain("no-at-sign")).toBeNull();
    expect(emailDomain("user@nodot")).toBeNull();
  });
});

describe("classifyEmail", () => {
  it("classes company domains as work", () => {
    expect(classifyEmail("jo@acme.io")).toBe("work");
    expect(classifyEmail("a@sub.corp.co.uk")).toBe("work");
  });

  it("classes free providers as personal, including country variants", () => {
    expect(classifyEmail("a@gmail.com")).toBe("personal");
    expect(classifyEmail("a@GMAIL.com")).toBe("personal");
    expect(classifyEmail("a@yahoo.co.uk")).toBe("personal");
    expect(classifyEmail("a@outlook.com.br")).toBe("personal");
    expect(classifyEmail("a@proton.me")).toBe("personal");
  });

  it("classes disposable inboxes as burner, including subdomains", () => {
    expect(classifyEmail("x@mailinator.com")).toBe("burner");
    expect(classifyEmail("x@abc.mailinator.com")).toBe("burner");
    expect(classifyEmail("x@yopmail.com")).toBe("burner");
  });

  it("does not suffix-match personal providers into work domains", () => {
    // notgmail.com is somebody's company, not Google.
    expect(classifyEmail("a@notgmail.com")).toBe("work");
  });

  it("falls back to personal when unparseable", () => {
    expect(classifyEmail(null)).toBe("personal");
    expect(classifyEmail("nonsense")).toBe("personal");
  });
});

describe("shapeActivity", () => {
  const owners = new Map([
    ["proj-a", "u1"],
    ["proj-b", "u2"],
    ["proj-c", "u2"],
  ]);

  it("counts rolling windows in both users and runs", () => {
    const runs = [
      run({ project_id: "proj-a", created_at: iso(0, 2) }), // today, u1
      run({ project_id: "proj-a", created_at: iso(0, 3) }), // today again, u1
      run({ project_id: "proj-b", created_at: iso(3) }), // this week, u2
      run({ project_id: "proj-b", created_at: iso(20) }), // this month, u2
    ];
    const a = shapeActivity(runs, owners, NOW);
    expect(a.daily).toEqual({ users: 1, runs: 2 });
    expect(a.weekly).toEqual({ users: 2, runs: 3 });
    expect(a.monthly).toEqual({ users: 2, runs: 4 });
    expect(a.stickiness).toBe(50);
  });

  it("ignores runs outside 30 days and runs from the future", () => {
    const runs = [
      run({ created_at: iso(31) }),
      run({ created_at: new Date(NOW + DAY_MS).toISOString() }),
    ];
    const a = shapeActivity(runs, owners, NOW);
    expect(a.monthly).toEqual({ users: 0, runs: 0 });
    expect(a.stickiness).toBeNull();
  });

  it("zero-fills a 30-day series, oldest first", () => {
    const runs = [run({ created_at: iso(1, 1) })];
    const a = shapeActivity(runs, owners, NOW);
    expect(a.series).toHaveLength(30);
    expect(a.series[29].day).toBe("2026-08-15");
    expect(a.series.reduce((sum, d) => sum + d.runs, 0)).toBe(1);
    expect(a.series.filter((d) => d.runs === 0)).toHaveLength(29);
  });

  it("counts a run whose project is gone in runs but not users", () => {
    const runs = [run({ project_id: "proj-deleted", created_at: iso(0, 1) })];
    const a = shapeActivity(runs, owners, NOW);
    expect(a.daily).toEqual({ users: 0, runs: 1 });
  });
});

describe("shapeTopAccounts", () => {
  it("ranks by run count and aggregates brands across projects", () => {
    const runs = [
      run({ project_id: "proj-b", created_at: iso(1) }),
      run({ project_id: "proj-c", created_at: iso(2) }),
      run({ project_id: "proj-a", created_at: iso(3) }),
    ];
    const top = shapeTopAccounts(runs, PROJECTS, PROFILES);
    expect(top.map((t) => t.userId)).toEqual(["u2", "u1"]);
    expect(top[0]).toMatchObject({
      email: "sam@gmail.com",
      emailClass: "personal",
      runs30d: 2,
      projects: 2,
      brands: ["BetaCo"],
    });
  });

  it("honors the limit", () => {
    const runs = [
      run({ project_id: "proj-a", created_at: iso(1) }),
      run({ project_id: "proj-b", created_at: iso(1, 1) }),
    ];
    expect(shapeTopAccounts(runs, PROJECTS, PROFILES, 1)).toHaveLength(1);
  });
});

describe("shapeRecentRuns", () => {
  it("returns newest first with the owner's email attached", () => {
    const runs = [
      run({ id: "old", project_id: "proj-a", created_at: iso(5) }),
      run({ id: "new", project_id: "proj-b", created_at: iso(0, 1) }),
    ];
    const feed = shapeRecentRuns(runs, PROJECTS, PROFILES);
    expect(feed.map((r) => r.id)).toEqual(["new", "old"]);
    expect(feed[0]).toMatchObject({
      email: "sam@gmail.com",
      projectName: "Beta",
      brandName: "BetaCo",
    });
  });

  it("survives a run whose project was deleted", () => {
    const feed = shapeRecentRuns([run({ project_id: "gone" })], PROJECTS, PROFILES);
    expect(feed[0].projectName).toBe("(deleted project)");
    expect(feed[0].email).toBeNull();
  });
});

describe("shapeLeads", () => {
  it("lists users with no run in 7 days, including never-ran signups", () => {
    const runs = [run({ project_id: "proj-b", created_at: iso(10) })];
    const projects: GrowthProjectRow[] = [
      { ...PROJECTS[0], last_run_at: iso(10) }, // u1 lapsed
      { ...PROJECTS[1], last_run_at: iso(10) }, // u2 lapsed
    ];
    const leads = shapeLeads(runs, projects, PROFILES, NOW);
    // Newest signup first: u3 (never ran) → u2 → u1.
    expect(leads.map((l) => l.userId)).toEqual(["u3", "u2", "u1"]);
    expect(leads[0]).toMatchObject({ emailClass: "burner", lastRunAt: null, projects: 0 });
    expect(leads[1].runs30d).toBe(1);
  });

  it("excludes anyone active within 7 days", () => {
    const runs = [run({ project_id: "proj-a", created_at: iso(2) })];
    const leads = shapeLeads(runs, PROJECTS, PROFILES, NOW);
    expect(leads.some((l) => l.userId === "u1")).toBe(false);
  });

  it("uses projects.last_run_at when the run predates the fetched window", () => {
    // No runs fetched at all, but the project remembers a run 3 days ago.
    const projects: GrowthProjectRow[] = [{ ...PROJECTS[0], last_run_at: iso(3) }];
    const leads = shapeLeads([], projects, PROFILES, NOW);
    expect(leads.some((l) => l.userId === "u1")).toBe(false);
  });

  it("drops accounts without an email — they cannot be contacted", () => {
    const profiles: GrowthProfileRow[] = [{ id: "u9", email: null, created_at: iso(1) }];
    expect(shapeLeads([], [], profiles, NOW)).toHaveLength(0);
  });
});

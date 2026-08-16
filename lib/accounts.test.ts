import { describe, expect, it } from "vitest";
import { companyFromDomain, deriveCompany, shapeAccounts } from "./accounts";
import type { GrowthProfileRow, GrowthProjectRow, GrowthRunRow } from "./growth";

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

describe("companyFromDomain", () => {
  it("titles the registrable label of a plain domain", () => {
    expect(companyFromDomain("acme.io")).toBe("Acme");
    expect(companyFromDomain("corp.com")).toBe("Corp");
  });

  it("skips a second-level public suffix", () => {
    expect(companyFromDomain("acme.co.uk")).toBe("Acme");
    expect(companyFromDomain("sub.corp.co.uk")).toBe("Corp");
    expect(companyFromDomain("shop.example.com.au")).toBe("Example");
  });

  it("uses the registrable label under subdomains", () => {
    expect(companyFromDomain("mail.corp.com")).toBe("Corp");
  });

  it("leaves interior casing alone, only capitalising the first letter", () => {
    expect(companyFromDomain("gitHub.com")).toBe("GitHub");
  });

  it("returns null for a bare label or nothing", () => {
    expect(companyFromDomain("localhost")).toBeNull();
    expect(companyFromDomain(null)).toBeNull();
    expect(companyFromDomain("")).toBeNull();
  });
});

describe("deriveCompany", () => {
  it("uses the email domain for work addresses", () => {
    expect(deriveCompany("alice@acme.io", "work", ["Nike"])).toBe("Acme");
  });

  it("falls back to the monitored brand for personal addresses", () => {
    expect(deriveCompany("sam@gmail.com", "personal", ["BetaCo"])).toBe("BetaCo");
    expect(deriveCompany("x@mailinator.com", "burner", ["Probe"])).toBe("Probe");
  });

  it("falls back to the brand when a work domain is unparseable", () => {
    expect(deriveCompany("weird", "work", ["Fallback"])).toBe("Fallback");
  });

  it("is null when there is nothing but a consumer email", () => {
    expect(deriveCompany("sam@gmail.com", "personal", [])).toBeNull();
  });
});

describe("shapeAccounts", () => {
  const PROJECTS: GrowthProjectRow[] = [
    { id: "proj-a", user_id: "u1", name: "Acme", brand_name: "Acme", last_run_at: iso(0, 1) },
    { id: "proj-b", user_id: "u2", name: "Beta", brand_name: "BetaCo", last_run_at: iso(2) },
    { id: "proj-c", user_id: "u2", name: "Beta EU", brand_name: "BetaEU", last_run_at: iso(40) },
    { id: "proj-d", user_id: "u3", name: "Probe", brand_name: "Probe", last_run_at: null },
  ];
  const PROFILES: GrowthProfileRow[] = [
    { id: "u1", email: "jo@acme.io", created_at: iso(60) },
    { id: "u2", email: "sam@gmail.com", created_at: iso(20) },
    { id: "u3", email: "eval@mailinator.com", created_at: iso(3) },
    { id: "u4", email: "never@newco.com", created_at: iso(1) },
  ];

  it("emits one row per profile, keeping consumer and burner addresses", () => {
    const rows = shapeAccounts([], PROJECTS, PROFILES);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.userId).sort()).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("ranks by last used, with never-ran accounts last by newest signup", () => {
    const runs = [
      run({ project_id: "proj-b", created_at: iso(0, 2) }), // u2 ran 2h ago
      run({ project_id: "proj-a", created_at: iso(1) }), // u1 ran 1d ago (in-window)
    ];
    const rows = shapeAccounts(runs, PROJECTS, PROFILES);
    // u1 leads: proj-a.last_run_at is 1h ago, more recent than either window run,
    // so recency reaches past the window. Then u2 (2h) > never-ran: u4 (signup
    // 1d) before u3 (signup 3d) — u3's project last_run_at is null with no window
    // run, so it too is "never".
    expect(rows.map((r) => r.userId)).toEqual(["u1", "u2", "u4", "u3"]);
  });

  it("counts window runs and reaches past the window for recency", () => {
    // u2 has a project whose last_run_at is 40d ago — older than the 30d window,
    // but it must still date the account rather than reading as never-ran.
    const rows = shapeAccounts([], PROJECTS, PROFILES);
    const u2 = rows.find((r) => r.userId === "u2")!;
    expect(u2.runs30d).toBe(0);
    expect(u2.lastRunAt).toBe(iso(2)); // most recent of its two projects
    expect(u2.projects).toBe(2);
    expect(u2.brands).toEqual(["BetaCo", "BetaEU"]);
  });

  it("prefers a fresh window run over a staler projects.last_run_at", () => {
    const runs = [run({ project_id: "proj-b", created_at: iso(0, 1) })];
    const rows = shapeAccounts(runs, PROJECTS, PROFILES);
    const u2 = rows.find((r) => r.userId === "u2")!;
    expect(u2.runs30d).toBe(1);
    expect(u2.lastRunAt).toBe(iso(0, 1));
  });

  it("labels the company from the work domain, and the brand for consumer mail", () => {
    const rows = shapeAccounts([], PROJECTS, PROFILES);
    expect(rows.find((r) => r.userId === "u1")!.company).toBe("Acme"); // work -> domain
    expect(rows.find((r) => r.userId === "u2")!.company).toBe("BetaCo"); // gmail -> brand
    expect(rows.find((r) => r.userId === "u3")!.company).toBe("Probe"); // burner -> brand
    expect(rows.find((r) => r.userId === "u4")!.company).toBe("Newco"); // work, no project
  });
});

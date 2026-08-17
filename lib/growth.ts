import { createServiceClient } from "@/lib/supabase/service";
import { shapeAccounts, type AccountRow } from "./accounts";

/**
 * The growth half of the operations picture: who is actually using the
 * product, measured in RUNS rather than sessions.
 *
 * A visibility tracker's unit of value is the run — a user who signs in daily
 * but never fires one is a spectator, and a user who runs weekly on a schedule
 * is retained even if they never open the app. So "active" here always means
 * "had a run", and every count comes in pairs: distinct users AND run volume,
 * because ten users running once and one user running ten times are different
 * businesses.
 *
 * This module also exists for outbound. The ops page deliberately masks
 * emails and never touches customer content; this one deliberately does the
 * opposite, because its consumer is the operator deciding who to email next.
 * Both pages sit behind the same requireAdmin gate — the difference is
 * purpose, not privilege.
 *
 * Everything below the loader is pure and unit-tested; the loader only
 * fetches rows and hands them over.
 */

// ---------------------------------------------------------------------------
// Email classification
// ---------------------------------------------------------------------------

export type EmailClass = "work" | "personal" | "burner";

/** Free consumer mail providers — real people, weak outbound targets. */
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "msn.com",
  "mail.com",
  "email.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "zoho.com",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  "daum.net",
  "web.de",
  "t-online.de",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "hey.com",
  "fastmail.com",
  "duck.com",
  "duckduckgo.com",
]);

/** Providers with many country TLDs — match on the first label instead of
 *  enumerating yahoo.co.uk, yahoo.fr, outlook.com.br, … */
const PERSONAL_FIRST_LABELS = new Set([
  "yahoo",
  "ymail",
  "hotmail",
  "outlook",
  "live",
  "gmx",
  "yandex",
]);

/** Disposable-inbox services. A signup from one is almost never a lead — but
 *  it IS a signal (someone evaluating anonymously, or abuse), so they are
 *  labeled rather than dropped. Suffix-matched: mailinator.com covers
 *  anything.mailinator.com. */
const BURNER_DOMAINS = [
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamailblock.com",
  "sharklasers.com",
  "yopmail.com",
  "temp-mail.org",
  "tempmail.dev",
  "tempmail.com",
  "temp-mail.io",
  "10minutemail.com",
  "10minemail.com",
  "trashmail.com",
  "trash-mail.com",
  "getnada.com",
  "nada.email",
  "dropmail.me",
  "maildrop.cc",
  "mohmal.com",
  "fakeinbox.com",
  "mintemail.com",
  "dispostable.com",
  "mailnesia.com",
  "tempr.email",
  "discard.email",
  "spamgourmet.com",
  "mytemp.email",
  "throwawaymail.com",
  "emailondeck.com",
  "burnermail.io",
  "33mail.com",
  "tmpmail.net",
  "mail.tm",
  "inboxkitten.com",
];

/** The domain part, lowercased, or null when the string isn't shaped like an
 *  address. Plus-addressing and case live in the local part and don't matter
 *  here. */
export function emailDomain(email: string | null | undefined): string | null {
  const at = (email ?? "").lastIndexOf("@");
  if (at <= 0) return null;
  const domain = (email ?? "")
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.includes(".") ? domain : null;
}

/** work / personal / burner. Unparseable addresses class as personal — the
 *  conservative bucket, since both other classes trigger operator action
 *  (outbound and suspicion respectively). */
export function classifyEmail(email: string | null | undefined): EmailClass {
  const domain = emailDomain(email);
  if (!domain) return "personal";
  if (BURNER_DOMAINS.some((b) => domain === b || domain.endsWith(`.${b}`))) return "burner";
  if (PERSONAL_DOMAINS.has(domain)) return "personal";
  const firstLabel = domain.split(".")[0];
  if (PERSONAL_FIRST_LABELS.has(firstLabel)) return "personal";
  return "work";
}

// ---------------------------------------------------------------------------
// Row shapes (what the loader fetches — kept minimal on purpose)
// ---------------------------------------------------------------------------

export interface GrowthRunRow {
  id: string;
  project_id: string;
  status: string;
  provider: string;
  model: string;
  prompt_count: number;
  completed_count: number;
  created_at: string;
}

export interface GrowthProjectRow {
  id: string;
  user_id: string;
  name: string;
  brand_name: string;
  last_run_at: string | null;
}

export interface GrowthProfileRow {
  id: string;
  email: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Activity: DAU / WAU / MAU in runs terms
// ---------------------------------------------------------------------------

export interface ActivityWindow {
  /** Distinct users who fired at least one run in the window. */
  users: number;
  /** Runs created in the window, any status — intent counts even when the
   *  provider fails the run. */
  runs: number;
}

export interface ActivityDay {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  users: number;
  runs: number;
}

export interface Activity {
  daily: ActivityWindow;
  weekly: ActivityWindow;
  monthly: ActivityWindow;
  /** daily.users / monthly.users — the classic stickiness ratio, null until
   *  there is a month of anyone to divide by. */
  stickiness: number | null;
  /** Last 30 UTC days, oldest first, zero-filled — a gap is a real zero. */
  series: ActivityDay[];
}

const DAY_MS = 86_400_000;

function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Rolling windows (24h / 7d / 30d back from `now`), not calendar buckets —
 *  an admin checking at 9am should not see a DAU that reset at midnight. */
export function shapeActivity(
  runs: GrowthRunRow[],
  projectOwner: Map<string, string>,
  now: number,
): Activity {
  const cutoffs = { daily: now - DAY_MS, weekly: now - 7 * DAY_MS, monthly: now - 30 * DAY_MS };
  const win = {
    daily: { users: new Set<string>(), runs: 0 },
    weekly: { users: new Set<string>(), runs: 0 },
    monthly: { users: new Set<string>(), runs: 0 },
  };
  const byDay = new Map<string, { users: Set<string>; runs: number }>();

  for (const run of runs) {
    const t = Date.parse(run.created_at);
    const owner = projectOwner.get(run.project_id);
    if (!Number.isFinite(t) || t < cutoffs.monthly || t > now) continue;
    for (const key of ["daily", "weekly", "monthly"] as const) {
      if (t >= cutoffs[key]) {
        win[key].runs += 1;
        if (owner) win[key].users.add(owner);
      }
    }
    const day = utcDay(run.created_at);
    const bucket = byDay.get(day) ?? { users: new Set<string>(), runs: 0 };
    bucket.runs += 1;
    if (owner) bucket.users.add(owner);
    byDay.set(day, bucket);
  }

  const series: ActivityDay[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
    const bucket = byDay.get(day);
    series.push({ day, users: bucket?.users.size ?? 0, runs: bucket?.runs ?? 0 });
  }

  const monthlyUsers = win.monthly.users.size;
  return {
    daily: { users: win.daily.users.size, runs: win.daily.runs },
    weekly: { users: win.weekly.users.size, runs: win.weekly.runs },
    monthly: { users: monthlyUsers, runs: win.monthly.runs },
    stickiness: monthlyUsers > 0 ? Math.round((win.daily.users.size / monthlyUsers) * 100) : null,
    series,
  };
}

// ---------------------------------------------------------------------------
// Most active accounts
// ---------------------------------------------------------------------------

export interface TopAccount {
  userId: string;
  email: string | null;
  emailClass: EmailClass;
  runs30d: number;
  projects: number;
  /** The account's brands, for "who is this" at a glance. */
  brands: string[];
  lastRunAt: string | null;
}

export function shapeTopAccounts(
  runs: GrowthRunRow[],
  projects: GrowthProjectRow[],
  profiles: GrowthProfileRow[],
  limit = 15,
): TopAccount[] {
  const projectOwner = new Map(projects.map((p) => [p.id, p.user_id]));
  const emailByUser = new Map(profiles.map((p) => [p.id, p.email]));

  const acc = new Map<string, { runs: number; lastRunAt: string | null }>();
  for (const run of runs) {
    const owner = projectOwner.get(run.project_id);
    if (!owner) continue;
    const entry = acc.get(owner) ?? { runs: 0, lastRunAt: null };
    entry.runs += 1;
    if (!entry.lastRunAt || run.created_at > entry.lastRunAt) entry.lastRunAt = run.created_at;
    acc.set(owner, entry);
  }
  // projects.last_run_at reaches further back than the fetched run window, so
  // an account whose last run predates the window still shows WHEN, even
  // though its 30d count is zero.
  const byUser = new Map<string, { projects: number; brands: string[]; lastRunAt: string | null }>();
  for (const p of projects) {
    const entry = byUser.get(p.user_id) ?? { projects: 0, brands: [], lastRunAt: null };
    entry.projects += 1;
    if (p.brand_name && !entry.brands.includes(p.brand_name)) entry.brands.push(p.brand_name);
    if (p.last_run_at && (!entry.lastRunAt || p.last_run_at > entry.lastRunAt)) {
      entry.lastRunAt = p.last_run_at;
    }
    byUser.set(p.user_id, entry);
  }

  return [...acc.entries()]
    .map(([userId, a]) => {
      const email = emailByUser.get(userId) ?? null;
      const meta = byUser.get(userId);
      return {
        userId,
        email,
        emailClass: classifyEmail(email),
        runs30d: a.runs,
        projects: meta?.projects ?? 0,
        brands: (meta?.brands ?? []).slice(0, 3),
        lastRunAt: a.lastRunAt ?? meta?.lastRunAt ?? null,
      };
    })
    .sort((a, b) => b.runs30d - a.runs30d || (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Recent runs feed (the outbound log)
// ---------------------------------------------------------------------------

export interface RecentRun {
  id: string;
  email: string | null;
  emailClass: EmailClass;
  projectName: string;
  brandName: string;
  provider: string;
  model: string;
  status: string;
  done: number;
  planned: number;
  createdAt: string;
}

export function shapeRecentRuns(
  runs: GrowthRunRow[],
  projects: GrowthProjectRow[],
  profiles: GrowthProfileRow[],
  limit = 30,
): RecentRun[] {
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const emailByUser = new Map(profiles.map((p) => [p.id, p.email]));
  return [...runs]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map((run) => {
      const project = projectById.get(run.project_id);
      const email = project ? (emailByUser.get(project.user_id) ?? null) : null;
      return {
        id: run.id,
        email,
        emailClass: classifyEmail(email),
        projectName: project?.name ?? "(deleted project)",
        brandName: project?.brand_name ?? "",
        provider: run.provider,
        model: run.model,
        status: run.status,
        done: run.completed_count,
        planned: run.prompt_count,
        createdAt: run.created_at,
      };
    });
}

// ---------------------------------------------------------------------------
// Lapsed leads (the outbound list)
// ---------------------------------------------------------------------------

export interface Lead {
  userId: string;
  email: string;
  emailClass: EmailClass;
  signedUpAt: string;
  /** Null = never fired a run at all (often the best outbound target: they
   *  wanted this enough to sign up, then bounced off something). */
  lastRunAt: string | null;
  runs30d: number;
  projects: number;
}

/** Users with no run in the last 7 days, most recent signup first. The page
 *  filters by class; this returns all three so the counts per class come for
 *  free. Accounts without an email can't be contacted and are dropped. */
export function shapeLeads(
  runs: GrowthRunRow[],
  projects: GrowthProjectRow[],
  profiles: GrowthProfileRow[],
  now: number,
): Lead[] {
  const cutoff = now - 7 * DAY_MS;
  const projectOwner = new Map(projects.map((p) => [p.id, p.user_id]));

  const lastRunByUser = new Map<string, string>();
  const runs30dByUser = new Map<string, number>();
  for (const p of projects) {
    if (!p.last_run_at) continue;
    const prev = lastRunByUser.get(p.user_id);
    if (!prev || p.last_run_at > prev) lastRunByUser.set(p.user_id, p.last_run_at);
  }
  for (const run of runs) {
    const owner = projectOwner.get(run.project_id);
    if (!owner) continue;
    runs30dByUser.set(owner, (runs30dByUser.get(owner) ?? 0) + 1);
    const prev = lastRunByUser.get(owner);
    if (!prev || run.created_at > prev) lastRunByUser.set(owner, run.created_at);
  }

  const projectsByUser = new Map<string, number>();
  for (const p of projects) {
    projectsByUser.set(p.user_id, (projectsByUser.get(p.user_id) ?? 0) + 1);
  }

  return profiles
    .filter((p) => p.email)
    .map((p) => {
      const lastRunAt = lastRunByUser.get(p.id) ?? null;
      return {
        userId: p.id,
        email: p.email as string,
        emailClass: classifyEmail(p.email),
        signedUpAt: p.created_at,
        lastRunAt,
        runs30d: runs30dByUser.get(p.id) ?? 0,
        projects: projectsByUser.get(p.id) ?? 0,
      };
    })
    .filter((lead) => !lead.lastRunAt || Date.parse(lead.lastRunAt) < cutoff)
    .sort((a, b) => b.signedUpAt.localeCompare(a.signedUpAt));
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface GrowthReport {
  activity: Activity;
  topAccounts: TopAccount[];
  recentRuns: RecentRun[];
  leads: Lead[];
  /** Every account, ranked by last used — the People directory behind the modal. */
  accounts: AccountRow[];
  totalUsers: number;
  /** Set when a query failed — the page says "incomplete", never fake zero. */
  degraded: string | null;
}

/** Row caps, not pagination: at 10× today's volume these still fit in one
 *  server render, and the day they don't is the day this page earns real
 *  aggregation SQL. */
const RUNS_CAP = 20_000;
const ROWS_CAP = 10_000;

export async function growthReport(now = Date.now()): Promise<GrowthReport> {
  const svc = createServiceClient();
  const since = new Date(now - 30 * DAY_MS).toISOString();

  const [runsQ, projectsQ, profilesQ] = await Promise.all([
    svc
      .from("runs")
      .select("id, project_id, status, provider, model, prompt_count, completed_count, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(RUNS_CAP),
    // Ordered oldest-first so shapeAccounts' brands[0] (the company label for a
    // consumer-email account) is the oldest project's brand — the same brand the
    // account detail page headlines, which also orders projects created_at asc.
    // Without a stable order the two surfaces can disagree on the label.
    svc
      .from("projects")
      .select("id, user_id, name, brand_name, last_run_at")
      .order("created_at", { ascending: true })
      .limit(ROWS_CAP),
    svc
      .from("profiles")
      .select("id, email, created_at")
      .order("created_at", { ascending: false })
      .limit(ROWS_CAP),
  ]);

  const failed = [
    runsQ.error && "runs",
    projectsQ.error && "projects",
    profilesQ.error && "profiles",
  ].filter(Boolean);

  const runs = (runsQ.data ?? []) as GrowthRunRow[];
  const projects = (projectsQ.data ?? []) as GrowthProjectRow[];
  const profiles = (profilesQ.data ?? []) as GrowthProfileRow[];
  const projectOwner = new Map(projects.map((p) => [p.id, p.user_id]));

  return {
    activity: shapeActivity(runs, projectOwner, now),
    topAccounts: shapeTopAccounts(runs, projects, profiles),
    recentRuns: shapeRecentRuns(runs, projects, profiles),
    leads: shapeLeads(runs, projects, profiles, now),
    accounts: shapeAccounts(runs, projects, profiles),
    totalUsers: profiles.length,
    degraded: failed.length > 0 ? failed.join(", ") : null,
  };
}

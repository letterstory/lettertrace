import {
  classifyEmail,
  emailDomain,
  type EmailClass,
  type GrowthProfileRow,
  type GrowthProjectRow,
  type GrowthRunRow,
} from "./growth";

/**
 * The people behind the runs, as a directory.
 *
 * The Growth page answers "is the product being used" in aggregate; this
 * answers "by whom" one account at a time. It exists so the operator can open a
 * modal, search for a specific address, and jump into one person's whole story
 * — how often they run, what they monitor, what they've done.
 *
 * A row's headline is the COMPANY, not the email: "who is this account" is a
 * company question, and the company is what the operator is really scanning
 * for. The email rides alongside it (and Gmails are kept, not dropped — a
 * consumer address is still a user, just a weaker outbound target), and the
 * class filter in the modal is what lets the operator hide them when the
 * question is outbound rather than usage.
 *
 * Everything here is pure and unit-tested; it reuses the row shapes and the
 * email classifier from lib/growth so the two pages agree on what "work" means.
 */

// ---------------------------------------------------------------------------
// Company label
// ---------------------------------------------------------------------------

/**
 * Second-level public suffixes — domains where the registrable name sits one
 * label FURTHER left than usual. Without this, `acme.co.uk` reads as company
 * "Co" and every British company collapses into one row. Not exhaustive (the
 * full Public Suffix List is thousands of entries and a dependency we don't
 * want for a hint label); it covers the suffixes a real signup list actually
 * carries, and an unlisted one degrades to a slightly-off label, never a crash.
 */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "net.uk",
  "sch.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "co.za",
  "co.in",
  "co.jp",
  "or.jp",
  "ne.jp",
  "com.br",
  "com.mx",
  "com.sg",
  "com.hk",
  "com.tr",
  "com.cn",
  "com.tw",
  "co.kr",
  "co.id",
  "co.th",
]);

/**
 * A human-ish company label from an email domain: the registrable name with a
 * capital first letter. "alice@acme.io" -> "Acme"; "x@sub.corp.co.uk" ->
 * "Corp". Deliberately only touches the first letter — the rest of the label is
 * left as the domain wrote it, because lowercasing it would turn "GitHub" into
 * "Github" and we have no way to know the real casing. A hint, not a legal name.
 */
export function companyFromDomain(domain: string | null): string | null {
  if (!domain) return null;
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  const nameIdx = MULTI_PART_SUFFIXES.has(lastTwo) ? labels.length - 3 : labels.length - 2;
  const name = labels[nameIdx];
  if (!name) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The company shown as the row's headline. A work address IS its company, so
 * the domain wins there; a consumer address has no company in it, so we borrow
 * the brand they monitor instead (an agency on a Gmail still reads as the brand
 * they watch). Null when there is nothing to show but the email.
 */
export function deriveCompany(
  email: string | null | undefined,
  emailClass: EmailClass,
  brands: string[],
): string | null {
  if (emailClass === "work") {
    return companyFromDomain(emailDomain(email)) ?? brands[0] ?? null;
  }
  return brands[0] ?? null;
}

// ---------------------------------------------------------------------------
// Account rows
// ---------------------------------------------------------------------------

export interface AccountRow {
  userId: string;
  email: string | null;
  emailClass: EmailClass;
  /** Headline label — see deriveCompany. Null falls back to the email in the UI. */
  company: string | null;
  /** Brands this account monitors, for the subtitle and for search. */
  brands: string[];
  projects: number;
  /** Runs inside the fetched window (30d). Volume, next to recency. */
  runs30d: number;
  /** Last used = last run, reaching back past the window via projects.last_run_at. */
  lastRunAt: string | null;
  signedUpAt: string;
}

/**
 * One row per account, ranked by last used (most recent first; never-ran
 * accounts sink to the bottom, ordered by signup so the newest arrival leads
 * them). Every profile is included — the directory is the whole audience, and
 * search only works if the account you're hunting is actually in the list.
 *
 * lastRunAt is the max of the run window and projects.last_run_at for the same
 * reason the growth lists do it: a run older than the fetched window still
 * dates the account correctly even though its 30d count is zero.
 */
export function shapeAccounts(
  runs: GrowthRunRow[],
  projects: GrowthProjectRow[],
  profiles: GrowthProfileRow[],
): AccountRow[] {
  const projectOwner = new Map(projects.map((p) => [p.id, p.user_id]));

  const runsByUser = new Map<string, number>();
  const lastRunByUser = new Map<string, string>();
  for (const run of runs) {
    const owner = projectOwner.get(run.project_id);
    if (!owner) continue;
    runsByUser.set(owner, (runsByUser.get(owner) ?? 0) + 1);
    const prev = lastRunByUser.get(owner);
    if (!prev || run.created_at > prev) lastRunByUser.set(owner, run.created_at);
  }

  const meta = new Map<string, { projects: number; brands: string[]; lastRunAt: string | null }>();
  for (const p of projects) {
    const entry = meta.get(p.user_id) ?? { projects: 0, brands: [], lastRunAt: null };
    entry.projects += 1;
    if (p.brand_name && !entry.brands.includes(p.brand_name)) entry.brands.push(p.brand_name);
    if (p.last_run_at && (!entry.lastRunAt || p.last_run_at > entry.lastRunAt)) {
      entry.lastRunAt = p.last_run_at;
    }
    meta.set(p.user_id, entry);
  }

  return profiles
    .map((profile) => {
      const info = meta.get(profile.id);
      const brands = info?.brands ?? [];
      const emailClass = classifyEmail(profile.email);
      const windowLast = lastRunByUser.get(profile.id) ?? null;
      const metaLast = info?.lastRunAt ?? null;
      const lastRunAt =
        windowLast && metaLast
          ? windowLast > metaLast
            ? windowLast
            : metaLast
          : (windowLast ?? metaLast);
      return {
        userId: profile.id,
        email: profile.email,
        emailClass,
        company: deriveCompany(profile.email, emailClass, brands),
        brands,
        projects: info?.projects ?? 0,
        runs30d: runsByUser.get(profile.id) ?? 0,
        lastRunAt,
        signedUpAt: profile.created_at,
      };
    })
    .sort((a, b) => {
      if (a.lastRunAt && b.lastRunAt) return b.lastRunAt.localeCompare(a.lastRunAt);
      if (a.lastRunAt) return -1;
      if (b.lastRunAt) return 1;
      return b.signedUpAt.localeCompare(a.signedUpAt);
    });
}

import { createServiceClient } from "@/lib/supabase/service";
import { classifyEmail, type EmailClass, type GrowthProfileRow } from "./growth";

/**
 * Cross-product conversions: who leaves lettertrace for another Letter
 * Company product, measured in clicks on the outbound links we place
 * ourselves (today: the Phantoms item in the dashboard nav).
 *
 * The write path is components/outbound-link.tsx → POST /api/out → an
 * outbound_clicks row; this module is the read path behind /admin/conversions.
 * A user with at least one click, ever, is CONNECTED — the deliberately weak
 * word, because clicking is the lowest rung of the conversion ladder and the
 * higher rungs (signed up on the other product, pays for it) will need their
 * own names when they become measurable. All-time IS the honest window: the
 * table only exists from the day this shipped, and per-window click counts
 * come alongside for trend.
 *
 * Everything below the loader is pure and unit-tested; the loader only
 * fetches rows and hands them over — same contract as lib/growth.ts.
 */

// ---------------------------------------------------------------------------
// Which URLs count
// ---------------------------------------------------------------------------

/** Letter Company product hosts. A click records only when its URL lands on
 *  one of these (subdomains included) — this is the allow-list the /api/out
 *  route enforces, so extending cross-promotion to a new product means adding
 *  its host here and linking it with <OutboundLink>. */
export const LETTER_PRODUCT_HOSTS = [
  "phantomstory.com",
  "letterbrace.com",
  "letterstory.com",
  "letterprove.com",
  "letterspade.com",
];

/** origin + path with query/hash dropped and a trailing slash trimmed, or
 *  null when the string isn't an http(s) URL on a Letter product host.
 *  Doubles as the allow-list check: null means "do not record". */
export function normalizeProductUrl(raw: string | null | undefined): string | null {
  let url: URL;
  try {
    url = new URL(raw ?? "");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const known = LETTER_PRODUCT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (!known) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/** The product a stored URL belongs to — the allow-list host, for grouping.
 *  Falls back to the raw hostname so an unexpected row still displays. */
export function productOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
  return LETTER_PRODUCT_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) ?? host;
}

// ---------------------------------------------------------------------------
// Row shapes (what the loader fetches)
// ---------------------------------------------------------------------------

export interface OutboundClickRow {
  user_id: string;
  url: string;
  clicked_at: string;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** The page's one time filter: every number, the chart, and the table read the
 *  same window, so the period is a page-level URL param rather than per-card
 *  state. (The option labels live with the dropdown in period-select.tsx,
 *  which is a client component and must not import this server module.) */
export type Period = "7d" | "30d" | "ytd" | "all";

export function isPeriod(value: unknown): value is Period {
  return value === "7d" || value === "30d" || value === "ytd" || value === "all";
}

/** When the period opens, as a ms timestamp — null means all-time. YTD is
 *  Jan 1 UTC, matching the UTC day-bucketing everywhere else on /admin. */
export function periodStart(period: Period, now: number): number | null {
  switch (period) {
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "ytd":
      return Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
    case "all":
      return null;
  }
}

/** Clicks at or after `since` (null = everything). Unparseable timestamps drop
 *  here rather than in every consumer. */
export function clicksSince(clicks: OutboundClickRow[], since: number | null): OutboundClickRow[] {
  if (since === null) return clicks;
  return clicks.filter((c) => {
    const t = Date.parse(c.clicked_at);
    return Number.isFinite(t) && t >= since;
  });
}

// ---------------------------------------------------------------------------
// The headline numbers
// ---------------------------------------------------------------------------

export interface ConversionStats {
  /** Distinct users with at least one click inside the period. */
  connectedUsers: number;
  totalUsers: number;
  /** connectedUsers / totalUsers as a percentage with one decimal, null until
   *  there is anyone to divide by. One decimal because early on the honest
   *  number is 0.x% — a rounded 0% reads as "feature is broken". */
  rate: number | null;
  /** Clicks inside the period. */
  clicks: number;
  /** All-time companions, so a narrow period keeps its context in the hints. */
  connectedAllTime: number;
  clicksAllTime: number;
  /** Most-clicked product host inside the period. */
  topProduct: { product: string; clicks: number } | null;
}

const DAY_MS = 86_400_000;

/** Takes ALL clicks and scopes internally — the all-time companions come from
 *  the same pass, so callers never juggle two filtered arrays. */
export function shapeConversionStats(
  clicks: OutboundClickRow[],
  totalUsers: number,
  since: number | null,
): ConversionStats {
  const inPeriod = clicksSince(clicks, since);
  const users = new Set<string>();
  const allUsers = new Set<string>();
  const byProduct = new Map<string, number>();

  for (const click of clicks) allUsers.add(click.user_id);
  for (const click of inPeriod) {
    users.add(click.user_id);
    const product = productOf(click.url);
    byProduct.set(product, (byProduct.get(product) ?? 0) + 1);
  }

  const top = [...byProduct.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  return {
    connectedUsers: users.size,
    totalUsers,
    rate: totalUsers > 0 ? Math.round((users.size / totalUsers) * 1000) / 10 : null,
    clicks: inPeriod.length,
    connectedAllTime: allUsers.size,
    clicksAllTime: clicks.length,
    topProduct: top ? { product: top[0], clicks: top[1] } : null,
  };
}

// ---------------------------------------------------------------------------
// The rate over time (the chart under the stat row)
// ---------------------------------------------------------------------------

export interface RatePoint {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  /** Cumulative-within-period connected rate as of this day's end: distinct
   *  users who clicked between the period start and this day, over signups
   *  that existed by this day. Null while there are no signups to divide by. */
  rate: number | null;
  /** Cumulative connected users behind that rate. */
  connected: number;
  /** Clicks on this day alone. */
  clicks: number;
  signups: number;
}

/** One point per UTC day from the period start (or the first click, for
 *  all-time) through today. The denominator is signups AS OF each day, not
 *  today's — so the curve is the rate as it actually stood, and its last
 *  point equals the headline card. */
export function shapeRateSeries(
  clicks: OutboundClickRow[],
  profiles: GrowthProfileRow[],
  since: number | null,
  now: number,
): RatePoint[] {
  const inPeriod = clicksSince(clicks, since)
    .map((c) => ({ ...c, t: Date.parse(c.clicked_at) }))
    .filter((c) => Number.isFinite(c.t) && c.t <= now)
    .sort((a, b) => a.t - b.t);

  const firstDay = since ?? inPeriod[0]?.t;
  if (firstDay === undefined) return [];

  const signupTimes = profiles
    .map((p) => Date.parse(p.created_at))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const startDay = new Date(firstDay).toISOString().slice(0, 10);
  const series: RatePoint[] = [];
  const connected = new Set<string>();
  let clickIdx = 0;
  let signupIdx = 0;

  for (
    let dayStart = Date.parse(`${startDay}T00:00:00.000Z`);
    dayStart <= now;
    dayStart += DAY_MS
  ) {
    const dayEnd = dayStart + DAY_MS;
    let dayClicks = 0;
    while (clickIdx < inPeriod.length && inPeriod[clickIdx].t < dayEnd) {
      connected.add(inPeriod[clickIdx].user_id);
      dayClicks += 1;
      clickIdx += 1;
    }
    while (signupIdx < signupTimes.length && signupTimes[signupIdx] < dayEnd) signupIdx += 1;

    series.push({
      day: new Date(dayStart).toISOString().slice(0, 10),
      rate: signupIdx > 0 ? Math.round((connected.size / signupIdx) * 1000) / 10 : null,
      connected: connected.size,
      clicks: dayClicks,
      signups: signupIdx,
    });
  }
  return series;
}

// ---------------------------------------------------------------------------
// The connected list
// ---------------------------------------------------------------------------

export interface ConnectedUser {
  userId: string;
  /** Null when the profile is gone or never had an email — the row still
   *  shows, because the click happened either way. */
  email: string | null;
  emailClass: EmailClass;
  /** Distinct destinations this user clicked, most-clicked first. */
  destinations: { url: string; product: string; clicks: number }[];
  clicks: number;
  firstClickAt: string;
  lastClickAt: string;
}

/** One row per connected user, most recent click first. */
export function shapeConnectedUsers(
  clicks: OutboundClickRow[],
  profiles: GrowthProfileRow[],
): ConnectedUser[] {
  const emailByUser = new Map(profiles.map((p) => [p.id, p.email]));

  const byUser = new Map<string, { urls: Map<string, number>; first: string; last: string }>();
  for (const click of clicks) {
    const entry =
      byUser.get(click.user_id) ??
      { urls: new Map<string, number>(), first: click.clicked_at, last: click.clicked_at };
    entry.urls.set(click.url, (entry.urls.get(click.url) ?? 0) + 1);
    if (click.clicked_at < entry.first) entry.first = click.clicked_at;
    if (click.clicked_at > entry.last) entry.last = click.clicked_at;
    byUser.set(click.user_id, entry);
  }

  return [...byUser.entries()]
    .map(([userId, entry]) => {
      const email = emailByUser.get(userId) ?? null;
      return {
        userId,
        email,
        emailClass: classifyEmail(email),
        destinations: [...entry.urls.entries()]
          .map(([url, count]) => ({ url, product: productOf(url), clicks: count }))
          .sort((a, b) => b.clicks - a.clicks || a.url.localeCompare(b.url)),
        clicks: [...entry.urls.values()].reduce((a, b) => a + b, 0),
        firstClickAt: entry.first,
        lastClickAt: entry.last,
      };
    })
    .sort((a, b) => b.lastClickAt.localeCompare(a.lastClickAt));
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface ConversionsReport {
  stats: ConversionStats;
  series: RatePoint[];
  connected: ConnectedUser[];
  /** Set when a query failed — the page says "incomplete", never fake zero. */
  degraded: string | null;
}

/** Same cap philosophy as growth.ts: comfortably above today's volume, and
 *  the day it isn't is the day this earns aggregation SQL. */
const ROWS_CAP = 10_000;

export async function conversionsReport(
  period: Period = "30d",
  now = Date.now(),
): Promise<ConversionsReport> {
  const svc = createServiceClient();

  const [clicksQ, profilesQ] = await Promise.all([
    svc
      .from("outbound_clicks")
      .select("user_id, url, clicked_at")
      .order("clicked_at", { ascending: false })
      .limit(ROWS_CAP),
    svc.from("profiles").select("id, email, created_at").limit(ROWS_CAP),
  ]);

  const failed = [clicksQ.error && "outbound_clicks", profilesQ.error && "profiles"].filter(
    Boolean,
  );
  const clicks = (clicksQ.data ?? []) as OutboundClickRow[];
  const profiles = (profilesQ.data ?? []) as GrowthProfileRow[];
  const since = periodStart(period, now);

  return {
    stats: shapeConversionStats(clicks, profiles.length, since),
    series: shapeRateSeries(clicks, profiles, since, now),
    // The table reads through the same window: destinations, counts and
    // first/latest are period-scoped, so it always agrees with the cards.
    connected: shapeConnectedUsers(clicksSince(clicks, since), profiles),
    degraded: failed.length > 0 ? failed.join(", ") : null,
  };
}

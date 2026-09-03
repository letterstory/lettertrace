import { createServiceClient } from "@/lib/supabase/service";
import { classifyEmail, type EmailClass, type GrowthProfileRow } from "./growth";
import { periodStart, type Period } from "@/lib/periods";

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

/** A BYOK credential row, from provider_keys OR router_keys — the two tables
 *  are separate because a router is not an answer engine (see the schema), but
 *  for "did this account bring its own key?" they are the same event. */
export interface KeyRow {
  user_id: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

// The vocabulary moved to lib/periods.ts when Growth grew a window of its own —
// two admin pages offering "last 7 days" and "past week" as separate ideas is
// how a dashboard stops being readable. Re-exported so existing importers of
// this module (and its tests) keep working.
export { isPeriod, periodStart, type Period } from "@/lib/periods";

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
// Brought their own keys
// ---------------------------------------------------------------------------

export interface KeyedStats {
  /** Users whose FIRST key landed inside the period — the conversion event. */
  users: number;
  /** Users with at least one key, ever. */
  allTime: number;
  /** Activation for the window's SIGNUP COHORT: of the accounts created inside
   *  it, the share that have since connected a key. One decimal, same reasoning
   *  as the connected rate — early on the honest number is 0.x%, and a rounded
   *  0% reads as "feature is broken".
   *
   *  Cohort rather than "keys added in the window over signups in the window",
   *  which is the obvious reading and is wrong: an account that signed up in
   *  March and pasted a key today would count in the numerator and not the
   *  denominator, so the ratio could exceed 100%. Numerator ⊆ denominator here,
   *  always. On all-time the two definitions coincide exactly, which is why
   *  this card's number does not move when the page first loads. */
  rate: number | null;
  /** The window's signup cohort — the denominator, named in the hint because a
   *  percentage of an unstated base is not a fact. */
  cohortSize: number;
  /** How many of that cohort have connected a key. */
  cohortKeyed: number;
  /** Median milliseconds from signing up to connecting the first key, over the
   *  users whose first key landed in the period. Null when that cohort is
   *  empty, or when none of them can be matched to a signup time. */
  medianMs: number | null;
  /** The same median over everyone who ever connected a key — the stable
   *  number, since a narrow period's median rests on very few people. */
  medianAllTimeMs: number | null;
}

/** The middle value, averaging the two middles on an even count. Its own
 *  function so the two medians above can't drift apart. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * How many accounts added their own API keys.
 *
 * A rung above CONNECTED and below paying: the trial runs on the operator's
 * shared keys, so pasting your own key is the moment an account stops costing
 * us money and starts intending to keep using the product.
 *
 * Period-scoping counts each user by their FIRST key, not by every key they
 * add — someone who pastes Anthropic in July and OpenAI in August converted
 * once, in July, and should not show up again in August's number. The all-time
 * stock comes back alongside so a narrow period keeps its context.
 */
export function shapeKeyedStats(
  keys: KeyRow[],
  profiles: GrowthProfileRow[],
  since: number | null,
): KeyedStats {
  const firstByUser = new Map<string, number>();
  for (const key of keys) {
    const t = Date.parse(key.created_at);
    if (!Number.isFinite(t)) continue;
    const prev = firstByUser.get(key.user_id);
    if (prev === undefined || t < prev) firstByUser.set(key.user_id, t);
  }

  const signedUpAt = new Map<string, number>();
  for (const profile of profiles) {
    const t = Date.parse(profile.created_at);
    if (Number.isFinite(t)) signedUpAt.set(profile.id, t);
  }

  let inPeriod = 0;
  const gapsInPeriod: number[] = [];
  const gapsAllTime: number[] = [];
  for (const [userId, firstKeyAt] of firstByUser) {
    const started = signedUpAt.get(userId);
    // A key whose owner has no profile row (deleted account, or a profile the
    // cap cut off) still counts as a key — it just can't contribute a gap.
    // Negative gaps can't happen from a real signup, so they'd be clock skew:
    // dropped rather than pulled toward zero.
    const gap = started === undefined ? null : firstKeyAt - started;
    if (gap !== null && gap >= 0) gapsAllTime.push(gap);
    if (since === null || firstKeyAt >= since) {
      inPeriod += 1;
      if (gap !== null && gap >= 0) gapsInPeriod.push(gap);
    }
  }

  // The activation cohort: accounts CREATED in the window, and how many of them
  // hold a key today. Walking profiles rather than keys is what keeps the
  // numerator inside the denominator.
  let cohortSize = 0;
  let cohortKeyed = 0;
  for (const [userId, created] of signedUpAt) {
    if (since !== null && created < since) continue;
    cohortSize += 1;
    if (firstByUser.has(userId)) cohortKeyed += 1;
  }

  return {
    users: inPeriod,
    allTime: firstByUser.size,
    rate: cohortSize > 0 ? Math.round((cohortKeyed / cohortSize) * 1000) / 10 : null,
    cohortSize,
    cohortKeyed,
    medianMs: median(gapsInPeriod),
    medianAllTimeMs: median(gapsAllTime),
  };
}

// ---------------------------------------------------------------------------
// The rate over time (the chart under the stat row)
// ---------------------------------------------------------------------------

export interface RatePoint {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  /** This day's connected rate: distinct users who clicked on this day, over
   *  signups that existed by this day's end. The headline card's construction
   *  with a one-day window, so a day is 0 when nobody clicked and null only
   *  while there is no one to divide by. Two decimals rather than the card's
   *  one: a single day's share of the whole user base is small by nature, and
   *  1 in 2,000 has to read as 0.05%, not 0%. */
  rate: number | null;
  /** Distinct users who clicked on this day. */
  connected: number;
  /** Clicks on this day alone. */
  clicks: number;
  /** Signups as of this day's end. */
  signups: number;
}

/** One point per UTC day from the period start (or the first click, for
 *  all-time) through today. Each point stands on its own — that day's
 *  clickers over that day's user base — so the curve shows which days
 *  actually moved people, not a total that can only climb. */
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
  let clickIdx = 0;
  let signupIdx = 0;

  for (
    let dayStart = Date.parse(`${startDay}T00:00:00.000Z`);
    dayStart <= now;
    dayStart += DAY_MS
  ) {
    const dayEnd = dayStart + DAY_MS;
    const connected = new Set<string>();
    let dayClicks = 0;
    while (clickIdx < inPeriod.length && inPeriod[clickIdx].t < dayEnd) {
      connected.add(inPeriod[clickIdx].user_id);
      dayClicks += 1;
      clickIdx += 1;
    }
    while (signupIdx < signupTimes.length && signupTimes[signupIdx] < dayEnd) signupIdx += 1;

    series.push({
      day: new Date(dayStart).toISOString().slice(0, 10),
      rate: signupIdx > 0 ? Math.round((connected.size / signupIdx) * 10_000) / 100 : null,
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
  keyed: KeyedStats;
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

  // All keys, all time: the period filter applies to a user's FIRST key, which
  // can only be found by looking at every row they have.
  const [clicksQ, profilesQ, providerKeysQ, routerKeysQ] = await Promise.all([
    svc
      .from("outbound_clicks")
      .select("user_id, url, clicked_at")
      .order("clicked_at", { ascending: false })
      .limit(ROWS_CAP),
    svc.from("profiles").select("id, email, created_at").limit(ROWS_CAP),
    svc.from("provider_keys").select("user_id, created_at").limit(ROWS_CAP),
    svc.from("router_keys").select("user_id, created_at").limit(ROWS_CAP),
  ]);

  const failed = [
    clicksQ.error && "outbound_clicks",
    profilesQ.error && "profiles",
    providerKeysQ.error && "provider_keys",
    routerKeysQ.error && "router_keys",
  ].filter(Boolean);
  const clicks = (clicksQ.data ?? []) as OutboundClickRow[];
  const profiles = (profilesQ.data ?? []) as GrowthProfileRow[];
  const keys = [
    ...((providerKeysQ.data ?? []) as KeyRow[]),
    ...((routerKeysQ.data ?? []) as KeyRow[]),
  ];
  const since = periodStart(period, now);

  return {
    stats: shapeConversionStats(clicks, profiles.length, since),
    keyed: shapeKeyedStats(keys, profiles, since),
    series: shapeRateSeries(clicks, profiles, since, now),
    // The table reads through the same window: destinations, counts and
    // first/latest are period-scoped, so it always agrees with the cards.
    connected: shapeConnectedUsers(clicksSince(clicks, since), profiles),
    degraded: failed.length > 0 ? failed.join(", ") : null,
  };
}

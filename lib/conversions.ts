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
// The headline numbers
// ---------------------------------------------------------------------------

export interface ConversionStats {
  /** Distinct users with at least one recorded click, ever. */
  connectedUsers: number;
  totalUsers: number;
  /** connectedUsers / totalUsers as a percentage with one decimal, null until
   *  there is anyone to divide by. One decimal because early on the honest
   *  number is 0.x% — a rounded 0% reads as "feature is broken". */
  rate: number | null;
  clicks7d: number;
  clicks30d: number;
  clicksTotal: number;
  /** Most-clicked product host, for the "where do they go" card. */
  topProduct: { product: string; clicks: number } | null;
}

const DAY_MS = 86_400_000;

export function shapeConversionStats(
  clicks: OutboundClickRow[],
  totalUsers: number,
  now: number,
): ConversionStats {
  const users = new Set<string>();
  const byProduct = new Map<string, number>();
  let clicks7d = 0;
  let clicks30d = 0;

  for (const click of clicks) {
    users.add(click.user_id);
    const t = Date.parse(click.clicked_at);
    if (Number.isFinite(t) && t <= now) {
      if (t >= now - 7 * DAY_MS) clicks7d += 1;
      if (t >= now - 30 * DAY_MS) clicks30d += 1;
    }
    const product = productOf(click.url);
    byProduct.set(product, (byProduct.get(product) ?? 0) + 1);
  }

  const top = [...byProduct.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  return {
    connectedUsers: users.size,
    totalUsers,
    rate: totalUsers > 0 ? Math.round((users.size / totalUsers) * 1000) / 10 : null,
    clicks7d,
    clicks30d,
    clicksTotal: clicks.length,
    topProduct: top ? { product: top[0], clicks: top[1] } : null,
  };
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
  connected: ConnectedUser[];
  /** Set when a query failed — the page says "incomplete", never fake zero. */
  degraded: string | null;
}

/** Same cap philosophy as growth.ts: comfortably above today's volume, and
 *  the day it isn't is the day this earns aggregation SQL. */
const ROWS_CAP = 10_000;

export async function conversionsReport(now = Date.now()): Promise<ConversionsReport> {
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

  return {
    stats: shapeConversionStats(clicks, profiles.length, now),
    connected: shapeConnectedUsers(clicks, profiles),
    degraded: failed.length > 0 ? failed.join(", ") : null,
  };
}

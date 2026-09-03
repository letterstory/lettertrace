import { Fragment } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { requireAdmin } from "@/lib/admin";
import { conversionsReport, isPeriod, type Period, type RatePoint } from "@/lib/conversions";
import type { EmailClass } from "@/lib/growth";
import { Badge, Card, SectionHeading, StatCard } from "@/components/ui";
import { timeAgo } from "@/lib/utils";
import { PeriodSelect } from "./period-select";
import { PERIOD_OPTIONS } from "./periods";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

/**
 * The cross-product page: who leaves lettertrace for another Letter Company
 * product. Like Growth, emails are in the clear — a connected user is the
 * warmest possible signal for the rest of the family, and this page exists to
 * act on that. Same requireAdmin gate.
 *
 * "Conversions" is the umbrella, and CONNECTED is deliberately its weakest
 * rung: clicked out to a product. The stronger rungs — signed up over there,
 * pays for a product — get their own words when we can measure them, which is
 * why nothing on this page says "converted" about a mere click.
 *
 * Deliberately small for now: one row of numbers, one chart, one table.
 */

const CLASS_TONE: Record<EmailClass, "teal" | "sand" | "terracotta"> = {
  work: "teal",
  personal: "sand",
  burner: "terracotta",
};

function ColumnHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`text-[10px] font-medium uppercase tracking-wider text-ink-faint ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

/**
 * Each day's connected rate on its own — that day's clickers over the signups
 * that existed by then — so a quiet day sits on the baseline and a busy one
 * stands out, instead of every day folding into a total that can only climb.
 * Same construction as Growth's RunSparkline: inline SVG, numbers in <title>
 * tooltips, colors through style because CSS var() only resolves in styles.
 * One series, so the title is the legend.
 */
function RateChart({ series }: { series: RatePoint[] }) {
  const points = series.filter((p) => p.rate !== null) as (RatePoint & { rate: number })[];
  if (points.length === 0) return null;

  const W = 600;
  const H = 110;
  const PAD_TOP = 8;
  const max = Math.max(0.1, ...points.map((p) => p.rate));
  const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (rate: number) => H - 4 - (rate / max) * (H - 4 - PAD_TOP);
  // One point can't make a line, so it becomes a flat one edge to edge — and
  // the fill reuses these same coordinates so it always sits under the line.
  const linePoints =
    points.length === 1
      ? [`0,${y(points[0].rate).toFixed(1)}`, `${W},${y(points[0].rate).toFixed(1)}`]
      : points.map((p, i) => `${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`);
  const line = linePoints.join(" ");
  const bandW = W / points.length;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-36 w-full"
      role="img"
      aria-label="Connected rate over time"
    >
      {/* Baseline at 0% — the one recessive gridline this needs. */}
      <line x1={0} y1={H - 4} x2={W} y2={H - 4} style={{ stroke: "rgb(var(--c-ink) / 0.12)", strokeWidth: 1 }} vectorEffect="non-scaling-stroke" />
      <polygon
        points={`0,${H - 4} ${line} ${W},${H - 4}`}
        style={{ fill: "rgb(var(--c-mint-bright) / 0.12)" }}
      />
      <polyline
        points={line}
        style={{ fill: "none", stroke: "rgb(var(--c-mint-bright))", strokeWidth: 2 }}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* Invisible per-day bands: hit targets wider than the marks, carrying
          the native tooltip with the numbers for that day. */}
      {points.map((p, i) => (
        <rect
          key={p.day}
          x={x(i) - bandW / 2}
          y={0}
          width={bandW}
          height={H}
          fill="transparent"
        >
          <title>{`${p.day} · ${p.rate}% connected (${p.connected} of ${p.signups} signups clicked this day) · ${p.clicks} click${p.clicks === 1 ? "" : "s"}`}</title>
        </rect>
      ))}
    </svg>
  );
}

type SP = Record<string, string | string[] | undefined>;

function periodFrom(searchParams: SP): Period {
  const raw = Array.isArray(searchParams.p) ? searchParams.p[0] : searchParams.p;
  return isPeriod(raw) ? raw : "30d";
}

export default async function ConversionsPage({ searchParams }: { searchParams: SP }) {
  const admin = await requireAdmin();
  if (!admin) notFound();

  const period = periodFrom(searchParams);
  const periodLabel = PERIOD_OPTIONS.find((o) => o.value === period)!.label.toLowerCase();
  const { stats, keyed, series, connected, degraded } = await conversionsReport(period);
  const latest = series.filter((p) => p.rate !== null).at(-1);
  const peak = series.reduce((a, b) => ((b.rate ?? -1) > (a?.rate ?? -1) ? b : a), latest);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-10">
      <SectionHeading
        title="Conversions"
        description="The rungs an account climbs: connected — clicked one of our outbound links — and keyed, where they paste their own API key and stop running on our shared trial. Signups on the other products and paying customers get their own rungs once we can measure them. Emails are in the clear: this is a cross-sell list."
        action={<PeriodSelect value={period} />}
      />

      {degraded && (
        <Card className="border-terracotta/40 bg-terracotta/[0.04]">
          <p className="px-6 py-4 text-sm text-terracotta-dark">
            Some figures could not be loaded ({degraded}). Treat the numbers below as incomplete
            rather than as zero.
          </p>
        </Card>
      )}

      {/* ---- Row 1: the numbers --------------------------------------------- */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard
          label="Connected rate"
          value={stats.rate === null ? "—" : `${stats.rate}%`}
          hint={`${stats.connectedUsers.toLocaleString()} of ${stats.totalUsers.toLocaleString()} signups clicked a Letter product · ${periodLabel}`}
          accent="mint"
        />
        <StatCard
          label="Connected users"
          value={stats.connectedUsers.toLocaleString()}
          hint={
            period === "all"
              ? "distinct users, all time"
              : `distinct users, ${periodLabel} · ${stats.connectedAllTime.toLocaleString()} all time`
          }
          accent="teal"
        />
        <StatCard
          label="Clicks"
          value={stats.clicks.toLocaleString()}
          hint={
            period === "all"
              ? "all time"
              : `${periodLabel} · ${stats.clicksAllTime.toLocaleString()} all time`
          }
          accent="butter"
        />
        <StatCard
          label="Added API keys"
          value={keyed.users.toLocaleString()}
          hint={
            period === "all"
              ? `${keyed.rate === null ? "—" : `${keyed.rate}%`} of ${stats.totalUsers.toLocaleString()} signups brought their own`
              : `first key in ${periodLabel} · ${keyed.allTime.toLocaleString()} all time, ${keyed.rate === null ? "—" : `${keyed.rate}%`} of signups`
          }
          accent="terracotta"
        />
        <StatCard
          label="Top destination"
          value={
            stats.topProduct ? (
              /* A host, not a number: sized down a step and truncating so a
                 long domain shrinks gracefully instead of escaping the card,
                 and a real link out — the arrow marks it as one. */
              <a
                href={`https://${stats.topProduct.product}`}
                target="_blank"
                rel="noreferrer"
                title={stats.topProduct.product}
                className="group flex min-w-0 items-center gap-1"
              >
                <span className="truncate text-xl leading-relaxed underline-offset-4 group-hover:underline">
                  {stats.topProduct.product}
                </span>
                <ArrowUpRight
                  className="h-4 w-4 shrink-0 text-ink-faint transition-colors group-hover:text-ink"
                  aria-hidden
                />
              </a>
            ) : (
              "—"
            )
          }
          hint={
            stats.topProduct
              ? `${stats.topProduct.clicks.toLocaleString()} click${stats.topProduct.clicks === 1 ? "" : "s"} · ${periodLabel}`
              : `no clicks ${period === "all" ? "recorded yet" : "in this period"}`
          }
          accent="sand"
        />
      </div>

      {/* ---- Row 2: the rate over time ---------------------------------------- */}
      <Card>
        <div className="flex flex-col px-5 pb-4 pt-5">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">Connected rate over time</h3>
            <span className="text-xs text-ink-faint">{periodLabel}</span>
          </div>
          {series.length === 0 || !latest ? (
            <p className="py-8 text-sm text-ink-faint">
              No clicks {period === "all" ? "recorded yet" : "in this period"}, so there is no
              rate to draw.
            </p>
          ) : (
            <>
              <div className="mt-3">
                <RateChart series={series} />
              </div>
              <p className="mt-3 text-xs tabular-nums text-ink-faint">
                {latest.day === today ? "today" : latest.day} {latest.rate}%
                {peak && peak.day !== latest.day ? ` · peak ${peak.rate}% on ${peak.day}` : ""} · each
                day on its own: users who clicked that day, over signups as of that day · hover for
                daily numbers
              </p>
            </>
          )}
        </div>
      </Card>

      {/* ---- Row 3: who's connected ------------------------------------------ */}
      <section className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold text-ink">Connected users</h3>
          <p className="mt-1 max-w-3xl text-sm text-ink-faint">
            Everyone who clicked out to a Letter Company product in this period ({periodLabel}),
            most recent first, with where they went.
          </p>
        </div>
        <Card>
          {connected.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-faint">
              Nobody clicked out {period === "all" ? "yet" : "in this period"}. Tracking only
              exists from the day it shipped, so an empty list right after a deploy means
              &ldquo;too early&rdquo;, not &ldquo;never&rdquo;.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-4 border-b border-ink/10 px-5 py-2">
                <ColumnHeader className="flex-1">Email · destinations</ColumnHeader>
                <ColumnHeader className="w-16 text-right">Class</ColumnHeader>
                <ColumnHeader className="w-14 text-right">Clicks</ColumnHeader>
                <ColumnHeader className="w-24 text-right">First</ColumnHeader>
                <ColumnHeader className="w-24 text-right">Latest</ColumnHeader>
              </div>
              <div className="max-h-96 divide-y divide-ink/5 overflow-y-auto">
                {connected.map((c) => (
                  <div
                    key={c.userId}
                    className="flex items-center gap-4 px-5 py-2.5 transition hover:bg-ink/[0.02]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[13px] text-ink">
                        {c.email ?? "(no email)"}
                      </p>
                      <p className="truncate text-xs text-ink-faint">
                        {/* Each destination links to the URL actually clicked
                            (path included), not just the product's front door. */}
                        {c.destinations.map((d, i) => (
                          <Fragment key={d.url}>
                            {i > 0 && " · "}
                            <a
                              href={d.url}
                              target="_blank"
                              rel="noreferrer"
                              title={d.url}
                              className="underline-offset-2 hover:text-ink hover:underline"
                            >
                              {d.product}
                            </a>
                            {d.clicks > 1 && ` ×${d.clicks}`}
                          </Fragment>
                        ))}
                      </p>
                    </div>
                    <span className="w-16 shrink-0 text-right">
                      <Badge tone={CLASS_TONE[c.emailClass]}>{c.emailClass}</Badge>
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono text-sm tabular-nums text-ink">
                      {c.clicks.toLocaleString()}
                    </span>
                    <span className="w-24 shrink-0 text-right text-xs tabular-nums text-ink-faint">
                      {timeAgo(c.firstClickAt)}
                    </span>
                    <span className="w-24 shrink-0 text-right text-xs tabular-nums text-ink-faint">
                      {timeAgo(c.lastClickAt)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </section>

      <p className="text-xs text-ink-faint">
        Connected means &ldquo;clicked one of our outbound product links while signed
        in&rdquo; — visits that start anywhere else are invisible here, and clicking is not
        signing up or paying, which will be measured separately. Links are counted when wrapped
        in OutboundLink; today that is the Phantoms item in the dashboard nav. Added API keys
        counts an account once, on its first provider or router key: the trial runs on our
        shared keys, so pasting your own is the rung where an account stops costing us money.{" "}
        <Link href="/admin/growth" className="underline">
          Back to growth
        </Link>
      </p>
    </div>
  );
}

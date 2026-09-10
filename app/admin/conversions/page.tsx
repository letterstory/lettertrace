import { Fragment } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { requireAdmin } from "@/lib/admin";
import { conversionsReport, type RatePoint, type SchedulePoint } from "@/lib/conversions";
import { periodFrom, periodLabel, type Period } from "@/lib/periods";
import type { EmailClass } from "@/lib/growth";
import { Badge, Card, SectionHeading, StatCard } from "@/components/ui";
import { duration, timeAgo } from "@/lib/utils";
import { PeriodSelect } from "../period-select";

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
 * A percentage per day, drawn as one filled line. Same construction as
 * Growth's RunSparkline: inline SVG, numbers in <title> tooltips, colors
 * through style because CSS var() only resolves in styles. One series, so the
 * card's title is the legend.
 *
 * Points arrive already filtered of their null days: a day with nothing to
 * divide by is a gap in the data, and interpolating across it would invent a
 * number. `tint` is a color token name — both charts on this page are the same
 * shape and differ only in hue.
 */
function DayRateChart({
  points,
  tint,
  ariaLabel,
}: {
  points: { day: string; rate: number; title: string }[];
  tint: string;
  ariaLabel: string;
}) {
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
      aria-label={ariaLabel}
    >
      {/* Baseline at 0% — the one recessive gridline this needs. */}
      <line x1={0} y1={H - 4} x2={W} y2={H - 4} style={{ stroke: "rgb(var(--c-ink) / 0.12)", strokeWidth: 1 }} vectorEffect="non-scaling-stroke" />
      <polygon
        points={`0,${H - 4} ${line} ${W},${H - 4}`}
        style={{ fill: `rgb(var(--c-${tint}) / 0.12)` }}
      />
      <polyline
        points={line}
        style={{ fill: "none", stroke: `rgb(var(--c-${tint}))`, strokeWidth: 2 }}
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
          <title>{p.title}</title>
        </rect>
      ))}
    </svg>
  );
}

/**
 * Each day's connected rate on its own — that day's clickers over the signups
 * that existed by then — so a quiet day sits on the baseline and a busy one
 * stands out, instead of every day folding into a total that can only climb.
 */
function RateChart({ series }: { series: RatePoint[] }) {
  return (
    <DayRateChart
      tint="mint-bright"
      ariaLabel="Connected rate over time"
      points={series
        .filter((p): p is RatePoint & { rate: number } => p.rate !== null)
        .map((p) => ({
          day: p.day,
          rate: p.rate,
          title: `${p.day} · ${p.rate}% connected (${p.connected} of ${p.signups} signups clicked this day) · ${p.clicks} click${p.clicks === 1 ? "" : "s"}`,
        }))}
    />
  );
}

/**
 * Scheduling by signup cohort: each day is the accounts that signed up THAT
 * day, and the share of them running a report on a cadence today. Days nobody
 * signed up carry no rate and drop out entirely.
 */
function ScheduleChart({ series }: { series: SchedulePoint[] }) {
  return (
    <DayRateChart
      tint="teal"
      ariaLabel="Share of each day's signups scheduling a report"
      points={series
        .filter((p): p is SchedulePoint & { rate: number } => p.rate !== null)
        .map((p) => ({
          day: p.day,
          rate: p.rate,
          title: `${p.day} · ${p.rate}% scheduling (${p.scheduled} of the ${p.signups} account${p.signups === 1 ? "" : "s"} that signed up this day)`,
        }))}
    />
  );
}

type SP = Record<string, string | string[] | undefined>;

export default async function ConversionsPage({ searchParams }: { searchParams: SP }) {
  const admin = await requireAdmin();
  if (!admin) notFound();

  const period: Period = periodFrom(searchParams.p);
  const label = periodLabel(period);
  const { stats, keyed, scheduled, series, scheduleSeries, connected, degraded } =
    await conversionsReport(period);
  const latest = series.filter((p) => p.rate !== null).at(-1);
  const peak = series.reduce((a, b) => ((b.rate ?? -1) > (a?.rate ?? -1) ? b : a), latest);
  const today = new Date().toISOString().slice(0, 10);
  // Days that had signups are the only ones the cohort chart can speak about.
  const scheduleDays = scheduleSeries.filter((p) => p.rate !== null);
  const cadence = scheduled.byInterval
    .map((i) => `${i.projects.toLocaleString()} ${i.schedule}`)
    .join(" · ");

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

      {/* ---- Row 1: the connected rung --------------------------------------- */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium uppercase tracking-wider text-ink-faint">
          Connected · clicked out to another Letter product
        </h3>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Connected rate"
          value={stats.rate === null ? "—" : `${stats.rate}%`}
          hint={`${stats.connectedUsers.toLocaleString()} of ${stats.totalUsers.toLocaleString()} signups clicked a Letter product · ${label}`}
          accent="mint"
        />
        <StatCard
          label="Connected users"
          value={stats.connectedUsers.toLocaleString()}
          hint={
            period === "all"
              ? "distinct users, all time"
              : `distinct users, ${label} · ${stats.connectedAllTime.toLocaleString()} all time`
          }
          accent="teal"
        />
        <StatCard
          label="Clicks"
          value={stats.clicks.toLocaleString()}
          hint={
            period === "all"
              ? "all time"
              : `${label} · ${stats.clicksAllTime.toLocaleString()} all time`
          }
          accent="butter"
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
              ? `${stats.topProduct.clicks.toLocaleString()} click${stats.topProduct.clicks === 1 ? "" : "s"} · ${label}`
              : `no clicks ${period === "all" ? "recorded yet" : "in this period"}`
          }
          accent="sand"
        />
        </div>
      </section>

      {/* ---- Row 1b: the activation rung -------------------------------------
          A rung up from a click: the trial runs on the operator's shared keys,
          so pasting your own is where an account stops costing us money. The
          rate is deliberately all-time on both sides — activation is a stock,
          "how many of everyone who ever signed up now have a key", and
          dividing this period's converters by every signup ever would read as
          a rate that collapses whenever the window narrows. */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium uppercase tracking-wider text-ink-faint">
          Activated · connected their own API key
        </h3>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <StatCard
            label="API-key activation"
            value={keyed.rate === null ? "—" : `${keyed.rate}%`}
            hint={
              keyed.cohortSize === 0
                ? `nobody signed up in ${label}`
                : `${keyed.cohortKeyed.toLocaleString()} of the ${keyed.cohortSize.toLocaleString()} accounts that signed up ${period === "all" ? "ever" : `in the ${label.replace("last ", "")}`} have connected a key`
            }
            accent="terracotta"
          />
          <StatCard
            label="Added API keys"
            value={keyed.users.toLocaleString()}
            hint={
              period === "all"
                ? "accounts, counted once on their first key"
                : `first key in ${label} · ${keyed.allTime.toLocaleString()} all time`
            }
            accent="teal"
          />
          <StatCard
            label="Time to first key"
            value={duration(keyed.medianMs ?? keyed.medianAllTimeMs)}
            hint={
              keyed.medianMs === null
                ? keyed.medianAllTimeMs === null
                  ? "nobody has connected a key yet"
                  : `median signup → first key · all time (nobody activated in ${label})`
                : `median signup → first key, ${keyed.users.toLocaleString()} account${keyed.users === 1 ? "" : "s"} · ${label} · ${duration(keyed.medianAllTimeMs)} all time`
            }
            accent="butter"
          />
        </div>
      </section>

      {/* ---- Row 1c: the cadence rung ----------------------------------------
          The one figure here that reads a STATE rather than an event: the
          projects table says what the cadence is now and nothing records when
          it became that, so the window scopes the SIGNUP COHORT, exactly as
          the activation card above does. Onboarding has created projects on a
          daily schedule since 2026-08-20, so for anyone newer than that this
          rung measures "left it on", not "switched it on" — said plainly in
          the hints, because a number near 100% otherwise reads as a triumph. */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium uppercase tracking-wider text-ink-faint">
          Scheduled · keeps a report running on a cadence
        </h3>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <StatCard
            label="Scheduling rate"
            value={scheduled.rate === null ? "—" : `${scheduled.rate}%`}
            hint={
              scheduled.cohortSize === 0
                ? `nobody signed up in ${label}`
                : `${scheduled.cohortScheduled.toLocaleString()} of the ${scheduled.cohortSize.toLocaleString()} accounts that signed up ${period === "all" ? "ever" : `in the ${label.replace("last ", "")}`} have a report on a schedule today`
            }
            accent="teal"
          />
          <StatCard
            label="Scheduling accounts"
            value={scheduled.allTime.toLocaleString()}
            hint={
              scheduled.rateAllTime === null
                ? "nobody has signed up yet"
                : `${scheduled.rateAllTime}% of all ${scheduled.totalUsers.toLocaleString()} signups · ${scheduled.projects.toLocaleString()} scheduled report${scheduled.projects === 1 ? "" : "s"} between them`
            }
            accent="mint"
          />
          <StatCard
            label="Average cadence"
            value={
              scheduled.avgIntervalDays === null
                ? "—"
                : `${scheduled.avgIntervalDays} day${scheduled.avgIntervalDays === 1 ? "" : "s"}`
            }
            hint={
              scheduled.avgIntervalDays === null
                ? "nothing is scheduled yet"
                : `mean gap between runs over ${scheduled.projects.toLocaleString()} scheduled report${scheduled.projects === 1 ? "" : "s"} · ${cadence} · all time`
            }
            accent="butter"
          />
        </div>
      </section>

      {/* ---- Row 1d: scheduling by signup cohort ------------------------------ */}
      <Card>
        <div className="flex flex-col px-5 pb-4 pt-5">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">Scheduling rate by signup cohort</h3>
            <span className="text-xs text-ink-faint">{label}</span>
          </div>
          {scheduleDays.length === 0 ? (
            <p className="py-8 text-sm text-ink-faint">
              Nobody signed up {period === "all" ? "yet" : "in this period"}, so there is no
              cohort to draw.
            </p>
          ) : (
            <>
              <div className="mt-3">
                <ScheduleChart series={scheduleSeries} />
              </div>
              <p className="mt-3 text-xs tabular-nums text-ink-faint">
                each day is that day&apos;s signups, and how many of them run a report on a
                cadence today · hover for the counts · a low-volume day is one or two people, so
                read the shape, not a single point
              </p>
            </>
          )}
        </div>
      </Card>

      {/* ---- Row 2: the rate over time ---------------------------------------- */}
      <Card>
        <div className="flex flex-col px-5 pb-4 pt-5">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">Connected rate over time</h3>
            <span className="text-xs text-ink-faint">{label}</span>
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
            Everyone who clicked out to a Letter Company product in this period ({label}),
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
        in OutboundLink; today that is the Phantoms item in the dashboard nav. The two key
        figures read the window differently on purpose: activation is a COHORT rate — of the
        accounts that signed up in it, how many hold a key today — while Added API keys and
        time to first key count the accounts whose first key LANDED in it. A cohort rate can
        never exceed 100%; the obvious alternative (keys added over signups in the window)
        can, because someone who signed up in March and pasted a key today belongs to only one
        of those two sets. On all time the two definitions coincide. Scheduling is a state and
        not an event — projects.schedule holds today&rsquo;s cadence and nothing records when it
        was set — so it is read through signup cohorts too, and the chart is cohorts rather than
        the stock curve it resembles: drawing &ldquo;what share had a schedule on that day&rdquo;
        would mean rewinding a change log that only covers the dashboard toggle, which produces a
        smooth line that is quietly wrong. Onboarding has started new projects on a daily
        schedule since 2026-08-20, so a high rate among recent cohorts means the default was
        kept, not that anyone went looking for the setting.{" "}
        <Link href="/admin/growth" className="underline">
          Back to growth
        </Link>
      </p>
    </div>
  );
}

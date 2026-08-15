import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight, Flame } from "lucide-react";
import { requireAdmin } from "@/lib/admin";
import { growthReport, type EmailClass, type Lead } from "@/lib/growth";
import { Badge, Card, SectionHeading, StatCard } from "@/components/ui";
import { timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

/**
 * The outbound side of /admin.
 *
 * Unlike the operations page, this one shows emails in the clear and links
 * into customer run content — that is its job: it exists so the operator can
 * decide who to email next and know what they saw when they last used the
 * product. Same requireAdmin gate, different purpose.
 *
 * Layout: one row of numbers, one row pairing the shape (sparkline) with the
 * names behind it (top accounts), then the two working lists full-width with
 * real column headers — they are tables the operator reads line by line, not
 * cards to glance at.
 */

type SP = Record<string, string | string[] | undefined>;

const CLASS_TONE: Record<EmailClass, "teal" | "sand" | "terracotta"> = {
  work: "teal",
  personal: "sand",
  burner: "terracotta",
};

const LEAD_FILTERS: { key: string; label: string; pick: (l: Lead) => boolean }[] = [
  { key: "work", label: "Work", pick: (l) => l.emailClass === "work" },
  { key: "personal", label: "Personal", pick: (l) => l.emailClass === "personal" },
  { key: "burner", label: "Burner", pick: (l) => l.emailClass === "burner" },
  { key: "all", label: "All", pick: () => true },
];

function leadFilterFrom(searchParams: SP) {
  const raw = Array.isArray(searchParams.f) ? searchParams.f[0] : searchParams.f;
  return LEAD_FILTERS.find((f) => f.key === raw) ?? LEAD_FILTERS[0];
}

/** 30 days of runs as bars. Inline SVG on purpose: no chart dependency, and
 *  the numbers live in <title> tooltips rather than labels — this is a shape,
 *  not a report. Colors go through style, not SVG attributes, because CSS
 *  var() only resolves in styles. */
function RunSparkline({ series }: { series: { day: string; users: number; runs: number }[] }) {
  const max = Math.max(1, ...series.map((d) => d.runs));
  const barW = 600 / series.length;
  return (
    <svg
      viewBox="0 0 600 110"
      preserveAspectRatio="none"
      className="h-32 w-full"
      role="img"
      aria-label="Runs per day, last 30 days"
    >
      {series.map((d, i) => {
        const h = d.runs === 0 ? 2 : Math.max(4, (d.runs / max) * 100);
        return (
          <rect
            key={d.day}
            x={i * barW + 1.5}
            y={106 - h}
            width={barW - 3}
            height={h}
            rx={1.5}
            style={{
              fill: d.runs === 0 ? "rgb(var(--c-ink) / 0.12)" : "rgb(var(--c-mint-bright))",
            }}
          >
            <title>{`${d.day} — ${d.runs} run${d.runs === 1 ? "" : "s"}, ${d.users} user${d.users === 1 ? "" : "s"}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** Uppercase micro-headers that make a flex list read as a table. */
function ColumnHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`text-[10px] font-medium uppercase tracking-wider text-ink-faint ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

export default async function GrowthPage({ searchParams }: { searchParams: SP }) {
  const admin = await requireAdmin();
  if (!admin) notFound();

  const report = await growthReport();
  const { activity } = report;
  const filter = leadFilterFrom(searchParams);
  const leads = report.leads.filter(filter.pick);
  const leadCounts = new Map(LEAD_FILTERS.map((f) => [f.key, report.leads.filter(f.pick).length]));
  const bestDay = activity.series.reduce((a, b) => (b.runs > a.runs ? b : a), activity.series[0]);

  return (
    <div className="space-y-10">
      <SectionHeading
        title="Growth"
        description="Activity measured in runs, and the lead list it produces. Emails are shown in the clear here — this page exists for outbound."
      />

      {report.degraded && (
        <Card className="border-terracotta/40 bg-terracotta/[0.04]">
          <p className="px-6 py-4 text-sm text-terracotta-dark">
            Some figures could not be loaded ({report.degraded}) — treat the numbers below as
            incomplete rather than as zero.
          </p>
        </Card>
      )}

      {/* ---- Row 1: the numbers --------------------------------------------- */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Daily active"
          value={activity.daily.users.toLocaleString()}
          hint={`${activity.daily.runs.toLocaleString()} runs · rolling 24h`}
          accent="mint"
        />
        <StatCard
          label="Weekly active"
          value={activity.weekly.users.toLocaleString()}
          hint={`${activity.weekly.runs.toLocaleString()} runs · rolling 7d`}
          accent="teal"
        />
        <StatCard
          label="Monthly active"
          value={activity.monthly.users.toLocaleString()}
          hint={`${activity.monthly.runs.toLocaleString()} runs · rolling 30d`}
          accent="butter"
        />
        <StatCard
          label="Stickiness"
          value={activity.stickiness === null ? "—" : `${activity.stickiness}%`}
          hint={`DAU / MAU · ${report.totalUsers.toLocaleString()} signups total`}
          accent="sand"
        />
      </div>

      {/* ---- Row 2: the shape next to the names ------------------------------ */}
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="flex flex-col lg:col-span-2">
          <div className="flex flex-1 flex-col px-5 pb-4 pt-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">Runs per day</h3>
              <span className="text-xs text-ink-faint">30d</span>
            </div>
            <div className="mt-3 flex flex-1 items-end">
              <RunSparkline series={activity.series} />
            </div>
            <p className="mt-3 text-xs tabular-nums text-ink-faint">
              {activity.monthly.runs.toLocaleString()} runs total · best day {bestDay.runs} ·
              hover bars for counts
            </p>
          </div>
        </Card>

        <Card className="lg:col-span-3">
          <div className="flex items-baseline justify-between gap-3 px-5 pb-2 pt-5">
            <h3 className="text-sm font-semibold text-ink">Most active accounts</h3>
            <span className="text-xs text-ink-faint">by runs, 30d</span>
          </div>
          {report.topAccounts.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-faint">No runs in the last 30 days.</p>
          ) : (
            <div className="max-h-72 divide-y divide-ink/5 overflow-y-auto">
              {report.topAccounts.map((account, i) => (
                <div
                  key={account.userId}
                  className="flex items-center gap-3 px-5 py-2.5 transition hover:bg-ink/[0.02]"
                >
                  <span className="w-5 shrink-0 text-right font-mono text-xs tabular-nums text-ink-faint">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[13px] text-ink">
                      {account.email ?? account.userId}
                      {i === 0 && account.runs30d > 0 && (
                        <Flame
                          className="ml-1 inline h-3.5 w-3.5 align-[-2px] text-terracotta"
                          aria-hidden
                        />
                      )}
                    </p>
                    <p className="truncate text-xs text-ink-faint">
                      {account.brands.length > 0 ? account.brands.join(" · ") : "no brands"} · last
                      run {timeAgo(account.lastRunAt)}
                    </p>
                  </div>
                  <Badge tone={CLASS_TONE[account.emailClass]}>{account.emailClass}</Badge>
                  <span className="w-14 shrink-0 text-right font-mono text-sm tabular-nums text-ink">
                    {account.runs30d.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ---- Row 3: the outbound log ----------------------------------------- */}
      <section className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold text-ink">Latest runs</h3>
          <p className="mt-1 max-w-3xl text-sm text-ink-faint">
            Who just used the product and what they ran. Open a run to see the prompts, the
            answers, and what the engines said about their brand.
          </p>
        </div>
        <Card>
          {report.recentRuns.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-faint">No runs in the last 30 days.</p>
          ) : (
            <>
              <div className="flex items-center gap-4 border-b border-ink/10 px-5 py-2">
                <ColumnHeader className="flex-1">Account · brand</ColumnHeader>
                <ColumnHeader className="w-20 text-right">Status</ColumnHeader>
                <ColumnHeader className="w-16 text-right">Answers</ColumnHeader>
                <ColumnHeader className="w-20 text-right">When</ColumnHeader>
                <span className="w-4" />
              </div>
              <div className="max-h-96 divide-y divide-ink/5 overflow-y-auto">
                {report.recentRuns.map((run) => (
                  <Link
                    key={run.id}
                    href={`/admin/runs/${run.id}`}
                    className="flex items-center gap-4 px-5 py-2.5 transition hover:bg-ink/[0.03]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[13px] text-ink">
                        {run.email ?? "(no email)"}
                      </p>
                      <p className="truncate text-xs text-ink-faint">
                        {run.brandName || run.projectName} · {run.provider}/{run.model}
                      </p>
                    </div>
                    <span className="w-20 shrink-0 text-right">
                      <Badge
                        tone={
                          run.status === "completed"
                            ? "mint"
                            : run.status === "failed"
                              ? "terracotta"
                              : "butter"
                        }
                      >
                        {run.status}
                      </Badge>
                    </span>
                    <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-ink-faint">
                      {run.done}/{run.planned}
                    </span>
                    <span className="w-20 shrink-0 text-right text-xs tabular-nums text-ink-faint">
                      {timeAgo(run.createdAt)}
                    </span>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                  </Link>
                ))}
              </div>
            </>
          )}
        </Card>
      </section>

      {/* ---- Row 4: the lead list --------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-ink">Lapsed leads</h3>
            <p className="mt-1 max-w-2xl text-sm text-ink-faint">
              No run in 7 days. Work addresses are the outbound list — and “never ran” is the
              warmest lead: they wanted this enough to sign up, then bounced off something.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded border border-ink/10 bg-surface p-1">
            {LEAD_FILTERS.map((f) => (
              <Link
                key={f.key}
                href={`/admin/growth?f=${f.key}`}
                scroll={false}
                aria-current={f.key === filter.key ? "page" : undefined}
                className={`rounded-sm px-2.5 py-1 text-xs transition ${
                  f.key === filter.key
                    ? "bg-ink/[0.08] font-medium text-ink"
                    : "text-ink-faint hover:text-ink-soft"
                }`}
              >
                {f.label}
                <span className="ml-1 tabular-nums opacity-60">{leadCounts.get(f.key)}</span>
              </Link>
            ))}
          </div>
        </div>
        <Card>
          {leads.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-faint">
              Nobody in this segment has lapsed. Either everyone is active, or nobody in it exists.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-4 border-b border-ink/10 px-5 py-2">
                <ColumnHeader className="flex-1">Email · signup</ColumnHeader>
                <ColumnHeader className="w-16 text-right">Class</ColumnHeader>
                <ColumnHeader className="w-28 text-right">Last run</ColumnHeader>
                <ColumnHeader className="w-14 text-right">R/30d</ColumnHeader>
              </div>
              <div className="max-h-96 divide-y divide-ink/5 overflow-y-auto">
                {leads.map((lead) => (
                  <div
                    key={lead.userId}
                    className="flex items-center gap-4 px-5 py-2.5 transition hover:bg-ink/[0.02]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[13px] text-ink">{lead.email}</p>
                      <p className="text-xs text-ink-faint">
                        signed up {timeAgo(lead.signedUpAt)} · {lead.projects} project
                        {lead.projects === 1 ? "" : "s"}
                      </p>
                    </div>
                    <span className="w-16 shrink-0 text-right">
                      <Badge tone={CLASS_TONE[lead.emailClass]}>{lead.emailClass}</Badge>
                    </span>
                    <span className="w-28 shrink-0 text-right text-xs tabular-nums">
                      {lead.lastRunAt === null ? (
                        <span className="font-medium text-terracotta-dark">never ran</span>
                      ) : (
                        <span className="text-ink-faint">{timeAgo(lead.lastRunAt)}</span>
                      )}
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-ink-faint">
                      {lead.runs30d}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </section>

      <p className="text-xs text-ink-faint">
        Active means “fired a run”, not “signed in”. Email classes: work = company domain,
        personal = consumer providers, burner = disposable inboxes.{" "}
        <Link href="/admin" className="underline">
          Back to operations
        </Link>
      </p>
    </div>
  );
}

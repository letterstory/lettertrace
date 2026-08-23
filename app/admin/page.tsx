import { notFound } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { requireAdmin } from "@/lib/admin";
import { liveHealth, inFlightCount } from "@/lib/ops-live";
import { opsReport } from "@/lib/ops-report";
import { operatorRoster } from "@/lib/ops-operators";
import { OperatorsMenu } from "./operators";
import { Telemetry } from "./telemetry";
import { Badge, Card, CardBody, SectionHeading, StatCard } from "@/components/ui";
import { timeAgo } from "@/lib/utils";
import { maskEmail } from "@/lib/mask";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

/** The windows worth having. Anything finer is noise; anything longer stops
 *  being "what is happening" and becomes reporting. */
const WINDOWS: { label: string; hours: number }[] = [
  { label: "1h", hours: 1 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
];

type SP = Record<string, string | string[] | undefined>;

function windowFrom(searchParams: SP): { label: string; hours: number } {
  const raw = Array.isArray(searchParams.w) ? searchParams.w[0] : searchParams.w;
  return WINDOWS.find((w) => w.label === raw) ?? WINDOWS[1];
}

export default async function AdminPage({ searchParams }: { searchParams: SP }) {
  const admin = await requireAdmin();
  // 404, not 403. Everyone who is not an operator sees exactly what they would
  // see for a route that does not exist, which is the honest answer to them.
  if (!admin) notFound();

  const win = windowFrom(searchParams);
  const [live, ops, inFlight, roster] = await Promise.all([
    liveHealth(win.hours),
    opsReport(win.hours),
    inFlightCount(),
    operatorRoster(),
  ]);

  const failing =
    live.stuck.length > 0 ||
    live.failures.length > 0 ||
    (live.successRate !== null && live.successRate < 90);

  return (
    <div className="space-y-8">
      <SectionHeading
        title="Operations"
        description={`Deployment health. Signed in as ${maskEmail(admin.email)}.`}
        action={<OperatorsMenu roster={roster} />}
      />

      {admin.gate === "email" && (
        <Card className="border-butter/50 bg-butter-tint/40">
          <CardBody className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-butter-ink" aria-hidden />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-ink">Access is gated on email addresses</p>
              <p className="text-ink-soft">
                Safe only while every address in{" "}
                <code className="font-mono text-xs">ADMIN_EMAILS</code> already has an account:
                signup issues a session immediately, so an allowlisted address nobody has
                registered can be claimed by whoever guesses it. Set{" "}
                <code className="font-mono text-xs">ADMIN_USER_IDS</code> instead.
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ---- The verdict, and the window it applies to ---------------------- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-faint">Showing the last {win.label}</p>
          <div className="flex items-center gap-1 rounded border border-ink/10 bg-surface p-1">
            {WINDOWS.map((w) => (
              <Link
                key={w.label}
                href={`/admin?w=${w.label}`}
                scroll={false}
                aria-current={w.label === win.label ? "page" : undefined}
                className={`rounded-sm px-2.5 py-1 text-xs transition ${
                  w.label === win.label
                    ? "bg-ink/[0.08] font-medium text-ink"
                    : "text-ink-faint hover:text-ink-soft"
                }`}
              >
                {w.label}
              </Link>
            ))}
          </div>
        </div>

        <Card
          className={
            failing ? "border-terracotta/40 bg-terracotta/[0.04]" : "border-mint/40 bg-mint-tint/40"
          }
        >
          <CardBody className="flex items-start gap-3">
            {failing ? (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-terracotta" aria-hidden />
            ) : (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-mint-ink" aria-hidden />
            )}
            <div className="space-y-1">
              <p className="font-semibold text-ink">
                {failing ? "Something needs attention" : "Everything looks operational"}
              </p>
              <p className="text-sm text-ink-soft">
                {live.stuck.length > 0 && `${live.stuck.length} run(s) stuck in flight. `}
                {live.failures.length > 0 &&
                  `${live.failures.length} distinct run failure${live.failures.length === 1 ? "" : "s"}. `}
                {!failing &&
                  (live.runs24h.total === 0
                    ? `No runs in the last ${win.label}: nothing has failed, but nothing has been exercised either.`
                    : `${live.runs24h.completed} of ${live.runs24h.completed + live.runs24h.failed} runs completed.`)}
              </p>
              {live.degraded && (
                <p className="text-sm text-terracotta-dark">
                  Some figures could not be loaded ({live.degraded}). Treat the numbers below as
                  incomplete rather than as zero.
                </p>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Run success"
          value={live.successRate === null ? "—" : `${live.successRate}%`}
          hint={
            live.successRate === null
              ? "no runs settled"
              : `${live.runs24h.completed} ok · ${live.runs24h.failed} failed`
          }
          accent={live.successRate !== null && live.successRate < 90 ? "terracotta" : "mint"}
        />
        <StatCard
          label="In flight now"
          value={inFlight.toLocaleString()}
          hint={live.stuck.length > 0 ? `${live.stuck.length} stuck` : "none stuck"}
          accent={live.stuck.length > 0 ? "terracotta" : "teal"}
        />
        <StatCard
          label="Signups"
          value={live.signups24h.toLocaleString()}
          hint={`${live.totalUsers.toLocaleString()} total`}
          accent="butter"
        />
        <StatCard
          label="Failed actions"
          value={live.apiErrors24h.toLocaleString()}
          hint="from the activity log"
          accent={live.apiErrors24h > 0 ? "terracotta" : "sand"}
        />
      </div>

      <Telemetry
        stuck={live.stuck}
        failures={live.failures}
        problems={ops.problems}
        telemetryOn={ops.enabled}
      />

      {/* ---- Per engine: is it us or them ----------------------------------- */}
      {live.engines.length > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3 className="text-lg font-semibold text-ink">By engine</h3>
            <span className="text-sm tabular-nums text-ink-faint">{live.engines.length}</span>
          </div>
          <p className="max-w-3xl text-sm text-ink-faint">
            Where a failure sits. One engine failing while the rest succeed is a provider problem,
            not ours.
          </p>
          <Card>
            <div className="max-h-72 divide-y divide-ink/5 overflow-y-auto">
              {live.engines.map((e) => (
                <div
                  key={e.engine}
                  className="flex items-center justify-between gap-4 px-6 py-3 transition hover:bg-ink/[0.02]"
                >
                  <p className="truncate font-mono text-sm text-ink">{e.engine}</p>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-xs tabular-nums text-ink-faint">
                      {e.completed} ok · {e.failed} failed
                    </span>
                    <Badge tone={e.rate !== null && e.rate < 90 ? "terracotta" : "mint"}>
                      <span className="tabular-nums">{e.rate === null ? "—" : `${e.rate}%`}</span>
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </section>
      )}

      <p className="text-xs text-ink-faint">
        Last run {timeAgo(live.lastRunAt)}. Nothing on this page records or displays customer
        content: prompts, answers and brand names are never written to telemetry.{" "}
        <Link href="/dashboard" className="underline">
          Back to dashboard
        </Link>
      </p>
    </div>
  );
}

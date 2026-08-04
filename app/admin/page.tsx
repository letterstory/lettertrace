import { notFound } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  Activity,
  CheckCircle2,
  CircleSlash,
  Clock,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { requireAdmin } from "@/lib/admin";
import { liveHealth, inFlightCount } from "@/lib/ops-live";
import { opsReport } from "@/lib/ops-report";
import { operatorRoster } from "@/lib/ops-operators";
import { OperatorsMenu } from "./operators";
import { Badge, Card, CardBody, SectionHeading, StatCard } from "@/components/ui";
import { timeAgo } from "@/lib/utils";
import { maskEmail } from "@/lib/mask";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function AdminPage() {
  const admin = await requireAdmin();
  // 404, not 403. Everyone who is not an operator sees exactly what they would
  // see for a route that does not exist, which is the honest answer to them.
  if (!admin) notFound();

  const [live, ops, inFlight, roster] = await Promise.all([
    liveHealth(24),
    opsReport(24),
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
        description={`Deployment health for the last 24 hours. Signed in as ${maskEmail(admin.email)}.`}
        action={<OperatorsMenu roster={roster} />}
      />

      {/* Gating on email is usable but conditional: it holds only while every
          allowlisted address already has an account, because signup issues a
          session immediately and an address with no account can simply be
          registered. A user id cannot be claimed that way. */}
      {admin.gate === "email" && (
        <Card className="border-butter/50 bg-butter-tint/40">
          <CardBody className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-butter-ink" />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-ink">Access is gated on email addresses</p>
              <p className="text-ink-soft">
                That is safe only while every address in{" "}
                <code className="font-mono text-xs">ADMIN_EMAILS</code> already has an account —
                signup issues a session immediately, so an allowlisted address that nobody has
                registered can be claimed by anyone who guesses it. Set{" "}
                <code className="font-mono text-xs">ADMIN_USER_IDS</code> instead: a user id is
                assigned by the auth server and cannot be registered into. When it is set, the
                email list is ignored.
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      {/* The single sentence someone should be able to read from a phone. */}
      <Card
        className={
          failing ? "border-terracotta/40 bg-terracotta/[0.04]" : "border-mint/40 bg-mint-tint/40"
        }
      >
        <CardBody className="flex items-start gap-3">
          {failing ? (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-terracotta" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-mint-ink" />
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
                  ? "No runs in the last 24 hours — nothing has failed, but nothing has been exercised either."
                  : `${live.runs24h.completed} of ${live.runs24h.completed + live.runs24h.failed} runs completed.`)}
            </p>
            {live.degraded && (
              <p className="text-sm text-terracotta-dark">
                Some figures could not be loaded ({live.degraded}) — treat the numbers below as
                incomplete rather than as zero.
              </p>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Run success (24h)"
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
          label="Signups (24h)"
          value={live.signups24h.toLocaleString()}
          hint={`${live.totalUsers.toLocaleString()} total`}
          accent="butter"
        />
        <StatCard
          label="Failed actions (24h)"
          value={live.apiErrors24h.toLocaleString()}
          hint="from the activity log"
          accent={live.apiErrors24h > 0 ? "terracotta" : "sand"}
        />
      </div>

      {/* ---- Stuck runs: the failure nothing else reports ------------------- */}
      {live.stuck.length > 0 && (
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-ink">
            <Clock className="h-4 w-4 text-terracotta" />
            Stuck runs
          </h3>
          <p className="text-sm text-ink-faint">
            Still marked running after 30 minutes. Usually an invocation that died without writing a
            status — the run will never finish on its own.
          </p>
          <Card>
            <CardBody className="divide-y divide-ink/5 p-0">
              {live.stuck.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-4 px-6 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">
                      {r.provider}/{r.model}
                    </p>
                    <p className="font-mono text-xs text-ink-faint">{r.id.slice(0, 8)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium text-terracotta-dark">{r.minutes}m</p>
                    <p className="text-xs text-ink-faint">
                      {r.done}/{r.planned} answers
                    </p>
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        </section>
      )}

      {/* ---- What is failing, grouped ---------------------------------------- */}
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-ink">
          <XCircle className="h-4 w-4 text-terracotta" />
          Run failures
        </h3>
        {live.failures.length === 0 ? (
          <Card>
            <CardBody className="flex items-center gap-2 text-sm text-ink-faint">
              <CheckCircle2 className="h-4 w-4 text-mint-ink" />
              No failed runs in the last 24 hours.
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardBody className="divide-y divide-ink/5 p-0">
              {live.failures.map((f) => (
                <div key={f.signature} className="space-y-1 px-6 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <p className="min-w-0 flex-1 text-sm text-ink">{f.example}</p>
                    <Badge tone="terracotta">
                      {f.count}
                      {f.count === 1 ? " run" : " runs"}
                    </Badge>
                  </div>
                  <p className="text-xs text-ink-faint">
                    {f.engines.join(", ")} · last {timeAgo(f.lastSeen)}
                  </p>
                </div>
              ))}
            </CardBody>
          </Card>
        )}
      </section>

      {/* ---- Per engine, so "is it us or them" is answerable ------------------ */}
      {live.engines.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-lg font-semibold text-ink">By engine</h3>
          <p className="text-sm text-ink-faint">
            Where a failure sits. One engine failing while the rest succeed is a provider problem,
            not ours.
          </p>
          <Card>
            <CardBody className="divide-y divide-ink/5 p-0">
              {live.engines.map((e) => (
                <div key={e.engine} className="flex items-center justify-between gap-4 px-6 py-3">
                  <p className="truncate font-mono text-sm text-ink">{e.engine}</p>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-xs text-ink-faint">
                      {e.completed} ok · {e.failed} failed
                    </span>
                    <Badge tone={e.rate !== null && e.rate < 90 ? "terracotta" : "mint"}>
                      {e.rate === null ? "—" : `${e.rate}%`}
                    </Badge>
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        </section>
      )}

      {/* ---- Errors from outside the run lifecycle ---------------------------- */}
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-ink">
          <Activity className="h-4 w-4 text-ink-faint" />
          Recorded errors
        </h3>
        {!ops.enabled ? (
          <Card>
            <CardBody className="flex items-start gap-2 text-sm text-ink-faint">
              <CircleSlash className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Telemetry is off, so errors outside the run lifecycle — API routes, background jobs,
                and individual provider calls within a run — are not being recorded. Set{" "}
                <code className="font-mono text-xs">OPS_TELEMETRY=1</code> and redeploy to collect
                them. It must literally be <code className="font-mono text-xs">1</code> or{" "}
                <code className="font-mono text-xs">true</code>: the variable existing but holding an
                empty string reads as off, which looks identical to never having set it. Everything
                above is read from run history and does not depend on this.
              </span>
            </CardBody>
          </Card>
        ) : ops.problems.length === 0 ? (
          <Card>
            <CardBody className="flex items-center gap-2 text-sm text-ink-faint">
              <CheckCircle2 className="h-4 w-4 text-mint-ink" />
              Nothing recorded in the last 24 hours.
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardBody className="divide-y divide-ink/5 p-0">
              {ops.problems.map((p) => (
                <div key={p.signature} className="space-y-1 px-6 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <p className="min-w-0 flex-1 break-words text-sm text-ink">{p.signature}</p>
                    <Badge tone="terracotta">{p.occurrences}×</Badge>
                  </div>
                  <p className="text-xs text-ink-faint">
                    {p.source} · last {timeAgo(p.lastSeen)}
                  </p>
                </div>
              ))}
            </CardBody>
          </Card>
        )}
      </section>

      <p className="text-xs text-ink-faint">
        Last run {timeAgo(live.lastRunAt)}. Nothing on this page records or displays customer content —
        prompts, answers and brand names are never written to telemetry.{" "}
        <Link href="/dashboard" className="underline">
          Back to dashboard
        </Link>
      </p>
    </div>
  );
}

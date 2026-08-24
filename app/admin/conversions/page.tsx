import { Fragment } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { requireAdmin } from "@/lib/admin";
import { conversionsReport } from "@/lib/conversions";
import type { EmailClass } from "@/lib/growth";
import { Badge, Card, SectionHeading, StatCard } from "@/components/ui";
import { timeAgo } from "@/lib/utils";

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
 * Deliberately small for now: one row of numbers, one table.
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

export default async function ConversionsPage() {
  const admin = await requireAdmin();
  if (!admin) notFound();

  const { stats, connected, degraded } = await conversionsReport();

  return (
    <div className="space-y-10">
      <SectionHeading
        title="Conversions"
        description="Who goes from lettertrace to another Letter Company product. Today this measures connected users — clicked one of our outbound links; signups and paying customers become their own rungs once we can measure them. Emails are in the clear: this is a cross-sell list."
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
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Connected rate"
          value={stats.rate === null ? "—" : `${stats.rate}%`}
          hint={`${stats.connectedUsers.toLocaleString()} of ${stats.totalUsers.toLocaleString()} signups clicked a Letter product`}
          accent="mint"
        />
        <StatCard
          label="Connected users"
          value={stats.connectedUsers.toLocaleString()}
          hint="distinct users, all time"
          accent="teal"
        />
        <StatCard
          label="Clicks"
          value={stats.clicks30d.toLocaleString()}
          hint={`rolling 30d · ${stats.clicks7d.toLocaleString()} in 7d · ${stats.clicksTotal.toLocaleString()} ever`}
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
              ? `${stats.topProduct.clicks.toLocaleString()} click${stats.topProduct.clicks === 1 ? "" : "s"}`
              : "no clicks recorded yet"
          }
          accent="sand"
        />
      </div>

      {/* ---- Row 2: who's connected ------------------------------------------ */}
      <section className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold text-ink">Connected users</h3>
          <p className="mt-1 max-w-3xl text-sm text-ink-faint">
            Everyone who clicked out to a Letter Company product, most recent first, with where
            they went.
          </p>
        </div>
        <Card>
          {connected.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-faint">
              Nobody has clicked out yet. Tracking only exists from the day it shipped, so an
              empty list right after a deploy means &ldquo;too early&rdquo;, not
              &ldquo;never&rdquo;.
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
        in OutboundLink; today that is the Phantoms item in the dashboard nav.{" "}
        <Link href="/admin/growth" className="underline">
          Back to growth
        </Link>
      </p>
    </div>
  );
}

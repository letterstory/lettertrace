"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  /** Base name of the icon in /public/images/icons (Default + active variants). */
  icon: string;
  /** Rendered only in the wrapped phone row; at md+ the item's content lives
      in the Reports sub-menu under Overview instead. */
  mobileOnly?: boolean;
}

/** A completed run, pre-formatted by the layout for the sidebar. */
export interface NavReport {
  id: string;
  /** Relative age ("6d ago") — recency is what people scan the list by. */
  when: string;
  model: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: "Overview" },
  { href: "/dashboard/topics", label: "Topics", icon: "Topics" },
  { href: "/dashboard/competitors", label: "Competitors", icon: "Competitors" },
  // Reports lives under Overview at md+ (see the sub-menu below); this item
  // exists so the section is still reachable from the phone row, where a
  // nested list inside a wrapping flex-row would be unreadable.
  { href: "/dashboard/runs", label: "Reports", icon: "Runs", mobileOnly: true },
  { href: "/dashboard/logs", label: "Logs", icon: "Logs" },
  { href: "/dashboard/settings", label: "Settings", icon: "Settings" },
];

export function DashboardNav({
  reports,
  totalReports,
}: {
  reports: NavReport[];
  totalReports: number;
}) {
  const pathname = usePathname();
  // Open by default: the sub-menu is the pitch — "reports are a thing you run
  // repeatedly" — so it shouldn't hide behind a click. The nav survives route
  // changes (the dashboard layout never remounts), so a collapse sticks for
  // the visit.
  const [reportsOpen, setReportsOpen] = useState(true);

  return (
    // Six labelled items in one un-wrapping row overflowed the viewport on a
    // phone, pushing every dashboard page ~267px wide. Wrapping keeps the
    // labels and needs no scrolling; the column layout at md+ must not wrap, or
    // the fixed-height sidebar would spill items into a second column.
    <nav className="flex flex-row flex-wrap gap-1 md:flex-col md:flex-nowrap">
      {NAV_ITEMS.map(({ href, label, icon, mobileOnly }) => {
        const isOverview = href === "/dashboard";
        const active =
          isOverview
            ? pathname === "/dashboard"
            : pathname.startsWith(href);
        const link = (
          <Link
            href={href}
            className={cn(
              "group flex items-center gap-3 rounded px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-terracotta/10 text-terracotta-dark"
                : "text-ink-soft hover:bg-ink/5",
              mobileOnly && "md:hidden",
            )}
          >
            <span className="relative h-4 w-4 shrink-0" aria-hidden>
              {/* Default state: shown when not active, hidden on hover. */}
              <img
                src={`/images/icons/${icon}-Default.svg`}
                alt=""
                className={cn(
                  "absolute inset-0 h-full w-full",
                  active ? "hidden" : "block group-hover:hidden",
                )}
              />
              {/* Active state: full opacity when active, 50% opacity on hover. */}
              <img
                src={`/images/icons/${icon}.svg`}
                alt=""
                className={cn(
                  "absolute inset-0 h-full w-full",
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-50",
                )}
              />
            </span>
            <span>{label}</span>
          </Link>
        );
        return (
          <Fragment key={href}>
          {isOverview ? (
            // The toggle can't live inside the Link (nested interactive
            // elements), so it overlays the row's right edge instead.
            <div className="relative w-full">
              {link}
              <button
                type="button"
                onClick={() => setReportsOpen((o) => !o)}
                aria-label={reportsOpen ? "Collapse reports" : "Expand reports"}
                aria-expanded={reportsOpen}
                className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded p-1 text-ink-faint transition-colors hover:bg-ink/10 hover:text-ink md:block"
              >
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 transition-transform",
                    !reportsOpen && "-rotate-90",
                  )}
                />
              </button>
            </div>
          ) : (
            link
          )}
          {/* Reports under Overview: the Overview page is the standing summary
              across time; each report is a one-off snapshot feeding it. Nesting
              them says that — and keeps "run another one" a single click from
              anywhere. The left border hangs from the Overview icon's center. */}
          {isOverview && reportsOpen && (
            <div className="mb-1 ml-5 hidden flex-col gap-0.5 border-l border-ink/10 pl-3 md:flex">
              <Link
                href="/dashboard/runs"
                className={cn(
                  "flex items-center gap-2 rounded px-2 py-1.5 text-[13px] font-medium transition-colors",
                  pathname === "/dashboard/runs"
                    ? "bg-terracotta/10 text-terracotta-dark"
                    : "text-ink-soft hover:bg-ink/5",
                )}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>Create New Report</span>
              </Link>
              {reports.map((report) => {
                const reportActive = pathname === `/dashboard/runs/${report.id}`;
                return (
                  <Link
                    key={report.id}
                    href={`/dashboard/runs/${report.id}`}
                    className={cn(
                      "flex items-center rounded px-2 py-1.5 text-[13px] transition-colors",
                      reportActive
                        ? "bg-terracotta/10 text-terracotta-dark"
                        : "text-ink-soft hover:bg-ink/5",
                    )}
                  >
                    <span className="truncate">
                      {report.when}
                      <span
                        className={cn(
                          "ml-1.5",
                          reportActive ? "opacity-70" : "text-ink-faint",
                        )}
                      >
                        {report.model}
                      </span>
                    </span>
                  </Link>
                );
              })}
              {totalReports > reports.length && (
                <Link
                  href="/dashboard/runs"
                  className="rounded px-2 py-1.5 text-[13px] text-ink-faint transition-colors hover:bg-ink/5 hover:text-ink-soft"
                >
                  All reports ({totalReports})
                </Link>
              )}
            </div>
          )}
          </Fragment>
        );
      })}
    </nav>
  );
}

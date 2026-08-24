"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { OutboundLink } from "@/components/outbound-link";

interface NavItem {
  href: string;
  label: string;
  /** Base name of the icon in /public/images/icons (Default + active variants). */
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: "Overview" },
  { href: "/dashboard/topics", label: "Topics", icon: "Topics" },
  { href: "/dashboard/competitors", label: "Competitors", icon: "Competitors" },
  { href: "/dashboard/runs", label: "Runs", icon: "Runs" },
  { href: "/dashboard/logs", label: "Logs", icon: "Logs" },
  { href: "/dashboard/settings", label: "Settings", icon: "Settings" },
];

export function DashboardNav() {
  const pathname = usePathname();

  return (
    // Six labelled items in one un-wrapping row overflowed the viewport on a
    // phone, pushing every dashboard page ~267px wide. Wrapping keeps the
    // labels and needs no scrolling; the column layout at md+ must not wrap, or
    // the fixed-height sidebar would spill items into a second column.
    <nav className="flex flex-row flex-wrap gap-1 md:flex-col md:flex-nowrap">
      {NAV_ITEMS.map(({ href, label, icon }) => {
        const active =
          href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(href);
        return (
          <Fragment key={href}>
          {/* Phantomstory sits above Settings: a nav-shaped item that is really
              an external link, and dressed to say so — the brand mark renders
              greyscale until hover brings the colour up, and the corner arrow
              is right-aligned where a route item would have nothing.
              OutboundLink so the click lands on /admin/conversions. */}
          {href === "/dashboard/settings" && (
            <OutboundLink
              href="https://phantomstory.com"
              target="_blank"
              rel="noreferrer"
              className="group flex items-center gap-3 rounded px-3 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-ink/5"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/phantomstory.png"
                alt=""
                aria-hidden
                className="h-4 w-4 shrink-0 grayscale transition group-hover:grayscale-0"
              />
              <span>Phantoms</span>
              <ArrowUpRight
                className="ml-auto h-3.5 w-3.5 shrink-0 text-ink-faint transition-colors group-hover:text-ink-soft"
                aria-hidden
              />
            </OutboundLink>
          )}
          <Link
            href={href}
            className={cn(
              "group flex items-center gap-3 rounded px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-terracotta/10 text-terracotta-dark"
                : "text-ink-soft hover:bg-ink/5",
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
          </Fragment>
        );
      })}
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

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
  { href: "/dashboard/settings", label: "Settings", icon: "Settings" },
];

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-row gap-1 md:flex-col">
      {NAV_ITEMS.map(({ href, label, icon }) => {
        const active =
          href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
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
        );
      })}
    </nav>
  );
}

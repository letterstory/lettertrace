"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquareText,
  Swords,
  Play,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/topics", label: "Topics", icon: MessageSquareText },
  { href: "/dashboard/competitors", label: "Competitors", icon: Swords },
  { href: "/dashboard/runs", label: "Runs", icon: Play },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-row gap-1 md:flex-col">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active =
          href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-terracotta/10 text-terracotta-dark"
                : "text-ink-soft hover:bg-ink/5",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

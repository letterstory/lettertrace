"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The admin surface grew a second page, so the static "operations" chip in the
 * layout became these tabs. Client-side only for usePathname — there is no
 * state here.
 *
 * A run detail page is reached from Growth, so it highlights Growth: the tab
 * answers "which section am I in", not "which URL is this".
 */
const TABS = [
  { href: "/admin", label: "Operations", match: (p: string) => p === "/admin" },
  {
    href: "/admin/growth",
    label: "Growth",
    match: (p: string) => p.startsWith("/admin/growth") || p.startsWith("/admin/runs"),
  },
];

export function AdminNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="flex items-center gap-1 rounded border border-ink/10 bg-surface p-1">
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-sm px-2.5 py-1 text-xs transition",
              active ? "bg-ink/[0.08] font-medium text-ink" : "text-ink-faint hover:text-ink-soft",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

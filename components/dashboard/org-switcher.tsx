"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface OrgOption {
  id: string;
  /** Workspace name (projects.name). */
  name: string;
  /** Brand being monitored (projects.brand_name). */
  brandName: string;
}

// Sidebar organization switcher: pick which of the account's organizations the
// dashboard shows, or jump to creating a new one.
export function OrgSwitcher({ orgs, activeId }: { orgs: OrgOption[]; activeId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const active = orgs.find((o) => o.id === activeId) ?? orgs[0];

  async function switchTo(id: string) {
    if (!active || id === active.id) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/project/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id }),
      });
      if (res.ok) {
        setOpen(false);
        // Land on the overview so the whole view belongs to the new org.
        router.push("/dashboard");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-2xl border border-ink/10 bg-paper-shade/50 px-4 py-3 text-left transition hover:border-ink/25 disabled:opacity-60"
      >
        <span className="min-w-0">
          <span className="block truncate font-serif text-sm font-semibold text-ink">
            {active?.brandName ?? "Select organization"}
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-faint">
            {active?.name}
          </span>
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
      </button>

      {open && (
        <>
          {/* Click-away layer */}
          <button
            type="button"
            aria-label="Close organization menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
            tabIndex={-1}
          />
          <div
            role="listbox"
            className="absolute left-0 right-0 z-20 mt-2 overflow-hidden rounded-2xl border border-ink/10 bg-paper shadow-card"
          >
            <p className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              Organizations
            </p>
            <ul className="max-h-64 overflow-y-auto pb-1">
              {orgs.map((org) => {
                const isActive = org.id === active?.id;
                return (
                  <li key={org.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => switchTo(org.id)}
                      disabled={busy}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm transition",
                        isActive ? "bg-terracotta/10 text-terracotta-dark" : "text-ink hover:bg-ink/5",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{org.brandName}</span>
                        {org.name !== org.brandName && (
                          <span className="block truncate text-xs text-ink-faint">{org.name}</span>
                        )}
                      </span>
                      {isActive && <Check className="h-4 w-4 shrink-0" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
            <Link
              href="/dashboard/new"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 border-t border-ink/10 px-4 py-2.5 text-sm font-medium text-terracotta-dark transition hover:bg-ink/5"
            >
              <Plus className="h-4 w-4" aria-hidden />
              New organization
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

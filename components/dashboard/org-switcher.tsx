"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Check, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface OrgOption {
  id: string;
  /** Workspace name (projects.name). */
  name: string;
  /** Brand being monitored (projects.brand_name). */
  brandName: string;
}

// Sidebar organization switcher: pick which of the account's organizations the
// dashboard shows, or jump to creating a new one. Switching is optimistic: the
// menu closes and the button shows the new org immediately, while a full-screen
// loader covers the server round-trip + dashboard re-render.
export function OrgSwitcher({
  orgs,
  activeId,
  canAddOrg,
}: {
  orgs: OrgOption[];
  activeId: string;
  /** False while the account is on the trial with one org already set up.
   *  A second org can't produce a usable result on free credits — no
   *  competitors, no calibrated prompts — and each one silently spends a
   *  free run on its first monitor. */
  canAddOrg: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pendingOrg, setPendingOrg] = useState<OrgOption | null>(null);
  const [isPending, startTransition] = useTransition();

  const active = orgs.find((o) => o.id === activeId) ?? orgs[0];
  // What the button shows: the org we're switching to wins until the server
  // catches up (activeId prop updates after the refresh).
  const shown = pendingOrg ?? active;

  // The switch is done once the re-rendered layout hands us the new activeId.
  useEffect(() => {
    if (pendingOrg && activeId === pendingOrg.id && !isPending) {
      setPendingOrg(null);
    }
  }, [pendingOrg, activeId, isPending]);

  async function switchTo(org: OrgOption) {
    setOpen(false);
    if (!active || org.id === active.id) return;
    setPendingOrg(org);
    try {
      const res = await fetch("/api/project/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: org.id }),
      });
      if (!res.ok) {
        setPendingOrg(null);
        return;
      }
      startTransition(() => {
        // Land on the overview so the whole view belongs to the new org.
        router.push("/dashboard");
        router.refresh();
      });
    } catch {
      setPendingOrg(null);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-2xl border border-ink/10 bg-paper-shade/50 px-4 py-3 text-left transition hover:border-ink/25"
      >
        <span className="min-w-0">
          <span className="block truncate font-serif text-sm font-semibold text-ink">
            {shown?.brandName ?? "Select organization"}
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-faint">
            {shown?.name}
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
                      onClick={() => switchTo(org)}
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
            {canAddOrg ? (
              <Link
                href="/dashboard/new"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 border-t border-ink/10 px-4 py-2.5 text-sm font-medium text-terracotta-dark transition hover:bg-ink/5"
              >
                <Plus className="h-4 w-4" aria-hidden />
                New organization
              </Link>
            ) : (
              <div className="border-t border-ink/10 px-4 py-3">
                <p className="flex items-center gap-2 text-sm font-medium text-ink-faint">
                  <Plus className="h-4 w-4 shrink-0" aria-hidden />
                  New organization
                </p>
                <p className="mt-1 text-xs text-ink-faint">
                  Add your own API key to monitor another brand.
                </p>
                <Link
                  href="/dashboard/settings"
                  onClick={() => setOpen(false)}
                  className="mt-1 inline-block text-xs font-medium text-terracotta-dark transition hover:text-terracotta"
                >
                  Add a key →
                </Link>
              </div>
            )}
          </div>
        </>
      )}

      {/* Full-screen loader while the dashboard re-renders as the new org. */}
      {pendingOrg && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-paper/85 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <div className="relative flex h-16 w-16 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-terracotta/20" />
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-terracotta/10 text-terracotta">
              <ArrowLeftRight className="h-7 w-7" aria-hidden />
            </span>
          </div>
          <p className="mt-5 font-serif text-lg font-semibold text-ink">
            {pendingOrg.brandName}
          </p>
          <p className="mt-1 text-sm text-ink-faint">Switching organization…</p>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ArrowUpRight, Search, Users, X } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import type { AccountRow } from "@/lib/accounts";
import type { EmailClass } from "@/lib/growth";

/**
 * The People directory: every account, in a modal, searchable and ranked by
 * last used. A client island so the server-rendered Growth page stays a server
 * component — the rows are computed once on the server (see shapeAccounts) and
 * handed down; all this does is filter, search and open one.
 *
 * It reads as a THIN list on purpose. The operator is scanning names and
 * hunting for one address, not reading cards, so every row is a single dense
 * line: company, email, how recently, how much. Clicking a row leaves the modal
 * for that account's full history at /admin/accounts/[id].
 *
 * Gmails are kept. The class chips are the answer to "actually, hide them" —
 * the default is All (everyone is a user), and Work narrows to the outbound
 * list in one click without the directory having to decide for you.
 */

const CLASS_DOT: Record<EmailClass, string> = {
  work: "bg-teal",
  personal: "bg-sand",
  burner: "bg-terracotta",
};

const CLASS_FILTERS: { key: "all" | EmailClass; label: string }[] = [
  { key: "all", label: "All" },
  { key: "work", label: "Work" },
  { key: "personal", label: "Personal" },
  { key: "burner", label: "Burner" },
];

// Rendered-row cap. Search filters the FULL list; only the DOM is bounded, so a
// directory of thousands never paints thousands of rows at once. When the cut
// bites, the list says so rather than pretending the tail isn't there.
const RENDER_CAP = 300;

export function PeopleDirectory({ accounts }: { accounts: AccountRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded border border-ink/15 bg-surface px-3 py-1.5 text-sm text-ink-soft transition hover:border-ink/25 hover:text-ink"
      >
        <Users className="h-4 w-4" aria-hidden />
        People
        <span className="text-ink-faint tabular-nums">{accounts.length}</span>
      </button>
      {open && <PeopleDialog accounts={accounts} onClose={() => setOpen(false)} />}
    </>
  );
}

function PeopleDialog({ accounts, onClose }: { accounts: AccountRow[]; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [q, setQ] = useState("");
  const [cls, setCls] = useState<"all" | EmailClass>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  // Put the cursor in search — this modal exists to be typed into. Keyed on
  // `mounted`, NOT run inline below, because the mount gate returns null on the
  // first render: focusing then hits a ref that isn't attached yet. This fires
  // on the render that actually paints the input.
  useEffect(() => {
    if (mounted) searchRef.current?.focus();
  }, [mounted]);

  // Escape to close, and lock body scroll while the modal is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const counts = useMemo(() => {
    const c = { all: accounts.length, work: 0, personal: 0, burner: 0 };
    for (const a of accounts) c[a.emailClass] += 1;
    return c;
  }, [accounts]);

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    return accounts.filter((a) => {
      if (cls !== "all" && a.emailClass !== cls) return false;
      if (!needle) return true;
      return (
        (a.email ?? "").toLowerCase().includes(needle) ||
        (a.company ?? "").toLowerCase().includes(needle) ||
        a.brands.some((b) => b.toLowerCase().includes(needle))
      );
    });
  }, [accounts, cls, needle]);

  const shown = filtered.slice(0, RENDER_CAP);
  const clipped = filtered.length - shown.length;

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="people-title"
    >
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm animate-fade-up" onClick={onClose} />
      <div className="relative mt-8 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded border border-ink/10 bg-paper shadow-lift animate-fade-up">
        {/* ---- Header --------------------------------------------------------- */}
        <div className="flex items-start justify-between gap-4 border-b border-ink/10 px-5 py-4">
          <div>
            <h2 id="people-title" className="text-lg font-semibold tracking-tight text-ink">
              People
            </h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Everyone who has signed up, ranked by last used. Click a row for their full history.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[2px] text-ink-soft transition hover:bg-ink/[0.05] hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* ---- Toolbar: search + class chips --------------------------------- */}
        <div className="space-y-3 border-b border-ink/10 px-5 py-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
              aria-hidden
            />
            <input
              ref={searchRef}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search an address, company or brand…"
              aria-label="Search people"
              className="w-full rounded border border-ink/15 bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-ink/30 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-1 rounded border border-ink/10 bg-surface p-1">
            {CLASS_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setCls(f.key)}
                aria-pressed={cls === f.key}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs transition",
                  cls === f.key
                    ? "bg-ink/[0.08] font-medium text-ink"
                    : "text-ink-faint hover:text-ink-soft",
                )}
              >
                {f.label}
                <span className="ml-1 tabular-nums opacity-60">{counts[f.key]}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ---- The list ------------------------------------------------------ */}
        {shown.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-faint">
            {needle ? `Nobody matches “${q}”.` : "No accounts yet."}
          </p>
        ) : (
          <div className="min-h-0 flex-1 divide-y divide-ink/5 overflow-y-auto">
            {shown.map((a) => (
              <Link
                key={a.userId}
                href={`/admin/accounts/${a.userId}`}
                className="flex items-center gap-3 px-5 py-1.5 transition hover:bg-ink/[0.03]"
              >
                <span
                  className={cn("h-2 w-2 shrink-0 rounded-sm", CLASS_DOT[a.emailClass])}
                  title={a.emailClass}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  <span className="text-ink">{a.company ?? a.email ?? "(no email)"}</span>
                  {a.company && a.email && (
                    <span className="ml-2 font-mono text-xs text-ink-faint">{a.email}</span>
                  )}
                </span>
                <span
                  className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-ink-faint"
                  title={`${a.runs30d} run${a.runs30d === 1 ? "" : "s"} in 30d`}
                >
                  {a.runs30d || "—"}
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-ink-faint">
                  {a.lastRunAt ? timeAgo(a.lastRunAt) : "never"}
                </span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
              </Link>
            ))}
          </div>
        )}

        {/* ---- Footer -------------------------------------------------------- */}
        <div className="border-t border-ink/10 px-5 py-2.5 text-xs text-ink-faint">
          {clipped > 0 ? (
            <>
              Showing the first {shown.length.toLocaleString()} of{" "}
              {filtered.length.toLocaleString()} — refine the search to reach the rest.
            </>
          ) : (
            <>
              {filtered.length.toLocaleString()}{" "}
              {filtered.length === 1 ? "account" : "accounts"}
              {cls !== "all" || needle ? " shown" : " total"}. Runs count the last 30 days.
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

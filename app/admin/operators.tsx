"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Users } from "lucide-react";
import { Badge } from "@/components/ui";
import type { OperatorRoster } from "@/lib/ops-operators";
import { maskEmail, maskUuid } from "@/lib/mask";
import { timeAgo } from "@/lib/utils";

/**
 * The operator list, as a menu rather than a section.
 *
 * It answers a question you ask occasionally ("who has access, and what is the
 * current value so I can add someone") rather than one you scan continuously,
 * so it does not earn permanent space next to the health figures.
 *
 * Identifiers are masked on screen. The copy button still copies the FULL
 * value — masking a field whose only purpose is to be pasted into Vercel would
 * be theatre. The point is that the page can be screenshared without spilling
 * addresses and complete ids, not that the operator cannot get at them.
 */
export function OperatorsMenu({ roster }: { roster: OperatorRoster }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (roster.gate === "none") return null;

  const varName = roster.gate === "user-id" ? "ADMIN_USER_IDS" : "ADMIN_EMAILS";
  const unresolved = roster.entries.filter((e) => !e.resolved).length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(roster.currentValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked; nothing else to do from here */
    }
  };

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className="inline-flex items-center gap-2 rounded border border-ink/15 bg-surface px-3 py-1.5 text-sm text-ink-soft transition hover:border-ink/25 hover:text-ink"
      >
        <Users className="h-4 w-4" aria-hidden />
        Operators
        <span className="text-ink-faint">{roster.entries.length}</span>
        {unresolved > 0 && <span className="h-1.5 w-1.5 rounded-full bg-terracotta" aria-hidden />}
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-[22rem] rounded border border-ink/10 bg-surface shadow-card sm:w-[26rem]">
          <div className="border-b border-ink/5 px-4 py-3">
            <p className="text-sm font-medium text-ink">Who can open this page</p>
            <p className="mt-0.5 text-xs text-ink-faint">
              From <code className="font-mono">{varName}</code>. Shown masked.
            </p>
          </div>

          <div className="max-h-64 divide-y divide-ink/5 overflow-y-auto">
            {roster.entries.map((e) => (
              <div key={e.value} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">
                    {e.email ? (
                      maskEmail(e.email)
                    ) : (
                      <span className="text-ink-faint">no account matches</span>
                    )}
                  </p>
                  <p className="truncate font-mono text-xs text-ink-faint">
                    {roster.gate === "user-id" ? maskUuid(e.value) : maskEmail(e.value)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {e.resolved && (
                    <span className="hidden text-xs text-ink-faint sm:inline">
                      {timeAgo(e.lastSignInAt)}
                    </span>
                  )}
                  {e.resolved ? (
                    <Badge tone="mint">active</Badge>
                  ) : (
                    <Badge tone="terracotta">
                      {roster.gate === "user-id" ? "unknown" : "claimable"}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>

          {unresolved > 0 && (
            <p className="border-t border-ink/5 px-4 py-2.5 text-xs text-terracotta-dark">
              {roster.gate === "user-id"
                ? "An id matching no account grants nothing. It is almost certainly a typo, and whoever it was meant for cannot get in."
                : "An allowlisted address with no account can be registered by anyone who guesses it. Switch to ADMIN_USER_IDS."}
            </p>
          )}

          {roster.degraded && (
            <p className="border-t border-ink/5 px-4 py-2.5 text-xs text-ink-faint">
              Accounts could not be fully read ({roster.degraded}), so an entry shown as unmatched may
              simply not have been checked.
            </p>
          )}

          <div className="space-y-2 border-t border-ink/5 px-4 py-3">
            <p className="text-xs text-ink-faint">
              To add someone, copy the current value, append their id after a comma, and paste it
              back into your host. Useful when the variable is marked sensitive and will not show
              you what is already there.
            </p>
            <button
              type="button"
              onClick={copy}
              className="inline-flex w-full items-center justify-center gap-2 rounded-sm border border-ink/15 px-3 py-1.5 text-xs text-ink-soft transition hover:border-ink/25 hover:text-ink"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden />
              )}
              {copied ? "Copied full value" : `Copy ${varName}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

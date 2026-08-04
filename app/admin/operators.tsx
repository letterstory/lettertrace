"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Badge, Card, CardBody } from "@/components/ui";
import type { OperatorRoster } from "@/lib/ops-operators";
import { timeAgo } from "@/lib/utils";

/**
 * The operator list, shown because Vercel will not show it to you.
 *
 * A "sensitive" variable is write-only in the management UI: editing it means
 * retyping the whole list from memory, and a mistake locks someone out
 * silently. The running app can read it perfectly well, so it is displayed
 * here with a copy button — the edit becomes copy, append, paste.
 */
export function Operators({ roster }: { roster: OperatorRoster }) {
  const [copied, setCopied] = useState(false);
  const varName = roster.gate === "user-id" ? "ADMIN_USER_IDS" : "ADMIN_EMAILS";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(roster.currentValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked; the value is still selectable below */
    }
  };

  if (roster.gate === "none") return null;

  return (
    <section className="space-y-3">
      <h3 className="text-lg font-semibold text-ink">Operators</h3>
      <p className="text-sm text-ink-faint">
        Everyone who can open this page, from{" "}
        <code className="font-mono text-xs">{varName}</code>.
      </p>

      <Card>
        <CardBody className="divide-y divide-ink/5 p-0">
          {roster.entries.map((e) => (
            <div key={e.value} className="flex items-center justify-between gap-4 px-6 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">
                  {e.email ?? <span className="text-ink-faint">no account matches this entry</span>}
                </p>
                <p className="truncate font-mono text-xs text-ink-faint">{e.value}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {e.resolved && (
                  <span className="hidden text-xs text-ink-faint sm:inline">
                    last seen {timeAgo(e.lastSignInAt)}
                  </span>
                )}
                {e.resolved ? (
                  <Badge tone="mint">active</Badge>
                ) : (
                  <Badge tone="terracotta">
                    {roster.gate === "user-id" ? "unknown id" : "claimable"}
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      {/* An unresolved entry means different things per gate, and the email
          one is a live weakness rather than a typo. Say which. */}
      {roster.entries.some((e) => !e.resolved) &&
        (roster.gate === "user-id" ? (
          <p className="text-xs text-terracotta-dark">
            An id matching no account grants nothing — it is almost certainly a typo, and whoever
            it was meant to be cannot get in.
          </p>
        ) : (
          <p className="text-xs text-terracotta-dark">
            An allowlisted address with no account can be registered by anyone who guesses it,
            which would hand them this page. Switch to{" "}
            <code className="font-mono">ADMIN_USER_IDS</code>, or make sure every address here has
            signed up.
          </p>
        ))}

      {roster.degraded && (
        <p className="text-xs text-ink-faint">
          Accounts could not be fully read ({roster.degraded}) — an entry shown as unmatched may
          simply not have been checked.
        </p>
      )}

      <div className="space-y-2">
        <p className="text-xs text-ink-faint">
          Vercel marks this variable sensitive, so it will not show you the current value when you
          edit it. Here it is — copy, add the new id on the end after a comma, and paste it back.
        </p>
        <div className="relative rounded border border-ink/10 bg-paper-shade/60">
          <pre className="overflow-x-auto p-3 pr-12 font-mono text-xs text-ink-soft">
            {roster.currentValue}
          </pre>
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? "Copied" : "Copy to clipboard"}
            title={copied ? "Copied" : "Copy"}
            className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-[2px] text-ink-faint transition hover:bg-ink/10 hover:text-ink"
          >
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      </div>
    </section>
  );
}

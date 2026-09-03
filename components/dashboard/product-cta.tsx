"use client";

import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { OutboundLink } from "@/components/outbound-link";

/**
 * The cross-product CTA at the foot of the dashboard sidebar, and the only
 * route from lettertrace to Phantomstory: it replaces the "Phantoms" nav row,
 * which sat among six page links in the same weight and colour and so read as
 * a page you had not opened yet rather than as an offer.
 *
 * Proportions copy OrgSwitcher's trigger, so a box of the same shape sits at
 * each end of the sidebar. The second line names the destination, which the
 * benefit-led title deliberately does not.
 *
 * OutboundLink is the instrumentation: the click records a row in
 * outbound_clicks, which is what /admin Conversions reads (lib/conversions.ts).
 */
export function ProductCta({ className }: { className?: string }) {
  return (
    <OutboundLink
      href="https://phantomstory.com"
      target="_blank"
      rel="noreferrer"
      className={cn(
        "group flex w-full items-center justify-between gap-2 rounded border border-terracotta/40",
        "bg-terracotta/[0.18] px-4 py-3 text-left transition hover:border-terracotta/70 hover:bg-terracotta/[0.26]",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold leading-snug text-terracotta-dark">
          Automate Your Content Strategy
        </span>
        <span className="mt-0.5 block truncate text-xs text-ink-faint">Phantomstory</span>
      </span>
      <ArrowUpRight
        className="h-4 w-4 shrink-0 text-terracotta-dark transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
        aria-hidden
      />
    </OutboundLink>
  );
}

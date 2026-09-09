"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

/**
 * The sidebar's container, in two shapes.
 *
 * At md and up this is exactly the aside it always was: a fixed-width column
 * on the left, scrolling on its own. Nothing here changes desktop.
 *
 * Below md the same column used to render ABOVE the page content — logo, org
 * switcher, six nav items, the Phantomstory offer, the account row — so every
 * dashboard page on a phone opened on a screen and a half of navigation
 * before the first number. Now the phone gets a slim top bar (logo + menu
 * button) and the column becomes a drawer that slides in from the left over
 * a backdrop. Same children, same order, same server-rendered content; only
 * where it sits.
 *
 * Closes on navigation, on Escape, on the backdrop, and on the X. Locks body
 * scroll while open so the page underneath doesn't scroll with the drawer.
 */
export function SidebarShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const drawerId = useId();

  // A tap on a nav link navigates; the drawer must not stay over the page it
  // just navigated to. Keyed on the path, not the click, so a link to the
  // current page (no navigation) leaves it open — nothing happened.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      {/* ---- Phone: the top bar ------------------------------------------- */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-ink/10 bg-paper px-4 py-3 md:hidden">
        <Logo />
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls={drawerId}
          className="inline-flex h-9 w-9 items-center justify-center rounded border border-ink/15 text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </header>

      {/* ---- Phone: the backdrop ------------------------------------------ */}
      {/* Below the org switcher's confirmation overlay (z-50) and the "why is
          this free" dialog (z-60), both of which can open from inside the
          drawer and must sit above it. */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        className={cn(
          "fixed inset-0 z-30 bg-ink/40 transition-opacity md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      {/* ---- The column: drawer on a phone, static aside at md+ ------------- */}
      <aside
        id={drawerId}
        className={cn(
          // Phone: off-canvas, sliding in from the left. `invisible` while
          // closed takes the drawer's links out of the tab order and the
          // accessibility tree, which an off-screen transform alone does not.
          "fixed inset-y-0 left-0 z-40 flex w-[280px] max-w-[85vw] flex-col bg-paper shadow-card transition-[transform,visibility] duration-200 ease-out",
          open ? "visible translate-x-0" : "invisible -translate-x-full",
          // md+: exactly the aside this replaced. `static` cancels the fixed
          // positioning, `translate-x-0` the off-canvas transform, `visible`
          // the phone's closed state.
          "md:visible md:static md:h-screen md:w-[260px] md:max-w-none md:shrink-0 md:translate-x-0 md:border-r md:border-ink/10 md:shadow-none md:transition-none",
        )}
      >
        {/* Scrolls: six reports in the sub-menu plus the CTA push Sign out past
            the fold, and a full-height column without it leaves them unreachable. */}
        <div className="flex h-full flex-col gap-6 overflow-y-auto px-5 py-6">
          {/* The drawer's own head, mirroring the top bar it slid out from, so
              the close control sits where the open control was. md+ has the
              layout's logo row instead. */}
          <div className="flex items-center justify-between gap-2 md:hidden">
            <Logo />
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="inline-flex h-9 w-9 items-center justify-center rounded border border-ink/15 text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          {children}
        </div>
      </aside>
    </>
  );
}

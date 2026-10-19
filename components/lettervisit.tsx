"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { LETTERVISIT_KEY, isLettervisitPath } from "@/lib/lettervisit";

/**
 * The LetterVisit (Visitors) script tag, on public pages only. Renders nothing unless
 * NEXT_PUBLIC_LETTERVISIT_KEY is set (see lib/lettervisit.ts). Verbatim the tag Letterstory's
 * Visitors → Setup gives: v.js reads its key from data-key.
 */
export function Lettervisit() {
  const pathname = usePathname();
  if (!LETTERVISIT_KEY || !isLettervisitPath(pathname)) return null;
  return (
    <Script id="lettervisit" src="https://lettervisit.com/v.js" data-key={LETTERVISIT_KEY} strategy="afterInteractive" />
  );
}

"use client";

import { usePathname } from "next/navigation";

/**
 * Letterstory Visitors script (lettervisit.com).
 *
 * Rendered inside <head> by the root layout. Renders nothing unless
 * NEXT_PUBLIC_LETTERVISIT_KEY is set, so a self-hosted deployment ships zero
 * third-party tracking. The key is the public snippet key (lv_pub_...), NOT a
 * secret. The tag itself is the vendor's, unchanged: a plain async <script>
 * with the key in data-key, loaded directly (no tag manager).
 *
 * With de-anonymization on, the script also loads a visitor-identification
 * pixel, so it follows the same consent rule as the RB2B pixel: PUBLIC
 * marketing pages only, never the authenticated product. Allowlist, not
 * denylist, and the same paths as components/rb2b-pixel.tsx.
 *
 * AI agents that never run JavaScript are counted server-side instead, in
 * middleware.ts (same key, same env gate).
 */

const PUBLIC_PATHS = ["/privacy", "/terms"];

function isPublicPath(pathname: string): boolean {
  return pathname === "/" || PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

export function LetterVisitScript() {
  const key = process.env.NEXT_PUBLIC_LETTERVISIT_KEY;
  const pathname = usePathname();
  if (!key || !isPublicPath(pathname)) return null;

  return <script async src="https://lettervisit.com/v.js" data-key={key} />;
}

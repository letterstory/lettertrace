"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

/**
 * RB2B website-visitor identification pixel.
 *
 * Renders nothing and does nothing unless NEXT_PUBLIC_RB2B_KEY is set, so it is
 * inert in local dev and in any deployment that hasn't opted in. The key is the
 * public snippet key from the RB2B dashboard (Settings -> Install), NOT a secret.
 *
 * Scoped to PUBLIC marketing pages only (see PUBLIC_PATHS). RB2B de-anonymizes
 * visitors via a third party, so it has no business firing on the authenticated
 * product (/dashboard, /login, /auth, /oauth, /admin) — we already know who those
 * people are, and tracking them there would be invasive and pointless. This is an
 * allowlist, not a denylist, on purpose: a new private route is never tracked by
 * accident; a new marketing route must be added here deliberately.
 *
 * The snippet body below is RB2B's dashboard snippet verbatim, with only the key
 * injected from the env. If RB2B changes the snippet they hand you, paste the new
 * body here — the only moving part is the ("<KEY>") argument at the end.
 */

// Public, unauthenticated marketing surface. Matched as exact "/" plus prefixes.
const PUBLIC_PATHS = ["/privacy", "/terms"];

function isPublicPath(pathname: string): boolean {
  return pathname === "/" || PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

export function RB2BPixel() {
  const key = process.env.NEXT_PUBLIC_RB2B_KEY;
  const pathname = usePathname();
  if (!key || !isPublicPath(pathname)) return null;

  return (
    <Script id="rb2b-pixel" strategy="afterInteractive">
      {`!function(key) {if (window.reb2b) return;window.reb2b = {loaded: true};var s = document.createElement("script");s.async = true;s.src = "https://ddwl4m2hdecbv.cloudfront.net/b/" + key + "/" + key + ".js.gz";document.getElementsByTagName("script")[0].parentNode.insertBefore(s, document.getElementsByTagName("script")[0]);}(${JSON.stringify(key)});`}
    </Script>
  );
}

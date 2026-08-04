"use client";

import Script from "next/script";

/**
 * RB2B website-visitor identification pixel.
 *
 * Renders nothing and does nothing unless NEXT_PUBLIC_RB2B_KEY is set, so it is
 * inert in local dev and in any deployment that hasn't opted in. The key is the
 * public snippet key from the RB2B dashboard (Settings -> Install), NOT a secret.
 *
 * This is the standard RB2B loader snippet with the key injected from the env.
 * If RB2B changes the snippet they hand you in the dashboard, paste the new body
 * here verbatim — the only moving part is the reb2b.load("<KEY>") call at the end.
 */
export function RB2BPixel() {
  const key = process.env.NEXT_PUBLIC_RB2B_KEY;
  if (!key) return null;

  return (
    <Script id="rb2b-pixel" strategy="afterInteractive">
      {`!function(key) {if (window.reb2b) return;window.reb2b = {loaded: true};var s = document.createElement("script");s.async = true;s.src = "https://ddwl4m2hdecbv.cloudfront.net/b/" + key + "/" + key + ".js.gz";document.getElementsByTagName("script")[0].parentNode.insertBefore(s, document.getElementsByTagName("script")[0]);}(${JSON.stringify(key)});`}
    </Script>
  );
}

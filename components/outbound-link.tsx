"use client";

import type { AnchorHTMLAttributes } from "react";

/**
 * An <a> that records its click before the browser leaves for another Letter
 * Company product. The row behind the /admin Conversions page.
 *
 * sendBeacon is the whole point: it hands the request to the browser and
 * returns immediately, so the navigation is never delayed and the POST
 * survives the page being torn down — a plain fetch here would be racing the
 * unload. The fetch/keepalive branch covers environments without sendBeacon.
 *
 * Recording is fire-and-forget by design; a failed beacon must never break a
 * link. The server drops URLs that aren't on the Letter product allow-list
 * (lib/conversions.ts), so using this component IS the instrumentation — no
 * per-link registration.
 */
export function OutboundLink({
  href,
  onClick,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        try {
          const body = JSON.stringify({ url: href });
          if (navigator.sendBeacon) {
            navigator.sendBeacon("/api/out", new Blob([body], { type: "application/json" }));
          } else {
            void fetch("/api/out", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
              keepalive: true,
            }).catch(() => {});
          }
        } catch {
          // Never let telemetry break the link.
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

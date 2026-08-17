"use client";

import { useEffect } from "react";

/**
 * Letterprove usage attestation.
 *
 * Renders nothing and does nothing unless NEXT_PUBLIC_LETTERPROVE_KEY is set,
 * so it is inert in local dev and in self-hosted container images (operators'
 * own deployments are never reported on). The key is a publishable, origin-
 * pinned vendor key — it ships in the HTML of every authenticated page and is
 * NOT a secret; Letterprove rejects it from any origin but ours.
 *
 * This is the inverse of the RB2B pixel's scope, deliberately. RB2B
 * de-anonymizes strangers on marketing pages and has no business on the
 * product. Letterprove measures *real product usage by real accounts*, which
 * only exists behind the login, so it is mounted in the dashboard layout and
 * nowhere else. There is nothing for it to observe on a public page.
 *
 * What actually leaves the browser is the DOMAIN of the signed-in email and
 * nothing else — `attest.js` splits the local part off and discards it before
 * building any request. We never send the address, a user id, or a name. See
 * Letterprove's README § "The one hard rule: domain only".
 *
 * Why the script is injected by hand rather than via next/script: `attest.js`
 * reads its configuration off its own <script> element (`data-key`, and the
 * origin of `src`), and it exposes `window.Letterprove` only once it has run.
 * Creating the element explicitly keeps both of those guarantees visible here
 * instead of resting on how a wrapper forwards unknown props.
 */

const SCRIPT_ID = "letterprove-attest";

/**
 * Letterprove's own custom domain — deliberately NOT a `*.vercel.app` alias.
 *
 * This defaulted to `letterprove.vercel.app`, which broke collection silently:
 * that alias has moved between Letterprove projects more than once and now
 * 404s entirely, so the script simply never loaded. Because telemetry fails
 * quietly by design, nothing surfaced it — the only symptom was `hot_events`
 * staying flat for two and a half days.
 *
 * A generated alias is not a stable contract. Point at a domain someone owns.
 */
const DEFAULT_ORIGIN = "https://app.letterprove.com";

declare global {
  interface Window {
    Letterprove?: {
      identify: (email: string) => void;
      signup: (email: string) => void;
      login: (email: string) => void;
    };
  }
}

export function LetterproveAttest({ email }: { email?: string | null }) {
  const key = process.env.NEXT_PUBLIC_LETTERPROVE_KEY;
  const origin = process.env.NEXT_PUBLIC_LETTERPROVE_ORIGIN ?? DEFAULT_ORIGIN;

  useEffect(() => {
    if (!key || !email) return;

    // Already injected by an earlier mount this page load. `identify` is
    // idempotent per page load on Letterprove's side — it fires at most one
    // session event — so calling it again on a client-side navigation is safe
    // and keeps the domain established if this remounts.
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      window.Letterprove?.identify(email);
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = `${origin}/attest.js`;
    script.async = true;
    script.setAttribute("data-key", key);
    // Telemetry must never break the product. attest.js wraps its own public
    // methods, but the load itself can still fail — a blocked request, an
    // offline client — and that has to be a no-op, not an error boundary.
    script.onload = () => {
      try {
        window.Letterprove?.identify(email);
      } catch {
        /* ignore */
      }
    };
    script.onerror = () => {
      /* ignore — no attestation this page load */
    };
    document.head.appendChild(script);
  }, [key, email, origin]);

  return null;
}

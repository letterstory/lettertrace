"use client";

import { useEffect } from "react";

/**
 * The Visitors script inside the signed-in product, saying who is signed in.
 *
 * Why: Letter counts which features signed-in companies use (links and
 * buttons carrying data-letter-feature) and sends that to Letterprove daily,
 * where it becomes the "features in use" section of Lettertrace's proof. The
 * signed-in count is the denominator, so the script has to know who is signed
 * in: lettervisit("identify", email). v.js hashes the address in the browser
 * under the site's key and keeps only its domain; the address never leaves
 * the page and nothing is stored in the browser.
 *
 * Nobody signed in is ever identified. The key is the marketing site's (one
 * Visitors site per domain), which has visitor identification on, so this tag
 * carries data-identification="off" and queues consent "denied" before it
 * loads: either one keeps the identification pixel off. ⌘L and A/B tests are
 * off too; nothing in the product is edited or tested from the page.
 *
 * Only one copy of v.js runs per page (window.__lettervisit). Arriving from a
 * public page by client-side navigation (the blog's Dashboard button) would
 * leave the marketing copy running here, identification and all, so in that
 * case the page loads once more from the server and this tag is the only one.
 *
 * Renders nothing without NEXT_PUBLIC_LETTERVISIT_KEY, like the public tag.
 */

const SCRIPT_ID = "lettervisit-dashboard";

type LetterVisit = ((cmd: string, ...args: unknown[]) => void) & { q?: unknown[][] };

declare global {
  interface Window {
    lettervisit?: LetterVisit;
    __lettervisit?: boolean;
  }
}

function queue(): LetterVisit {
  if (!window.lettervisit) {
    const q: unknown[][] = [];
    const stub = ((...args: unknown[]) => void q.push(args)) as LetterVisit;
    stub.q = q;
    window.lettervisit = stub;
  }
  return window.lettervisit;
}

export function LetterVisitDashboard({ email }: { email: string | null | undefined }) {
  const key = process.env.NEXT_PUBLIC_LETTERVISIT_KEY;

  useEffect(() => {
    if (!key) return;
    try {
      if (!document.getElementById(SCRIPT_ID)) {
        // A copy from a public page is already running: start this page clean.
        if (window.__lettervisit) {
          window.location.reload();
          return;
        }
        queue()("consent", "denied");
        const script = document.createElement("script");
        script.id = SCRIPT_ID;
        script.async = true;
        script.src = `https://lettervisit.com/v.js?k=${key}`;
        script.setAttribute("data-key", key);
        script.setAttribute("data-identification", "off");
        script.setAttribute("data-editor", "off");
        script.setAttribute("data-variationals", "off");
        document.head.appendChild(script);
      }
      if (email) queue()("identify", email);
    } catch {
      /* telemetry never breaks the product */
    }
  }, [key, email]);

  return null;
}

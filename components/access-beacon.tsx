"use client";

import { useEffect } from "react";

/**
 * In-page engagement beacon for owned-site access telemetry on /blog.
 *
 * Reports once per page view, on the way out (visibility hidden / pagehide),
 * with dwell time, max scroll depth, and the referrer source. This is the
 * human-confirmed half of the signal — bots that never run JS are counted by
 * middleware instead. Posts to the same-origin /api/track collector, which holds
 * the reporting key; nothing sensitive touches the browser.
 *
 * Only rendered on /blog pages, and only when owned-access reporting is
 * configured (see app/blog/layout.tsx), so it never runs on forks / self-host.
 */

// Map a referrer host to a source the ingest accepts (AI + search allowlist);
// anything else is an ordinary visit ('').
function referrerSource(referrer: string): string {
  let host = "";
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return "";
  }
  if (!host) return "";
  const has = (s: string) => host === s || host.endsWith(`.${s}`);
  if (has("chatgpt.com") || has("openai.com")) return "chatgpt";
  if (has("claude.ai") || has("anthropic.com")) return "claude";
  if (has("perplexity.ai")) return "perplexity";
  if (has("gemini.google.com") || has("bard.google.com")) return "gemini";
  if (has("copilot.microsoft.com")) return "copilot";
  if (has("duckduckgo.com")) return "duckduckgo";
  if (has("bing.com")) return "bing";
  if (has("ecosia.org")) return "ecosia";
  if (has("search.brave.com")) return "brave";
  if (host.includes("yahoo.")) return "yahoo";
  if (host.includes("google.")) return "google";
  return "";
}

export default function AccessBeacon() {
  useEffect(() => {
    const startedAt = Date.now();
    const path = window.location.pathname;
    const from = referrerSource(document.referrer);
    let maxScroll = 0;
    let sent = false;

    const onScroll = () => {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      const pct = scrollable > 0 ? Math.round((doc.scrollTop / scrollable) * 100) : 100;
      if (pct > maxScroll) maxScroll = Math.min(100, pct);
    };

    const send = () => {
      if (sent) return;
      sent = true;
      const payload = JSON.stringify({
        path,
        from,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        scroll: maxScroll,
      });
      // sendBeacon survives unload; keepalive fetch is the fallback.
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/track", new Blob([payload], { type: "application/json" }));
      } else {
        void fetch("/api/track", { method: "POST", body: payload, keepalive: true });
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") send();
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", send);

    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", send);
      send();
    };
  }, []);

  return null;
}

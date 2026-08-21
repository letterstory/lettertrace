"use client";

import { useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { Button, Spinner } from "@/components/ui";

// Mints (or rotates) the anonymous, no-login share link for this run. See
// lib/share-links.ts: sharing again replaces the previous link rather than
// adding a second one, so there's no separate "revoke" control here — this
// button IS the revoke, for whoever had the old link.

export default function ShareRunButton({ runId }: { runId: string }) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleShare() {
    if (sharing) return;
    setError(null);
    setSharing(true);
    try {
      const res = await fetch(`/api/runs/${runId}/share`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Something went wrong. Please try again.");
        return;
      }
      setShareUrl(`${window.location.origin}/share/${data.token}`);
      setCopied(false);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSharing(false);
    }
  }

  async function handleCopy() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; the link is still visible to select */
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" size="sm" variant="secondary" onClick={handleShare} disabled={sharing}>
        {sharing ? <Spinner /> : <Share2 className="h-3.5 w-3.5" />}
        {shareUrl ? "Get a new link" : "Share"}
      </Button>

      {shareUrl && (
        // w-full + max-w-md bounds this box regardless of where it's rendered
        // (here, inside SectionHeading's unconstrained flex "action" slot) —
        // without it the <code> below never has a width to truncate against,
        // and the long token pushes the Copy button off-screen entirely.
        <div className="w-full max-w-md rounded border border-emerald-700/20 bg-mint/30 p-4">
          <p className="text-sm font-medium text-ink">
            Anyone with this link can view this run&apos;s full report, no account
            needed. It expires in 7 days, and generating a new link disables this
            one.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-paper px-3 py-2 font-mono text-sm text-ink">
              {shareUrl}
            </code>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={handleCopy}
              className="shrink-0"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-terracotta-dark">{error}</p>}
    </div>
  );
}

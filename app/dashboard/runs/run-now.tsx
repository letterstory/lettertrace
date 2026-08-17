"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Play } from "lucide-react";
import { Button } from "@/components/ui";
import type { KeySource } from "@/lib/trial";

export function RunNow({
  canRun,
  keySource,
  activePrompts,
  providerLabel,
}: {
  canRun: boolean;
  /** Why we can or can't run, so the hint names the actual blocker. Typed off
   *  KeySource rather than restated, so a new blocker can't reach this component
   *  as a silently unhandled state. */
  keySource: KeySource;
  activePrompts: number;
  providerLabel: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = loading || !canRun || activePrompts === 0;

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        setError(data?.error ?? "Something went wrong running the monitor.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error, please try again.");
    } finally {
      setLoading(false);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      {/* Just "Running…". The label used to read "Running… this can take a
          minute", which roughly doubled the button's width the moment it was
          clicked — the spinner already says a wait is underway. */}
      <Button onClick={run} loading={loading} loadingText="Running…" disabled={disabled}>
        <Play className="h-4 w-4" /> Run monitor now
      </Button>

      {keySource === "exhausted" && (
        <p className="text-xs text-ink-faint">
          Your free runs are used up. Add your {providerLabel} key in{" "}
          <Link href="/dashboard/settings" className="text-terracotta-dark hover:text-terracotta">
            Settings
          </Link>{" "}
          to keep going.
        </p>
      )}
      {keySource === "none" && (
        <p className="text-xs text-ink-faint">
          Add your {providerLabel} key in{" "}
          <Link href="/dashboard/settings" className="text-terracotta-dark hover:text-terracotta">
            Settings
          </Link>{" "}
          to run.
        </p>
      )}
      {/* Has keys, just not for the engine they picked. Both fixes live on the
          same page, so the link does double duty. */}
      {keySource === "mismatch" && (
        <p className="text-xs text-ink-faint">
          No {providerLabel} key saved. Add one, or change your answer engine, in{" "}
          <Link href="/dashboard/settings" className="text-terracotta-dark hover:text-terracotta">
            Settings
          </Link>
          .
        </p>
      )}
      {/* A router credential that reaches the engine but can't measure it. The
          full explanation (which router, which of the three fixes) is already in
          the heading via engineKeyMessage, so this stays a pointer. */}
      {keySource === "unroutable" && (
        <p className="text-xs text-ink-faint">
          Your router can&apos;t measure {providerLabel}. Change your answer engine, or add a{" "}
          {providerLabel} key, in{" "}
          <Link href="/dashboard/settings" className="text-terracotta-dark hover:text-terracotta">
            Settings
          </Link>
          .
        </p>
      )}
      {/* The engine can't browse at all, so no key changes anything. The fix is
          the project's own web-search setting, which is why this points at
          Settings rather than at adding a credential. */}
      {keySource === "ungrounded" && (
        <p className="text-xs text-ink-faint">
          {providerLabel} can&apos;t search the web, so it can&apos;t answer a project that asks
          for live results. Turn off web search, or pick another engine, in{" "}
          <Link href="/dashboard/settings" className="text-terracotta-dark hover:text-terracotta">
            Settings
          </Link>
          .
        </p>
      )}
      {canRun && activePrompts === 0 && (
        <p className="text-xs text-ink-faint">
          Add active prompts in{" "}
          <Link href="/dashboard/topics" className="text-terracotta-dark hover:text-terracotta">
            Topics
          </Link>{" "}
          to run.
        </p>
      )}
      {error && <p className="text-xs text-terracotta">{error}</p>}
    </div>
  );
}

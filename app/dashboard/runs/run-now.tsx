"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Play } from "lucide-react";
import { Button, Spinner } from "@/components/ui";

export function RunNow({
  canRun,
  keySource,
  activePrompts,
  providerLabel,
}: {
  canRun: boolean;
  /** Why we can or can't run, so the hint names the actual blocker. */
  keySource: "own" | "trial" | "none" | "exhausted";
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
      <Button onClick={run} disabled={disabled}>
        {loading ? (
          <>
            <Spinner /> Running… this can take a minute
          </>
        ) : (
          <>
            <Play className="h-4 w-4" /> Run monitor now
          </>
        )}
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

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui";

/**
 * "Run everywhere" is a loop of ordinary runs, one per engine the account can
 * fund (own keys or the trial's coverage) — the server enforces funding per
 * run, this component just drives the loop. Sequential on purpose: each run
 * already fans out its prompts with internal concurrency, and two runs racing
 * would double-load the same providers for no wall-clock win the user can see.
 */
export function RunAllEngines({
  engines,
  disabled,
}: {
  engines: { provider: string; label: string }[];
  /** Mirrors RunNow's gating (no active prompts, etc.). */
  disabled?: boolean;
}) {
  const router = useRouter();
  const [progress, setProgress] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  async function runAll() {
    setErrors([]);
    const failures: string[] = [];
    for (let i = 0; i < engines.length; i++) {
      const engine = engines[i];
      setProgress(`Running ${engine.label} (${i + 1}/${engines.length})…`);
      try {
        const res = await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: engine.provider }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.error) {
          failures.push(`${engine.label}: ${data?.error ?? "run failed"}`);
        }
      } catch {
        failures.push(`${engine.label}: network error`);
      }
      // Refresh between engines so finished runs appear while later ones work.
      router.refresh();
    }
    setProgress(null);
    setErrors(failures);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <Button
        variant="secondary"
        onClick={runAll}
        loading={progress !== null}
        loadingText={progress ?? "Running…"}
        disabled={disabled || progress !== null}
      >
        <Layers className="h-4 w-4" /> Run on all {engines.length} engines
      </Button>
      {errors.map((e) => (
        <p key={e} className="text-xs text-terracotta">
          {e}
        </p>
      ))}
    </div>
  );
}

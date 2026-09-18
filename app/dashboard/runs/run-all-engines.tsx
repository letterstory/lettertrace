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
 *
 * The one thing that changed: a batch is opened first and its id travels with
 * every run, so the N runs are summarised in ONE email instead of N. The batch
 * is only a label — nothing server-side executes it — which is why leaving this
 * page still stops the remaining engines, exactly as it always did. The sweep
 * closes the batch out afterwards and reports what never ran.
 */
export function RunAllEngines({
  engines,
  disabled,
}: {
  engines: { provider: string; label: string }[];
  disabled?: boolean;
}) {
  const router = useRouter();
  const [progress, setProgress] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  async function runAll() {
    setErrors([]);
    setProgress("Starting reports…");

    let groupId: string | null = null;
    try {
      const res = await fetch("/api/report-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: engines.map((engine) => engine.provider) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        setErrors([data?.error ?? "Could not start the reports. Try again."]);
        setProgress(null);
        return;
      }
      groupId = data.groupId as string;
    } catch {
      setErrors(["Network error. Check Reports before starting again."]);
      setProgress(null);
      return;
    }

    const failures: string[] = [];
    for (let i = 0; i < engines.length; i++) {
      const engine = engines[i];
      setProgress(`Running ${engine.label} (${i + 1}/${engines.length})…`);
      try {
        const res = await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: engine.provider, groupId }),
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
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <Button
        variant="secondary"
        onClick={runAll}
        loading={progress !== null}
        loadingText={progress ?? "Running…"}
        disabled={disabled || progress !== null}
      >
        <Layers className="h-4 w-4" /> Run on all {engines.length} engines
      </Button>
      <p className="text-xs text-ink-faint">
        Keep this page open until the last engine finishes — closing it stops the ones
        that haven&apos;t started.
      </p>
      {errors.map((e) => (
        <p key={e} className="text-xs text-terracotta">
          {e}
        </p>
      ))}
    </div>
  );
}

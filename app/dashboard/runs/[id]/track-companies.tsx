"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardBody } from "@/components/ui";

export interface UntrackedCompany {
  name: string;
  /** How many of this run's answers named it. */
  answers: number;
}

/**
 * The companies THIS run's answers named that the project doesn't track yet.
 *
 * Mention detection only looks for the brand and its listed competitors, so a
 * project with a thin competitor list reads as "named nobody" while its answers
 * are full of rivals — the exact confusion this panel resolves. Tracking one
 * adds it as a competitor (same endpoint the Competitors page uses), so every
 * FUTURE run measures it deterministically; this past run isn't re-scored.
 */
export function TrackUntrackedCompanies({ companies }: { companies: UntrackedCompany[] }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(companies);
  const [tracking, setTracking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (remaining.length === 0) return null;

  async function track(name: string) {
    if (tracking) return;
    setTracking(name);
    setError(null);
    try {
      const res = await fetch("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, aliases: [], domain: null }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        // A 409 (already tracked) is a fine outcome — drop it from the list too.
        if (res.status !== 409) {
          setError(json.error ?? "Could not track this company.");
          return;
        }
      }
      setRemaining((prev) => prev.filter((c) => c.name !== name));
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setTracking(null);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <p className="text-sm font-medium text-ink">
            Companies these answers named that you don&apos;t track ({remaining.length})
          </p>
          <p className="mt-0.5 text-xs text-ink-faint">
            We only measure the brand and competitors you&apos;ve added, so these show up in the answers
            but not in your numbers. Track one to measure it from the next run on.
          </p>
        </div>
        {error && <p className="text-xs text-terracotta-dark">{error}</p>}
        <div className="flex flex-wrap gap-2">
          {remaining.map((c) => (
            <span
              key={c.name}
              className="inline-flex items-center gap-2 rounded border border-ink/10 bg-paper-shade/60 py-1 pl-3 pr-1 text-sm"
            >
              <span className="text-ink">{c.name}</span>
              <span className="text-xs text-ink-faint">
                {c.answers} answer{c.answers === 1 ? "" : "s"}
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="h-7 px-2.5 text-xs"
                loading={tracking === c.name}
                loadingText="Adding…"
                onClick={() => track(c.name)}
              >
                Track
              </Button>
            </span>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

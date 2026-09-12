// ---------------------------------------------------------------------------
// mapPool is the one concurrency primitive under both a run (its asks) and the
// daily sweep (its due projects, since 2026-09-12). These cases pin what the
// sweep relies on: never more than `limit` in flight, every item handled once,
// results in input order however the work finishes.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { mapPool } from "@/lib/engine";

describe("mapPool", () => {
  it("runs at most `limit` items at once and keeps input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [50, 5, 30, 1, 20, 10, 2, 40];
    const results = await mapPool(items, 3, async (ms, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return `${i}:${ms}`;
    });
    expect(peak).toBe(3);
    expect(results).toEqual(items.map((ms, i) => `${i}:${ms}`));
  });

  it("handles an empty list and a limit wider than the list", async () => {
    expect(await mapPool([], 4, async (x: number) => x)).toEqual([]);
    expect(await mapPool([1, 2], 8, async (x) => x * 2)).toEqual([2, 4]);
  });
});

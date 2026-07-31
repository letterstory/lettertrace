import { describe, it, expect } from "vitest";
import { selectAll } from "@/lib/paging";

/** A fake table of `total` rows that honours an inclusive range, the way
 *  PostgREST does, and records the ranges it was asked for. */
function fakeTable(total: number, pageSize = 1000) {
  const asked: [number, number][] = [];
  const page = async (from: number, to: number) => {
    asked.push([from, to]);
    const rows = [];
    for (let i = from; i <= Math.min(to, total - 1); i++) rows.push({ i });
    return { data: rows, error: null };
  };
  return { page, asked, pageSize };
}

describe("selectAll", () => {
  it("returns everything past the server's row cap", async () => {
    const t = fakeTable(2500);
    const rows = await selectAll(t.page);
    expect(rows).toHaveLength(2500);
    // and in order, so callers that assume ordering still can
    expect(rows[0]).toEqual({ i: 0 });
    expect(rows[2499]).toEqual({ i: 2499 });
  });

  it("stops on a short page rather than probing forever", async () => {
    const t = fakeTable(1500);
    await selectAll(t.page);
    expect(t.asked).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  // The boundary that would otherwise loop one extra time or, worse, stop early.
  it("handles an exact multiple of the page size", async () => {
    const t = fakeTable(2000);
    const rows = await selectAll(t.page);
    expect(rows).toHaveLength(2000);
    expect(t.asked).toHaveLength(3); // 0-999, 1000-1999, then the empty probe
  });

  it("handles empty and single-page results in one round trip", async () => {
    const empty = fakeTable(0);
    expect(await selectAll(empty.page)).toEqual([]);
    expect(empty.asked).toHaveLength(1);

    const small = fakeTable(3);
    expect(await selectAll(small.page)).toHaveLength(3);
    expect(small.asked).toHaveLength(1);
  });

  // Returning what arrived before the failure would be a partial result that
  // looks complete — precisely the bug this module exists to prevent.
  it("throws on a query error instead of returning a partial set", async () => {
    const page = async (from: number) =>
      from === 0
        ? { data: Array.from({ length: 1000 }, (_, i) => ({ i })), error: null }
        : { data: null, error: { message: "boom" } as never };
    await expect(selectAll(page)).rejects.toMatchObject({ message: "boom" });
  });

  it("respects a caller-chosen page size", async () => {
    const t = fakeTable(250);
    const rows = await selectAll(t.page, 100);
    expect(rows).toHaveLength(250);
    expect(t.asked).toEqual([
      [0, 99],
      [100, 199],
      [200, 299],
    ]);
  });
});

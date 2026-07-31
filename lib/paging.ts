import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Read every row of a query, not the first page of it.
 *
 * PostgREST caps an unpaginated select at a server-configured maximum (1000 rows
 * on Supabase's default) and says nothing about it: no error, no flag, just a
 * short array. Measured on this deployment — a `select` over a 7,173-row table
 * returned exactly 1000.
 *
 * That silence is the danger. A truncated read of `runs` is a missing row in a
 * list; a truncated read of `sources` or `mentions` is a share-of-voice number
 * computed over part of the evidence and presented as if it were whole. The
 * failure has no symptom until someone reconciles a report by hand.
 *
 * So anything whose row count grows with answers, prompts or projects reads
 * through here. `range` is inclusive on both ends, and a short page means the
 * end — asking for one page beyond the data returns empty rather than erroring,
 * so the loop terminates on its own.
 */
export async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    // Surface the failure rather than returning a partial set that looks
    // complete — reporting half the evidence as all of it is the thing this
    // module exists to prevent.
    if (error) throw error;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

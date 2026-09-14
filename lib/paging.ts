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
 *
 * `maxRows` is a ceiling for callers that want every row up to a point rather
 * than every row there is — the admin pages read whole tables into one server
 * render and would rather stop at a known bound than page through a table that
 * outgrew them. It trims to exactly that many, so the caller's own cap and what
 * it gets back can never disagree.
 */
export async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
  pageSize = 1000,
  maxRows = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    // Surface the failure rather than returning a partial set that looks
    // complete — reporting half the evidence as all of it is the thing this
    // module exists to prevent.
    if (error) throw error;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  return rows.slice(0, maxRows);
}

/**
 * selectAll for a page that would rather say "incomplete" than fail.
 *
 * The /admin loaders fetch several tables at once and render a "some figures
 * could not be loaded (runs, profiles)" banner when one of them doesn't come
 * back. That needs the failure as a NAME in a list rather than as a thrown
 * error, so this appends to `problems` and yields an empty array — the caller
 * keeps the shape it expected and the page tells the operator not to trust the
 * zeroes.
 */
export async function selectAllNoted<T>(
  problems: string[],
  name: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
  maxRows = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  try {
    return await selectAll<T>(page, 1000, maxRows);
  } catch {
    problems.push(name);
    return [];
  }
}

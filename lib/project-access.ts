import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * "Which projects may this user reach?", as filters.
 *
 * Its own module, and deliberately the lightest one in lib/: it imports
 * nothing but a type. lib/logs.ts needs these — a teammate's events belong in
 * the owner's feed — and lib/logs.ts is also imported by a CLIENT component
 * for its display labels. Reaching this through lib/team.ts instead pulled
 * lib/crypto and therefore node:crypto into the browser bundle, which fails
 * the build. Anything that both a server module and a client module can end up
 * importing has to be able to live in both.
 *
 * The filters below are written explicitly rather than left to RLS because
 * several callers hold the SERVICE-ROLE client, where RLS is bypassed and
 * dropping a filter would hand every caller every account's rows.
 */

/** Ids are interpolated into PostgREST's filter grammar, so they are checked
 *  before they go in — even though they come from our own tables. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The project ids this user was invited into. Not the ones they own — the
 *  owner has no membership row, by design. */
export async function memberProjectIds(
  supabase: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("project_members")
    .select("project_id")
    .eq("user_id", userId);
  return ((data as { project_id: string }[] | null) ?? []).map((r) => r.project_id);
}

/**
 * A PostgREST `or` filter for "a project I own, or one I was invited to", or
 * null when there are no memberships and a plain `.eq("user_id", …)` will do.
 *
 * Null rather than an equivalent one-armed `or` so the single-person case —
 * which is nearly every case — issues exactly the query it always did.
 */
export function projectAccessFilter(userId: string, memberIds: string[]): string | null {
  const ids = memberIds.filter((id) => UUID_RE.test(id));
  return ids.length === 0 ? null : `user_id.eq.${userId},id.in.(${ids.join(",")})`;
}

/**
 * The same question asked of a table that POINTS at projects rather than being
 * one: "rows I caused, or rows on a project shared with me".
 *
 * Owned projects need no clause here — their rows already carry the owner's
 * user_id — so a single-person account gets the untouched query.
 */
export function ownerOrSharedProjectFilter(
  userId: string,
  sharedProjectIds: string[],
): string | null {
  const ids = sharedProjectIds.filter((id) => UUID_RE.test(id));
  return ids.length === 0 ? null : `user_id.eq.${userId},project_id.in.(${ids.join(",")})`;
}

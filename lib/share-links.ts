import type { SupabaseClient } from "@supabase/supabase-js";
import { generateShareToken, sha256Hex } from "@/lib/crypto";
import { getOwnedProject } from "@/lib/api-service";
import type { Run } from "@/lib/types";

// Fixed 7 days -- v1 has no owner-configurable duration and no separate
// revoke, so this is the only thing that ever closes a link on its own.
export const SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CreateShareLinkOutcome =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; code: "not_found" };

/**
 * Mint (or rotate) the one share link for a run the caller owns. run_id is
 * unique on share_links, so sharing again upserts in place: the previous
 * token stops resolving the moment this lands, which is the only revoke
 * mechanism v1 has.
 */
export async function createShareLink(
  supabase: SupabaseClient,
  userId: string,
  runId: string,
): Promise<CreateShareLinkOutcome> {
  const { data: runRow } = await supabase
    .from("runs")
    .select("id, project_id")
    .eq("id", runId)
    .maybeSingle();
  const run = runRow as Pick<Run, "id" | "project_id"> | null;
  if (!run) return { ok: false, code: "not_found" };

  // Same ownership check getRunReport uses. Not-found and not-yours are
  // deliberately the same outcome, so a run id never becomes an existence
  // oracle on someone else's data.
  const project = await getOwnedProject(supabase, userId, run.project_id);
  if (!project) return { ok: false, code: "not_found" };

  const token = generateShareToken();
  const expiresAt = new Date(Date.now() + SHARE_LINK_TTL_MS).toISOString();

  const { error } = await supabase.from("share_links").upsert(
    {
      run_id: runId,
      created_by: userId,
      token_hash: sha256Hex(token),
      expires_at: expiresAt,
    },
    { onConflict: "run_id" },
  );
  if (error) throw error;

  return { ok: true, token, expiresAt };
}

/**
 * Resolve a public share token to its run id. Callers must pass the
 * service-role client -- the anonymous viewer has no session, so RLS can't
 * apply. An unknown token and an expired one both return null: telling
 * them apart would let a prober enumerate tokens that were once valid.
 */
export async function resolveShareToken(
  serviceSupabase: SupabaseClient,
  token: string,
): Promise<{ runId: string } | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const { data } = await serviceSupabase
    .from("share_links")
    .select("run_id, expires_at")
    .eq("token_hash", sha256Hex(trimmed))
    .maybeSingle();
  if (!data) return null;

  const row = data as { run_id: string; expires_at: string };
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  return { runId: row.run_id };
}

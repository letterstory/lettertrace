import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret } from "@/lib/crypto";
import { selectAll } from "@/lib/paging";
import { memberProjectIds, projectAccessFilter } from "@/lib/project-access";
import type {
  Project,
  Provider,
  ProviderKeyPublic,
  RouterId,
  RouterKeyPublic,
} from "@/lib/types";

// Server-side data helpers shared across pages and route handlers.
// All expect a Supabase client already scoped to the request (RLS).
// Read helpers are wrapped in React cache() so the layout and page of a single
// request (which pass the same cached client) each hit the database only once.

/** Every project (organization) the user can reach — the ones they created and
 *  the ones a teammate invited them into — oldest first. */
export const getProjects = cache(async function getProjects(
  supabase: SupabaseClient,
  userId: string,
): Promise<Project[]> {
  const filter = projectAccessFilter(userId, await memberProjectIds(supabase, userId));
  // Paged, because an account can hold more projects than a single PostgREST
  // read returns. One account per customer-fleet is a supported shape — every
  // client is a project on it — and the 1001st would otherwise vanish from the
  // org switcher, from `lettertrace projects`, and from the CLI's name lookup,
  // which would then report a real project as "no project called that".
  return selectAll<Project>((from, to) => {
    const q = supabase.from("projects").select("*");
    return (filter ? q.or(filter) : q.eq("user_id", userId))
      .order("created_at", { ascending: true })
      .range(from, to);
  });
});

/**
 * The user's active project (organization): the one selected via the org
 * switcher (profiles.active_project_id), falling back to the earliest project
 * they can reach. Null when there is none.
 *
 * "Can reach" now spans two things — projects they created and projects a
 * teammate invited them into — so the stale-pointer fallback matters more than
 * it used to: being removed from a team leaves a pointer aimed at a project
 * that is no longer visible, and landing on the next accessible one beats
 * landing on an error.
 */
export const getProject = cache(async function getProject(
  supabase: SupabaseClient,
  userId: string,
): Promise<Project | null> {
  const [profileQ, memberIds] = await Promise.all([
    supabase.from("profiles").select("active_project_id").eq("id", userId).maybeSingle(),
    memberProjectIds(supabase, userId),
  ]);
  const activeId = (profileQ.data as { active_project_id?: string | null } | null)
    ?.active_project_id;
  const filter = projectAccessFilter(userId, memberIds);

  if (activeId) {
    const q = supabase.from("projects").select("*").eq("id", activeId);
    const { data } = await (filter ? q.or(filter) : q.eq("user_id", userId)).maybeSingle();
    if (data) return data as Project;
    // Stale pointer (project deleted, or they were removed from it): fall
    // through to the oldest project they can still see.
  }

  const q = supabase.from("projects").select("*");
  const { data } = await (filter ? q.or(filter) : q.eq("user_id", userId))
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as Project | null) ?? null;
});

/**
 * Point the dashboard at another of the user's organizations — one they own,
 * or one they were invited to.
 *
 * Goes through the set_active_project RPC, which is SECURITY DEFINER and first
 * guarantees a profile row exists — without that, an account whose profile row
 * is missing (older signups) silently no-ops here, leaving active_project_id
 * unchanged and the org switcher spinning forever. If the RPC isn't present yet
 * (deployment hasn't re-applied the schema), fall back to a direct update; the
 * schema's profile backfill keeps that row present.
 */
export async function setActiveProject(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
): Promise<void> {
  const { error } = await supabase.rpc("set_active_project", {
    p_project_id: projectId,
  });
  if (!error) return;
  await supabase
    .from("profiles")
    .update({ active_project_id: projectId })
    .eq("id", userId);
}

/** Safe (no ciphertext) list of the user's stored provider keys. */
export const getProviderKeysPublic = cache(async function getProviderKeysPublic(
  supabase: SupabaseClient,
  userId: string,
): Promise<ProviderKeyPublic[]> {
  const { data } = await supabase
    .from("provider_keys")
    .select("id, provider, label, key_hint, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return (data as ProviderKeyPublic[] | null) ?? [];
});

/** Which providers the user has a key for. */
export async function getConfiguredProviders(
  supabase: SupabaseClient,
  userId: string,
): Promise<Provider[]> {
  const keys = await getProviderKeysPublic(supabase, userId);
  return keys.map((k) => k.provider);
}

const ROUTER_KEY_COLUMNS = "id, router, label, base_url, key_hint, search_verified, created_at";

/** Safe (no ciphertext) list of the user's stored LLM router keys. */
export const getRouterKeysPublic = cache(async function getRouterKeysPublic(
  supabase: SupabaseClient,
  userId: string,
): Promise<RouterKeyPublic[]> {
  const { data } = await supabase
    .from("router_keys")
    .select(ROUTER_KEY_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return (data as RouterKeyPublic[] | null) ?? [];
});

/** A router credential with its plaintext key, for making calls (server-only). */
export interface DecryptedRouterKey {
  router: RouterId;
  baseUrl: string | null;
  /** Providers whose native web search this key was observed to pass through. */
  searchVerified: Provider[];
  apiKey: string;
}

/**
 * The user's router credentials, decrypted, oldest first (server-only).
 *
 * Returns every stored router rather than a single "the" router: which one can
 * serve a given engine depends on the engine, so the choice belongs to the
 * resolver in lib/trial, not here. A row whose ciphertext won't decrypt is
 * skipped — same as getDecryptedKey — since an undecryptable credential is
 * indistinguishable from an absent one at the point of use.
 */
export async function getDecryptedRouterKeys(
  supabase: SupabaseClient,
  userId: string,
): Promise<DecryptedRouterKey[]> {
  const { data } = await supabase
    .from("router_keys")
    .select("router, base_url, search_verified, encrypted_key")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  const rows = (data ?? []) as {
    router: RouterId;
    base_url: string | null;
    search_verified: Provider[] | null;
    encrypted_key: string;
  }[];

  const keys: DecryptedRouterKey[] = [];
  for (const row of rows) {
    try {
      keys.push({
        router: row.router,
        baseUrl: row.base_url,
        searchVerified: row.search_verified ?? [],
        apiKey: decryptSecret(row.encrypted_key),
      });
    } catch {
      continue;
    }
  }
  return keys;
}

/** Decrypt the user's key for a provider (server-only). Returns null if none. */
export async function getDecryptedKey(
  supabase: SupabaseClient,
  userId: string,
  provider: Provider,
): Promise<string | null> {
  const { data } = await supabase
    .from("provider_keys")
    .select("encrypted_key")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (!data?.encrypted_key) return null;
  try {
    return decryptSecret(data.encrypted_key as string);
  } catch {
    return null;
  }
}

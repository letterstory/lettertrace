import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret } from "@/lib/crypto";
import type { Project, Provider, ProviderKeyPublic } from "@/lib/types";

// Server-side data helpers shared across pages and route handlers.
// All expect a Supabase client already scoped to the request (RLS).
// Read helpers are wrapped in React cache() so the layout and page of a single
// request (which pass the same cached client) each hit the database only once.

/** All of the user's projects (organizations), oldest first. */
export const getProjects = cache(async function getProjects(
  supabase: SupabaseClient,
  userId: string,
): Promise<Project[]> {
  const { data } = await supabase
    .from("projects")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return (data as Project[] | null) ?? [];
});

/**
 * The user's active project (organization): the one selected via the org
 * switcher (profiles.active_project_id), falling back to the earliest project
 * they created. Null when they have no projects yet.
 */
export const getProject = cache(async function getProject(
  supabase: SupabaseClient,
  userId: string,
): Promise<Project | null> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("active_project_id")
    .eq("id", userId)
    .maybeSingle();
  const activeId = (profile as { active_project_id?: string | null } | null)
    ?.active_project_id;

  if (activeId) {
    const { data } = await supabase
      .from("projects")
      .select("*")
      .eq("id", activeId)
      .eq("user_id", userId)
      .maybeSingle();
    if (data) return data as Project;
    // Stale pointer (project deleted / not the user's): fall through.
  }

  const { data } = await supabase
    .from("projects")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as Project | null) ?? null;
});

/**
 * Point the dashboard at another of the user's organizations.
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

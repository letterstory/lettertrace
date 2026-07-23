import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret } from "@/lib/crypto";
import type { Project, Provider, ProviderKeyPublic } from "@/lib/types";

// Server-side data helpers shared across pages and route handlers.
// All expect a Supabase client already scoped to the request (RLS).

/** The user's active project (the earliest one they created), or null. */
export async function getProject(
  supabase: SupabaseClient,
  userId: string,
): Promise<Project | null> {
  const { data } = await supabase
    .from("projects")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as Project | null) ?? null;
}

/** Safe (no ciphertext) list of the user's stored provider keys. */
export async function getProviderKeysPublic(
  supabase: SupabaseClient,
  userId: string,
): Promise<ProviderKeyPublic[]> {
  const { data } = await supabase
    .from("provider_keys")
    .select("id, provider, label, key_hint, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return (data as ProviderKeyPublic[] | null) ?? [];
}

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

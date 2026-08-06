import type { SupabaseClient } from "@supabase/supabase-js";
import { ConfigurationError, decryptSecret, encryptSecret, keyHint } from "@/lib/crypto";
import { ENCRYPTION_UNAVAILABLE_MESSAGE } from "@/lib/provider-keys";
import { SEARCH_PROVIDERS, SEARCH_PROVIDER_LIST, isSearchProvider } from "@/lib/search";
import type { SearchProviderId } from "@/lib/search";

// ==================================================================
// The single write path for BYOK web-search keys (search_keys table).
//
// Deliberately the same contract as lib/provider-keys, for the same reason
// that module exists: verify the key against the provider FIRST, encrypt it
// SECOND, and only ever persist the ciphertext plus a non-reversible hint.
// A separate module rather than a widening of provider-keys because a search
// engine is not an answer engine — the two allow-lists must never bleed into
// each other (see the search_keys schema note).
//
// Every function takes userId explicitly rather than leaning on RLS, because
// the collector reaches this through the service-role client.
//
// Nothing in this module ever returns, logs, or echoes the plaintext key
// except decryptedSearchKey, whose only caller is the collector handing the
// key straight to the provider adapter.
// ==================================================================

/** A search_keys row trimmed to what any surface may show. No ciphertext. */
export interface SearchKeySummary {
  id: string;
  provider: SearchProviderId;
  label: string | null;
  key_hint: string;
  created_at: string;
}

export type SetSearchKeyOutcome =
  | { ok: true; key: SearchKeySummary }
  | {
      ok: false;
      code: "invalid" | "unverified" | "misconfigured" | "failed";
      message: string;
    };

/** Narrow an untrusted provider value, or null. */
export function parseSearchProvider(value: unknown): SearchProviderId | null {
  return typeof value === "string" && isSearchProvider(value) ? value : null;
}

export function unknownSearchProviderMessage(): string {
  return `Unknown search provider. Supported: ${SEARCH_PROVIDER_LIST.map((p) => p.id).join(", ")}.`;
}

const SUMMARY_COLUMNS = "id, provider, label, key_hint, created_at";

/** The caller's stored search keys, hints only. Throws on a query error —
 *  an empty list is a meaningful answer ("no key stored"), so it must never
 *  double as a failure signal. */
export async function listSearchKeys(
  supabase: SupabaseClient,
  userId: string,
): Promise<SearchKeySummary[]> {
  const { data, error } = await supabase
    .from("search_keys")
    .select(SUMMARY_COLUMNS)
    .eq("user_id", userId)
    .order("provider");
  if (error) throw error;
  return (data as SearchKeySummary[] | null) ?? [];
}

/**
 * Verify a search key, encrypt it, and store it as the account's key for
 * that provider (one per provider — an existing key is replaced; "set" and
 * "rotate" are the same operation). The ordering is the reason this function
 * exists: a key the provider rejects must never reach the database, and an
 * encryption failure must be distinguishable from a rejected key.
 */
export async function setSearchKey(
  supabase: SupabaseClient,
  userId: string,
  input: { provider: unknown; apiKey: unknown; label?: unknown },
): Promise<SetSearchKeyOutcome> {
  const provider = parseSearchProvider(input.provider);
  if (!provider) {
    return { ok: false, code: "invalid", message: unknownSearchProviderMessage() };
  }
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    return { ok: false, code: "invalid", message: "An API key is required" };
  }

  const key = input.apiKey.trim();
  const label =
    typeof input.label === "string" && input.label.trim().length > 0
      ? input.label.trim()
      : null;

  const verified = await SEARCH_PROVIDERS[provider].verifyKey(key);
  if (!verified.ok) {
    return {
      ok: false,
      code: "unverified",
      message: verified.error || "Key verification failed",
    };
  }

  let encrypted_key: string;
  const key_hint = keyHint(key);
  try {
    encrypted_key = encryptSecret(key);
  } catch (e) {
    if (e instanceof ConfigurationError) {
      console.error("[search-keys] deployment misconfigured:", e.message);
      return {
        ok: false,
        code: "misconfigured",
        message: ENCRYPTION_UNAVAILABLE_MESSAGE,
      };
    }
    return {
      ok: false,
      code: "failed",
      message: e instanceof Error ? e.message : "Could not store the key.",
    };
  }

  const { data, error } = await supabase
    .from("search_keys")
    .upsert(
      { user_id: userId, provider, label, encrypted_key, key_hint },
      { onConflict: "user_id,provider" },
    )
    .select(SUMMARY_COLUMNS)
    .single();

  if (error || !data) {
    return {
      ok: false,
      code: "failed",
      message: error?.message || "Could not store the key.",
    };
  }
  return { ok: true, key: data as SearchKeySummary };
}

/**
 * Delete the account's key for one search provider. Returns the removed
 * row's summary, or null when nothing was stored (caller answers 404, so a
 * typo'd provider never reads as "removed"). A query error throws: this is
 * a revocation path, and "no key is stored" after a failed delete leaves
 * the user believing a live credential is gone.
 */
export async function removeSearchKey(
  supabase: SupabaseClient,
  userId: string,
  provider: SearchProviderId,
): Promise<SearchKeySummary | null> {
  const { data, error } = await supabase
    .from("search_keys")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider)
    .select(SUMMARY_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return (data as SearchKeySummary | null) ?? null;
}

/**
 * The collector's read path: the user's stored key for a provider, decrypted,
 * or null when none is stored. Throws ConfigurationError when a key exists
 * but this deployment can't decrypt it (missing/rotated ENCRYPTION_KEY) —
 * that is an operator problem and must not be reported as "enable the signal
 * by adding a key", which the user already did.
 */
export async function decryptedSearchKey(
  supabase: SupabaseClient,
  userId: string,
  provider: SearchProviderId,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("search_keys")
    .select("encrypted_key")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  if (!data?.encrypted_key) return null;
  return decryptSecret(data.encrypted_key);
}

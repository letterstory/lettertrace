import type { SupabaseClient } from "@supabase/supabase-js";
import { ConfigurationError, encryptSecret, keyHint } from "@/lib/crypto";
import { humanError, verifyKey } from "@/lib/llm";
import { isProvider, PROVIDER_LIST } from "@/lib/models";
import type { Provider } from "@/lib/types";

// ==================================================================
// The single write path for BYOK provider keys.
//
// Two surfaces store keys — the dashboard (app/api/keys, cookie/RLS client) and
// the REST v1 API used by the CLI (app/api/v1/keys, service-role client) — and
// the sequence they must follow is identical and security-critical: verify the
// key against the provider FIRST, encrypt it SECOND, and only ever persist the
// ciphertext plus a non-reversible hint. Duplicating that in two routes is how
// one of them eventually drifts into storing a plaintext key or skipping
// verification, so both call in here instead.
//
// Every function takes userId explicitly rather than leaning on RLS, because
// the API surface passes the service-role client, where RLS is bypassed.
//
// Nothing in this module ever returns, logs, or echoes the plaintext key. The
// only representation that leaves is keyHint() — e.g. "sk-ant-…4a9c".
// ==================================================================

/** A provider_keys row trimmed to what any surface may show. No ciphertext:
 *  the encrypted key is decryptable by the server and has no business being in
 *  a JSON response, even to the key's owner. */
export interface ProviderKeySummary {
  id: string;
  provider: Provider;
  label: string | null;
  key_hint: string;
  created_at: string;
}

/**
 * What an operator (not the end user) has to fix. Kept as one constant so the
 * dashboard and the CLI say the same thing, and phrased to make the ordering
 * explicit: the key was already accepted by the provider, so the failure is the
 * deployment's. Rendering this as field-level "invalid API key" feedback would
 * send the user off to regenerate a key that was never the problem.
 */
export const ENCRYPTION_UNAVAILABLE_MESSAGE =
  "Your key is valid, but this deployment can't store it yet: the server is missing a working ENCRYPTION_KEY. Nothing was saved. Contact whoever operates this instance.";

export type SetProviderKeyOutcome =
  | { ok: true; key: ProviderKeySummary }
  // `invalid` = malformed request, `unverified` = the provider rejected the
  // key, `misconfigured` = ours to fix (503), `failed` = storage blew up.
  // Callers map the code to a status; they never re-derive it from the message.
  | {
      ok: false;
      code: "invalid" | "unverified" | "misconfigured" | "failed";
      message: string;
    };

/** The providers this deployment can hold a key for, derived from the model
 *  catalog. Exposed over the API so clients (the CLI) can enumerate providers
 *  without shipping their own copy of the list — adding a provider to
 *  lib/models.ts is then the only change needed. */
export function supportedProviders(): {
  id: Provider;
  label: string;
  key_url: string;
  key_prefix: string;
}[] {
  return PROVIDER_LIST.map((p) => ({
    id: p.id,
    label: p.label,
    key_url: p.keyUrl,
    key_prefix: p.keyPrefix,
  }));
}

/** Narrow an untrusted provider value, or null. */
export function parseProvider(value: unknown): Provider | null {
  return typeof value === "string" && isProvider(value) ? value : null;
}

/** The 400 message for an unrecognized provider, naming the ones that do work
 *  so a caller never has to guess (and so a newly added provider self-documents). */
export function unknownProviderMessage(): string {
  return `Unknown provider. Supported: ${PROVIDER_LIST.map((p) => p.id).join(", ")}.`;
}

const SUMMARY_COLUMNS = "id, provider, label, key_hint, created_at";

/** The caller's stored keys, hints only. */
export async function listProviderKeys(
  supabase: SupabaseClient,
  userId: string,
): Promise<ProviderKeySummary[]> {
  const { data } = await supabase
    .from("provider_keys")
    .select(SUMMARY_COLUMNS)
    .eq("user_id", userId)
    .order("provider");
  return (data as ProviderKeySummary[] | null) ?? [];
}

/**
 * Verify a provider key, encrypt it, and store it as the account's key for that
 * provider (one per provider — an existing key is replaced, which is what both
 * "set" and "rotate" mean here).
 *
 * The order matters and is the reason this function exists: a key that the
 * provider rejects must never reach the database, and an encryption failure
 * must be distinguishable from a rejected key.
 */
export async function setProviderKey(
  supabase: SupabaseClient,
  userId: string,
  input: { provider: unknown; apiKey: unknown; label?: unknown },
): Promise<SetProviderKeyOutcome> {
  const provider = parseProvider(input.provider);
  if (!provider) {
    return { ok: false, code: "invalid", message: unknownProviderMessage() };
  }
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    return { ok: false, code: "invalid", message: "An API key is required" };
  }

  const key = input.apiKey.trim();
  const label =
    typeof input.label === "string" && input.label.trim().length > 0
      ? input.label.trim()
      : null;

  const verified = await verifyKey(provider, key);
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
      // Operator-facing, and only ever reachable AFTER the provider accepted
      // the key — so it is safe to state plainly that the key itself is fine.
      console.error("[provider-keys] deployment misconfigured:", e.message);
      return {
        ok: false,
        code: "misconfigured",
        message: ENCRYPTION_UNAVAILABLE_MESSAGE,
      };
    }
    return { ok: false, code: "failed", message: humanError(e) };
  }

  const { data, error } = await supabase
    .from("provider_keys")
    .upsert(
      { user_id: userId, provider, label, encrypted_key, key_hint },
      { onConflict: "user_id,provider" },
    )
    .select(SUMMARY_COLUMNS)
    .single();

  if (error || !data) {
    return { ok: false, code: "failed", message: humanError(error) };
  }
  return { ok: true, key: data as ProviderKeySummary };
}

/**
 * Delete the account's key for one provider. Returns the removed row's summary,
 * or null when there was nothing stored — the caller can then answer 404 rather
 * than reporting a no-op as a successful removal, which would let a typo'd
 * provider read as "removed".
 */
export async function removeProviderKey(
  supabase: SupabaseClient,
  userId: string,
  provider: Provider,
): Promise<ProviderKeySummary | null> {
  const { data } = await supabase
    .from("provider_keys")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider)
    .select(SUMMARY_COLUMNS)
    .maybeSingle();
  return (data as ProviderKeySummary | null) ?? null;
}

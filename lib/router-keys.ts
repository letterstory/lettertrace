import type { SupabaseClient } from "@supabase/supabase-js";
import { ConfigurationError, encryptSecret, keyHint } from "@/lib/crypto";
import { humanError, verifyRouterKey, type RouterVerification } from "@/lib/llm";
import { ROUTER_LIST, parseRouterId, routerProviders, unknownRouterMessage } from "@/lib/routers";
import { PROVIDERS } from "@/lib/models";
import type { Provider, RouterId, RouterKeyPublic } from "@/lib/types";
import { ENCRYPTION_UNAVAILABLE_MESSAGE } from "@/lib/provider-keys";

// ==================================================================
// The single write path for LLM router (gateway) credentials.
//
// Same contract as lib/provider-keys, and for the same reason: verify against
// the router FIRST, encrypt SECOND, persist only ciphertext plus a
// non-reversible hint. Nothing here returns, logs, or echoes the plaintext key.
//
// One addition specific to routers. Verification doesn't just ask "does this key
// work" — it asks, per provider, whether the provider's own web search survives
// the gateway, and stores the answer on the row. That set is what lib/trial
// consults before letting a router serve a monitored run, so it is written here
// at save time and nowhere else. See the header of lib/routers.ts for why an
// unverified router is a data-integrity problem rather than a feature gap.
// ==================================================================

export interface RouterKeySummary {
  id: string;
  router: RouterId;
  label: string | null;
  base_url: string | null;
  key_hint: string;
  search_verified: Provider[];
  created_at: string;
}

export type SetRouterKeyOutcome =
  | { ok: true; key: RouterKeySummary; verification: RouterVerification }
  | {
      ok: false;
      code: "invalid" | "unverified" | "misconfigured" | "failed";
      message: string;
    };

/** The routers this deployment supports, for clients (the CLI) to enumerate. */
export function supportedRouters(): {
  id: RouterId;
  label: string;
  key_url: string;
  key_prefix: string;
  docs_url: string;
  providers: Provider[];
}[] {
  return ROUTER_LIST.map((r) => ({
    id: r.id,
    label: r.label,
    key_url: r.keyUrl,
    key_prefix: r.keyPrefix,
    docs_url: r.docsUrl,
    providers: routerProviders(r.id),
  }));
}

const SUMMARY_COLUMNS = "id, router, label, base_url, key_hint, search_verified, created_at";

/** The caller's stored router keys, hints only. Throws on a query error rather
 *  than returning [] — see the same note on listProviderKeys. */
export async function listRouterKeys(
  supabase: SupabaseClient,
  userId: string,
): Promise<RouterKeySummary[]> {
  const { data, error } = await supabase
    .from("router_keys")
    .select(SUMMARY_COLUMNS)
    .eq("user_id", userId)
    .order("router");
  if (error) throw error;
  return (data as RouterKeySummary[] | null) ?? [];
}

/**
 * A one-line summary of what a verified credential can actually do, for the
 * activity log and the API response.
 *
 * Worth spelling out rather than saying "saved": the difference between a router
 * that carries grounded answers and one that only carries ungrounded ones is the
 * difference between usable and not usable for monitoring, and the user has no
 * other way to find out.
 */
export function verificationSummary(v: RouterVerification): string {
  if (v.reachable.length === 0) return "no engines reachable";
  const names = (list: Provider[]) => list.map((p) => PROVIDERS[p].label).join(", ");
  const grounded = v.searchVerified.length > 0 ? `web search confirmed for ${names(v.searchVerified)}` : null;
  const ungrounded = v.reachable.filter((p) => !v.searchVerified.includes(p));
  const plain = ungrounded.length > 0 ? `no confirmed web search for ${names(ungrounded)}` : null;
  return [`reached ${names(v.reachable)}`, grounded, plain].filter(Boolean).join("; ");
}

/**
 * Verify a router key, record what it can do, encrypt it, and store it as the
 * account's credential for that router (one per router; an existing row is
 * replaced, which is what both "set" and "rotate" mean here).
 */
export async function setRouterKey(
  supabase: SupabaseClient,
  userId: string,
  input: { router: unknown; apiKey: unknown; label?: unknown; baseUrl?: unknown },
): Promise<SetRouterKeyOutcome> {
  const router = parseRouterId(input.router);
  if (!router) {
    return { ok: false, code: "invalid", message: unknownRouterMessage() };
  }
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    return { ok: false, code: "invalid", message: "An API key is required" };
  }

  const key = input.apiKey.trim();
  const label =
    typeof input.label === "string" && input.label.trim().length > 0 ? input.label.trim() : null;

  // A self-hosted deployment of a router. Rejected unless it is an https URL:
  // this value becomes the base URL we send the user's key to, so a http:// or
  // otherwise malformed value would leak the credential in plaintext or send it
  // somewhere unintended.
  let baseUrl: string | null = null;
  if (typeof input.baseUrl === "string" && input.baseUrl.trim().length > 0) {
    const raw = input.baseUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, code: "invalid", message: "That base URL isn't a valid URL." };
    }
    if (parsed.protocol !== "https:") {
      return {
        ok: false,
        code: "invalid",
        message: "A router base URL must use https — your API key is sent to it.",
      };
    }
    baseUrl = raw.replace(/\/+$/, "");
  }

  const verification = await verifyRouterKey(router, key, baseUrl);
  if (!verification.ok) {
    return {
      ok: false,
      code: "unverified",
      message: verification.error || "Key verification failed",
    };
  }

  let encrypted_key: string;
  const key_hint = keyHint(key);
  try {
    encrypted_key = encryptSecret(key);
  } catch (e) {
    if (e instanceof ConfigurationError) {
      console.error("[router-keys] deployment misconfigured:", e.message);
      return { ok: false, code: "misconfigured", message: ENCRYPTION_UNAVAILABLE_MESSAGE };
    }
    return { ok: false, code: "failed", message: humanError(e) };
  }

  const { data, error } = await supabase
    .from("router_keys")
    .upsert(
      {
        user_id: userId,
        router,
        label,
        base_url: baseUrl,
        encrypted_key,
        key_hint,
        // Overwritten on every save, never merged: a rotated key is a different
        // credential and may have different model access, so carrying the old
        // key's verified set forward would let a downgrade pass unnoticed.
        search_verified: verification.searchVerified,
      },
      { onConflict: "user_id,router" },
    )
    .select(SUMMARY_COLUMNS)
    .single();

  if (error || !data) {
    return { ok: false, code: "failed", message: humanError(error) };
  }
  return { ok: true, key: data as RouterKeySummary, verification };
}

/**
 * Delete the account's credential for one router. Returns the removed summary,
 * or null when nothing was stored. A query error throws rather than collapsing
 * into that null — this is a revocation path, and reporting a failed delete as
 * "nothing stored" would leave someone believing a live credential is gone.
 */
export async function removeRouterKey(
  supabase: SupabaseClient,
  userId: string,
  router: RouterId,
): Promise<RouterKeySummary | null> {
  const { data, error } = await supabase
    .from("router_keys")
    .delete()
    .eq("user_id", userId)
    .eq("router", router)
    .select(SUMMARY_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return (data as RouterKeySummary | null) ?? null;
}

/** Public (no ciphertext) shape for the browser. */
export function toPublic(key: RouterKeySummary): RouterKeyPublic {
  return {
    id: key.id,
    router: key.router,
    label: key.label,
    base_url: key.base_url,
    key_hint: key.key_hint,
    search_verified: key.search_verified ?? [],
    created_at: key.created_at,
  };
}

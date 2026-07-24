import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { hashApiKey } from "@/lib/crypto";

// Bearer-token auth for the programmatic surface (/api/v1 and /api/mcp).
// Requests carry a Lettertrace API key instead of a Supabase session, so the
// returned client is the service-role client: RLS is bypassed and every query
// made with it MUST be scoped by userId explicitly.

export interface ApiAuthContext {
  supabase: SupabaseClient;
  userId: string;
  keyId: string;
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Resolve an API key to its owner. Returns null for a missing or unknown key.
 * Touches last_used_at so the settings page can show stale keys.
 */
export async function authenticateApiKey(
  token: string | null | undefined,
): Promise<ApiAuthContext | null> {
  if (!token) return null;
  const supabase = createServiceClient();

  const { data } = await supabase
    .from("api_keys")
    .select("id, user_id")
    .eq("key_hash", hashApiKey(token))
    .maybeSingle();
  if (!data) return null;

  await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);

  return { supabase, userId: data.user_id as string, keyId: data.id as string };
}

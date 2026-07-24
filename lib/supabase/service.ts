import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client that bypasses RLS. Only for trusted server contexts:
// the cron endpoint (enumerates every user's due projects) and the
// API-key-authenticated surface (/api/v1, /api/mcp), where every query must
// scope by userId explicitly. Lives outside lib/supabase/server.ts so modules
// that never touch request cookies (and their tests) don't drag in
// next/headers. Requires SUPABASE_SERVICE_ROLE_KEY.
export function createServiceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. It is required for scheduled runs and API-key access.",
    );
  }
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        // Next.js patches global fetch and may serve repeated GETs (same URL)
        // from its data cache — which turned api_keys lookups and report reads
        // into stale snapshots. Data queries must always hit Postgres.
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
      },
    },
  );
}

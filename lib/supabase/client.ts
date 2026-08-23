"use client";

import { createBrowserClient } from "@supabase/ssr";
import { PUBLIC_ENV_GLOBAL, type PublicEnv } from "@/lib/public-env";

/**
 * Runtime config first, build-time inlining second.
 *
 * The injected object is what makes a prebuilt image work for someone else's
 * Supabase project (see lib/public-env.ts). The `process.env` fallback is what
 * keeps a Vercel build working unchanged if the script is ever missing — on
 * Vercel both paths hold the same values, so the order only matters for
 * self-hosted containers.
 */
function browserEnv(): PublicEnv {
  const injected = (globalThis as unknown as Record<string, PublicEnv | undefined>)[
    PUBLIC_ENV_GLOBAL
  ];

  return {
    supabaseUrl: injected?.supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    supabaseAnonKey:
      injected?.supabaseAnonKey || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  };
}

// Browser Supabase client (uses the public anon key + RLS).
export function createClient() {
  const { supabaseUrl, supabaseAnonKey } = browserEnv();

  // Failing loudly here beats createBrowserClient throwing something opaque
  // about an invalid URL. Self-hosting is the case that hits this, so the
  // message names the fix rather than the symptom.
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Supabase browser config is missing. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY in the server environment. See the " +
        "self-hosting section of the README.",
    );
  }

  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}

import { cache } from "react";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

export { createServiceClient } from "./service";

// Server Supabase client bound to the request cookies (respects RLS as the
// signed-in user). Use inside Server Components, Route Handlers, Server Actions.
// Wrapped in React cache() so the layout and page of one request share a single
// client instance — which also lets the cached data helpers dedupe their reads.
export const createClient = cache(function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // `setAll` from a Server Component is a no-op; middleware refreshes
            // the session cookie instead. Safe to ignore.
          }
        },
      },
    },
  );
});

// Convenience: the signed-in user (or null). Deduped per request.
export const getUser = cache(async function getUser() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

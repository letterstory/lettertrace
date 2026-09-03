import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase auth session on every request and guards /dashboard.
export async function updateSession(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Machine and metadata endpoints must never be touched by session handling:
  // no cookie refresh (a Set-Cookie on a token response is noise at best), no
  // redirect (a 302-to-login would break discovery for an MCP client), and no
  // getUser() network hop. These carry their own credential (a client secret,
  // PKCE, a device code) or are fully public.
  //
  // The INTERACTIVE OAuth endpoints are deliberately NOT listed here —
  // /api/oauth/authorize, /oauth/consent, and /activate need the Supabase
  // session to identify the human approving the grant, so they must fall
  // through to the normal handling below.
  if (
    path.startsWith("/.well-known/") ||
    path === "/api/oauth/token" ||
    path === "/api/oauth/device" ||
    path === "/api/oauth/register" ||
    path === "/api/oauth/revoke"
  ) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        // Keep auth lookups out of Next's data cache (see lib/supabase/service.ts).
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, cache: "no-store" }),
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Gate the app behind auth.
  //
  // /invite is gated for the same reason /dashboard is, and gets the same
  // `next` round-trip: someone opening an invitation link who has never used
  // Lettertrace lands on sign-up, creates the account the invite was sent to,
  // and comes back to the link. The token is a path segment rather than a
  // query param precisely so it survives that — the redirect below strips
  // url.search, and an invite reduced to /login would be an invite lost.
  if (!user && (path.startsWith("/dashboard") || path.startsWith("/invite/"))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  // Signed-in users skip the auth screens.
  if (user && (path === "/login" || path === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

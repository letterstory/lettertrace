import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveRedirectBase, safePath } from "@/lib/utils";

// Longest provider error we'll echo back onto the sign-in screen. The text is
// attacker-influenceable via the query string (it renders as escaped text, so
// this is about not handing someone a full-page message to write), and real
// provider errors are short.
const MAX_ERROR_LENGTH = 200;

// Handles the email-confirmation / OAuth redirect. Supabase appends a `code`
// query param that we exchange for a session (setting the auth cookies), then
// forward the user to their intended destination.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safePath(searchParams.get("next"));

  // Prefer the configured site URL — behind a proxy the origin parsed off the
  // request can be the internal deployment host — but never follow it to
  // loopback from a deployed request. See resolveRedirectBase.
  const base = resolveRedirectBase(process.env.NEXT_PUBLIC_SITE_URL, origin);

  const failed = (reason: string) => {
    const url = new URL("/login", base);
    url.searchParams.set("error", reason.slice(0, MAX_ERROR_LENGTH));
    return NextResponse.redirect(url);
  };

  // A declined consent screen (or a misconfigured provider) comes back with no
  // `code` and an error description instead. Without this the user lands on a
  // bare /login with no idea what happened.
  const providerError = searchParams.get("error_description") ?? searchParams.get("error");
  if (providerError) {
    return failed(providerError);
  }

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, base));
    }
    return failed(error.message);
  }

  // No code and no error: nothing to exchange, send them back to sign in.
  return NextResponse.redirect(new URL("/login", base));
}

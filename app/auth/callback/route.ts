import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safePath } from "@/lib/utils";

// Handles the email-confirmation / OAuth redirect. Supabase appends a `code`
// query param that we exchange for a session (setting the auth cookies), then
// forward the user to their intended destination.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safePath(searchParams.get("next"));

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  // No code, or the exchange failed, send them back to sign in.
  return NextResponse.redirect(new URL("/login", origin));
}

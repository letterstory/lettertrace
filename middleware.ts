import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Run on everything except static assets, image files, and the
    // token-authenticated programmatic surface (API keys, not cookies).
    //
    // Load-bearing: /api/oauth and /.well-known are deliberately NOT excluded.
    // The interactive OAuth endpoints (/api/oauth/authorize, /oauth/consent,
    // /activate) need the Supabase cookie session to identify the approving
    // user, so they MUST pass through here. updateSession itself early-returns
    // for the machine OAuth endpoints and metadata (see lib/supabase/
    // middleware.ts), so those run no session logic. Never add `api/oauth` to
    // this negative-lookahead: it would strip the session from the consent
    // screen and make every approval anonymous.
    "/((?!_next/static|_next/image|favicon.ico|api/v1|api/mcp|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

import { NextResponse } from "next/server";

// Small HTTP response helpers shared by the OAuth route handlers. Kept out of
// lib/oauth.ts so that module (imported by node-env unit tests) doesn't pull in
// next/server.

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** A minimal, self-contained HTML error page for the interactive endpoints —
 *  used only when we cannot safely redirect the error back (unknown client or
 *  unregistered redirect_uri), so we never become an open redirector. */
export function oauthErrorPage(message: string, status = 400): NextResponse {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Authorization error</title></head>` +
    `<body style="font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.25rem;color:#1a1a1a">` +
    `<h1 style="font-size:1.25rem">Authorization error</h1>` +
    `<p style="color:#555">${escapeHtml(message)}</p>` +
    `</body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Redirect an OAuth error back to a (previously validated) redirect_uri, with
 *  the state echoed and the issuer stamped (RFC 9207 mix-up defense). */
export function oauthRedirectError(
  redirectUri: string,
  code: string,
  state: string | null,
  issuer: string,
): NextResponse {
  const u = new URL(redirectUri);
  u.searchParams.set("error", code);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuer);
  return NextResponse.redirect(u, { status: 302 });
}

/** An RFC 6749 §5.2 token/authorization error body — the error CODE only, never
 *  an internal message. Always no-store. */
export function oauthErrorJson(
  code: string,
  status: number,
  description?: string,
): NextResponse {
  const body: Record<string, string> = { error: code };
  if (description) body.error_description = description;
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

/** A successful token response — always no-store per RFC 6749 §5.1. */
export function tokenJson(payload: Record<string, unknown>): NextResponse {
  return NextResponse.json(payload, {
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

/**
 * Letterprove integration helpers that are not React.
 *
 * Lives here rather than beside the client component because the dashboard
 * layout is a SERVER component: it needs this to decide which event the page
 * load should report, and a server file importing a "use client" module for a
 * pure function is a needless boundary crossing.
 */

/**
 * Whether this is the account's first-ever sign-in.
 *
 * Supabase stamps `created_at` and `last_sign_in_at` together at signup and
 * only advances the latter on subsequent sign-ins, so they coincide exactly
 * once in an account's life. Computed on the server because it needs the auth
 * record, and derived rather than stored because the alternative — a column —
 * duplicates state the auth server already holds correctly.
 *
 * This covers OAuth and password identically, which matters: the login form
 * knows whether the person pressed "sign up", but for OAuth that intent is
 * meaningless — Supabase creates the account either way, so a first-time
 * Google user pressing "sign in" is still a signup.
 */
export function isFirstSignIn(user: {
  created_at?: string;
  last_sign_in_at?: string | null;
}): boolean {
  if (!user.created_at || !user.last_sign_in_at) return false;
  const created = Date.parse(user.created_at);
  const signedIn = Date.parse(user.last_sign_in_at);
  if (Number.isNaN(created) || Number.isNaN(signedIn)) return false;
  // Seconds, not milliseconds: the two writes happen in one request but not in
  // one instant.
  return Math.abs(signedIn - created) < 10_000;
}

/**
 * Letterprove's own custom domain — deliberately NOT a `*.vercel.app` alias.
 *
 * The default was `letterprove.vercel.app`, which broke collection silently:
 * that alias has moved between Letterprove projects more than once and now
 * 404s entirely, so the script never loaded and nothing said so.
 *
 * Shared by the browser component and the health canary ON PURPOSE. If the two
 * ever read different values, the canary would be checking a URL nobody uses
 * and would stay green through exactly the outage it exists to catch.
 */
const DEFAULT_ORIGIN = "https://app.letterprove.com";

export function letterproveOrigin(): string {
  return process.env.NEXT_PUBLIC_LETTERPROVE_ORIGIN ?? DEFAULT_ORIGIN;
}

import crypto from "node:crypto";

/**
 * Whether a request carries `Authorization: Bearer $CRON_SECRET`. Constant-time,
 * and false when the secret isn't configured, so an unconfigured deployment
 * refuses rather than accepting an empty bearer.
 */
export function isCronAuthorized(header: string | null, secret: string | undefined = process.env.CRON_SECRET): boolean {
  if (!header || !secret) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

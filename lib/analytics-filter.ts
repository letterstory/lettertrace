/**
 * Share links embed their bearer token directly in the URL path
 * (/share/<token> -- see lib/share-links.ts). Anything that auto-captures
 * the current URL for analytics or tracing must never see that path, or
 * the token leaves this deployment through a side channel nobody reviews
 * as a credential. Kept in lib/ (not components/) so it's covered by
 * vitest.config.ts's test glob -- components/**\/*.test.ts is not included.
 */
export function isShareLinkPath(pathname: string): boolean {
  return pathname.startsWith("/share/");
}

// Deriving a brand's display name from what its site says about itself.
//
// Its own module rather than part of lib/scrape.ts because the onboarding
// wizard is a client component and needs the same rule: lib/scrape.ts imports
// node:dns and node:net, which cannot be bundled for the browser. One
// implementation, both sides, so the name the wizard shows for a skipped scrape
// matches the one the server would have derived.

/** The registrable host of whatever the user typed: scheme, path, port, query
 *  and a leading "www." removed. Onboarding now asks for a URL and nothing
 *  else, so a pasted "https://acme.com/pricing?ref=x" is the normal input, not
 *  an edge case — storing that verbatim as a brand domain is what put a full
 *  URL with a path in the Settings domain field. */
export function hostOf(domain: string | null): string {
  if (!domain) return "";
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .split("?")[0]
    .split(":")[0]
    .replace(/^www\./i, "")
    .toLowerCase();
}

// A page title is usually "Brand <separator> what we do". Splitting on the
// separator is what turns "Stripe | Financial Infrastructure" into "Stripe".
//
// Colon and pipe are matched flush against the brand ("Vercel: Build and
// deploy") because that is how they are written. The dashes require a space on
// BOTH sides, so a hyphenated brand ("Well-Known Co") is not cut in half.
const TITLE_SEPARATORS = /\s*[:|]\s+|\s+[–—·\-]\s+/;

// Titles that name the page rather than the company. Falling through to the
// domain gives "Acme"; keeping these would create a brand called "Home".
const GENERIC_TITLES = new Set([
  "home",
  "homepage",
  "welcome",
  "index",
  "untitled",
  "landing page",
]);

// Second-level labels that are part of the public suffix, not the brand, so
// acme.co.uk is Acme and not Co.
const PUBLIC_SLDS = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne"]);

/** Derive a display name for the brand from what the site says about itself.
 *
 *  Onboarding asks for a URL and nothing else, so this has to produce something
 *  usable every time — the name lands in an editable field the user confirms,
 *  and `projects.brand_name` is NOT NULL. The domain fallback always resolves,
 *  so the field is never empty even when a site declares no metadata at all. */
export function brandNameFromSite(input: {
  siteName?: string;
  title?: string;
  domain?: string;
}): string {
  const declared = input.siteName?.trim();
  if (declared) return declared.slice(0, 60);

  const head = input.title?.split(TITLE_SEPARATORS)[0]?.trim() ?? "";
  if (head && !GENERIC_TITLES.has(head.toLowerCase())) return head.slice(0, 60);

  const labels = hostOf(input.domain ?? "").split(".").filter(Boolean);
  if (labels.length > 1) labels.pop(); // the TLD
  if (labels.length > 1 && PUBLIC_SLDS.has(labels[labels.length - 1])) labels.pop();

  const brand = labels[labels.length - 1] ?? "";
  return brand
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

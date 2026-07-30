// Deterministic mention detection. Given an assistant answer and an entity's
// set of terms (name + aliases), find whether/how often/where it appears.

export interface MentionHit {
  mentioned: boolean;
  count: number;
  /** Normalized 0..1 position of the FIRST occurrence (0 = very start). -1 if absent. */
  firstPosition: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build one case-insensitive, word-boundary regex covering every term.
function buildRegex(terms: string[]): RegExp | null {
  const cleaned = terms
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .map(escapeRegex);
  if (cleaned.length === 0) return null;
  // Sort longest-first so multi-word aliases match before their fragments.
  cleaned.sort((a, b) => b.length - a.length);
  // (?<![A-Za-z0-9]) / (?![A-Za-z0-9]) approximates word boundaries but also
  // works when the term itself contains punctuation (e.g. "Notion.so").
  const pattern = `(?<![A-Za-z0-9])(?:${cleaned.join("|")})(?![A-Za-z0-9])`;
  return new RegExp(pattern, "gi");
}

/**
 * Link surfaces aren't prose naming. A brand string inside a URL, a markdown
 * link (text OR target — link text is usually the URL itself), or a
 * scheme-less www host means the answer LINKED a page — that's a citation,
 * tracked through sources — not that it NAMED the brand. Counting it as a
 * mention once minted a first-mention milestone off "[brand.com](https://…)".
 * Matched spans are blanked with spaces so positions in the original text
 * stay valid.
 */
export function stripLinkSurfaces(text: string): string {
  const blank = (m: string) => " ".repeat(m.length);
  return text
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, blank) // whole markdown links
    .replace(/\bhttps?:\/\/[^\s<>"')\]]+/gi, blank) // bare URLs
    .replace(/\bwww\.[^\s<>"')\]]+/gi, blank); // scheme-less www hosts
}

export function detectMention(text: string, terms: string[]): MentionHit {
  const absent: MentionHit = { mentioned: false, count: 0, firstPosition: -1 };
  if (!text) return absent;
  const re = buildRegex(terms);
  if (!re) return absent;
  text = stripLinkSurfaces(text);

  let count = 0;
  let firstIndex = -1;
  const matches = Array.from(text.matchAll(re));
  for (const match of matches) {
    count++;
    if (firstIndex === -1) firstIndex = match.index ?? -1;
  }
  if (count === 0) return absent;

  const len = Math.max(text.length, 1);
  return {
    mentioned: true,
    count,
    firstPosition: firstIndex >= 0 ? Math.min(firstIndex / len, 1) : 0,
  };
}

// Common second-level public-suffix labels (so "acme.co.uk" -> "acme", not "co").
const PUBLIC_SLD_LABELS = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);

// Convenience: the full term set for a brand / competitor.
export function brandTerms(brandName: string, aliases: string[], domain?: string | null): string[] {
  const terms = [brandName, ...aliases];
  if (domain) {
    // Extract the registrable (second-level) domain label, e.g. "acme" from
    // "https://www.acme.com/pricing" or "acme.co.uk" -> "acme".
    const host = domain
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .replace(/^www\./i, "")
      .toLowerCase();
    const labels = host.split(".").filter(Boolean);
    let sld = "";
    if (labels.length >= 2) {
      sld = labels[labels.length - 2];
      // Handle two-part suffixes like ".co.uk" / ".com.au".
      if (PUBLIC_SLD_LABELS.has(sld) && labels.length >= 3) {
        sld = labels[labels.length - 3];
      }
    } else if (labels.length === 1) {
      sld = labels[0];
    }
    if (sld && sld.length >= 2) terms.push(sld);
  }
  return terms;
}

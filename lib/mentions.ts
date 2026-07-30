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
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, markdownLink)
    .replace(/\bhttps?:\/\/[^\s<>"')\]]+/gi, blank) // bare URLs
    .replace(/\bwww\.[^\s<>"')\]]+/gi, blank); // scheme-less www hosts
}

/**
 * A markdown link keeps its LABEL and loses its target — unless the label is
 * itself an address.
 *
 * Blanking the whole link was too broad. "[Vercel](https://vercel.com)" is the
 * single most common way an assistant names a brand in a ranked list, and to
 * the person reading the answer the brand is named: the label is the prose.
 * Dropping it means a brand that assistants always link reads as never
 * mentioned, which is the same class of error as counting a URL, pointing the
 * other way — and the silent direction, because nobody notices a zero that
 * looks plausible.
 *
 * "[vercel.com](https://vercel.com)" is different: what the reader sees is an
 * address, so the answer cited a page rather than naming a company. Those are
 * still blanked, which is what keeps a link from minting a first-mention.
 *
 * Length-preserving, and the label keeps its exact original offsets — the label
 * starts one character into the match either way — so `firstPosition` and the
 * prominence built on it stay valid.
 */
function markdownLink(match: string, label: string): string {
  const keep = isAddress(label) ? "" : label;
  return " " + keep + " ".repeat(match.length - keep.length - 1);
}

/**
 * Does this link label read as an address rather than as words?
 *
 * A scheme or www prefix, or a bare dotted token with an optional path and
 * nothing else around it. "Vercel" keeps its dots-free spelling and stays;
 * "vercel.com" and "vercel.com/docs" go. A label with any surrounding prose
 * ("Vercel — the hosting platform") is words, whatever else it contains.
 *
 * A brand whose NAME is a domain (You.com) is the residual cost: its label is
 * indistinguishable from a citation of the same domain, so it is treated as
 * one. That was the behaviour for every label before this change; it now
 * applies only to the labels that genuinely look like addresses.
 */
function isAddress(label: string): boolean {
  const trimmed = label.trim();
  if (/^(?:https?:\/\/|www\.)/i.test(trimmed)) return true;
  return /^[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/.test(trimmed);
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

// Domain labels that are ordinary English words match everywhere — "you"
// (you.com) as a word-boundary term reads a ~100% mention rate off every
// answer's prose. Such labels never become terms; the brand still matches via
// its name and aliases ("You.com").
const COMMON_WORD_LABELS = new Set([
  "you", "the", "and", "for", "are", "can", "get", "one", "now", "how",
  "who", "new", "all", "our", "out", "use", "app", "web", "here", "there", "about",
]);

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
    if (sld && sld.length >= 3 && !COMMON_WORD_LABELS.has(sld)) terms.push(sld);
  }
  return terms;
}

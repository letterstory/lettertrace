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

/**
 * The full term set for a brand or competitor: its name and the aliases the
 * owner supplied. Nothing is derived from the domain.
 *
 * A domain label used to be added as a term — "acme" from acme.com — and it was
 * a steady source of false positives, because the label of a real brand is
 * routinely an ordinary English word. you.com read a ~100% mention rate off the
 * pronoun in every answer. #54 answered that with a denylist, but the denylist
 * cannot be the rule: `monday`, `zoom`, `slack` and `box` are exactly as much
 * ordinary English as `you`, they are real tracked brands, and they were still
 * matching prose the day this was written — the list only ever grows one
 * incident at a time, and every incident is discovered by a client looking at a
 * wrong number.
 *
 * Measured before removing it: across 22 projects and 1000 stored answers, the
 * domain label was the sole reason for a detection in 2 answers of one project
 * — "OpenHands" written closed against a brand named "Open Hands". That is an
 * alias, and aliases are per-brand, visible in Settings, and already built.
 *
 * The trade is deliberate. An inflated mention rate is the failure this product
 * exists to prevent and nobody questions it; a missed spelling shows up as a
 * zero the owner goes looking into. Given a choice of error, take the visible
 * one.
 */
export function brandTerms(brandName: string, aliases: string[]): string[] {
  return [brandName, ...aliases];
}

import { describe, expect, it } from "vitest";
import { brandTerms, detectMention, stripLinkSurfaces } from "@/lib/mentions";

describe("stripLinkSurfaces", () => {
  it("blanks markdown links, bare URLs and www hosts — preserving length", () => {
    const text = "See [runlayer.com](https://llms.runlayer.com/blog/x) and https://acme.io/docs, or www.acme.io now.";
    const stripped = stripLinkSurfaces(text);
    expect(stripped.length).toBe(text.length);
    expect(stripped).not.toMatch(/runlayer|acme/i);
    expect(stripped).toContain("See ");
    expect(stripped).toContain(" now.");
  });
});

describe("detectMention vs link surfaces", () => {
  const terms = brandTerms("Runlayer", ["runlayer.com"]);

  it("a brand string inside a link is a citation, not a mention", () => {
    const hit = detectMention(
      "You can stop shadow MCP usage ([runlayer.com](https://llms.runlayer.com/blog/runlayer-vs-arcade?x=1)).",
      terms,
    );
    expect(hit.mentioned).toBe(false);
  });

  it("prose naming still counts, even next to a link", () => {
    const hit = detectMention(
      "Runlayer is one option here — see https://llms.runlayer.com/blog/runlayer-vs-arcade for a comparison.",
      terms,
    );
    expect(hit.mentioned).toBe(true);
    expect(hit.count).toBe(1); // the URL occurrences don't inflate the count
  });

  it("brands whose NAME is a domain keep matching in prose", () => {
    const hit = detectMention("For search, You.com is a solid pick.", ["You.com"]);
    expect(hit.mentioned).toBe(true);
  });
});

describe("terms come from the name and aliases, never the domain", () => {
  // The domain label was a standing source of false positives: a real brand's
  // label is routinely an ordinary English word, and a denylist can only name
  // the ones that have already burned someone.
  it("does not turn a domain into a term", () => {
    expect(brandTerms("You.com", [])).toEqual(["You.com"]);
    expect(brandTerms("Monday.com", [])).toEqual(["Monday.com"]);
    expect(brandTerms("Acme", ["Acme Inc"])).toEqual(["Acme", "Acme Inc"]);
  });

  it("stops ordinary prose reading as a mention", () => {
    // Both matched before, off the domain label: 'you' from you.com and
    // 'monday' from monday.com.
    expect(detectMention("Here is what you should do.", brandTerms("You.com", [])).mentioned).toBe(false);
    expect(detectMention("On Monday we shipped it.", brandTerms("Monday.com", [])).mentioned).toBe(false);
  });

  // The limit of this change, asserted so nobody reads more into it. A brand
  // whose NAME is an ordinary word still matches that word — matching is
  // case-insensitive and the name is the one term we cannot drop. Nothing about
  // domains can fix that; it is a naming choice, and the fix is to register the
  // brand under the name answers actually use.
  it("cannot save a brand whose own name is an ordinary word", () => {
    expect(detectMention("You can zoom in on the chart.", brandTerms("Zoom", [])).mentioned).toBe(true);
    expect(detectMention("On Monday we shipped it.", brandTerms("Monday", [])).mentioned).toBe(true);
  });

  it("still names the brand when the answer writes it out", () => {
    expect(detectMention("You.com is a solid AI search pick.", brandTerms("You.com", [])).mentioned).toBe(true);
    expect(detectMention("Monday.com is the tracker they use.", brandTerms("Monday.com", [])).mentioned).toBe(true);
  });

  // The one thing the label bought, now bought explicitly and per-brand.
  it("covers a spelling the name misses through an alias", () => {
    const terms = brandTerms("Open Hands", ["OpenHands"]);
    expect(detectMention("Tools here include OpenHands and Factory.", terms).mentioned).toBe(true);
  });
});

describe("markdown link labels", () => {
  const terms = brandTerms("Vercel", []);

  // The shape this exists for: a ranked list where every brand name is a link.
  // To the reader the brand is named — the label IS the prose.
  it("counts the brand when it is the visible label", () => {
    expect(detectMention("Try [Vercel](https://vercel.com) for Next.js.", terms).mentioned).toBe(true);
    expect(detectMention("1. **[Vercel](https://vercel.com)** — best for Next.js.", terms).mentioned).toBe(true);
  });

  // ...but a label that reads as an address is a citation, which is what keeps
  // a link from minting a first-mention milestone.
  it("still ignores a label that is itself an address", () => {
    expect(detectMention("See [vercel.com](https://vercel.com).", terms).mentioned).toBe(false);
    expect(detectMention("See [vercel.com/docs](https://vercel.com/docs).", terms).mentioned).toBe(false);
    expect(detectMention("See [https://vercel.com](https://vercel.com).", terms).mentioned).toBe(false);
    expect(detectMention("See [www.vercel.com](https://vercel.com).", terms).mentioned).toBe(false);
  });

  it("never counts the link target, only the label", () => {
    // One mention: the label. The target names the brand twice more.
    const hit = detectMention("[Vercel](https://vercel.com/vercel-docs) is good.", terms);
    expect(hit.count).toBe(1);
  });

  it("treats a label with prose around it as prose", () => {
    expect(
      detectMention("[Vercel — the hosting platform](https://vercel.com) is good.", terms).mentioned,
    ).toBe(true);
  });

  // firstPosition drives prominence, so every transform here has to leave the
  // surviving characters exactly where they were.
  it("preserves length and label offsets", () => {
    const text = "Try [Vercel](https://vercel.com) today.";
    const stripped = stripLinkSurfaces(text);
    expect(stripped.length).toBe(text.length);
    expect(stripped.indexOf("Vercel")).toBe(text.indexOf("Vercel"));
  });

  it("handles an empty label without shifting anything", () => {
    const text = "See [](https://vercel.com) here.";
    expect(stripLinkSurfaces(text).length).toBe(text.length);
    expect(detectMention(text, terms).mentioned).toBe(false);
  });
});

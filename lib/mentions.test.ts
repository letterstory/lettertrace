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
  const terms = brandTerms("Runlayer", [], "runlayer.com");

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

describe("common-word domain labels never become terms", () => {
  it("you.com does not make 'you' a brand term", () => {
    const terms = brandTerms("You.com", [], "you.com");
    expect(terms).not.toContain("you");
    expect(detectMention("Here is what you should do.", terms).mentioned).toBe(false);
    expect(detectMention("You.com is a solid AI search pick.", terms).mentioned).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { brandNameFromSite, hostOf } from "@/lib/brand-name";

describe("brandNameFromSite", () => {
  it("prefers the name the site declares for itself", () => {
    expect(
      brandNameFromSite({ siteName: "Stripe", title: "Payments | Stripe", domain: "stripe.com" }),
    ).toBe("Stripe");
  });

  // "Stripe | Financial Infrastructure for the Internet" is the brand plus its
  // pitch. Storing the whole title makes every later mention check look for a
  // string no assistant will ever write.
  it.each([
    ["Stripe | Financial Infrastructure", "Stripe"],
    ["Notion – The all-in-one workspace", "Notion"],
    ["Linear — Plan and build products", "Linear"],
    ["Vercel: Build and deploy", "Vercel"],
    ["Figma - The collaborative interface tool", "Figma"],
    ["Ramp · Corporate cards", "Ramp"],
  ])("trims the tagline off %s", (title, expected) => {
    expect(brandNameFromSite({ title, domain: "example.com" })).toBe(expected);
  });

  // A hyphenated brand is not a separator: only a SPACED separator splits, so
  // "Well-Known" survives intact.
  it("keeps a hyphenated name together", () => {
    expect(brandNameFromSite({ title: "Well-Known Co", domain: "wk.com" })).toBe("Well-Known Co");
  });

  it("falls through a title that names the page instead of the company", () => {
    expect(brandNameFromSite({ title: "Home", domain: "acme.com" })).toBe("Acme");
    expect(brandNameFromSite({ title: "Welcome", domain: "acme.com" })).toBe("Acme");
  });

  describe("domain fallback", () => {
    it.each([
      ["acme.com", "Acme"],
      ["www.acme.com", "Acme"],
      ["https://acme.com/pricing", "Acme"],
      ["acme.com:8080", "Acme"],
      ["ACME.COM", "Acme"],
      ["acme-labs.com", "Acme Labs"],
      ["acme_labs.io", "Acme Labs"],
      // The public suffix is two labels here; without that rule the brand
      // becomes "Co".
      ["www.acme-labs.co.uk", "Acme Labs"],
      ["shop.acme.com", "Acme"],
    ])("derives %s as %s", (domain, expected) => {
      expect(brandNameFromSite({ domain })).toBe(expected);
    });
  });

  // projects.brand_name is NOT NULL and screen 1 asks only for a URL, so this
  // has to produce something for every input that got far enough to be scraped.
  it("still returns a name when the site declares nothing", () => {
    expect(brandNameFromSite({ domain: "acme.com" })).toBe("Acme");
    expect(brandNameFromSite({ title: "   ", siteName: "  ", domain: "acme.com" })).toBe("Acme");
  });

  it("caps a runaway title rather than storing a paragraph", () => {
    const long = "A".repeat(200);
    expect(brandNameFromSite({ siteName: long }).length).toBe(60);
    expect(brandNameFromSite({ title: long, domain: "x.com" }).length).toBe(60);
  });

  it("returns an empty string only when there is nothing at all", () => {
    expect(brandNameFromSite({})).toBe("");
  });
});

describe("hostOf", () => {
  // Screen 1 is a URL box now, so a pasted address with a path is ordinary
  // input. Saving it verbatim put "https://acme.com/pricing" in the Settings
  // domain field, where a domain is what belongs.
  it.each([
    ["acme.com", "acme.com"],
    ["https://acme.com/pricing", "acme.com"],
    ["http://www.acme.com", "acme.com"],
    ["  https://WWW.Acme.com/a/b?ref=x  ", "acme.com"],
    ["acme.com:8080", "acme.com"],
    ["shop.acme.co.uk/path", "shop.acme.co.uk"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(hostOf(input)).toBe(expected);
  });

  it("returns empty for nothing", () => {
    expect(hostOf(null)).toBe("");
    expect(hostOf("")).toBe("");
    expect(hostOf("   ")).toBe("");
  });
});

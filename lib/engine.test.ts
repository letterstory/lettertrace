import { describe, it, expect } from "vitest";
import { hostOf, isOwnedDomain } from "@/lib/engine";

describe("hostOf", () => {
  it("normalizes a messy brand_domain to a registrable host", () => {
    expect(hostOf("https://www.notion.so/pricing")).toBe("notion.so");
    expect(hostOf("Notion.so")).toBe("notion.so");
    expect(hostOf("http://acme.co.uk/path?x=1")).toBe("acme.co.uk");
  });

  it("returns empty for null/blank", () => {
    expect(hostOf(null)).toBe("");
    expect(hostOf("")).toBe("");
  });
});

describe("isOwnedDomain", () => {
  it("matches the exact host", () => {
    expect(isOwnedDomain("notion.so", "notion.so")).toBe(true);
  });

  it("matches subdomains of the owned host", () => {
    expect(isOwnedDomain("blog.notion.so", "notion.so")).toBe(true);
    expect(isOwnedDomain("help.docs.notion.so", "notion.so")).toBe(true);
  });

  it("does not match unrelated or look-alike hosts", () => {
    expect(isOwnedDomain("notnotion.so", "notion.so")).toBe(false);
    expect(isOwnedDomain("evil-notion.so", "notion.so")).toBe(false);
    expect(isOwnedDomain("notion.so.evil.com", "notion.so")).toBe(false);
  });

  it("is false when either side is empty", () => {
    expect(isOwnedDomain("notion.so", "")).toBe(false);
    expect(isOwnedDomain("", "notion.so")).toBe(false);
  });
});

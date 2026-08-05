import { describe, expect, it } from "vitest";
import {
  discoverCompanies,
  looksLikeCompanyName,
  namesInAnswer,
  untrackedNamesInAnswer,
} from "@/lib/discover";

describe("looksLikeCompanyName", () => {
  it("accepts the shapes real vendor names take", () => {
    for (const name of [
      "Fastly",
      "Kore.ai",
      "CDN77",
      "Deno Deploy",
      "Boomi Agentstudio",
      "IBM watsonx.governance",
      "AWS Lambda@Edge",
      "Amazon FSx for Lustre", // " for " is allowed on purpose
      "GSLB.me",
    ]) {
      expect(looksLikeCompanyName(name), name).toBe(true);
    }
  });

  // Each of these was produced by the extractor against stored answers before
  // the corresponding rule existed.
  it("rejects the prose headings that bold text is also used for", () => {
    for (const junk of [
      "1. Start with discovery and a solid data foundation",
      "Why this matters first",
      "A practical approach",
      "Core Best Practices",
      "AI-Specific Governance Platforms", // plural category tail
      "Architectural Options",
      "MCP gateways/proxies", // slash
      "Access & Identity Management", // spaced ampersand
      "Identity and permissions", // conjunction
      "For Amazon S3", // heading starter
      "Cost",
      "Analytics",
    ]) {
      expect(looksLikeCompanyName(junk), junk).toBe(false);
    }
  });

  // A finance brand's answers bolded these; "Beta = 0" as a suggested
  // competitor would look broken.
  it("rejects defined quantities and bolded jargon", () => {
    for (const junk of ["Beta = 0", "Beta < 1.0", "Beta > 1.0", "Alpha", "Beta", "Measures", "Reflects"]) {
      expect(looksLikeCompanyName(junk), junk).toBe(false);
    }
  });

  it("still accepts multi-word names containing an otherwise-common word", () => {
    // The single-word stoplist must not reach into real product names.
    expect(looksLikeCompanyName("Bloomberg Terminal")).toBe(true);
    expect(looksLikeCompanyName("Value Line")).toBe(true);
  });

  it("rejects bare category acronyms that name no company", () => {
    for (const term of ["API", "MCP", "CDN", "IAM", "POSIX", "Kubernetes"]) {
      expect(looksLikeCompanyName(term), term).toBe(false);
    }
  });

  it("rejects anything too long, too short, or not starting on a letter", () => {
    expect(looksLikeCompanyName("A")).toBe(false);
    expect(looksLikeCompanyName("2024")).toBe(false);
    expect(looksLikeCompanyName("A".repeat(41))).toBe(false);
  });
});

describe("namesInAnswer", () => {
  const answer = `
## Options for shared storage

**Fastly** is a solid choice, and **Akamai** competes directly.

### BeeGFS

See [ObjectiveFS](https://objectivefs.com/) for a hosted option.

**1. Start with discovery.** You can't govern what you can't see.
`;

  it("picks names out of bold, headings and links", () => {
    const names = namesInAnswer(answer);
    expect(names).toContain("Fastly");
    expect(names).toContain("Akamai");
    expect(names).toContain("BeeGFS");
    expect(names).toContain("ObjectiveFS");
  });

  it("leaves the prose heading and the section title behind", () => {
    const names = namesInAnswer(answer);
    expect(names.some((n) => n.startsWith("1."))).toBe(false);
    expect(names).not.toContain("Options for shared storage");
  });

  // The patterns carry /g, so a shared lastIndex would make results depend on
  // call order.
  it("returns the same names when called repeatedly", () => {
    expect(namesInAnswer(answer)).toEqual(namesInAnswer(answer));
  });

  it("survives empty and junk input", () => {
    expect(namesInAnswer("")).toEqual([]);
    expect(namesInAnswer("no markup here at all")).toEqual([]);
  });
});

describe("discoverCompanies", () => {
  it("counts the answers naming each company, most-named first", () => {
    const found = discoverCompanies(
      ["**Fastly** and **Akamai**", "**Fastly** again", "**CacheFly**"],
      [],
    );
    expect(found).toEqual([
      { name: "Fastly", answers: 2 },
      { name: "Akamai", answers: 1 },
      { name: "CacheFly", answers: 1 },
    ]);
  });

  it("counts an answer once however many times it repeats a name", () => {
    const found = discoverCompanies(["**Fastly** **Fastly** **Fastly**"], []);
    expect(found).toEqual([{ name: "Fastly", answers: 1 }]);
  });

  it("omits anything already tracked, ignoring case", () => {
    const found = discoverCompanies(["**Fastly** and **Akamai**"], ["fastly"]);
    expect(found.map((f) => f.name)).toEqual(["Akamai"]);
  });

  // The point of the whole module: surface what's MISSING from the list.
  it("omits the tracked brand's own product lines", () => {
    const found = discoverCompanies(
      ["**Cloudflare Workers** vs **Fastly**", "**Cloudflare (1.1.1.1)** is fast"],
      ["Cloudflare"],
    );
    expect(found.map((f) => f.name)).toEqual(["Fastly"]);
  });

  it("respects a limit", () => {
    const answers = ["**Fastly** **Akamai** **CacheFly** **CDN77**"];
    expect(discoverCompanies(answers, [], { limit: 2 })).toHaveLength(2);
  });

  it("returns nothing for answers that named no company", () => {
    expect(discoverCompanies(["**Why this matters**", ""], [])).toEqual([]);
  });
});

describe("untrackedNamesInAnswer", () => {
  const answer = "The leaders are **Galileo** and **Fiddler**, alongside **Runlayer**.";

  it("returns named companies minus the brand and tracked competitors", () => {
    // Runlayer is the brand, Fiddler is tracked → only Galileo is left.
    const out = untrackedNamesInAnswer(answer, ["Runlayer", "Fiddler"]);
    expect(out).toEqual(["Galileo"]);
  });

  it("drops a tracked company's own product line (extends a tracked name)", () => {
    const text = "**Cloudflare** ships **Cloudflare Workers** for edge compute.";
    const out = untrackedNamesInAnswer(text, ["Cloudflare"]);
    expect(out).toEqual([]);
  });

  it("matches tracked terms case-insensitively", () => {
    expect(untrackedNamesInAnswer(answer, ["runlayer", "GALILEO", "fiddler"])).toEqual([]);
  });

  it("is the same filter discoverCompanies aggregates over", () => {
    // Two answers each naming Galileo once → discoverCompanies counts 2 answers.
    const rollup = discoverCompanies([answer, answer], ["Runlayer", "Fiddler"]);
    expect(rollup).toEqual([{ name: "Galileo", answers: 2 }]);
  });
});

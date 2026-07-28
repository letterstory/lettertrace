import { describe, it, expect } from "vitest";
import {
  safeSource,
  dedupeSources,
  domainFromTitle,
  googleGroundingSources,
  type CitedSource,
} from "@/lib/llm";

describe("safeSource", () => {
  it("keeps http(s) URLs and extracts the host", () => {
    expect(safeSource("https://www.Notion.so/pricing", "Notion", "x")).toEqual({
      url: "https://www.Notion.so/pricing",
      domain: "notion.so",
      title: "Notion",
      snippet: "x",
    });
    expect(safeSource("http://example.com", null, null)?.domain).toBe("example.com");
  });

  it("strips only a leading www. and lowercases the host", () => {
    expect(safeSource("https://wwwx.example.com", null, null)?.domain).toBe("wwwx.example.com");
    expect(safeSource("https://BLOG.Example.COM", null, null)?.domain).toBe("blog.example.com");
  });

  it("rejects non-http(s) protocols (javascript:, data:, ftp:)", () => {
    expect(safeSource("javascript:alert(1)", null, null)).toBeNull();
    expect(safeSource("data:text/html,<script>1</script>", null, null)).toBeNull();
    expect(safeSource("ftp://example.com/file", null, null)).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(safeSource("not a url", null, null)).toBeNull();
    expect(safeSource("", null, null)).toBeNull();
  });
});

describe("dedupeSources", () => {
  it("collapses duplicate URLs and back-fills a missing snippet", () => {
    const raw: CitedSource[] = [
      { url: "https://a.com", domain: "a.com", title: "A", snippet: null },
      { url: "https://a.com", domain: "a.com", title: "A", snippet: "quoted" },
      { url: "https://b.com", domain: "b.com", title: "B", snippet: null },
    ];
    const out = dedupeSources(raw);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.url === "https://a.com")?.snippet).toBe("quoted");
  });

  it("drops entries with no URL", () => {
    const raw: CitedSource[] = [{ url: "", domain: "", title: null, snippet: null }];
    expect(dedupeSources(raw)).toHaveLength(0);
  });
});

describe("domainFromTitle", () => {
  it("accepts a bare hostname and normalizes it", () => {
    expect(domainFromTitle("uefa.com")).toBe("uefa.com");
    expect(domainFromTitle("EN.Wikipedia.org")).toBe("en.wikipedia.org");
    expect(domainFromTitle("www.notion.so")).toBe("notion.so");
  });

  it("rejects titles that aren't domains", () => {
    expect(domainFromTitle("How Spain won Euro 2024")).toBeNull();
    expect(domainFromTitle("localhost")).toBeNull();
    expect(domainFromTitle("")).toBeNull();
    expect(domainFromTitle(null)).toBeNull();
  });
});

describe("googleGroundingSources", () => {
  it("keeps the redirect uri as the url but takes the domain from the title", () => {
    const out = googleGroundingSources([
      {
        web: {
          uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC",
          title: "uefa.com",
        },
      },
    ]);
    expect(out).toHaveLength(1);
    // url stays the (clickable) Google redirect; domain is the real source host,
    // so ownership / attribution keeps working.
    expect(out[0].url).toBe(
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC",
    );
    expect(out[0].domain).toBe("uefa.com");
    expect(out[0].title).toBe("uefa.com");
  });

  it("falls back to the uri host when the title isn't a domain", () => {
    const out = googleGroundingSources([
      { web: { uri: "https://example.com/page", title: "Some Page Title" } },
    ]);
    expect(out[0].domain).toBe("example.com");
  });

  it("skips chunks without a web uri and dedupes by url", () => {
    const out = googleGroundingSources([
      { web: { title: "no-uri.com" } },
      {},
      { web: { uri: "https://a.com", title: "a.com" } },
      { web: { uri: "https://a.com", title: "a.com" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].domain).toBe("a.com");
  });
});

describe("googleGroundingSources — unattributable redirects", () => {
  // Google serves grounding links through its own redirect host, so when the
  // title isn't a hostname there is nothing to attribute the citation to.
  // Recording it under the redirect host would mean is_owned could never match
  // and the cited-domain leaderboard would fill with a host nobody published to.
  it("drops a redirect whose title is not a domain", () => {
    expect(
      googleGroundingSources([
        {
          web: {
            uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/XYZ",
            title: "How Spain won Euro 2024",
          },
        },
      ]),
    ).toEqual([]);
  });

  it("keeps a redirect when the title does give a domain", () => {
    const out = googleGroundingSources([
      {
        web: {
          uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/XYZ",
          title: "uefa.com",
        },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].domain).toBe("uefa.com");
  });

  it("still keeps a real URL even when its title is prose", () => {
    const out = googleGroundingSources([
      { web: { uri: "https://acme.com/blog/post", title: "Our take on CDNs" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].domain).toBe("acme.com");
  });
});

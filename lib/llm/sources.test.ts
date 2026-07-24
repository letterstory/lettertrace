import { describe, it, expect } from "vitest";
import { safeSource, dedupeSources, type CitedSource } from "@/lib/llm";

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

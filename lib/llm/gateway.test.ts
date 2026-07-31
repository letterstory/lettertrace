import { describe, it, expect } from "vitest";
import { gatewaySources } from "@/lib/llm";

// Sources are how a run proves its answer came from the live web rather than the
// model's memory. Through a router they arrive as normalized `url_citation`
// annotations instead of each provider's own citation shape, so this parser sits
// between a gateway and the measurement.

describe("gatewaySources", () => {
  it("reads url_citation annotations into cited sources", () => {
    expect(
      gatewaySources([
        {
          type: "url_citation",
          url_citation: {
            url: "https://www.Example.com/post",
            title: "A post",
            content: "snippet",
          },
        },
      ]),
    ).toEqual([
      {
        url: "https://www.Example.com/post",
        domain: "example.com",
        title: "A post",
        snippet: "snippet",
      },
    ]);
  });

  it("treats a missing type as a citation", () => {
    // The payload is the evidence: only url_citation annotations carry a
    // url_citation object, so a router that omits the discriminator still
    // produces a usable source rather than a silently dropped one.
    const sources = gatewaySources([{ url_citation: { url: "https://example.com" } }]);
    expect(sources).toHaveLength(1);
    expect(sources[0].title).toBeNull();
  });

  // A run's source count is the difference between "grounded" and "not
  // grounded", so a non-web annotation must not inflate it.
  it("ignores annotation kinds that aren't web sources", () => {
    expect(
      gatewaySources([
        { type: "file_citation", url_citation: { url: "https://example.com/leak" } },
        { type: "url_citation", url_citation: { url: "https://real.example.com" } },
      ]),
    ).toEqual([
      {
        url: "https://real.example.com",
        domain: "real.example.com",
        title: null,
        snippet: null,
      },
    ]);
  });

  it("drops URLs that aren't safe to render as links", () => {
    expect(
      gatewaySources([
        { type: "url_citation", url_citation: { url: "javascript:alert(1)" } },
        { type: "url_citation", url_citation: { url: "not a url" } },
      ]),
    ).toEqual([]);
  });

  it("collapses repeats of one URL", () => {
    const sources = gatewaySources([
      { type: "url_citation", url_citation: { url: "https://example.com/a" } },
      { type: "url_citation", url_citation: { url: "https://example.com/a", content: "later" } },
    ]);
    expect(sources).toHaveLength(1);
    // The first row wins, but a snippet it lacked is filled in from the repeat.
    expect(sources[0].snippet).toBe("later");
  });

  it("returns nothing when the router sent no annotations", () => {
    expect(gatewaySources(undefined)).toEqual([]);
    expect(gatewaySources([])).toEqual([]);
  });
});

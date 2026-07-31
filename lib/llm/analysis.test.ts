import { describe, it, expect } from "vitest";
import { parseAnalysis, humanError, type AnalyzeEntity } from "@/lib/llm";

const entities: AnalyzeEntity[] = [
  { key: "brand", name: "Cloudflare" },
  { key: "c1f2e3d4-0000-4000-8000-000000000001", name: "Fastly" },
];

describe("parseAnalysis", () => {
  it("resolves rows keyed by the key we supplied (Claude's shape)", () => {
    const results = parseAnalysis(entities, {
      results: [
        { key: "brand", sentiment: "positive", recommended: true },
        { key: "c1f2e3d4-0000-4000-8000-000000000001", sentiment: "neutral", recommended: false },
      ],
    });
    expect(results).toEqual([
      { key: "brand", sentiment: "positive", recommended: true },
      { key: "c1f2e3d4-0000-4000-8000-000000000001", sentiment: "neutral", recommended: false },
    ]);
  });

  // The regression this function exists for: gpt-4o-mini echoes the entity NAME
  // in the `key` field, which used to drop every row and flatten OpenAI projects
  // to neutral / not-recommended.
  it("resolves rows keyed by entity name (gpt-4o-mini's shape)", () => {
    const results = parseAnalysis(entities, {
      results: [
        { key: "Cloudflare", sentiment: "positive", recommended: true },
        { key: "Fastly", sentiment: "negative", recommended: false },
      ],
    });
    expect(results).toEqual([
      { key: "brand", sentiment: "positive", recommended: true },
      { key: "c1f2e3d4-0000-4000-8000-000000000001", sentiment: "negative", recommended: false },
    ]);
  });

  it("matches names case- and whitespace-insensitively, and reads a `name` field", () => {
    expect(parseAnalysis(entities, [{ name: "  cloudflare ", sentiment: "positive" }])).toEqual([
      { key: "brand", sentiment: "positive", recommended: false },
    ]);
  });

  it("accepts a bare array as well as a { results: [...] } wrapper", () => {
    expect(parseAnalysis(entities, [{ key: "brand", sentiment: "negative" }])).toEqual([
      { key: "brand", sentiment: "negative", recommended: false },
    ]);
  });

  it("drops rows that match no requested entity rather than guessing", () => {
    expect(
      parseAnalysis(entities, {
        results: [
          { key: "Akamai", sentiment: "positive", recommended: true },
          { key: "brand", sentiment: "positive", recommended: true },
        ],
      }),
    ).toEqual([{ key: "brand", sentiment: "positive", recommended: true }]);
  });

  it("keeps only the first row per entity when the model repeats one", () => {
    const results = parseAnalysis(entities, {
      results: [
        { key: "brand", sentiment: "positive", recommended: true },
        { key: "Cloudflare", sentiment: "negative", recommended: false },
      ],
    });
    expect(results).toEqual([{ key: "brand", sentiment: "positive", recommended: true }]);
  });

  it("prefers a key match over a name match when the two collide", () => {
    // "Fastly" is both the second entity's name and the first entity's key.
    const collide: AnalyzeEntity[] = [
      { key: "Fastly", name: "Acme" },
      { key: "comp-1", name: "Fastly" },
    ];
    expect(parseAnalysis(collide, [{ key: "Fastly", sentiment: "positive" }])).toEqual([
      { key: "Fastly", sentiment: "positive", recommended: false },
    ]);
  });

  it("defaults an unrecognized sentiment to neutral and coerces recommended", () => {
    expect(parseAnalysis(entities, [{ key: "brand", sentiment: "glowing", recommended: "yes" }])).toEqual([
      { key: "brand", sentiment: "neutral", recommended: true },
    ]);
  });

  it("returns nothing for malformed payloads instead of throwing", () => {
    expect(parseAnalysis(entities, null)).toEqual([]);
    expect(parseAnalysis(entities, "nope")).toEqual([]);
    expect(parseAnalysis(entities, { results: "nope" })).toEqual([]);
    expect(parseAnalysis(entities, [null, 42, "x"])).toEqual([]);
  });
});

describe("humanError on non-Error failures", () => {
  // Supabase hands back a plain object, not an Error. It used to fall through
  // to "Unknown error." — which is what a check-constraint violation reported
  // while a deployment ran an older schema, turning a one-line fix into a
  // debugging session.
  it("keeps the message and code from a database error", () => {
    const message = humanError({
      code: "23514",
      message: 'new row for relation "router_keys" violates check constraint',
    });
    expect(message).toContain("violates check constraint");
    expect(message).toContain("23514");
  });

  it("still says something when there is nothing to say", () => {
    expect(humanError({})).toBe("Unknown error.");
    expect(humanError(null)).toBe("Unknown error.");
  });
});

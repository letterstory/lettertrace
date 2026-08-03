import { describe, it, expect } from "vitest";
import { parseArgs as parseArgsRaw, BOOLEAN_FLAGS as BOOLEAN_FLAGS_RAW } from "./args.mjs";

/** args.mjs is plain ESM with no types, so give the two imports a shape here
 *  rather than scattering casts through every assertion. */
type Parsed = { positionals: string[]; flags: Record<string, string | true> };
const parseArgs = parseArgsRaw as (argv: string[]) => Parsed;
const BOOLEAN_FLAGS = BOOLEAN_FLAGS_RAW as Set<string>;

/**
 * The CLI is the surface the landing page tells people to install, and until
 * now none of it was tested — which is how a boolean flag quietly eating the
 * following word shipped and stayed shipped.
 */

describe("boolean flags", () => {
  it("does not swallow the word after --json", () => {
    // The actual bug: `competitors --json acme` parsed as --json="acme" with no
    // positional, and the error said "needs a <project>" on a line that had one.
    const { positionals, flags } = parseArgs(["competitors", "--json", "acme"]);
    expect(positionals).toEqual(["competitors", "acme"]);
    expect(flags.json).toBe(true);
  });

  it("holds for every flag declared boolean", () => {
    for (const flag of BOOLEAN_FLAGS) {
      const { positionals, flags } = parseArgs(["cmd", `--${flag}`, "value"]);
      expect(positionals).toEqual(["cmd", "value"]);
      expect(flags[flag]).toBe(true);
    }
  });

  it("works at the end of the line too", () => {
    const { positionals, flags } = parseArgs(["projects", "--json"]);
    expect(positionals).toEqual(["projects"]);
    expect(flags.json).toBe(true);
  });
});

describe("value flags", () => {
  it("takes the following word", () => {
    const { flags } = parseArgs(["run", "--project", "acme"]);
    expect(flags.project).toBe("acme");
  });

  it("never consumes another flag as its value", () => {
    // Otherwise `--url --json` would set url="--json" and silently drop the flag.
    const { flags } = parseArgs(["projects", "--url", "--json"]);
    expect(flags.url).toBe(true);
    expect(flags.json).toBe(true);
  });

  it("treats a missing trailing value as a bare flag rather than crashing", () => {
    const { flags } = parseArgs(["keys", "set", "--label"]);
    expect(flags.label).toBe(true);
  });
});

describe("positionals", () => {
  it("keeps order and survives flags interleaved", () => {
    const { positionals, flags } = parseArgs([
      "competitors", "add", "--json", "Vanta", "--name", "Drata", "Secureframe",
    ]);
    expect(positionals).toEqual(["competitors", "add", "Vanta", "Secureframe"]);
    expect(flags.name).toBe("Drata");
  });

  it("handles an empty line", () => {
    expect(parseArgs([])).toEqual({ positionals: [], flags: {} });
  });

  it("keeps values that look like paths or URLs intact", () => {
    const { flags } = parseArgs(["keys", "set", "anthropic", "--key-file", "/tmp/k.txt"]);
    expect(flags["key-file"]).toBe("/tmp/k.txt");
  });
});

/**
 * Command-line argument parsing.
 *
 * Extracted from lettertrace.mjs so it can be tested. That file reads
 * process.argv at import time, so importing it from a test runs the CLI —
 * which is why the one bug this function has already had (a boolean flag
 * swallowing the following word) went unnoticed until someone hit it.
 */

/**
 * Flags that take NO value.
 *
 * Without this set, `--json` consumed whatever followed it, so
 * `lettertrace competitors --json acme` parsed as `--json=acme` with no
 * project — and the failure surfaced as "needs a <project>" on a command line
 * that plainly had one. Every value-less flag must be listed here.
 */
export const BOOLEAN_FLAGS = new Set(["json", "on", "off", "mcp", "both", "ipv6", "help"]);

/**
 * Split argv into positionals and flags.
 *
 * `--flag value` takes the value unless the flag is known to be boolean;
 * `--flag --other` never consumes `--other`, so a boolean flag at the end of a
 * line behaves the same as one in the middle.
 */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

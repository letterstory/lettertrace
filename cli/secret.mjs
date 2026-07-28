import fs from "node:fs";

// Reading a secret without leaking it.
//
// The one thing this module exists to prevent is a provider key ever appearing
// in argv. A `--key sk-ant-…` flag lands in shell history, in `ps` output for
// every user on the box, and in any process supervisor's logs — and unlike a
// file or a pipe there is no way to un-leak it afterwards. So the CLI accepts a
// key from exactly three places, none of which is the command line:
//
//   1. --key-file <path>  (or `-` for stdin), so a secret manager can feed it
//   2. $LETTERTRACE_PROVIDER_KEY, for CI where a pipe is awkward
//   3. an interactive prompt with the terminal echo turned off
//
// Nothing here writes the value anywhere: not to stdout, not to a temp file,
// not into an error message. Errors describe the source, never the contents.

export const SECRET_ENV = "LETTERTRACE_PROVIDER_KEY";

/** A secret could not be obtained; the message is safe to print. */
export class SecretInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecretInputError";
  }
}

function readAllStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

/**
 * Prompt on a TTY with echo disabled. Nothing is rendered as the user types —
 * not even asterisks, which would put the key's length on screen and in a
 * screen-share recording for no benefit. Raw mode is always restored, including
 * on Ctrl-C, so an aborted prompt can't leave the terminal unusable.
 */
function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = Boolean(input.isRaw);
    let buffer = "";

    const cleanup = () => {
      input.removeListener("data", onData);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(buffer);
          return;
        }
        if (code === 3) {
          // Ctrl-C: the prompt owns raw mode, so the default SIGINT handling
          // never fires and we have to quit deliberately.
          cleanup();
          process.stderr.write("\n");
          reject(new SecretInputError("Aborted."));
          return;
        }
        if (code === 127 || ch === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        if (code < 32) continue; // drop arrow keys and other control sequences
        buffer += ch;
      }
    };

    process.stderr.write(label);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

/**
 * Obtain a secret. Precedence: an explicitly named --key-file, then the
 * environment variable, then piped stdin, then an interactive prompt. The
 * explicit flag wins over the environment so a stale exported variable can
 * never silently override what the user just asked for.
 */
export async function readSecret({ file, label } = {}) {
  if (typeof file === "string" && file.length > 0) {
    if (file === "-") {
      const piped = (await readAllStdin()).trim();
      if (!piped) throw new SecretInputError("No key arrived on stdin.");
      return piped;
    }
    let contents;
    try {
      contents = fs.readFileSync(file, "utf8");
    } catch (e) {
      throw new SecretInputError(`Could not read ${file}: ${e.code ?? e.message}`);
    }
    const trimmed = contents.trim();
    if (!trimmed) throw new SecretInputError(`${file} is empty.`);
    return trimmed;
  }

  const fromEnv = process.env[SECRET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();

  if (!process.stdin.isTTY) {
    const piped = (await readAllStdin()).trim();
    if (!piped) {
      throw new SecretInputError(
        `No key provided. Pipe it in, set $${SECRET_ENV}, or use --key-file <path>.`,
      );
    }
    return piped;
  }

  const typed = (await promptHidden(label ?? "Key (input hidden): ")).trim();
  if (!typed) throw new SecretInputError("No key entered.");
  return typed;
}

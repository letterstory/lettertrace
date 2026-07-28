// Tiny output helpers. Color is used only on a TTY and honors NO_COLOR; every
// command also supports --json for raw, scriptable output.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
};

export function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function ok(message) {
  process.stderr.write(`${c.green("✓")} ${message}\n`);
}

export function info(message) {
  process.stderr.write(`${message}\n`);
}

export function fail(message) {
  process.stderr.write(`${c.red("✗")} ${message}\n`);
}

const cell = (v) => (v === null || v === undefined ? "" : String(v));

/** Render an array of row objects as an aligned table over the given columns.
 *  columns: [{ key, label, map? }]. */
export function table(rows, columns) {
  if (!rows || rows.length === 0) {
    info(c.dim("(none)"));
    return;
  }
  const headers = columns.map((col) => col.label ?? col.key);
  const body = rows.map((row) =>
    columns.map((col) => cell(col.map ? col.map(row[col.key], row) : row[col.key])),
  );
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i].length)),
  );
  const line = (cells) => cells.map((v, i) => v.padEnd(widths[i])).join("  ");
  process.stdout.write(c.bold(line(headers)) + "\n");
  process.stdout.write(c.dim(line(widths.map((w) => "-".repeat(w)))) + "\n");
  for (const r of body) process.stdout.write(line(r) + "\n");
}

/** Render a flat object as aligned key: value lines. */
export function kv(obj) {
  const keys = Object.keys(obj);
  const w = Math.max(0, ...keys.map((k) => k.length));
  for (const k of keys) {
    process.stdout.write(`${c.dim(k.padEnd(w))}  ${cell(obj[k])}\n`);
  }
}

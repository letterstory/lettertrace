// Brand rendering for the CLI: the intro splash and the animated logo loader.
//
// Both emulate the Lettertrace mark: a 2x2 pinwheel of rounded petal clusters,
// three in mint with one terracotta accent (top-right), on a dark rounded tile
// (see /public/icon.png). The art degrades gracefully with the terminal's color
// support: truecolor draws the tile with the exact brand palette, 256/16-color
// approximate it, and a plain (no-color / piped) terminal gets a clean text
// header instead of muddy monochrome blocks. Colors render only on a TTY (so
// nothing leaks into a redirected or scripted stream) unless FORCE_COLOR asks
// for them, and NO_COLOR always wins. output.mjs shares this same detector so
// the splash and the help body below it never disagree on color.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- color support tiers -------------------------------------------------
// 0 = none, 1 = 16-color, 2 = 256-color, 3 = truecolor. Detected per stream so
// the splash (stdout) and loader (stderr) each pick the right depth. A non-TTY
// stream stays plain (no leak into a redirect or pipe) unless FORCE_COLOR is
// set; NO_COLOR and FORCE_COLOR=0 always disable.
function colorLevel(stream) {
  const noColor = process.env.NO_COLOR;
  if (noColor != null && noColor !== "") return 0;
  const forced = process.env.FORCE_COLOR;
  if (forced === "0" || forced === "false") return 0;
  const forcedLevel = forced === "3" ? 3 : forced === "2" ? 2 : forced === "1" || forced === "true" ? 1 : 0;
  const tty = Boolean(stream && stream.isTTY);
  if (!tty && !forcedLevel) return 0; // redirected/piped: plain unless forced
  if (forcedLevel) return forcedLevel;
  if (process.env.TERM === "dumb") return 0;
  const ct = (process.env.COLORTERM || "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return 3;
  if (/-256(color)?$/.test(process.env.TERM || "")) return 2;
  return 1;
}

// Shared with output.mjs so the whole CLI agrees on when color is on.
export function supportsColor(stream = process.stdout) {
  return colorLevel(stream) > 0;
}

// Each brand color carries a truecolor triple plus 256- and 16-color fallbacks.
const COL = {
  mint: { rgb: [130, 234, 209], x256: 158, x16: 36 },
  mintSoft: { rgb: [168, 240, 220], x256: 159, x16: 96 },
  terra: { rgb: [224, 120, 80], x256: 173, x16: 31 },
  terraSoft: { rgb: [240, 173, 144], x256: 217, x16: 91 },
  ink: { rgb: [244, 243, 239], x256: 255, x16: 97 },
  faint: { rgb: [138, 134, 125], x256: 244, x16: 90 },
  teal: { rgb: [116, 201, 183], x256: 116, x16: 36 },
  paper: { rgb: [19, 18, 17], x256: 233, x16: 30 },
};

function sgrFg(level, col) {
  if (!col) return "";
  if (level >= 3) return `38;2;${col.rgb[0]};${col.rgb[1]};${col.rgb[2]}`;
  if (level === 2) return `38;5;${col.x256}`;
  if (level === 1) return String(col.x16);
  return "";
}
function sgrBg(level, col) {
  if (!col) return "";
  if (level >= 3) return `48;2;${col.rgb[0]};${col.rgb[1]};${col.rgb[2]}`;
  if (level === 2) return `48;5;${col.x256}`;
  if (level === 1) return String(col.x16 + 10);
  return "";
}
const paint = (level, codes, s) => {
  const joined = codes.filter(Boolean).join(";");
  return joined ? `\x1b[${joined}m${s}\x1b[0m` : String(s);
};

// Render one character cell from a top pixel and a bottom pixel (each a color
// or null). Two stacked pixels share one text row via half-block glyphs.
function cell(level, top, bot) {
  if (!top && !bot) return " ";
  if (top && bot) return paint(level, [sgrFg(level, top), sgrBg(level, bot)], "▀");
  if (top) return paint(level, [sgrFg(level, top)], "▀");
  return paint(level, [sgrFg(level, bot)], "▄");
}

// --- the mark ------------------------------------------------------------
// A rounded 5x5 blob is one petal cluster; four of them tile 2x2 with a
// one-pixel gutter, so the whole mark is 11x11 pixels.
const BLOB = [
  [0, 1, 1, 1, 0],
  [1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1],
  [0, 1, 1, 1, 0],
];

// Paint the 11x11 cluster into `grid` at (oy,ox). Each quadrant gets a color
// pair (a lighter top tone for gloss, a deeper body tone); the top-right
// quadrant is the terracotta accent, the rest mint.
function stampCluster(grid, oy, ox) {
  const quads = [
    { dy: 0, dx: 0, top: COL.mintSoft, body: COL.mint }, // top-left
    { dy: 0, dx: 6, top: COL.terraSoft, body: COL.terra }, // top-right (accent)
    { dy: 6, dx: 0, top: COL.mintSoft, body: COL.mint }, // bottom-left
    { dy: 6, dx: 6, top: COL.mintSoft, body: COL.mint }, // bottom-right
  ];
  for (const q of quads) {
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        if (!BLOB[y][x]) continue;
        grid[oy + q.dy + y][ox + q.dx + x] = y < 2 ? q.top : q.body;
      }
    }
  }
}

// Build the rounded dark tile (truecolor / 256-color) with the cluster centered.
function tileGrid() {
  const padX = 3;
  const padY = 2;
  const w = 11 + padX * 2; // 17
  const h = 11 + padY * 2; // 15
  const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => COL.paper));
  // Round the corners by clearing a small triangle at each.
  const corners = [
    [0, 0], [0, 1], [1, 0],
    [0, w - 1], [0, w - 2], [1, w - 1],
    [h - 1, 0], [h - 2, 0], [h - 1, 1],
    [h - 1, w - 1], [h - 1, w - 2], [h - 2, w - 1],
  ];
  for (const [y, x] of corners) grid[y][x] = null;
  stampCluster(grid, padY, padX);
  return grid;
}

// The cluster alone, no tile (used at 16-color where a dark tile can't be
// distinguished from the terminal background).
function clusterGrid() {
  const grid = Array.from({ length: 11 }, () => Array.from({ length: 11 }, () => null));
  stampCluster(grid, 0, 0);
  return grid;
}

// Turn a pixel grid into text rows (two pixel rows per text row).
function renderGrid(level, grid, indent = 0) {
  const lines = [];
  const pad = " ".repeat(indent);
  for (let r = 0; r < grid.length; r += 2) {
    let line = pad;
    for (let x = 0; x < grid[r].length; x++) {
      const top = grid[r][x];
      const bot = grid[r + 1] ? grid[r + 1][x] : null;
      line += cell(level, top, bot);
    }
    lines.push(line);
  }
  return lines;
}

function version() {
  try {
    const pkgPath = fileURLToPath(new URL("./package.json", import.meta.url));
    return JSON.parse(readFileSync(pkgPath, "utf8")).version || "";
  } catch {
    return "";
  }
}

// --- intro splash --------------------------------------------------------
// Shown above the menu. Returns a multi-line string ending in a newline.
export function banner(stream = process.stdout) {
  const level = colorLevel(stream);
  const v = version();
  const tag = "Monitor how your brand shows up in AI answers.";

  if (level === 0) {
    // Plain, pipe-friendly header: no block art, no escape codes.
    const head = v ? `lettertrace v${v}` : "lettertrace";
    return `${head}\n${tag}\n`;
  }

  const grid = level >= 2 ? tileGrid() : clusterGrid();
  const indent = 2;
  const art = renderGrid(level, grid, indent);

  // Wordmark: "letter" in ink, "trace" in mint, with a terracotta petal dot.
  const dot = paint(level, [sgrFg(level, COL.terra)], "●");
  const word =
    paint(level, ["1", sgrFg(level, COL.ink)], "letter") +
    paint(level, ["1", sgrFg(level, COL.mint)], "trace");
  const meta = paint(level, [sgrFg(level, COL.faint)], `${v ? `v${v}  ·  ` : ""}OAuth · BYOK`);
  const tagline = paint(level, [sgrFg(level, COL.faint)], tag);
  const pad = " ".repeat(indent);

  return [
    "",
    ...art,
    "",
    `${pad}${dot}  ${word}   ${meta}`,
    `${pad}${tagline}`,
    "",
  ].join("\n") + "\n";
}

// --- animated logo loader ------------------------------------------------
// The mark, spinning: the terracotta accent travels around the four quadrants.
// Truecolor/256 draw the two-cell 2x2 mark; lower tiers use a single rotating
// quadrant block, so it still reads as a pinwheel with no color at all.
const MONO_FRAMES = ["▘", "▝", "▗", "▖"]; // one lit quadrant, clockwise

function colorFrames(level) {
  // Quadrant order clockwise from top-left: TL, TR, BR, BL.
  return [0, 1, 2, 3].map((accent) => {
    const q = [0, 1, 2, 3].map((i) => (i === accent ? COL.terra : COL.mint));
    const left = cell(level, q[0], q[3]); // top-left over bott-left
    const right = cell(level, q[1], q[2]); // top-right over bottom-right
    return left + right;
  });
}

// Registered so any exit path can restore a hidden cursor. Node's default
// disposition for SIGTERM/SIGHUP would kill the process without running our
// teardown, leaving the terminal cursor invisible; we hook those (plus SIGINT)
// and keep a synchronous "exit" fallback for every other path. Handlers are
// installed lazily on the first spinner, so non-spinner runs keep default
// signal behavior. All writes are guarded: an exit handler must never throw
// (e.g. on a closed pipe / EPIPE).
const activeCleanups = new Set();
let signalsHooked = false;
function ensureSignalCleanup() {
  if (signalsHooked) return;
  signalsHooked = true;
  const runAll = () => {
    for (const c of activeCleanups) {
      try {
        c();
      } catch {
        /* best-effort */
      }
    }
  };
  // 128 + signal number is the conventional exit code for a fatal signal.
  const onSignal = (signo) => () => {
    runAll();
    process.exit(128 + signo);
  };
  process.on("SIGINT", onSignal(2));
  process.on("SIGTERM", onSignal(15));
  process.on("SIGHUP", onSignal(1));
  process.on("exit", () => {
    if (activeCleanups.size === 0) return; // already cleaned up
    try {
      process.stderr.write("\r\x1b[K\x1b[?25h");
    } catch {
      /* stream may be closed */
    }
  });
}

export function createLoader(text, { stream = process.stderr, enabled = true } = {}) {
  const level = enabled ? colorLevel(stream) : 0;
  const animate = enabled && Boolean(stream.isTTY) && process.env.TERM !== "dumb";
  const frames = level >= 2 ? colorFrames(level) : MONO_FRAMES;
  let curText = text;
  let i = 0;
  let timer = null;
  let running = false;

  const draw = () => {
    stream.write(`\r${frames[i % frames.length]}  ${curText}\x1b[K`);
    i++;
  };
  const restore = () => {
    if (timer) clearInterval(timer);
    timer = null;
    running = false;
    try {
      stream.write("\r\x1b[K\x1b[?25h"); // clear line, show cursor
    } catch {
      /* stream may be closed */
    }
    activeCleanups.delete(restore);
  };

  return {
    start() {
      if (!animate) {
        // Non-interactive: announce the step once so logs still show it.
        if (enabled) stream.write(`•  ${curText}\n`);
        return this;
      }
      if (running) return this;
      running = true;
      ensureSignalCleanup();
      activeCleanups.add(restore);
      stream.write("\x1b[?25l"); // hide cursor
      draw();
      timer = setInterval(draw, 110);
      if (typeof timer.unref === "function") timer.unref();
      return this;
    },
    setText(t) {
      curText = t;
    },
    stop(finalLine) {
      if (running) restore();
      if (finalLine) stream.write(finalLine + "\n");
    },
  };
}

// Run `fn` with a spinner up, tearing it down whether it resolves or throws.
export async function withSpinner(text, fn, opts) {
  const loader = createLoader(text, opts).start();
  try {
    return await fn();
  } finally {
    loader.stop();
  }
}

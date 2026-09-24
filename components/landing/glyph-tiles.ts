// The Lettertrace mark, tile by tile, on a 256 grid (matches public/icon.png):
// four terracotta petals are quarter circles bowing out from the corners of
// the centre square; the mint centre is four quarter circles bowing in, which
// leaves the four-point star between them. Same grammar as the Phantomstory
// glyph: quarter circles around a star.
export type GlyphTile = { d: string; role: "petal" | "core" };

export const GLYPH_TILES: GlyphTile[] = [
  { role: "petal", d: "M78 78 L78 26 A52 52 0 0 0 26 78 Z" },
  { role: "petal", d: "M178 78 L230 78 A52 52 0 0 0 178 26 Z" },
  { role: "petal", d: "M178 178 L178 230 A52 52 0 0 0 230 178 Z" },
  { role: "petal", d: "M78 178 L26 178 A52 52 0 0 0 78 230 Z" },
  { role: "core", d: "M78 78 L128 78 A50 50 0 0 1 78 128 Z" },
  { role: "core", d: "M178 78 L178 128 A50 50 0 0 1 128 78 Z" },
  { role: "core", d: "M178 178 L128 178 A50 50 0 0 1 178 128 Z" },
  { role: "core", d: "M78 178 L78 128 A50 50 0 0 1 128 178 Z" },
];

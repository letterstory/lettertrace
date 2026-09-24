// Illustrative data for the landing page's charts (brand "Acme"), plus the
// geometry that turns a weekly series into a smooth SVG path. Nothing here is
// real customer data.

export const WEEKS = 12;

// Visibility by model: how often each assistant mentions the brand.
export const BY_MODEL = [
  { key: "claude", label: "Claude", color: "rgb(var(--c-terracotta))", values: [40, 42, 45, 44, 50, 53, 55, 58, 61, 63, 66, 70] },
  { key: "chatgpt", label: "ChatGPT", color: "rgb(var(--c-teal))", values: [28, 30, 29, 33, 35, 38, 37, 41, 44, 47, 50, 54] },
  { key: "gemini", label: "Gemini", color: "rgb(var(--c-butter))", values: [20, 21, 24, 23, 25, 27, 30, 29, 33, 35, 38, 41] },
];

// Share of voice against tracked competitors.
export const SHARE = [
  { key: "acme", label: "Acme (you)", color: "rgb(var(--c-terracotta))", values: [22, 23, 22, 26, 31, 33, 32, 36, 38, 39, 40, 41] },
  { key: "notion", label: "Notion", color: "rgb(var(--c-teal))", values: [38, 37, 39, 38, 35, 34, 35, 33, 31, 30, 29, 28] },
  { key: "linear", label: "Linear", color: "rgb(var(--c-sand))", values: [24, 25, 23, 22, 21, 21, 20, 20, 19, 19, 19, 19] },
  { key: "others", label: "Others", color: "rgb(var(--c-ink-faint))", values: [16, 15, 16, 14, 13, 12, 13, 11, 12, 12, 12, 12] },
];

// What moved the line, pinned to the week it happened.
export const EVENTS = [
  { week: 3, label: "Published a comparison page" },
  { week: 7, label: "Cited in a Claude answer roundup" },
  { week: 10, label: "Competitor launched v2" },
];

export type Box = { w: number; h: number; max: number; padX?: number; padY?: number };

export function point(i: number, v: number, n: number, b: Box) {
  const px = b.padX ?? 0;
  const py = b.padY ?? 0;
  const x = px + (i / (n - 1)) * (b.w - px * 2);
  const y = py + (1 - v / b.max) * (b.h - py * 2);
  return [x, y] as const;
}

// Catmull-Rom through the points, expressed as cubic Béziers.
export function smoothPath(values: number[], b: Box) {
  return smoothThrough(values.map((v, i) => point(i, v, values.length, b)));
}

export function smoothThrough(pts: readonly (readonly [number, number])[]) {
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

// The same line closed down to the baseline, for a soft area fill.
export function areaPath(values: number[], b: Box) {
  const [x0] = point(0, 0, values.length, b);
  const [x1] = point(values.length - 1, 0, values.length, b);
  const base = b.h - (b.padY ?? 0);
  return `${smoothPath(values, b)} L${x1.toFixed(1)} ${base} L${x0.toFixed(1)} ${base} Z`;
}

// Illustrative data for the landing page's charts (brand "Acme"), plus the
// geometry that turns a weekly series into a smooth SVG path. Nothing here is
// real customer data.

export const WEEKS = 12;

// Visibility by model: how often each assistant mentions the brand.
export const BY_MODEL = [
  { key: "claude", label: "Claude", color: "rgb(var(--c-chart-1))", values: [40, 42, 45, 44, 50, 53, 55, 58, 61, 63, 66, 70] },
  { key: "chatgpt", label: "ChatGPT", color: "rgb(var(--c-chart-2))", values: [28, 30, 29, 33, 35, 38, 37, 41, 44, 47, 50, 54] },
  { key: "gemini", label: "Gemini", color: "rgb(var(--c-chart-3))", values: [20, 21, 24, 23, 25, 27, 30, 29, 33, 35, 38, 41] },
];

// Share of voice against tracked competitors. Each week sums to 100, so it
// stacks as a part-to-whole; the brand sits on the baseline so its growth
// reads against a fixed edge.
export const SHARE = [
  { key: "acme", label: "Acme (you)", color: "rgb(var(--c-chart-1))", values: [22, 23, 22, 26, 31, 33, 32, 36, 38, 39, 40, 41] },
  { key: "notion", label: "Notion", color: "rgb(var(--c-chart-2))", values: [38, 37, 39, 38, 35, 34, 35, 33, 31, 30, 29, 28] },
  { key: "linear", label: "Linear", color: "rgb(var(--c-chart-3))", values: [24, 25, 23, 22, 21, 21, 20, 20, 19, 19, 19, 19] },
  { key: "others", label: "Others", color: "rgb(var(--c-chart-other))", values: [16, 15, 16, 14, 13, 12, 13, 11, 12, 12, 12, 12] },
];

// What moved the line, pinned to the week it happened.
export const EVENTS = [
  { week: 3, label: "Published a comparison page" },
  { week: 7, label: "Cited in a Claude answer roundup" },
  { week: 10, label: "Competitor launched v2" },
];

// padR defaults to padX; set it to leave room for end labels.
export type Box = { w: number; h: number; max: number; padX?: number; padR?: number; padY?: number };

export function point(i: number, v: number, n: number, b: Box) {
  const px = b.padX ?? 0;
  const pr = b.padR ?? px;
  const py = b.padY ?? 0;
  const x = px + (i / (n - 1)) * (b.w - px - pr);
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

// A closed band between two boundaries (lower is the previous band's top),
// smoothed the same way as the lines.
export function bandPath(upper: number[], lower: number[], b: Box) {
  const n = upper.length;
  const top = upper.map((v, i) => point(i, v, n, b));
  const bot = lower.map((v, i) => point(i, v, n, b)).reverse();
  const back = smoothThrough(bot).replace(/^M/, "L");
  return `${smoothThrough(top)} ${back} Z`;
}

// Running totals: stacked[k][i] is the top of series k at week i.
export function stack(series: { values: number[] }[]) {
  const out: number[][] = [];
  series.forEach((s, k) => out.push(s.values.map((v, i) => v + (k ? out[k - 1][i] : 0))));
  return out;
}

// The same band, pulled in by `gap` px on both edges so neighbouring bands
// separate into ribbons instead of touching.
export function ribbonPath(upper: number[], lower: number[], b: Box, gap: number) {
  const n = upper.length;
  const top = upper.map((v, i) => {
    const [x, y] = point(i, v, n, b);
    return [x, y + gap / 2] as const;
  });
  const bot = lower
    .map((v, i) => {
      const [x, y] = point(i, v, n, b);
      return [x, y - gap / 2] as const;
    })
    .reverse();
  return `${smoothThrough(top)} ${smoothThrough(bot).replace(/^M/, "L")} Z`;
}

// Just the upper edge of a ribbon, for its highlight line.
export function ribbonEdge(upper: number[], b: Box, gap: number) {
  const n = upper.length;
  return smoothThrough(upper.map((v, i) => {
    const [x, y] = point(i, v, n, b);
    return [x, y + gap / 2] as const;
  }));
}

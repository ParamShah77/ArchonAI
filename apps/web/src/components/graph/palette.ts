/**
 * Perceptual colour for the code map (decisions.md D-029). Colours are built in OKLCH so areas are equally
 * bright at the same chroma (no muddy olive or brown), nesting steps are even, and mixes stay in hue.
 */

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (x: number) => {
  x = clamp01(x);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};

export function hexToOklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => toLin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToHex(L: number, a: number, b: number): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb.map((x) => Math.round(toGamma(x) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function oklch(L: number, C: number, H: number): string {
  const h = (H * Math.PI) / 180;
  return oklabToHex(L, C * Math.cos(h), C * Math.sin(h));
}

export function hexToOklch(hex: string): [number, number, number] {
  const [L, a, b] = hexToOklab(hex);
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

/** Mix in OKLab (perceptually even, keeps hue). */
export function mixOklab(x: string, y: string, t: number): string {
  const a = hexToOklab(x);
  const b = hexToOklab(y);
  return oklabToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

/** WCAG contrast ratio of two opaque colours. */
export function contrast(x: string, y: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => toLin(parseInt(hex.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
}

// ---- tokens shared by canvas, key and tooltip ------------------------------------------------------------
export const MAP_BG = "#0f1218";
export const MAP_PANEL = "#151922";
export const MAP_INK = "#e6e9f0";
export const MAP_MUTED = "#a4adbe";

/** Area hue angles, cool first; warm hues come only after six cool ones (and are toned down). */
const AREA_HUES = [245, 150, 300, 195, 275, 15, 85, 55];
const NEUTRAL_H = 85;

export interface BoxPalette {
  tileTop: string;
  tileBottom: string;
  tileBorder: string;
  name: string; // name on a closed tile
  sub: string; // summary on a closed tile
  title: string; // title of an open box
  frame: string; // open surface
  frameBorder: string;
  band: string; // header strip of an open box
  bandLine: string;
  frameL: number; // lightness of the open surface (children's chips sit just above it)
}

/** Colours for a box of area `index` at nesting `depth`. The open-surface ramp stops at depth 2, so a closed
 *  tile always stands clearly above the surface it sits on. */
export function boxPalette(index: number, depth: number, neutral: boolean, test = false): BoxPalette {
  const H = neutral ? NEUTRAL_H : AREA_HUES[index % AREA_HUES.length];
  const warm = !neutral && H >= 30 && H <= 100;
  // chroma scale; test code is drawn at half chroma so it does not compete with product code
  const c = (neutral ? 0.25 : warm ? 0.7 : 1) * (test ? 0.5 : 1);
  const lift = warm ? 0.02 : 0;
  const d = Math.min(depth, 2);
  const frameL = 0.228 + 0.025 * d;
  const frameC = (0.012 + 0.004 * Math.min(depth, 4)) * c;
  return {
    tileTop: oklch(0.43 + lift, 0.05 * c, H),
    tileBottom: oklch(0.37 + lift, 0.045 * c, H),
    tileBorder: oklch(0.58 + lift, 0.065 * c, H),
    name: MAP_INK,
    sub: oklch(0.86, 0.02 * c, H),
    title: oklch(0.82, 0.08 * c, H),
    frame: oklch(frameL, frameC, H),
    frameBorder: oklch(frameL + 0.16, 0.05 * c, H),
    band: oklch(frameL + 0.02, frameC, H),
    bandLine: oklch(frameL + 0.05, frameC, H),
    frameL,
  };
}

export interface ChipPalette {
  fill: string;
  stroke: string;
  dot: string;
}

/** A symbol chip in its kind's hue, sitting just above the surface it is on. Private helpers are quieter. */
export function chipPalette(kindColor: string, surfaceL: number, priv: boolean, muted = false): ChipPalette {
  const [, C, H] = hexToOklch(kindColor);
  if (muted) {
    // dev-only or test-fixture package: an outline on the surface, no fill of its own
    return { fill: oklch(surfaceL + 0.01, 0.005, H), stroke: oklch(0.5, C * 0.4, H), dot: oklch(0.62, C * 0.5, H) };
  }
  return {
    fill: oklch(surfaceL + (priv ? 0.045 : 0.075), Math.min(C * 0.35, priv ? 0.025 : 0.04), H),
    stroke: oklch(priv ? 0.5 : 0.62, C * (priv ? 0.45 : 0.7), H),
    dot: kindColor,
  };
}

/** Health lens: findings per 1,000 lines, in five steps from a receding slate to a soft rose (chroma kept at
 *  or below 0.09 so the map never looks alarming). Bins follow the health score's bands. */
export const HEALTH_BINS = [2, 5, 8, 11]; // findings weight per KLOC: <2, 2-5, 5-8, 8-11, >=11
export const HEALTH_LABELS = ["clean", "minor", "some", "many", "needs attention"];
export const HEALTH_TILES: { top: string; bottom: string; border: string }[] = [
  [250, 0.012, 0.36],
  [75, 0.04, 0.41],
  [55, 0.06, 0.42],
  [30, 0.075, 0.43],
  [12, 0.09, 0.44],
].map(([H, C, L]) => ({ top: oklch(L + 0.03, C, H), bottom: oklch(L - 0.03, C * 0.9, H), border: oklch(L + 0.18, C * 1.1, H) }));

/** Lines of the focused item: what it uses, what uses it, both ways. */
export const FOCUS_OUT = "#f5d9a8";
export const FOCUS_IN = "#b9c3f5";
export const FOCUS_BOTH = "#efb8cf";

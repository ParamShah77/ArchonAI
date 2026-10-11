/**
 * Text fitting for the map canvas (decisions.md D-027). Widths are cached per font+text, so fitting
 * hundreds of labels per frame costs a few map lookups.
 */
const cache = new Map<string, number>();

export function measure(ctx: CanvasRenderingContext2D, text: string, font: string): number {
  const key = `${font}|${text}`;
  let w = cache.get(key);
  if (w === undefined) {
    ctx.font = font;
    w = ctx.measureText(text).width;
    if (cache.size > 8000) cache.clear();
    cache.set(key, w);
  }
  return w;
}

/** Longest prefix that fits, ending in "…" (never "name_…" or "path/…": separators are dropped first). */
export function fit(ctx: CanvasRenderingContext2D, text: string, font: string, max: number): string {
  if (max <= 0) return "";
  if (measure(ctx, text, font) <= max) return text;
  let lo = 0;
  let hi = text.length;
  const cut = (n: number) => `${text.slice(0, n).replace(/[\s._\-/:(]+$/, "")}…`;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(ctx, cut(mid), font) <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? cut(lo) : "";
}

const EXT = /\.(py|pyi|tsx?|jsx?|mjs|cjs|mts|cts|go|java|kt|rs|rb|php|cs|sql|md|json|ya?ml|toml|css|html)$/i;

/** Like fit(), but a file name keeps its extension and its ending: "RepoOv…ew.tsx", not "RepoOver…". */
export function fitSmart(ctx: CanvasRenderingContext2D, text: string, font: string, max: number): string {
  if (max <= 0) return "";
  if (measure(ctx, text, font) <= max) return text;
  // "chat/ChatPanel.tsx" (a folder merged into its only file): the file name matters more than the folder
  const slash = text.lastIndexOf("/");
  if (slash > 0 && slash < text.length - 1) {
    const last = `…/${text.slice(slash + 1)}`;
    if (measure(ctx, last, font) <= max) return last;
    text = text.slice(slash + 1);
  }
  const m = text.match(EXT);
  if (m) {
    const ext = m[0];
    const stem = text.slice(0, -ext.length);
    let lo = 3; // at least two characters of head + one of tail, or it is not worth it
    let hi = stem.length - 1;
    let best = "";
    while (lo <= hi) {
      const k = (lo + hi) >> 1;
      const head = Math.ceil(k * 0.6);
      const tail = k - head;
      const cand = `${stem.slice(0, head).replace(/[\s._\-/]+$/, "")}…${stem.slice(stem.length - tail)}${ext}`;
      if (measure(ctx, cand, font) <= max) {
        best = cand;
        lo = k + 1;
      } else hi = k - 1;
    }
    if (best) return best;
  }
  return fit(ctx, text, font, max);
}

const COMPACT: [RegExp, string][] = [
  [/ functions?$/, " fn"],
  [/ classes$| class$/, " cls"],
  [/ types?$/, " ty"],
  [/ folders?$/, " dirs"],
  [/ files?$/, " files"],
  [/ endpoints?$/, " api"],
  [/ tables?$/, " tbl"],
  [/ packages?$/, " pkg"],
];

/** Join summary parts with " · ", dropping whole parts from the end (never cutting a word) until it fits;
 *  falls back to compact forms ("12 fn · 2 cls"). Returns "" when not even one part fits. */
export function fitParts(ctx: CanvasRenderingContext2D, parts: string[], font: string, max: number): string {
  if (max <= 0 || !parts.length) return "";
  for (let n = parts.length; n >= 1; n--) {
    const s = parts.slice(0, n).join(" · ");
    if (measure(ctx, s, font) <= max) return s;
  }
  const compact = parts.map((p) => COMPACT.reduce((acc, [re, to]) => acc.replace(re, to), p));
  for (let n = compact.length; n >= 1; n--) {
    const s = compact.slice(0, n).join(" · ");
    if (measure(ctx, s, font) <= max) return s;
  }
  return "";
}

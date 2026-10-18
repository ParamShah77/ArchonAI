/**
 * Turn the files an answer cites into links that open them on the code map (decisions.md D-034).
 *
 * Models cite in several ways: `[path:12-30]` (what the prompt asks for), `path:12` in backticks, or just the file
 * name in the text ("text_palette.py – text_to_palette [290‑301]"). Every form that names a file the answer's
 * sources contain becomes a link: to the cited source's node when the lines match one, otherwise to the file.
 * Code blocks are left alone.
 */
import type { ChatSource } from "@/lib/api";

const DASH = "[-‑–—]"; // models use hyphen, non-breaking hyphen, en and em dashes
const BRACKET = new RegExp(`\\[([\\w./@-]+\\.\\w+):(\\d+)(?:\\s*${DASH}\\s*(\\d+))?\\](?!\\()`, "g");
const CODE_REF = new RegExp(`^([\\w./@-]+\\.\\w+)(?::(\\d+)(?:\\s*${DASH}\\s*(\\d+))?)?$`);

export function linkCitations(text: string, repoId: string, sources: ChatSource[]): string {
  if (!sources.length && !BRACKET.test(text)) return text;
  BRACKET.lastIndex = 0;
  // full paths, and file names that point at exactly one cited file
  const paths = new Set(sources.map((s) => s.path));
  const byBase = new Map<string, string | null>();
  for (const p of paths) {
    const base = p.split("/").pop()!;
    byBase.set(base, byBase.has(base) && byBase.get(base) !== p ? null : p);
  }
  const resolve = (name: string) => (paths.has(name) ? name : (byBase.get(name) ?? null));
  const href = (path: string, lo?: number, hi?: number) => {
    const at = sources.filter((s) => s.path === path && s.node_id);
    const hit = lo ? at.find((s) => s.start_line <= (hi ?? lo) && s.end_line >= lo) : undefined;
    return hit
      ? `/repos/${repoId}/map?focus=${hit.node_id}&node=${hit.node_id}`
      : `/repos/${repoId}/map?prefix=${encodeURIComponent(path)}`;
  };

  const linkProse = (seg: string) =>
    seg
      // [path:12-30]
      .replace(BRACKET, (all, name: string, a: string, b?: string) => {
        const path = resolve(name) ?? name;
        return `[${name}:${a}${b ? `-${b}` : ""}](${href(path, Number(a), b ? Number(b) : undefined)})`;
      })
      // a cited file named in the text (not inside a link we just made)
      .split(/(\[[^\]]*\]\([^)]*\))/)
      .map((part, i) =>
        i % 2
          ? part
          : part.replace(/(^|[\s(“"'])([\w./@-]+\.\w+)(?=$|[\s,.;:)”"'])/g, (all, pre: string, name: string) => {
              const path = resolve(name);
              return path ? `${pre}[${name}](${href(path)})` : all;
            }),
      )
      .join("");

  return text
    .split(/(```[\s\S]*?```)/)
    .map((block, i) =>
      i % 2
        ? block
        : block
            .split(/(`[^`\n]+`)/)
            .map((seg, j) => {
              if (j % 2 === 0) return linkProse(seg);
              const m = seg.slice(1, -1).match(CODE_REF);
              const path = m && resolve(m[1]);
              return path ? `[${seg}](${href(path, m[2] ? Number(m[2]) : undefined, m[3] ? Number(m[3]) : undefined)})` : seg;
            })
            .join(""),
    )
    .join("");
}

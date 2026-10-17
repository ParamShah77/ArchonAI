"use client";

/**
 * The Graph view's side panel (decisions.md D-032): what kinds of nodes and relationships the repository has,
 * how many of each, and which are shown. Click a chip to hide or show that kind; "*" shows everything.
 */
import { GRAPH_COLORS, GRAPH_KIND_LABEL, KIND_ORDER, relLabel } from "./forceData";
import { MAP_PANEL } from "./palette";

interface Props {
  kindCounts: Map<string, number>;
  relCounts: Map<string, number>;
  hiddenKinds: Set<string>;
  hiddenRels: Set<string>;
  onToggleKind: (kind: string | null) => void; // null = show all
  onToggleRel: (kind: string | null) => void;
  shown: { nodes: number; links: number };
  width: number;
}

export function GraphOverview({ kindCounts, relCounts, hiddenKinds, hiddenRels, onToggleKind, onToggleRel, shown, width }: Props) {
  const kinds = [...kindCounts.keys()].sort((a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99));
  const rels = [...relCounts.entries()].sort((a, b) => b[1] - a[1]);
  const totalNodes = [...kindCounts.values()].reduce((a, b) => a + b, 0);
  const totalRels = [...relCounts.values()].reduce((a, b) => a + b, 0);
  return (
    <aside className="absolute inset-y-0 right-0 z-10 border-l border-line overflow-y-auto text-xs" style={{ width, background: `${MAP_PANEL}f0` }}>
      <div className="px-4 pt-4 pb-3 border-b border-line">
        <div className="text-sm font-semibold text-fg">Overview</div>
        <div className="text-faint mt-0.5">Click a chip to hide or show it</div>
      </div>

      <section className="px-4 py-3">
        <div className="text-muted font-medium mb-2">Node labels</div>
        <div className="flex flex-wrap gap-1.5">
          <Chip label={`* (${totalNodes})`} color="#9aa3b5" off={false} onClick={() => onToggleKind(null)} title="Show every kind" />
          {kinds.map((k) => (
            <Chip
              key={k}
              label={`${GRAPH_KIND_LABEL[k] ?? k} (${kindCounts.get(k)})`}
              color={GRAPH_COLORS[k] ?? "#9aa3b5"}
              off={hiddenKinds.has(k)}
              onClick={() => onToggleKind(k)}
            />
          ))}
        </div>
      </section>

      <section className="px-4 py-3 border-t border-line">
        <div className="text-muted font-medium mb-2">Relationship types</div>
        <div className="flex flex-wrap gap-1.5">
          <Chip label={`* (${totalRels})`} color="#c3cad6" off={false} square onClick={() => onToggleRel(null)} title="Show every type" />
          {rels.map(([k, c]) => (
            <Chip key={k} label={`${relLabel(k)} (${c})`} color="#c3cad6" off={hiddenRels.has(k)} square onClick={() => onToggleRel(k)} />
          ))}
        </div>
      </section>

      <div className="px-4 py-3 border-t border-line text-muted">
        Displaying <span className="text-fg">{shown.nodes.toLocaleString()}</span> nodes,{" "}
        <span className="text-fg">{shown.links.toLocaleString()}</span> relationships.
      </div>
      <div className="px-4 pb-4 text-faint leading-relaxed">
        Zoom in to read more: names appear beside the main nodes, then inside every circle, then the type on every line.
        Drag a node to move it; double-click to fly to it.
      </div>
    </aside>
  );
}

function Chip({ label, color, off, onClick, square, title }: { label: string; color: string; off: boolean; onClick: () => void; square?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title ?? (off ? "Show" : "Hide")}
      aria-pressed={!off}
      className={`px-2 py-0.5 font-semibold transition-opacity ${square ? "rounded" : "rounded-full"} ${off ? "opacity-35 line-through" : "hover:brightness-110"}`}
      style={{ background: square ? "transparent" : color, color: square ? color : "#14171d", border: `1px solid ${color}` }}
    >
      {label}
    </button>
  );
}

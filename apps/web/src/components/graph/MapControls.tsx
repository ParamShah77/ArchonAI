"use client";

import { Maximize, Minus, Plus, Scan } from "lucide-react";
import type { MapController } from "./MapCanvas";

/** Zoom buttons in the map's corner (decisions.md D-029): + / − zoom about the centre with the same glide as
 *  the wheel, "Fit" fits the box you are in, "Fit all" shows the whole map. */
export function MapControls({ ctrl, right }: { ctrl: MapController | null; right: number }) {
  const btn = "h-8 w-8 grid place-items-center text-muted hover:text-fg hover:bg-[#1c212c] transition-colors";
  return (
    <div
      className="absolute bottom-3 z-10 flex flex-col overflow-hidden rounded-lg border border-line shadow-lg transition-[right] duration-200"
      style={{ right: right + 12, background: "#151922" }}
    >
      <button className={btn} title="Zoom in (+)" aria-label="Zoom in" onClick={() => ctrl?.zoomBy(1.5)}>
        <Plus size={15} />
      </button>
      <button className={`${btn} border-t border-line`} title="Zoom out (−)" aria-label="Zoom out" onClick={() => ctrl?.zoomBy(1 / 1.5)}>
        <Minus size={15} />
      </button>
      <button className={`${btn} border-t border-line`} title="Fit the box you are in" aria-label="Fit the current box" onClick={() => ctrl?.fitCurrent()}>
        <Scan size={14} />
      </button>
      <button className={`${btn} border-t border-line`} title="Fit all (0)" aria-label="Fit all" onClick={() => ctrl?.reset()}>
        <Maximize size={14} />
      </button>
    </div>
  );
}

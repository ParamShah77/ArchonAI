# Code Map: design review plan

8 review lenses → 85 proposals kept after skeptic checks (5 dropped) → merged into this plan → checked by a completeness critic.

## Why it doesn't feel right yet

1. The map can stop halfway between two states. Openness depends only on on-screen size (MapCanvas.tsx:137-146), so wherever a wheel zoom or fly-to stops, neighbouring boxes stay half-open. You see a see-through tile drawn over a second frame (frame at alpha t under the lines, :247; tile at 1-t over them, :251), with two different corner radii (:297 vs :331), a faded name, and child capsules whose names only appear from t=0.4 (:237, capsule at :414 vs text at :435). Examples: docs.py in 05, services in 07, tools in 10, AnalysisContext in 21_wheel_step1_rest. This is the biggest single cause of both 'not properly visible' and 'not smooth'.
2. Lines are drawn in the wrong place, so they say the wrong thing. They are drawn under opaque tiles and chips (pass 2 before pass 3, :249-252) and attach at tile borders across gutters of only 3-6 px (layoutCore.ts:41-42). They bend by the centre-to-centre distance rather than the visible length (:525), so short links become hooks, and two-way pairs overlap exactly. They run under unrelated tiles and chips and seem to start there (30, 32/33, 12), and they cross frame titles (06). Meanwhile lines into Packages are the strongest thing on the overview (01, 30; the `external` flag is dropped). Two backend resolution bugs also mean the whole frontend has zero file-to-file lines.
3. Text is not set as one system. Name size follows character count (:365), so equal neighbouring tiles get different sizes (07, 09). Open-folder titles are about 10 px above 22 px child names (:309). Titles are pinned to the box corner and slide off-screen ('sis', or '13 files · 13 classes' with no name). Summaries cut words in half and never show endpoints or tables (mapModel.ts:74). Methods repeat their class name ('DebtAnalyzer._…' seven times). Small items become 7-9 px text or anonymous dots.
4. The layout ignores relationships and the shape of the screen. Leaves are sorted by kind and then name, so private _helpers fill the top rows and almost every call arrow points up and crosses others (05). Rows are centred and ragged. Classes collapse into a single tall column (21_step1). Gaps and padding are fixed world units, and every chip carries a dead 18-unit label slot (54-unit pitch for a 24-unit chip).
5. Interaction is thin and sometimes stale. Hovering or selecting only thickens lines; every other chip stays fully bright (06). Hover replaces the selection (:244). Hover is never re-picked after a zoom. A double-click also selects, which opens a 380 px panel that shrinks the canvas and changes which boxes are open. Open boxes cannot be clicked (:612), and there is no keyboard control. Glide speed depends on the screen refresh rate, touchpad pinch is about 12.5x too slow, and every flight takes a fixed 850 ms and starts from d3's target instead of the drawn view, so it jumps.
6. Colour carries little meaning, and the key misleads. Colour only marks the top-level area, and it is assigned by area rank, so it can swap after a re-index. Each nesting level is only 1.046:1 lighter than its parent. The Packages box is olive. Dash styles are defined but never drawn. Folders, files and classes look the same. The legend's Folder and File swatches match nothing on screen, and the dev badge covers it. Caveat: the 20_*_mid and 22_fly_* snapshots are byte-identical to the rest frames (captured in a hidden tab), so every claim about motion rests on reading the code. Re-record in a visible tab before tuning any constants.

## Signature changes

- Every box lands clean and opens as one card (T2.1 + T2.2). About a quarter-second after you stop zooming, each box is either a named tile or a fully open box whose contents all show their names. Opening looks like one card dimming its lights while its name moves into the header and its named contents appear. Ghost boxes, blank pills and double outlines are gone.
- Lines you can trust (T1.1 + T2.3). Lines no longer form hooks in gutters. Two-way links show as a lens of two curves. Package lines become faint dotted threads. Wires between folders visibly plug into their two tiles, and no line runs under an unrelated tile and seems to start there. Highlighted lines are always continuous and on top, and no line ever strikes through a name.
- Point at something, see its world (T1.5 + T2.4 + T2.5). Resting on a node softly veils the rest of the map. Its neighbours stay bright and named, with pale amber for 'uses' and periwinkle for 'used by'. The selection stays lit while you hover elsewhere, the highlight always matches what is under the cursor, and the details panel slides over the map without shrinking it or changing what is open.
- A calm, typeset look (T1.2, T1.3, T1.7, T1.9 + T2.7, T2.8). Areas get equally bright soft OKLCH colours that never swap. Each nesting level is a slightly lighter card with a faint header strip. Equal tiles get equal name sizes, and titles stick to the visible edge. Method names are short, summaries are honest, and the legend explains exactly what is on screen.
- Files read like a call tree (T1.6 + T2.9). Boxes are shaped to the screen instead of tall single columns. Inside a file, public entry functions sit on top and their helpers below, so lines flow downward with far fewer crossings, and folders have room to show the wires between them.

## Tier 1 - Quick wins

_Small, safe renderer, model and layout fixes that one session can ship. They remove the most visible defects (broken line geometry, names that vanish or get crossed, repeated method names, a camera that feels different on each screen, a highlight that goes stale, misleading summaries, stray dots, unstable colours, a key that lies) without changing the approved semantic-zoom direction._

### T1.1 Fix line geometry and quiet the package lines  (effort S, impact 4)

**What you'll see:** Lines between neighbouring boxes no longer loop into hooks and U-shapes in the gaps. A two-way relationship shows as two gently separated curves, not one line with two arrowheads. Arrowheads appear only where there is room for them. Lines into the Packages box become faint dotted threads, so on the home view the line that matters (tests -> archon) is the clearest thing on screen. Lines between folders and files use one calm grey-blue 'depends on' colour. Colours and dash patterns (dashed = extends, dotted = implements, short dash = exposes/queries) appear where lines connect individual functions and classes.

**How:** MapCanvas.tsx drawEdges (:511-560).

Geometry, after clip():
- seg = hypot(q-p); skip if seg < 2.
- u = (q-p)/seg; bend = seg < 30 ? 0 : min(40, seg*0.15).
- Use a constant +1 bend sign. The perpendicular (-u.y, u.x) already flips with direction, so A->B and B->A bow to opposite sides. Today `m.a<m.b?1:-1` at :525 cancels that flip and the two curves overlap exactly.
- Control point = midpoint + perpendicular * bend.
- Draw an arrowhead only when inB && seg > 32; size min(4 + 1.5*width, seg*0.25); angle from the control point.

Package lines:
- Add `external?: boolean` to MapEdge (mapModel.ts:29-33). The runtime objects already carry it (viewModel.ts:147).
- Count m.ext in the merge loop (:483-495).
- When m.ext === m.n and the pair is not touched: setLineDash([1.5,5]), alpha *= 0.35, width = min(width, 1.5), no arrowhead.

Colour:
- When both stand-ins are boxes, use DEPENDS = '#a9b3c4'. The majority kind flips arbitrarily: 30 of the 32 archon folder pairs mix calls and imports.
- Otherwise use the EDGE_STYLE kind colour.

Dashes:
- Add `dash: number[]` to EDGE_STYLE (lib/api.ts:360-369): extends [6,4], implements [1.5,3.5], exposes [2,4], queries [3,3], everything else [].
- Apply ctx.setLineDash(dash.map(d => d*max(1, width*0.8))) only when alpha >= 0.15 or the line is touched.
- setLineDash([]) before each arrowhead and after the loop.

Add a decisions.md entry restoring D-023's quiet external-line rule, and a flow.md changelog entry.

**Files:** apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/mapModel.ts, apps/web/src/lib/api.ts, decisions.md, flow.md

### T1.2 Names always on top and in view  (effort S, impact 4)

**What you'll see:** A box's name is never crossed by a line and never slides off the screen. When a folder's left edge is off-screen, its title moves to the visible left edge. A partly visible tile keeps its name centred on the part you can see. The counts are dropped before they collide with a name, so you never see '13 files · 13 classes' without knowing what it belongs to. Name tags under small tiles no longer overlap.

**How:** MapCanvas.tsx.

(1) Labels queue: replace S.pills (:106, :253) with S.labels: {rect, prio, draw}[], drawn after chips and before halos.

(2) drawFrame (:305-325): keep fill and stroke; push the title and summary into S.labels.
- visL = max(sx, 0) + 12; visR = min(sx+sw, s.w) - 12.
- Title x = max(sx+12, min(visL, visR - titleW)). Fit the title to 0.6*(visR - visL).
- Draw the summary right-aligned at visR only if titleW + sumW + 24 <= visR - visL. Otherwise omit it; never truncate both.
- The header band lies above the children (layoutCore.ts:117-118), so drawing it late only lifts it above lines.

(3) drawTile text (:360-384) becomes a label.
- vr = intersect(tile, [8, 8, w-16, h-16]).
- If vr.w >= 60, centre the name and summary on vr and fit them to vr.w - 16; otherwise push a pill.

(4) drawPill (:387-399): set textAlign = 'center' and textBaseline = 'middle'. This fixes a latent bug: drawChip leaves textAlign = 'left', and pills are drawn after chips.

(5) Pills: sort by tile area, largest first. Accept a pill only if its rect does not intersect an accepted label (O(n²), fewer than 100 items). A skipped name stays reachable through the tooltip (T1.5).

No vertical sticky headers; the breadcrumb already shows depth.

**Files:** apps/web/src/components/graph/MapCanvas.tsx

### T1.3 Short method names, clean truncation, one less click into single-file folders  (effort S, impact 4)

**What you'll see:** Inside the DebtAnalyzer box, chips read '_class_rules' and '_cycles' instead of 'DebtAnalyzer._class_rules' seven times. Method chips become about half as wide, so classes show 2-3 columns instead of a tall strip. Cut-off names keep their ending ('RepoOv…ew.tsx', never 'Markdown.…'). A folder that holds only one file, such as src/components/chat, collapses into a single 'chat/ChatPanel.tsx' tile.

**How:** Labels:
- viewModel.ts:52-55 labelOf: for kind === 'method' whose view parent is its class box, return n.name.
- Keep the qualified name in a new `fullLabel` on ViewNode and MapNode (mapModel.ts) and show it in the canvas tooltip (MapCanvas.tsx:891). Search and NodePanel already add the class prefix themselves.
- The footprint (viewModel.ts:173-181) uses the short label. viewKey hashes w, so cached layouts refresh.

Truncation: add fitSmart() next to fit() (MapCanvas.tsx:161-171). Steps:
- try the full text;
- strip trailing [._\-/] before '…';
- for names ending in .py/.ts/.tsx/.js/.jsx/.mjs, use a middle ellipsis that keeps the extension (roughly 60/40 split).
Use it for tile names, frame titles, pills and chips only. Summaries use T1.7's part dropping.

Single-file folders: in the compaction loop (viewModel.ts:111-134), add a branch that dissolves a directory whose only child is a single file.
- Re-parent the file to its grandparent with labelOverride `${dirLabel}/${fileName}`.
- The file keeps its id, so ?node= and selection still work.
- Directories carry only contains edges (builder.py:105-117), so no relationship is lost.

Skip the '__init__' -> 'constructor' rename.

**Files:** apps/web/src/components/graph/viewModel.ts, apps/web/src/components/graph/mapModel.ts, apps/web/src/components/graph/MapCanvas.tsx

### T1.4 A camera that feels native: even glide, zoom toward the cursor, real pinch, flights that start at once  (effort S, impact 4)

**What you'll see:** Each wheel notch is a soft swell toward exactly what is under the cursor, and it feels the same on a 60 Hz and a 144 Hz screen. Touchpad pinch works at normal speed. Getting from the overview to function names takes about 15 notches instead of about 24. Double-click, breadcrumb and search flights start moving at once, with no jump even mid-scroll. Short hops are quick and long trips are unhurried. With Windows 'reduce animations' on, the map jumps and cross-fades instead of sweeping.

**How:** MapCanvas.tsx.

(1) Time-based glide: add S.lastT; dt = min(50, now - lastT); a = 1 - exp(-dt/65). This replaces GLIDE (:47, :199).

(2) Zoom toward the cursor:
- In the zoom handler (:760-768), set S.anchor = d3 pointer(e.sourceEvent, canvas) for wheel events, otherwise the canvas centre.
- Replace :202-213 with: Wv = (anchor - v.xy)/v.k; Wt = (anchor - T.xy)/T.k; W = Wv + (Wt - Wv)*a; ease k in log space; v.xy = anchor - W*nk.

(3) wheelDelta (:758) = clamp(-deltaY * (mode==1 ? 0.05 : mode ? 1 : 0.0025) * (ctrlKey ? 8 : 1), -0.5, 0.5).
- That gives ×1.19 per notch and native pinch speed; d3's default includes the ctrl factor (zoom.js:35).
- The clamp stops Ctrl+wheel making 4× jumps.

(4) fly() (:633-652):
- First call s.zoom.transform(sel, zoomIdentity.translate(v.x, v.y).scale(v.k)) so the flight starts from the drawn view.
- duration = clamp(0.6 * interpolateZoom([cx0,cy0,w/k0], [cx1,cy1,w/k1]).duration, 400, 1100).
- Ease with a 12-line cubicBezier(0.25, 0.1, 0.25, 1).
- Skip the flight when the target is within 4 px and 2% of k.
- Add d3-interpolate and @types/d3-interpolate to package.json explicitly.

(5) Set S.reduced from matchMedia('(prefers-reduced-motion: reduce)') and listen for changes. When reduced: a = 1 and fly jumps.

(6) Cursor 'grabbing' between d3 'start' and 'end'. A canvas mousedown listener never fires, because d3 stops propagation (zoom.js:280).

Retune OPEN_* only after recording in a visible tab.

**Files:** apps/web/src/components/graph/MapCanvas.tsx, apps/web/package.json, decisions.md, flow.md

### T1.5 Hover and selection that tell the truth  (effort S, impact 4)

**What you'll see:** After a zoom with the mouse held still, the highlight follows what is actually under the cursor; there is no glowing ring around a box you have already entered. The selected item keeps its lines lit while you hover something else. A function picked from search lights its lines even while its file is still a closed tile. Flying into a file no longer leaves its call lines greyed out. The selected item gets the app's blue ring; the hovered one gets a quiet ring. Double-click only flies; it no longer also pops open the 380 px panel and shrinks the map. Tiles whose name is cut short or shown as a tag get a tooltip, and tooltips never trail behind a drag.

**How:** MapCanvas.tsx.

(1) Live hover: store S.ptr in onMove. At the end of renderFrame (when the view changed) and on d3 'end', re-run pick(S.ptr) and update hover. Call setTip only when the id changes. Hide the tip while the camera moves.

(2) Focus = {selected (sticky), hover (transient)}.
- When either changes, precompute its subtree Set by walking children.
- In the merge loop (:483-495), mark m.touchSel / m.touchHov when some edge has exactly one end inside that subtree.
- A pair is touched if either flag is set. Hover-only touched lines use 0.75× the selected strength.

(3) If the focus is an open box (t >= 0.5), do not dim lines with both ends inside it. drawHalo (:569-583) draws a quiet 1 px #5aa9ff outline for it instead of a glow.

(4) Rings, replacing :256-257: selected = 2 px #5aa9ff (the app --accent) plus a 10 px glow; hover = 1.5 px #c9d3e3 at 0.7 with no glow.

(5) onClick (:797-802): defer the selection by 220 ms and cancel it in onDbl, so a double-click only flies.

(6) Tooltip (:886): also show it for boxes whose name was truncated or drawn as a pill (flag set in drawTile).

(7) GraphExplorer.tsx:36-46: sync ?node= with window.history.replaceState instead of router.replace, so a click no longer triggers an RSC request (Next 16 docs, linking-and-navigating.md:345-414).

**Files:** apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/GraphExplorer.tsx

### T1.6 Boxes shaped for the screen  (effort S, impact 4)

**What you'll see:** Opening a folder or class fills the screen side to side instead of showing a tall narrow column with empty margins, and no class is a single column of methods. Chip rows sit closer together, with no empty band under every chip. The overview looks the same on every load, also for repositories with more than 12 top-level blocks.

**How:** layoutCore.ts pack() (:85-101).

Aspect search:
- Move the shelf pass into shelf(kids, target, gx, gy) -> {w, h, rows}.
- Try targets W_i = max(maxChildW, sqrt(area * 0.4 * 1.15^i)) for i = 0..23.
- Score each as |ln((W/H)/1.55)| + 0.8*(1 - fill), measured on the final box including header and padding.
- Reject a one-column result for 4 or more leaves when a 2-or-more-column result scores within 0.15.
- TARGET_ASPECT 1.55 is the geometric mean of the panel-open (1.34) and full (1.86) canvas shapes.

Roots:
- Use the same search for the roots, and delete placeRoot's fCoSE branch and separateRigid (:159-209).
- Remove cytoscape, cytoscape-fcose, @types/cytoscape and src/types/cytoscape-fcose.d.ts (about 424 KB off the worker).

Dead label slot:
- Leaf footprint h 44 -> 30 (viewModel.ts:20, :182).
- emit() outputs the chip centre (layoutCore.ts:215).
- drawChip and anchor drop their +9 (MapCanvas.tsx:407, :451) in the same commit; pick and drawHalo follow through anchor.

Also fix the stale GraphCanvas comment (:40). Add a decision entry superseding the packing and root-placement parts of D-023/D-026.

**Files:** apps/web/src/components/graph/layoutCore.ts, apps/web/src/components/graph/viewModel.ts, apps/web/src/components/graph/MapCanvas.tsx, apps/web/package.json, apps/web/src/types/cytoscape-fcose.d.ts, decisions.md

### T1.7 Honest one-line summaries  (effort S, impact 3)

**What you'll see:** Tiles say what matters: 'routes/analysis.py · 10 endpoints · 12 functions', 'db/models.py · 11 tables · 12 classes', 'src/lib · 2 files · 26 types' instead of '29 classes'. Words are never cut off; a whole part is dropped instead ('1 class · 3 functio…' disappears). The packages box reads 'Packages · 24 packages' instead of 'Packages (24) / 24 packages'. Frame summaries are at least 11 px.

**How:** Types:
- viewModel.ts (:170-188): add isType = meta.interface === true. javascript.py:180 stores TS interfaces as CLASS.
- Carry isType to MapNode.

mapModel.ts summarize (:53-77): return parts[] ranked by how informative they are, and drop `.slice(0,2)`.
- Boxes containing folders/files: folders, files, then endpoints and tables when non-zero.
- File and class boxes: endpoints, tables, then classes/types/functions by count.

MapCanvas:
- New fitParts(parts, maxW) joins parts with ' · ' and drops whole parts from the right until the line fits, falling back to compact forms ('3 fn').
- Use it in drawTile (:376-379) and drawFrame (:319-324).
- Frame summary font: Math.max(9, …) -> 11 (:320).

Packages: viewModel.ts:191 label 'Packages'; note the change against D-026.

Lines of code go into the tooltip and panel, not onto the tile.

**Files:** apps/web/src/components/graph/viewModel.ts, apps/web/src/components/graph/mapModel.ts, apps/web/src/components/graph/MapCanvas.tsx

### T1.8 No anonymous specks, no fine print  (effort S, impact 3)

**What you'll see:** A far-away function shrinks to a small coloured dot exactly where its name's dot will be, then grows smoothly into a labelled pill. You never see an empty capsule or 7-9 px text. Loose config files (eslint.config.mjs, next.config.ts…) gather into one 'Other files (3)' tile instead of three floating dots with lines, and the portfolio's two root-level dots become a 'Root files' tile. Empty marker files (an __init__.py with no code and no links) fade to half strength.

**How:** MapCanvas.tsx drawChip (:402-444):
- ca = smooth(19, 23, ch).
- Dot alpha = (1 - ca)*0.7, drawn at the capsule's kind-dot position (x + ch*0.5, radius max(1.5, ch*0.17)) instead of the centre (:418).
- Capsule, kind dot and label all use alpha·ca, one alpha, so a capsule is never blank.
- Label size clamp(ch*0.5, 10, 13), so text never goes below 10 px.
- anchor and pick use dot radius + 4 px for leaves drawn as dots, not the invisible capsule.

viewModel.ts (after the edges step):
- In every box that has sub-boxes, and at the root, move symbol-less file leaves into a synthetic `__files__:<parentId|root>` box labelled 'Other files (n)' or 'Root files (n)'.
- Push it the same way PACKAGES_ID is pushed (:189-192); isSynthetic already covers the '__' prefix.
- Files with no symbols and no non-contains edges draw at 50% alpha. Hide them only after T3.1 fixes the __init__ import bug.

**Files:** apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/viewModel.ts

### T1.9 Stable colours, a neutral Packages box, and a legend that matches the map  (effort S, impact 3)

**What you'll see:** Each top-level area keeps its colour; a re-index or a layout change never swaps blue and green. Packages becomes a quiet neutral box with a dashed border that clearly reads as external, not an olive code block. The key under the map explains what you actually see: one swatch per area with its name, the symbol kinds on screen, and line samples (grey = folder/file dependency, dotted = packages, green = calls, dashed = extends…). The Next.js 'N' dev badge no longer covers it, and the toolbar button reads 'Fit all', so there are no longer two 'Overview' labels.

**How:** Hues: mapModel.ts:110-121 ranks roots by descendant file count (ties broken by path), excluding kind === 'group'. Today the area rank swaps colours when sizes change, and the group wastes a slot.

Packages root:
- Neutral surface: top #3b3a36, bottom #302f2c, border #6f6d66 drawn with setLineDash([4,3]) in drawTile/drawFrame when n.kind === 'group'.
- Package chips keep their sand dot.

Key:
- MapCanvas gets a new prop onKey({areas: {label, top, bot}[], chipKinds, edgeKinds, hasExternal}), emitted once per model build (:851-881), not per frame.
- GraphExplorer.tsx:135-147 replaces LEGEND (:13) with three compact rows: Areas, Symbols, Lines. Line samples are inline SVG with strokeDasharray from EDGE_STYLE.dash.
- The key collapses, with the state in localStorage (try/catch).

Toolbar and breadcrumb:
- Rename the button at :78-80 to 'Fit all'.
- Add a root crumb (repo name -> Fit all); show the last crumb in text-fg.
- Cut the hint to one line.

next.config.ts: devIndicators: false. Read node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/devIndicators.md first; compile errors still show.

**Files:** apps/web/src/components/graph/mapModel.ts, apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/GraphExplorer.tsx, apps/web/next.config.ts

### T1.10 Self-healing canvas  (effort S, impact 2)

**What you'll see:** After the laptop sleeps, after a GPU hiccup, or when you switch back to the tab, the map redraws by itself instead of staying blank until you move the mouse. An old 'drawing failed' chip disappears as soon as drawing works again.

**How:** MapCanvas.tsx setup effect (:740-848):
- canvas 'contextrestored' -> requestDraw().
- document 'visibilitychange' -> when visible, fitCanvas() + requestDraw(). ResizeObserver is silent while the tab is hidden (:696).
- Remove both listeners in the cleanup.

draw() (:174-186): after a successful renderFrame, if s.drawError is set, clear it and call setLayout({state: 'idle'}).

place() retry (:862-868): after 20 attempts show 'waiting for the map area…' and keep retrying.

**Files:** apps/web/src/components/graph/MapCanvas.tsx


## Tier 2 - Core upgrades

_Set the new look and feel. Boxes land clean and open as one card. Lines are drawn above the right things. Focus + context replaces flat highlighting. The panel no longer disturbs the map, and the map gets real actions. Colour and type are designed as a system. Files read top to bottom, and symbols gain detail at deep zoom._

### T2.1 Land clean: no half-open boxes at rest  (effort M, impact 5)

**What you'll see:** Zooming still cross-fades continuously. About a quarter-second after you stop, every box on screen is either a named tile or a fully open box whose contents all carry names. The ghost of docs.py next to reasoning.py, the faded 'services' and 'tools', and 'AnalysisContext' printed over blank pills are gone. Panning never makes boxes pulse.

**How:** MapCanvas.tsx. Add S.anim: Map<id, {t, open, seen}>, S.lastScaleAt and a debounced settle timer.

Zoom handler (:760-768):
- If |log e.transform.k - log s.target.k| > 1e-3, set lastScaleAt = now. Pure pans do not count.
- Schedule setTimeout(requestDraw, 200) to wake the frame loop, which otherwise stops at :260.

In visit() (:231-238):
- raw = openness(); m = gate * max(area/0.39, span/0.78).
- Open state with hysteresis on m: opens at m >= 1.08, closes at m <= 0.85 (about ×1.13 zoom, more than one wheel notch). Initial state: raw >= 0.5.
- scaling = now - lastScaleAt < 180 || |log v.k - log target.k| > 1e-3. Flights count as scaling.
- While scaling, shown = raw. When scaling resumes from a snapped value, ease back to raw over 120 ms.
- At rest, shown += (target - shown)*(1 - exp(-dt/85)).
- A box first seen this frame starts at its target. Hidden tabs set shown = target.
- Write shown into NodeState.t, so visit, standIns (:471), pick (:612), updateCrumbs (:592) and drawHalo (:571) all agree.

Frame loop:
- settled = camera settled && every |shown - target| < 0.004.
- Prune entries not seen for 2 s; clear the map on a model rebuild (:851).

Add a decision entry amending D-026: 'size-driven while scaling, snapped at rest'.

Verify with a visible-tab screen recording, plus an __archon check that no on-screen box has 0.05 < t < 0.95 one second after input stops.

**Files:** apps/web/src/components/graph/MapCanvas.tsx, decisions.md, flow.md

### T2.2 One card that opens, with named contents  (effort M, impact 5)

**What you'll see:** Zooming into a folder looks like one card dimming its lights. Its name hands off from the middle of the tile to the header, and its contents appear with their names already on them. There is no see-through double image, no pair of different corner shapes, no second outline and no sudden darkening.

**How:** MapCanvas.tsx.

(1) One radius: boxRadius(sw, sh) = min(14, max(4, min(sw, sh)*0.06)), used by drawFrame (:297), drawTile (:331) and drawHalo (:574).

(2) One surface:
- Pass 1 draws the frame fill opaque at alpha `da` whenever t > 0.005 (not da·t).
- Pass 3 draws the tile body over it at da·(1-e), with e = smooth(0.15, 0.7, t).
- The composite is a lerp from tile to frame, so the background never shows through (today about 25% of the background shows at t = 0.5).
- Shadow and glass edge are multiplied by (1-e).
- Stroke a single border in pass 3, with colour and alpha lerped from the tile border (0.7) to the frame border (0.32) by e.

(3) Separate drawing alpha from edge weights:
- Keep vis = parentVis·t for edge weights (the standIns sum-to-one rule, :464-471) and for picking.
- Add da = parentDa·smooth(0.25, 0.65, t) on NodeState. Use it for the body and the text of child tiles, frames and chips, replacing tvis. drawChip uses one alpha for capsule, dot and label (:414, :435).

(4) Name hand-off:
- Tile centred name alpha = da·(1 - smooth(0, 0.3, t)).
- Frame title alpha = da·smooth(0.05, 0.3, t), drawn in T1.2's late label pass.
- For a short range the name shows both in the centre (fading) and in the header (appearing).

(5) Lines between the box's children (pass 2) lie under its fading tile body, so they fade in instead of popping.

Add a decision entry updating D-026's text stagger.

**Files:** apps/web/src/components/graph/MapCanvas.tsx, decisions.md, flow.md

### T2.3 Lines you can trust: drawn over the right things, never misleading  (effort M, impact 5)

**What you'll see:** Inside an open folder you see about 10 clean wires between subfolders (ingest -> graph and api -> analysis thick, minor links thin) that visibly plug into their two tiles, instead of 3 px stubs in the gaps. A line never runs under an unrelated tile or chip and seems to start there (as sampleAt -> windowFor and tools -> src do today in the portfolio). Highlighted lines are continuous and on top, yet never strike through a name. While panning, lines fade at the screen edge instead of blinking out.

**How:** MapCanvas.tsx.

Pass split:
- Split drawTile into drawTileBody/drawTileText and drawChip into drawChipBody/drawChipText; the text parts go to S.labels.
- renderFrame order: frames -> quiet edges -> tile bodies -> chip bodies -> socket over-pass -> touched edges (BG casing at width+2 and alpha 0.6, then the coloured line with glow and 8 px arrowheads) -> labels -> halos.
- drawEdges writes curves {p, c, q, alpha, width, colour, dash, endIds, touched} into S.curves instead of stroking touched ones itself.

Sockets:
- For box ends, anchor d = min(28, 0.18·min(sw, sh)) inside the tile along the ray, not at the border (:511-512).
- Over-pass: for each box<->box curve, save(); clip to each endpoint tile's roundRect; re-stroke at the same alpha; restore(). Then a 2.5 px source dot and the arrowhead.

Occlusion:
- Build a per-frame 64 px grid of drawn closed-tile and chip-body rects.
- Sample each quiet curve at 8 points (t from 0.1 to 0.9), ignoring the two endpoints and their ancestors and descendants.
- On a hit, retry with the opposite bend, then with 2× bend. If it still hits, skip the line at rest; it still appears when touched.

Budget: sort unfocused box<->box pairs by m.w. Ranks 1-10 at full alpha, ranks 11-18 taper to 0, the rest appear only on focus.

Screen edge: replace inA/inB (:504-506, :517) with f = 1 - smooth(0, 120, outsidePx) per end, and alpha *= fA·fB for unfocused lines.

Cost: a few hundred extra strokes and grid tests, under 1 ms. Add a decision entry superseding D-024's 'lines pass behind tiles'.

**Files:** apps/web/src/components/graph/MapCanvas.tsx, decisions.md, flow.md

### T2.4 Point at something, see its world (focus + context)  (effort M, impact 5)

**What you'll see:** Resting the mouse on plan_feature softly veils the rest of the file. Its 4 callees and 2 callers stay bright and named. Lines to what it uses are pale amber and lines from what uses it are pale periwinkle, so 'what does it use, and who uses it?' takes one glance. Sweeping the mouse across the map does not flicker. Clicking makes the focus sticky and a little stronger, and one short glint travels along each lit line to show its direction.

**How:** MapCanvas.tsx, building on T1.5's focus sets and T2.3's pass split.

Timing:
- Hover focus engages after 100 ms of rest on the same id (setTimeout in onMove) and lingers 150 ms after the pointer leaves. Selection is immediate.
- S.emph eases by time (in: τ 60 ms, out: τ 110 ms).
- A per-id litWeight Map eases toward 0 or 1, so moving from chip to chip cross-fades with no dip.

Veil pass, after labels:
- fillRect the viewport with BG at alpha emph·0.35 (hover) or emph·0.5 (selection).
- Then redraw on top: the focus, its ancestors' frame titles, and the lit neighbour stand-ins (body and text at their normal level-of-detail alpha × litWeight; those alphas are never modified).
- Then the touched lines, then the halos.

Direction colours, on touched lines only: outgoing ('uses') #f5d9a8, incoming ('used by') #b9c3f5, both ways #efb8cf. The kind stays visible as the dash pattern.

Neighbours drawn as dots or pill-sized tiles get a name pill through S.labels (at most 12, by weight).

On a new selection, run one 600 ms glint (a 2.5 px dot along the quadratic) per lit line. It never loops and is skipped under reduced motion.

Request frames only while something is easing. The legend adds 'amber = uses · periwinkle = used by' while focused.

Log the decision and the new pass order in flow.md.

**Files:** apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/GraphExplorer.tsx, decisions.md, flow.md

### T2.5 Details panel slides over the map  (effort M, impact 4)

**What you'll see:** Clicking a node slides the details panel in from the right, over the map. The map does not shrink or jump, and nothing opens or closes just because you clicked. If the node would end up under the panel, the camera glides it into view.

**How:** GraphExplorer.tsx:
- Render NodePanel inside the map's relative container (:126) as absolute inset-y-0 right-0 w-[380px] z-20, with an opaque bg-elev and a left shadow (no backdrop-blur).
- Slide it in with translateX over 220 ms and out over 180 ms, keeping the last id mounted during the exit. Esc closes it.

MapCanvas.tsx:
- New prop occlusion {right: number}. transformFor (:625-631) and updateCrumbs (:588-589) use the visible rect.
- New ensureVisible(id), called from the selected effect (:113-117): pans by the smallest dx/dy that puts the stand-in 48 px inside the visible rect, over 450 ms, starting from the drawn view (T1.4).
- openness and homeK keep using the full canvas.
- fitCanvas (:698-715): on real window resizes after homing, translate by Δw/2, Δh/2 so the centre stays put.

Shift the legend, the T2.6 controls and the search dropdown left while the panel is open.

**Files:** apps/web/src/components/graph/GraphExplorer.tsx, apps/web/src/components/graph/NodePanel.tsx, apps/web/src/components/graph/MapCanvas.tsx

### T2.6 Actions on the map: clickable titles, smart double-click, keyboard, zoom buttons, landing ping  (effort M, impact 4)

**What you'll see:** You can click an open folder's or file's title to inspect it or light up its outside connections. Double-clicking empty space steps out one level; double-clicking a function selects it and pings it. A small + / − / Fit / Fit all cluster sits in the bottom-right corner. The keyboard works:
- Backspace goes up a level, Enter goes in, 0 goes home;
- + and − zoom, arrow keys pan;
- / jumps to search, and ↑ / ↓ / Enter work in the search results.
After any flight the target pings once (twice from search), so your eye finds it. You can no longer fling the map off screen.

**How:** MapCanvas.tsx pick() (:605-622):
- An open frame's title band (rect.header·k tall, only while the title alpha > 0.5) becomes hit-testable.
- Hover underlines the title and focuses the box (T1.5's subtree rule lights the lines leaving it). Click selects it. Double-click flies to its parent.

onDbl (:803-807):
- closed tile: fly in, as today;
- chip: select and pulse (fly only if the chip is drawn as a dot);
- empty space inside open frame F: fit F if view k < 0.9·fitK(F), otherwise fly to F's parent (S.crumbIds stored by updateCrumbs);
- outside every root: Fit all.

Keyboard:
- Wrapper gets tabIndex = 0 and a 1 px accent :focus-visible ring.
- keydown is ignored when the target is an input or textarea.
- Backspace = upOneLevel; Esc = clear selection; Enter = fly into the hovered or selected box; 0 or Home = Fit all; + / − = zoomBy(1.5) through the glide; arrows pan 120 px (Shift: 40%); '/' focuses search.
- MapController gains upOneLevel(), zoomBy(f) and fitCurrent().

Controls: new MapControls.tsx with 32 px buttons on the panel colour.

Bounds: in goHome (:717-732), translateExtent = the roots' world bounding box padded by 25% (flight targets lie inside it).

Pulse:
- S.pulse {id, t0, count}. On fly 'end' (not 'interrupt'), a ring around the node's current stand-in grows 0 -> 18 px and fades 0.65 -> 0 over 650 ms.
- The selection halo grows in over 180 ms. Wheel or drag cancels a pending pulse.

Search (GraphExplorer.tsx:95-120): activeIndex plus onKeyDown (↑ / ↓ / Enter / Esc); Enter picks with 2 pulses.

Update the hint text.

**Files:** apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/MapControls.tsx (new), apps/web/src/components/graph/GraphExplorer.tsx

### T2.7 Soft perceptual palette with visible depth  (effort M, impact 4)

**What you'll see:** The top-level areas get clean, equally bright soft colours (sky, sage, lilac, teal…) with no olive or brown mud. Inside an area, each nesting level is a slightly lighter card with its own faint header strip, so 'analysis > base.py > AnalysisContext' reads as three steps instead of three identical dark boxes. Files show a small folded corner and classes a ◆ before their title, so you can tell folder from file from class before zooming in. Canvas, legend and tooltip sit on exactly the same tones.

**How:** New components/graph/palette.ts (~70 lines):
- oklch/oklab <-> hex conversion and mixOklab.
- MAP_BG, MAP_PANEL, MAP_INK, MAP_MUTED. These replace BG (mapModel.ts:9), TEXT/MUTED (MapCanvas.tsx:51-52), the tooltip's bg-[#151922] (:888) and the legend's bg-[#0f1218] (GraphExplorer.tsx:136).

Area hues:
- Cool-first angle order [245 sky, 150 sage, 300 lilac, 195 teal, 275 periwinkle, 15 rose, 85 sand, 55 apricot], assigned through T1.9's stable order.
- Warm hues (H 30-100) are used only from the 7th area on, with C <= 0.035 and L + 0.02 so they read as clay, not brown.

Per box, precompute n.pal once in buildMapModel:
- tile top oklch(.43 .05 H), bottom (.37 .045 H), border (.58 .065 H), title (.82 .08 H);
- frame fill oklch(min(.33, .228 + .025·depth), .012 + .004·min(depth, 4), H). This starts at or above today's .216 at depth 0, so top-level frames do not sink into the background;
- frame border L + .16, C .05;
- header band fill L + .02 with a 1 px separator at L + .05, drawn before the title.

Chips: fill = parent frame L + .075 in the chip's kind hue (drawChip :424).

Wiring: n.hue = pal.title keeps existing reads working. drawTile (:339-349), drawFrame (:300-303) and drawHalo (:576) read n.pal.

Box kind cues:
- file: an 8 px dog-ear top-right in the border colour;
- class: '◆ ' before the title, and the border mixed 40% toward KIND_STYLE.class;
- folder: plain.

Change only the file kind colour, to oklch(.80 .075 230). This fixes the file/class clash under deuteranopia (ΔE 0.5); the other KIND_STYLE colours stay.

Add D-027 superseding D-024's palette and recording the real slate value.

**Files:** apps/web/src/components/graph/palette.ts (new), apps/web/src/components/graph/mapModel.ts, apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/GraphExplorer.tsx, apps/web/src/lib/api.ts, decisions.md

### T2.8 A real type system  (effort M, impact 4)

**What you'll see:** Rows of tiles look typeset: equal tiles carry equal names, and sizes change smoothly while zooming, with no jumps. Long names shrink a little and then truncate cleanly. The summary is clearly secondary, and an open folder's title clearly heads its contents (no more 10 px 'services' above 22 px child names). The map uses the same font as the rest of ARCHON.

**How:** Tile names:
- mapModel.ts buildMapModel: for each box, nameWorld = median over its box children of min(w/(len·0.62), h/3.2), in world units, stored on each child.
- MapCanvas drawTile: nameSize = min(22, nameWorld·k). This is continuous and equal for siblings.
- A name that does not fit vr.w - 16 shrinks to at least 0.8×, then uses fitSmart (T1.3). Below 11 px it becomes a pill.
- Summary = 0.68 × the name size, drawn only at 11 px or more (fitParts, T1.7).

Frame titles:
- One size per sibling group = clamp(band·0.5, 13, 16), weight 600, in pal.title, inside the T2.7 band.
- When the band is short, the title may use the top half of BOX_PADDING.
- Frame summary 12 px.

Width cache: measure each (weight, family, text) once at a 100 px reference and scale linearly. Today's measure() key includes the continuous font size, so it misses on every zoom frame (:148-159). Draw at the exact size, with no quantising.

Font: SANS = getComputedStyle(document.body).fontFamily at mount. The 'Inter' named at :49 is never loaded.

**Files:** apps/web/src/components/graph/mapModel.ts, apps/web/src/components/graph/MapCanvas.tsx

### T2.9 Files read top to bottom; folders breathe  (effort M, impact 4)

**What you'll see:** Inside reasoning.py, the public entry functions sit at the top and the _helpers they call underneath, so lines flow downward with far fewer crossings (97 -> about 71 for this hub file; most files drop much more). Route files still open with their endpoints. Files without internal calls show tidy aligned columns instead of zig-zag rows. The gaps between folder tiles are wide enough to show the wires between them, content starts right under the title, and tiles in a row share top and bottom edges.

**How:** Edge data to the worker:
- layoutClient.ts:72 sends edges as [src, dst, kind]; LayoutRequest.edges gains the kind (layoutCore.ts:30).
- viewKey adds the kind and a LAYOUT_VERSION.
- runLayout builds parentId -> internal leaf edges once, lifting each end to the direct child of the lowest common box.

pack(), for all-leaf boxes with 3 or more internal calls/extends/implements edges, calls layerLeaves():
- DFS cycle break, visiting in sortKey order (deterministic).
- exposes edges reversed, and endpoints/tables pinned to layer 0.
- Longest-path layers, callers first; 4 barycenter sweeps.
- Python private names (single leading '_', not dunders) after public ones within a layer; unconnected leaves last.
- Start a new row at a layer boundary only when the current row is at least 40% of the target width.

Other all-leaf boxes call gridLeaves(): a column-major grid, column width = the widest leaf footprint, column count from T1.6's aspect search, chips left-aligned. viewModel's sortKey gains the private flag for all boxes.

Spacing:
- Gap between box children = clamp(0.06 × median min side, 14, 80) (today fixed 14/10, :41-42).
- BOX_PADDING = max(10, 0.02W); headerFor = max(14, W/28) (:49-51).
- Chip row gap 14 in boxes without internal edges, 30 in boxes with them.

Rows of boxes: equalise heights when the ratio is at most 1.5 (padY); rows with at most 30% free width share it in proportion. No recursive re-pack.

Add a decision entry superseding D-023's 'placement by name'.

**Files:** apps/web/src/components/graph/layoutCore.ts, apps/web/src/components/graph/layoutClient.ts, apps/web/src/components/graph/viewModel.ts, decisions.md

### T2.10 Symbols that grow into cards at deep zoom  (effort M, impact 3)

**What you'll see:** Function pills stay a neat size however far you zoom. Instead of blowing up into 600 px empty capsules, the last zoom step shows each function's parameters, line range and flags, e.g. '(self, repo_id: str) · L42–88 · async'. Endpoints show their route and packages their version. Private Python helpers look quieter than public functions, React components get a small </> mark, and kinds have their own shapes (◆ class, ▶ endpoint, ▭ table, tag for a package).

**How:** viewModel.ts: add to ViewNode (not part of viewKey):
- detail {params, start_line, end_line, async, decorators, version, route};
- priv: a single leading '_' in Python;
- isComponent: a PascalCase function in a .jsx/.tsx file. Do not use meta.exported, which is wrong for arrow-function exports.
mapModel carries them to MapNode.

MapCanvas: one chipGeom(st) shared by drawChip, anchor (:447-452), pick (:616-619) and drawHalo (:573-580):
- ch = min(24k, 30);
- cw = min((rect.w - 8)·k, textW + ch·1.25 + 14), centred in the slot;
- dot radius min(3.5, ch·0.15).

Card: when slot height·k >= 2.2·ch, fade in a card:
- the name in 14 px mono, weight 600;
- a muted 11 px detail line (fitSmart);
- a third line with decorators at 60 px or more;
- endpoints show a method tag; packages show their version.

Private chips: fill tint 0.12, stroke 0.30, name in MUTED, hollow kind dot.

drawGlyph(ctx, shape, x, y, r) draws KIND_STYLE.shape when ch >= 18 (a dot below that); the legend uses it too.

**Files:** apps/web/src/components/graph/viewModel.ts, apps/web/src/components/graph/mapModel.ts, apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/GraphExplorer.tsx


## Tier 3 - Bigger bets

_Optional upgrades: backend work that makes the relationships correct, an analysis view that colours the map by health, richer facts, touchable lines, next-step actions from the map, ordering that follows how the code is built, calmer dense files, and crispness and performance insurance._

### T3.1 Backend: add the relationships that are missing or wrong  (effort M, impact 4, needs backend)

**What you'll see:** The frontend comes alive: GraphExplorer -> NodePanel/MapCanvas appear, and src/components -> src/lib becomes a strong wire. main.py points at each route module instead of an empty routes/__init__.py. Arrows stop ending on empty __init__ files, so those can then be hidden. Test-fixture packages (express, pg) stop appearing as real dependencies.

**How:** apps/api/archon/graph/builder.py:

(1) _resolve_js (:186-196): when '@/' or '~/' does not resolve at the repo root:
- walk up from the importing file's directory to the nearest tsconfig.json/jsconfig.json and read compilerOptions.baseUrl + paths (e.g. '@/*': ['./src/*']);
- fallback: <ancestor>/src/<rest>;
- last resort: a suffix match among _file_by_path keys, taking the one with the longest shared prefix.
Cache the result per directory per build.

(2) _resolve_imports (:120-141), Python: for each name in imp['names'], try _exact_module(f'{full}.{name}') first and emit one imports edge per submodule found. Fall back to the package __init__ only when none resolve.

(3) Dependencies whose meta.manifest matches TEST_PATH_RE (analysis/base.py:16) get meta.fixture = true.

Tests: pytest fixtures for a tiny monorepo (apps/web/tsconfig.json with src/a.ts importing '@/b') and a package using `from pkg import sub`.

Re-index both repos. Then in viewModel: hide symbol-less, edge-less files of 3 lines or fewer (T1.8), and mute fixture packages.

Update decisions.md and flow.md.

**Files:** apps/api/archon/graph/builder.py, apps/api/tests (new fixtures + tests), apps/web/src/components/graph/viewModel.ts, decisions.md, flow.md

### T3.2 Health lens: one click turns the calm map into a soft heat map  (effort M, impact 4)

**What you'll see:** A two-way toggle, 'Structure | Health', sits in the toolbar. In Health, tiles fade over 350 ms from area colours to a scale that runs from receding to warm. Clean files turn misty slate, while routes/analysis.py, debt.py, graph/store.py and services/docs.py glow peach to rose. Functions with findings get a soft severity ring. Nothing moves. If no analysis has run, the button says 'Run analysis'.

**How:** Data:
- lib/api.ts:294: findings() gains `limit`.
- GraphExplorer lazily fetches findings (status open, limit 2000) and runs, only when lens === 'health'.

New lenses.ts: computeMetrics(model, findings), run once per data change.
- Map each finding to its file via node_id -> ancestors, falling back to path. Manifest findings go to the folder that owns the manifest.
- Per file: w = Σ SEVERITY_WEIGHT × confidence; density = w/(kloc + 0.15). Folders roll up.
- Fixed bins: <2, 2-5, 5-8, 8-11, ≥11 per KLOC (the health.py bands). Fixture files are excluded (T3.1).

Colours:
- Built in OKLCH with palette.ts (T2.7): bin 0 neutral slate, rising through apricot to rose with increasing chroma. Never reuse area hues.
- Output hex strings only, because tint()/withAlpha() parse #rrggbb.

MapCanvas:
- Props lens and metrics. colorOf(n) = mixOklab(from, to, ease(lensT)), with lensT going 0 -> 1 over 350 ms and keeping the frame loop alive.
- A findings mark (dot + count, top-right, tiles of 90 px or wider) appears only in Health.

Legend: swaps to a 5-swatch 'clean -> needs attention · analysed <date>'.

**Files:** apps/web/src/components/graph/lenses.ts (new), apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/GraphExplorer.tsx, apps/web/src/lib/api.ts, decisions.md

### T3.3 Rich hover card and panel facts  (effort M, impact 3)

**What you'll see:** Resting on any tile shows a steady card with:
- the path and lines of code;
- symbols ('12 functions · 2 classes · 27 types');
- API ('10 endpoints: GET 6 · POST 3');
- 'imported by 14 files · imports 6';
- 'a test imports it';
- the worst finding.
The side panel shows the same facts, plus Findings and Tested-by lists.

**How:** buildMapModel computes per node: loc; fanIn/fanOut (distinct files, lifting imports/calls edges through ancestors); endpoint methods.

MapCanvas tooltip:
- also for boxes (drop `!tip.node.box` at :886);
- shown after 250 ms of dwell, anchored below the node;
- flips to stay on the canvas;
- hidden while the camera moves (T1.5);
- at most 6 rows.

NodePanel.tsx: add 'Facts', 'Findings (n)' and 'Tested by' sections above Source (~:86), using the findings `path` filter and the tests-intel map (lazy useApi).

Wording: 'a test imports it', not 'tested'.

**Files:** apps/web/src/components/graph/mapModel.ts, apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/NodePanel.tsx, apps/web/src/components/graph/GraphExplorer.tsx

### T3.4 Lines you can touch, that say where they go  (effort M, impact 3)

**What you'll see:** With something selected, every lit line that leaves the screen ends in a small tag at the edge, such as '↗ graph/builder.py · 3'. Clicking the tag glides along that connection. Hovering any line highlights it and shows something like 'ingest → graph · 29 relationships · 22 calls · 7 imports · e.g. parse_file → GraphBuilder.add_node'. Clicking a line frames both of its ends.

**How:** MapCanvas, using S.curves from T2.3.

Edge tags:
- For touched pairs with one end off-screen, find the first curve point outside the viewport inset by 14 px (bisection on t) and place a pill there.
- Merge pills within 22 px; cap at 6 plus '+N more'; keep clear of the legend and search.
- Store hit rects in S and test them first in pick().
- Click flies to the union rect of both ends, then pulses (T2.6).
- Only for the sticky selection, not for transient hover.

Line hover:
- The merge loop keeps up to 3 sample edges per pair.
- pickEdge(px, py) samples curves at 16 points within 6 px, used when pick() returns null and the line's alpha > 0.15.
- tip {kind: 'edge'}.
- Clicking a hovered line flies to the union of both rects without clearing the selection.
- Counts appear only on the hovered line.

**Files:** apps/web/src/components/graph/MapCanvas.tsx

### T3.5 Next steps from any node  (effort M, impact 3)

**What you'll see:** The details panel header gets one-click actions: Change impact, Generate tests, Refactoring ideas, Ask Chat (question prefilled, not sent) and Copy path. Right-clicking any node opens the same small menu. Arrowing through search results shows each hit on the map with a soft ring before you fly there.

**How:** NodePanel.tsx:23-29: icon buttons linking to:
- /repos/:id/tools?tool=impact|tests|refactor&node=:id (ToolsPanel already reads these, :142-158);
- /repos/:id/chat?q=… .
ChatPanel.tsx reads `q` once via useSearchParams and prefills the question without sending. Buttons are hidden for synthetic ids, and 'Generate tests' shows only for functions and methods.

MapCanvas: canvas 'contextmenu' listener (preventDefault; Shift+right-click keeps the native menu) -> pick -> select -> a 200 px menu (fade and scale over 120 ms).
- Items: Inspect, Zoom to, Focus, plus the same actions through onAction(kind, id) in GraphExplorer.
- Closes on Esc, outside click, wheel or drag.

MapController.preview(id | null): a soft ring and one pulse on the active result's stand-in, with no camera move. Skip ids not in model.nodes.

**Files:** apps/web/src/components/graph/NodePanel.tsx, apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/GraphExplorer.tsx, apps/web/src/components/chat/ChatPanel.tsx

### T3.6 Structure that matches how the code is organised  (effort M, impact 3)

**What you'll see:** Inside a folder, files that use things come before the things they use. Tests and Packages always sit at the end of the overview, and test code is drawn slightly greyer so it does not compete with product code. Packages lists PyPI then npm, most-used first, with dev tools muted. Inner helper functions sit right after their parent in a quieter style, and ORM model classes no longer become eleven nearly empty boxes.

**How:** layoutCore.ts runLayout:
- Lift edges to child pairs of the lowest common ancestor.
- rankChildren(box): DFS cycle break in path order, then longest path.
- Comparator (tier, rank, size bucket desc, path). Tier 1 = test/fixture paths (a TS port of TEST_PATH_RE); tier 2 = Packages and 'Other files' groups.
- The root uses (tier, size desc, path).

viewModel:
- An n.test flag mixes the box hue 50% toward neutral in the palette (no dashes, no glyphs).
- Dependency sortKey `${eco}${fixture?2:dev?1:0}${pad(9999-importers)}${name}`; dev and fixture chips are outline-only.
- Inner functions (function -> function contains) sort as `${KIND_ORDER}${parentLabel}~${label}`, drawn at 85% height and excluded from summaries.
- Drop class -> table contains, so tables are parented to their file (viewModel.ts:65).

Add a decision entry.

**Files:** apps/web/src/components/graph/layoutCore.ts, apps/web/src/components/graph/viewModel.ts, apps/web/src/components/graph/palette.ts, decisions.md

### T3.7 Calmer dense files: quiet hubs, spread ports, bundled exits  (effort L, impact 3)

**What you'll see:** In reasoning.py, the two fans of 8 lines into _llm_json and _answered_by become faint, with a small '8' bubble on each chip. Lines enter boxes at evenly spaced points instead of piling 8 arrowheads on one spot. Lines that leave an open folder for the same target merge into one trunk, which turns into the folder-level wire as you zoom out.

**How:** drawEdges, after the merge.

Hubs:
- A hub is a leaf with local in-degree >= max(5, 0.3 × leaves), at most 2 per box.
- Its unfocused incoming local lines draw at alpha ×0.35, width 1.
- A count bubble sits on the chip's top-right border (14 px, when ch >= 15).

Ports: routePorts(merged, states).
- Group each stand-in's incident pairs by exit side and sort by the far end.
- Spread them over the middle 70% of the side, at least 6 px apart.
- Store (side, fraction), eased in node-relative terms.
- Cubic beziers leave perpendicular to the side, k = clamp(0.35·|pq|, 12, 80).

Bundling (last, behind a flag): for sources whose open parent P (t > 0.5) is not an ancestor of the target, route through P's exit port, placed exactly where P's own closed-tile line attached. The trunk width is Σw, and branches run into the port.

No tapered ribbons and no B-splines through ancestor centres.

**Files:** apps/web/src/components/graph/MapCanvas.tsx

### T3.8 Crisp and fast canvas  (effort M, impact 2)

**What you'll see:** At 125% scaling, borders become single sharp hairlines and map text looks as sharp (ClearType) as the rest of the app. The dot grid stops shimmering while you pan, and very large repositories still zoom at full frame rate.

**How:** Opaque context:
- Create the context once in setup with getContext('2d', {alpha: false}) and keep it in S, instead of fetching it per frame at :194.
- An opaque canvas starts black, so paint BG synchronously after every canvas.width/height assignment in fitCanvas (:709) and in renderFrame's early return while !homed.
- Pre-mix muted text colours. Check that the glyph-edge chroma spread is above 60.

At rest only:
- snap rect edges to round(v·dpr)/dpr;
- put 1 px strokes on half device pixels;
- draw grid dots as 2×2 device-pixel squares.

Edge aggregation:
- integer node indices, Int32Array edges and kinds;
- numeric pair keys a·N + b;
- Int32Array(8) kind counts, with no spread+sort per pair (:513).
Validate the merged pairs against the old path via __archon on both repos, and time the real drawEdges before and after.

**Files:** apps/web/src/components/graph/MapCanvas.tsx, apps/web/src/components/graph/mapModel.ts

## Critic: gaps

- **[Tier 0 - pre-flight] The map shows a stale index, so the owner judges 'proper' against code that no longer exists. Snapshot 10_web_components_graph.png shows GraphCanvas.tsx and no MapCanvas.tsx. GraphCanvas.tsx was deleted on 2026-10-06 (git b010c8a); apps/web/src/components/graph/ no longer has it, yet the snapshots were taken on 2026-10-10. Nothing in the plan tells the user how old the map is or offers a refresh.**

  Why: 'Proper' also means correct. Every baseline and before/after the plan relies on is taken from a graph that is 4+ days old. T3.1's promised effects (GraphExplorer -> MapCanvas wires) cannot even be checked until a re-index.

  Fix: Pre-flight: re-ingest ArchonAI before recording any baseline (api.repos.reingest already exists, lib/api.ts:327). Add a quiet toolbar chip 'indexed 4 d ago · ada866f' built from repo.updated_at/commit_sha, with a 'Re-index' button that calls reingest. After the new graph arrives, restore the camera by the last crumb path (see the continuity gap) instead of jumping home.

- **[Tier 0 - pre-flight] An uncommitted working-tree change breaks the error colour that the map relies on. The globals.css diff deletes `--color-danger: var(--danger)` from @theme and removes the Geist fonts (layout.tsx). Without the token, the classes text-danger, border-danger and bg-danger generate nothing in Tailwind 4. They are used by the map's 'drawing failed / layout failed' chip (MapCanvas.tsx:901), NodePanel's error (NodePanel.tsx:31), ErrorBox (ui.tsx:67) and ApiStatus (ApiStatus.tsx:10-11).**

  Why: The plan's first commit would silently sweep this regression in. T2.8 also reads the font from document.body, so the font result depends on whether dropping Geist was intended.

  Fix: Restore `--color-danger: var(--danger);` in the @theme block. Ask or decide whether system-ui or Geist is the app font before T2.8, and commit that change separately with a decisions.md note.

- **[Tier 1] Inside files, everything is the same green. Call lines (#94c2a3) and function chips (#9ccfac) differ by only ΔE_OK 0.037, and method chips (#92c6bf) are just as close. In 05/06/33, lines, chip outlines and arrowheads merge into one green mass. The 8 arrowheads into _answered_by and _llm_json disappear into the chip borders. T1.1 keeps EDGE_STYLE kind colours for symbol-level lines at rest, and T2.4 recolours only focused lines, so the view people see most stays monotone.**

  Why: This is the most direct hit on 'everything properly visible' at the deepest, most-used level. Direction (arrowheads) and the edge between line and node are both lost.

  Fix: In drawEdges, draw calls and imports between symbols at rest in a neutral ink (the same #a9b3c4 DEPENDS ink T1.1 introduces, alpha rules unchanged). Keep hue only for the rare kinds (extends, implements, exposes, queries), so colour means something. End the curve 2 px outside the chip border. Before filling each arrowhead, stroke the same path in BG at lineWidth+2 so a thin knock-out separates it from the chip outline.

- **[Tier 1] At depth, ancestor frame edges stack as unlabelled parallel 'rails'. 33/34 show two vertical hairlines at x≈38 and x≈77 (the components and sections frames whose titles are off-screen). 20_wheel_step1 shows full-width horizontal lines at y≈77 and y≈113 with an empty band between them, and 20_step2 shows one at y≈161. T1.2 explicitly does no vertical sticky headers, and T2.7 adds a lighter fill per depth plus a header strip at every level, which turns these rails into visible stripes.**

  Why: These are lines that mean nothing to the viewer: exactly the clutter the owner rejected. They get worse as you go deeper, where the user spends the most time.

  Fix: In drawFrame, treat a frame larger than the viewport as 'the room you are in': strokeAlpha *= 1 - smooth(1.1, 1.8, max(sw/s.w, sh/s.h)), and fade its header band the same way. Apply T2.7's depth lightening only to the two deepest open levels on screen; ancestors above them share one fill, so no step lines appear at the screen edges. The breadcrumb already names those ancestors.

- **[Tier 2] No item makes text contrast an acceptance criterion. Computed: today's tile summary (#dfe5ee at 0.7 over the mid-gradient) is only 4.56:1 on sage and peach areas, borderline for 10-12 px text. On T2.7's proposed tiles (oklch .43/.37), a summary in MUTED #9aa3b5 drops to 3.55-3.69:1, which fails 4.5:1, and T2.4's veil lowers it further. T2.8 does not say which colour summaries use.**

  Why: 'Everything properly visible' is measurable, and the palette rework could quietly make secondary text worse than today.

  Fix: In palette.ts, derive secondary text per surface (e.g. mixOklab(MAP_INK, surface, 0.25)) instead of one fixed MUTED. Add a dev-only check in buildMapModel that computes the WCAG ratio of each text colour against its real surface (the gradient midpoint for tiles, the frame fill for titles, the chip fill for chips) and console.warns below 4.5:1 for text under 14 px. List the numbers in the T2.7 decision entry.

- **[Tier 1] The map does not keep your place. Every return to the Code Map tab refetches the whole graph (useApi in lib/hooks.ts:16-56 has no cache; GraphExplorer.tsx:30) and re-homes the camera (MapCanvas.tsx:861 sets s.homed=false, then goHome). Only ?node= is restored, by flying out from the overview 120 ms later. There is also no 'back to where I was' after a search jump or a fly (T2.6's Backspace goes up a level, not back). T3.5 adds links to Tools and Chat, which makes these round trips frequent.**

  Why: Each return shows 'loading map', drops the user on the overview and replays a flight. That feels neither smooth nor proper, and it gets worse exactly when the plan's new actions are used.

  Fix: (1) Add a module-level Map cache for the graph payload keyed by `graph:${repo.id}:${updated_at}`. (2) On zoom 'end', save {k, x, y, crumbPath, selected} per repo to sessionStorage (try/catch). In goHome, restore it when viewKey matches; after a re-index, fall back to zoomToPath(crumbPath). (3) Keep a 10-entry camera history pushed on every fly 'end', exposed as Alt+← and a small back arrow beside 'Fit all'.

- **[Tier 1] The first paint flashes. Before the graph arrives, the map area shows the page background --bg #0b0d12 (GraphExplorer.tsx:126-133 mounts MapCanvas only once graph exists). It then switches to the map BG #0f1218 plus the dot grid, and the first frame pops in fully drawn. A re-index rebuild also snaps.**

  Why: The first impression of 'smooth' is a background colour jump followed by a pop-in.

  Fix: Give the GraphExplorer map container the map BG and a CSS radial-gradient dot grid matching drawGrid from the start. Fade the canvas in (opacity 0 -> 1 over 240 ms) on the first homed draw. On a model rebuild, keep the previous frame as a drawImage snapshot and cross-fade over 200 ms. Under prefers-reduced-motion, no fades.

- **[Tier 2] The details panel and the map do not talk to each other. Hovering a neighbour row in NodePanel (NodePanel.tsx:101-115) shows nothing on the map. The panel's group headers use EDGE_STYLE kind colours with ↗/↙ icons, while T2.4 turns focused map lines amber ('uses') and periwinkle ('used by'), so after T2.4 the panel and the map disagree on what colour means. The Crosshair button is titled 'Focus neighborhood' but only flies (GraphExplorer.tsx:160).**

  Why: 'Actions' and 'proper' both suffer when the two halves of the screen use different colour languages and do not link.

  Fix: Add an onHover(id|null) prop to NodePanel that calls MapController.preview(id), which T3.5 already plans for search: a soft ring on the neighbour's stand-in plus that single lit edge. Colour the panel's direction arrows with the same two palette.ts tokens T2.4 uses, with the kind as text. Make the Crosshair set the sticky T2.4 focus instead of only flying.

- **[Tier 2] The action engineers want most is missing: open the code. NodePanel shows path:line and a dim 11 px text-muted <pre> source (NodePanel.tsx:86-93). There is no 'Open in editor' or 'Open on GitHub', and T3.5's action list (impact, tests, refactor, chat, copy path) does not include one. The repo source is a local path (D:/ArchonAI) or a GitHub URL (34 shows github.com/ParamShah77/Portfolio_Param), and commit_sha is known.**

  Why: 'Actions' from a code map almost always means 'take me to this code'. It is cheap and free, with no new service.

  Fix: In T3.5's panel action row and the context menu, add 'Open in VS Code' (`vscode://file/${absPath}:${start_line}`) for local sources and 'Open on GitHub' (`${url}/blob/${commit_sha}/${path}#L${start}-L${end}`) for GitHub sources. Restyle the Source block as 12 px text-fg/85 with line numbers starting at start_line.

- **[Tier 2] The map gets too little of the screen, and overlays sit on top of content. In 34, the app header, repo header, tabs and map toolbar take about 21% of the 928 px window height, and the legend covers the bottom-left tiles. T2.5 introduces occlusion only for the right-hand panel; home, fit and fly targets still put content under the legend and the planned T2.6 controls.**

  Why: 'Everything properly visible' on a ~1362×928 window: every row of map height matters, and content hidden under the key makes it look sloppy.

  Fix: Add a Focus-mode toggle (F key plus a toolbar button) that makes the map container `fixed inset-0 z-40`, keeps only the map toolbar, and exits with Esc. Generalise T2.5's occlusion prop to {top, right, bottom, left}, filled from the legend's and controls' measured rects (ResizeObserver), and use it in transformFor, homeTransform and ensureVisible.

- **[Tier 1] A repo with one dominant root gets a dead first step. The portfolio overview (30) is one big 'src' tile holding most of the files, plus small Packages, api and tools tiles; the first zoom-in reveals nothing new. MapCanvas.tsx:230 already force-opens the root when there is exactly one, but not when one root dominates. T1.3 and T1.8 do not address this.**

  Why: The owner asked for 'first just overview, then one by one'. An overview with a single labelled box is not an overview, and it costs a click on every visit to typical app repos.

  Fix: In MapCanvas pass 0, set forced = true at home for a root holding at least 70% of all files and having at most 12 children. Alternatively, dissolve it in viewModel's compaction when its only siblings are Packages, 'Other files' or roots with 3 files or fewer, labelling the children 'src/components' and so on as the existing wrapper rule does.

- **[Tier 1] There is no engineering safety net for a large renderer rewrite. MapCanvas.tsx is 905 lines in one component closure, and the plan adds a label queue, curve list, sockets, occlusion grid, veil pass, pulses, keyboard, context menu, edge tags, ports, bundling and lenses. The frame loop is already fragile: three consecutive commits on 2026-10-10 fixed a blank map (340957a, c0b554d, c9e768f). apps/web/package.json has no test runner.**

  Why: Regressions here look to the owner like 'janky' or 'blank', which is the exact complaint history. Most of the new logic is pure and cheap to test.

  Fix: Before Tier 2, split MapCanvas into camera.ts (glide, fly, history), lod.ts (openness and settle state), edges.ts (merge, geometry, occlusion), labels.ts (fit, fitSmart, fitParts, label queue) and draw/*.ts, keeping MapCanvas as the React shell. Add vitest (a dev dependency, worth it) with tests for: fitSmart and fitParts; summarize ranking; pack() aspect search (no overlaps, deterministic, rejects a single column); layerLeaves determinism; viewModel compaction including the single-file collapse; the T2.1 hysteresis state machine. Log the split in flow.md.

- **[Tier 1] Nothing measures 'smooth', and the plan has no owner checkpoint. The plan says to re-record in a visible tab, but no item builds that recording. It ships 28 items to an owner who rejected three earlier rounds. Several items add per-frame cost: T2.2 draws frame and tile together, T2.4 re-draws neighbours in a veil pass, and T2.3 adds an occlusion grid. Meanwhile every tile already runs shadowBlur up to 22 px each frame (MapCanvas.tsx:334-337), the costliest Canvas2D operation, which matters on a laptop GPU.**

  Why: Without numbers and an early look from the owner, the team can spend a whole tier polishing something the owner calls 'not smooth' again.

  Fix: (1) Add a dev-only `?debug=map` overlay on the existing __archon hook showing p50/p95 renderFrame ms, strokes per frame, on-screen boxes with 0.05 < t < 0.95, and the settled flag. (2) Script captures from the same camera set as the review snapshots (__archon.zoomTo plus fixed transforms) to produce before/after pairs. (3) Budget: p95 under 8 ms during a 20-notch wheel sweep on both repos, with tile shadows skipped while the camera moves and restored on settle. (4) Checkpoint: after Tier 1 + T2.1/T2.2, send the owner a short before/after comparison plus the open questions, before T2.7 (global palette) and T2.4 (veil) land.

- **[Tier 3] Small siblings fall back to a second labelling system. Tiny file tiles, such as config.py and main.py at about 55 px in 03, or ApiStatus.tsx and 'Markdown.…' in 09 with 11-13 px names beside 26 px neighbours, get names in pills under the tile or very small text. T2.8 keeps pills below 11 px, and footprints are pure content size.**

  Why: Pills hanging under tiles, mixed with in-tile names, read as inconsistent and fiddly ('proper').

  Fix: In layoutCore pack(), floor each box child's footprint at about 0.3× the median sibling side, with the contents centred inside it. Every child can then hold an 11 px name at the zoom where its parent finishes opening, and pills remain only for packages and dots.

- **[Tier 3] Optional, for 'smooth coloring' in the literal sense. T1.1 makes every box-to-box line one grey-blue, including the few meaningful lines that cross top-level areas on the overview and at folder level (tests -> archon in 01, and web -> lib after T3.1).**

  Why: A soft hue blend from source area to target area shows direction without arrowheads and gives the calm map one deliberate touch of colour.

  Fix: At rest only, when the two stand-ins belong to different top-level areas, stroke with createLinearGradient(p, q) from area A's border colour to area B's at the existing alpha. Same-area lines stay neutral. Focused lines keep T2.4's direction colours, and the legend adds a 'between areas' sample.

## Critic: items that could backfire

- T2.4 dimming the map on hover (a 0.35 veil after 100 ms of rest, 150 ms linger): chips in 05 are about 50 px apart, so sweeping across a file keeps crossing gaps longer than the linger. The whole screen then pulses darker and lighter, which repeats the owner's 'not smooth' complaint. Keep hover to brighter lines and neighbours only; dim the map only on click, at no more than 0.3.
- T1.5(5), delaying every single click by 220 ms to protect double-click: the ring and panel then appear a quarter-second late on every click, a lag you can feel. Select immediately and draw the ring at once; only delay opening the panel, or cancel it when a double-click arrives.
- T2.1, finishing the open or close by itself after the user stops: a closed tile is about 1.9× as bright as an open frame (pixels: 10 tile (66,83,78) vs frame (29,36,39); 03 (58,73,89) vs (21,26,34)). Snapping a box that fills half the screen therefore changes the whole screen's brightness for about 250 ms after input ends. That reads as a blink, or as 'the map moved by itself'. Also, because a box opens at 1.08 but closes at 0.85, the same camera position looks different depending on whether you zoomed in or out. Settle only the children's text and opacity, settle only boxes within 0.25 of their target, and never settle while a mouse button is held.
- T1.1 dash patterns: setLineDash works in screen pixels from the start of each curve. As curves lengthen during a wheel glide, the dashes slide along the line like marching ants, and 1.5/3.5 dots shimmer at 125% display scaling. Fade the dashes in only once the view is settled, or anchor lineDashOffset at the curve's midpoint.
- T2.3 per-frame occlusion (try the opposite bend, then double the bend, otherwise skip the line) is not continuous. The bend is capped in screen pixels (min(40, seg*0.15)) and chip size does not scale linearly with zoom, so hit-test results change mid-glide and lines flip sides or blink out. Decide occlusion at settle, or per stand-in pair in world space with a cache, and ease opacity and bend between decisions. Its sockets also draw lines 28 px into tile bodies, which may read as lines stabbing through tiles.
- T2.7's lighter fill per nesting level: with tiles fixed at L .43/.37, the brightness ratio between a closed tile and an open frame falls from 1.85 at depth 0 to 1.34 at depth 4 (computed). Open and closed blur together exactly where the user is deepest. Adding a header strip at every level turns the stacked ancestor edges (33, 20_step1) into stripes, and MUTED summaries on the new tiles compute at 3.6:1. Raise tile lightness with depth, or stop the ramp at depth 2.
- T2.4 glints: selecting a hub or a folder lights 20-50 lines (the _llm_json and _answered_by fans in 05, chat.py's lines in 12). One 600 ms moving dot per line becomes a burst of fireworks. Limit it to the 6 strongest lines and skip it when more than 12 are lit.
- T2.4 recolouring lines on focus: if only opacity and litWeight ease while the colour switches at once, a green line visibly snaps to amber. Blend the colour as well, with mixOklab(kindColour, directionColour, litWeight).
- Too many overlays: T2.6 zoom controls (bottom-right), T1.9 three-row key (bottom-left), T3.3 six-row hover card, T3.4 up to 6 edge tags plus '+N more' pinned to the screen edges, the T3.5 context menu and the T2.5 panel. Together they put chrome on all four sides of a canvas the owner wants clean. Show edge tags only for a sticky selection, only after the camera has rested 400 ms, and at most 3.
- T1.5's selection ring in #5aa9ff with a 10 px glow: this app blue is more saturated than any area colour on the soft palette, so a glowing ring can look harsh. Use a 2 px ring with a glow of at most 6 px at 0.5.
- T3.2's Health view tinting tiles 'peach to rose': warm, saturated fills over a calm map risk looking alarming. Keep chroma at or below 0.09, add no glow, and keep it off by default.
- T2.8 measuring text once at 100 px and scaling linearly: Chrome on Windows hints canvas text at small sizes, so widths at 11-13 px differ by a few percent from linear scaling. Truncation decisions would then be off by 1-3 px, so text either overflows the tile edge or is cut when it would fit. Cache widths per whole-pixel size, draw at the exact size, and keep a 2 px margin.
- Several layout changes at once (T1.3 single-file collapse, T1.6 shape search, T1.8 'Other files' groups, T2.9 call-flow order) rearrange every box together and erase the owner's mental map. Ship them as one batch, with before/after images and the alphabetical vs call-flow question answered first.

## Deliberately not recommended

- 3D or WebGL (three.js, PixiJS): the map is a flat diagram with at most about 200 shapes per frame. D-026 already weighed this; it would add a lot of code and make crisp text harder, for no visible gain.
- Minimap inset: at file or function depth the viewport is a few pixels inside a 160 px inset. The breadcrumb plus 'Fit all' already show where you are, and the inset adds chrome over a canvas the owner wants clean.
- Dots or comets that keep flowing along lit lines: they make a calm map move all the time and risk a setTimeout(0) spin in hidden tabs. One glint on selection is enough.
- Dimming the whole map on every hover with no dwell delay: sweeping the mouse across dense views would strobe.
- Snapping or quantising font sizes to fixed steps while zooming: labels would visibly jump on every wheel tick. Sizes stay continuous and consistent instead.
- Always-on badges on every tile (endpoint, table or findings counts, a lines-of-code line, a composition strip, grade chips): this brings back the clutter the owner rejected. These facts go in honest summaries, the tooltip, and the Health lens.
- Hierarchical edge bundling through ancestor centres, and tapered ribbons: in nested boxes the curves cross the middles of unrelated tiles, and a taper is invisible at about 1.5 px widths.
- A dark casing on every line, or raising the alpha and chroma of all lines: it cuts grooves across the soft tiles and makes the hairball inside files heavier. Casing is used only for focused lines.
- A rose 'cycle' alarm colour with a per-frame Tarjan pass: it over-dramatises a 29:1 pair and disagrees with the Health page's file-level import cycles. Separating the two directions into a lens shape is enough.
- Opening boxes by pointer distance (Furnas degree-of-interest) or under a global detail budget: the structure would change under a still camera, which conflicts with the owner's 'one by one, clear'.
- Hue offsets between sibling folders inside one area: invisible at a small spread, a rainbow at a large one, and either way it blurs 'colour = area'.
- A Tests lens or a Coupling/Usage lens now: the data is wrong until T3.1 (apps/web has 0 file-to-file imports, route modules have 0 importers, and tests-intel is a heuristic).
- Auto-detecting touchpads to make two-finger scroll pan: it misclassifies high-resolution mice and changes the primary gesture. Offer it only as an opt-in.
- Magnetic detents, or the camera nudging itself after the user stops: this fights the user's intent and their next wheel notch.
- 'Fly to fit the focus plus all its neighbours': when neighbours live in other components it zooms out to closed tiles, and the focus disappears into one.
- Recursively re-packing stretched children into a 'mosaic': this only moves the empty space inside the child. A bounded equalisation of each row is used instead.
- Ecosystem sub-boxes inside Packages: each sub-box stays below the open threshold, adding a zoom step. Ordering by sortKey achieves the grouping without that cost.
- Regenerating every KIND_STYLE colour app-wide: badges would change across the whole app for little gain. Only the file colour changes, to fix the deuteranopia clash.
- localStorage layout-order hints: extra state that can freeze bad orders and never reaches other devices or viewers. A deterministic order is enough.
- Forced-colors or high-contrast palettes and screen-reader spatial navigation for now: large, unrequested, and not verifiable here. The keyboard basics and reduced motion are included.
- Dashed borders plus a flask glyph plus colour mixing for test code: three encodings for one fact. A single desaturation is used.
- A 'zoom-in' magnifier cursor over tiles: a single click selects, so the cursor would promise the wrong action.
- Shift+click compare, and renaming __init__ to 'constructor': scope creep, and Python readers do not need the rename.

## Decisions for the owner

- Should merely resting the mouse on something dim the rest of the map (after about 0.1 s), or should only a click do that, with hover limited to lighting lines?
- Inside a file, do you prefer call-flow order (entry functions on top, helpers below, fewer crossings) or the current alphabetical order (easier to scan by name)?
- Once a zoom stops, may the map finish opening or closing a box by itself over about a quarter-second so nothing rests half-open, or should it always stay exactly where your zoom left it?
- At folder level, should the top ~10 wires between subfolders always be visible, or should folder-to-folder lines appear only when you hover or select something (the calmest option)?
- Colours for 'uses' and 'used by' on focused lines: pale amber and periwinkle as proposed, or the green and blue convention some tools use?
- Do you want a Health view that recolours the map by findings, or should colour stay purely about structure (areas and depth)?
- Touchpad two-finger scroll: keep it zooming (Google Maps style), or add an opt-in setting where it pans (Figma style)?
- Should a single click open the details panel, which now slides over the map, or should the panel open only from a button or Enter, with click only highlighting?
- Should test code (apps/api/tests) look slightly greyer than product code on the overview?
- Which colour should each top-level area keep (the current blue for archon, green for web and lilac for tests), and should warm hues (sand, apricot) be allowed at all?
- Do you want to keep the dot-grid background, or switch to a plain slate?
"""Assemble per-file extractions into one repository graph.

Responsibilities (decisions.md D-005):
  1. repo / directory nodes and CONTAINS edges
  2. import resolution (module string -> file node, or external DEPENDENCY node)
  3. call resolution (callee name -> function/method node; heuristic, name-based)
  4. inheritance resolution (base name -> class node)
  5. SQL string references -> QUERIES edges to TABLE nodes
  6. dependency nodes from manifests + DEPENDS_ON edges from the repo node
"""

from __future__ import annotations

import posixpath
from collections import defaultdict
from dataclasses import dataclass, field

from archon.graph.model import Edge, EdgeKind, FileExtraction, Node, NodeKind, make_id
from archon.ingest.manifests import Dependency

_JS_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")
_CALLABLE = {NodeKind.FUNCTION, NodeKind.METHOD, NodeKind.CLASS}
_MAX_CANDIDATES = 6
_LANG_FAMILY = {"python": "py", "javascript": "js", "typescript": "js", "tsx": "js", "go": "go", "java": "java"}


@dataclass(slots=True)
class BuiltGraph:
    nodes: dict[str, Node] = field(default_factory=dict)
    edges: dict[str, Edge] = field(default_factory=dict)
    stats: dict[str, int] = field(default_factory=dict)

    def add_node(self, n: Node) -> Node:
        return self.nodes.setdefault(n.id, n)

    def add_edge(self, e: Edge) -> None:
        if e.source == e.target or e.source not in self.nodes or e.target not in self.nodes:
            return
        self.edges.setdefault(e.id, e)


class GraphBuilder:
    def __init__(self, repo_name: str, go_module: str = "") -> None:
        self.repo_name = repo_name
        self.go_module = go_module
        self.g = BuiltGraph()
        self.repo_node = Node.create(NodeKind.REPO, name=repo_name, qualified_name=f"repo:{repo_name}")
        self.g.add_node(self.repo_node)
        self._file_by_path: dict[str, Node] = {}
        self._file_by_module: dict[str, list[Node]] = defaultdict(list)
        self._symbols_by_name: dict[str, list[Node]] = defaultdict(list)
        self._symbols_by_file: dict[str, dict[str, list[Node]]] = defaultdict(lambda: defaultdict(list))
        self._tables_by_name: dict[str, Node] = {}
        self._dep_nodes: dict[str, Node] = {}
        self._extractions: list[FileExtraction] = []
        self._file_imports: dict[str, set[str]] = defaultdict(set)  # file path -> imported file paths

    # ------------------------------------------------------------------ public
    def add_file(self, fx: FileExtraction) -> None:
        self._extractions.append(fx)
        for n in fx.nodes:
            self.g.add_node(n)
            if n.kind == NodeKind.FILE:
                self._file_by_path[n.path] = n
                mod = n.meta.get("module") or ""
                if mod:
                    self._file_by_module[mod].append(n)
                    # allow suffix matches: "pkg.sub.mod" also indexed as "sub.mod" and "mod"
                    parts = mod.split(".")
                    for i in range(1, len(parts)):
                        self._file_by_module[".".join(parts[i:])].append(n)
            elif n.kind in _CALLABLE:
                self._symbols_by_name[n.name].append(n)
                self._symbols_by_file[n.path][n.name].append(n)
            elif n.kind == NodeKind.TABLE:
                self._tables_by_name.setdefault(n.name, n)
        for e in fx.edges:
            self.g.add_edge(e)
        self._ensure_directories(fx.path)

    def add_dependencies(self, deps: list[Dependency]) -> None:
        for d in deps:
            key = f"{d.ecosystem}:{d.name}"
            if key in self._dep_nodes:
                continue
            n = Node.create(
                NodeKind.DEPENDENCY,
                name=d.name,
                qualified_name=key,
                meta={"ecosystem": d.ecosystem, "version": d.version, "dev": d.dev, "manifest": d.manifest},
            )
            self.g.add_node(n)
            self._dep_nodes[key] = n
            self.g.add_edge(Edge(self.repo_node.id, n.id, EdgeKind.DEPENDS_ON, {"dev": d.dev}))

    def build(self) -> BuiltGraph:
        for fx in self._extractions:
            self._resolve_imports(fx)
        for fx in self._extractions:
            self._resolve_bases(fx)
            self._resolve_calls(fx)
        self._compute_stats()
        return self.g

    # ------------------------------------------------------------ directories
    def _ensure_directories(self, rel_path: str) -> None:
        parts = rel_path.split("/")
        parent = self.repo_node
        for i in range(len(parts) - 1):
            dir_path = "/".join(parts[: i + 1])
            d = Node.create(NodeKind.DIRECTORY, name=parts[i], path=dir_path, qualified_name=dir_path)
            d = self.g.add_node(d)
            self.g.add_edge(Edge(parent.id, d.id, EdgeKind.CONTAINS))
            parent = d
        file_node = self._file_by_path.get(rel_path)
        if file_node is not None:
            self.g.add_edge(Edge(parent.id, file_node.id, EdgeKind.CONTAINS))

    # ---------------------------------------------------------------- imports
    def _resolve_imports(self, fx: FileExtraction) -> None:
        src = self._file_by_path[fx.path]
        for imp in fx.imports:
            module = imp.get("module") or ""
            level = int(imp.get("level") or 0)
            target = self._resolve_module(fx, module, level)
            if target is not None:
                self.g.add_edge(
                    Edge(src.id, target.id, EdgeKind.IMPORTS, {"names": imp.get("names", []), "line": imp.get("line")})
                )
                self._file_imports[fx.path].add(target.path)
                continue
            dep = self._match_dependency(fx.language, module)
            if dep is not None:
                self.g.add_edge(
                    Edge(
                        src.id,
                        dep.id,
                        EdgeKind.IMPORTS,
                        {"names": imp.get("names", []), "line": imp.get("line"), "external": True},
                    )
                )

    def _resolve_module(self, fx: FileExtraction, module: str, level: int) -> Node | None:
        lang = fx.language
        if lang == "python":
            return self._resolve_python(fx.path, module, level)
        if lang in ("javascript", "typescript", "tsx"):
            return self._resolve_js(fx.path, module)
        if lang == "go":
            return self._resolve_go(module)
        if lang == "java":
            return self._resolve_java(module)
        return None

    def _resolve_python(self, from_path: str, module: str, level: int) -> Node | None:
        if level > 0:
            base_dir = posixpath.dirname(from_path)
            for _ in range(level - 1):
                base_dir = posixpath.dirname(base_dir)
            base_mod = base_dir.replace("/", ".") if base_dir else ""
            full = f"{base_mod}.{module}".strip(".") if module else base_mod
            hit = self._exact_module(full)
            if hit is not None:
                return hit
            # `from . import x` / `from .pkg import name` where name is a module
            return self._exact_module(full) or None
        hit = self._exact_module(module)
        if hit is not None:
            return hit
        # from a.b import c  -> module may be a.b.c (c is a submodule)
        parts = module.split(".")
        while len(parts) > 1:
            parts.pop()
            hit = self._exact_module(".".join(parts))
            if hit is not None:
                return hit
        return None

    def _exact_module(self, module: str) -> Node | None:
        cands = self._file_by_module.get(module)
        if not cands:
            return None
        # prefer the shortest path (closest to the repo root) for suffix matches
        return sorted(cands, key=lambda n: (n.path.count("/"), n.path))[0]

    def _resolve_js(self, from_path: str, module: str) -> Node | None:
        if module.startswith("."):
            base = posixpath.normpath(posixpath.join(posixpath.dirname(from_path), module))
        elif module.startswith(("@/", "~/", "src/")):
            base = module.split("/", 1)[1] if module.startswith(("@/", "~/")) else module
            base = posixpath.normpath(base)
            # Path aliases are relative to the app that owns the importing file, which in a monorepo is not
            # the repo root (apps/web/src/lib/api.ts for "@/lib/api"). Try each folder above the importer,
            # nearest first: <dir>/<base> and <dir>/src/<base>.
            d = posixpath.dirname(from_path)
            while True:
                for root in (posixpath.join(d, base), posixpath.join(d, "src", base)):
                    hit = self._js_candidates(posixpath.normpath(root))
                    if hit is not None:
                        return hit
                if not d:
                    return None
                d = posixpath.dirname(d)
        else:
            return None
        return self._js_candidates(base)

    def _js_candidates(self, base: str) -> Node | None:
        for cand in (
            base,
            *[base + ext for ext in _JS_EXTS],
            *[posixpath.join(base, "index" + ext) for ext in _JS_EXTS],
        ):
            hit = self._file_by_path.get(cand)
            if hit is not None:
                return hit
        return None

    def _resolve_go(self, import_path: str) -> Node | None:
        if self.go_module and import_path.startswith(self.go_module):
            rel = import_path[len(self.go_module) :].strip("/") or "."
        else:
            rel = import_path
        # Go imports a package (directory): link to the directory's first file, preferring <dir>.go / main-like names
        files = [
            n for p, n in self._file_by_path.items() if n.language == "go" and (posixpath.dirname(p) or ".") == rel
        ]
        if not files:
            return None
        return sorted(files, key=lambda n: (not n.name.startswith(("doc", n.meta.get("package", "") + ".go")), n.name))[
            0
        ]

    def _resolve_java(self, fqcn: str) -> Node | None:
        hit = self._exact_module(fqcn)
        if hit is not None:
            return hit
        # wildcard import of a package: link to nothing specific
        return None

    def _match_dependency(self, language: str, module: str) -> Node | None:
        if not module or module.startswith("."):
            return None
        if language == "python":
            root = module.split(".")[0].lower().replace("_", "-")
            return self._dep_nodes.get(f"pypi:{root}") or self._dep_nodes.get(f"pypi:{module.split('.')[0].lower()}")
        if language in ("javascript", "typescript", "tsx"):
            parts = module.split("/")
            name = "/".join(parts[:2]) if module.startswith("@") else parts[0]
            return self._dep_nodes.get(f"npm:{name}")
        if language == "go":
            best = None
            for key, node in self._dep_nodes.items():
                if key.startswith("go:") and module.startswith(key[3:]) and (best is None or len(key) > len(best[0])):
                    best = (key, node)
            return best[1] if best else None
        if language == "java":
            for key, node in self._dep_nodes.items():
                if key.startswith("maven:"):
                    group = key[6:].split(":")[0]
                    if group and module.startswith(group):
                        return node
        return None

    # ------------------------------------------------------------------ bases
    def _resolve_bases(self, fx: FileExtraction) -> None:
        for b in fx.bases:
            cls_id, base = b["class"], b["base"]
            if base.startswith("table:"):
                t = self._tables_by_name.get(base[6:])
                if t is not None:
                    self.g.add_edge(Edge(cls_id, t.id, EdgeKind.QUERIES, {"relation": "references"}))
                continue
            name = base.split(".")[-1]
            target = self._pick(name, fx.path, kinds={NodeKind.CLASS})
            if target is not None and target.id != cls_id:
                kind = EdgeKind.IMPLEMENTS if b.get("kind") == "implements" else EdgeKind.EXTENDS
                self.g.add_edge(Edge(cls_id, target.id, kind))

    # ------------------------------------------------------------------ calls
    def _resolve_calls(self, fx: FileExtraction) -> None:
        seen: set[tuple[str, str]] = set()
        for c in fx.calls:
            caller = c["caller"]
            if "table" in c:
                t = self._tables_by_name.get(c["table"])
                if t is not None:
                    self.g.add_edge(Edge(caller, t.id, EdgeKind.QUERIES))
                continue
            callee = c.get("callee") or ""
            if not callee or (caller, callee) in seen:
                continue
            seen.add((caller, callee))
            target = self._pick(callee, fx.path, kinds=_CALLABLE, receiver=c.get("receiver"))
            if target is None or target.id == caller:
                continue
            meta = {"line": c.get("line")}
            if c.get("handler_for"):
                meta["handler_for"] = c["handler_for"]
            self.g.add_edge(Edge(caller, target.id, EdgeKind.CALLS, meta))

    def _pick(self, name: str, from_path: str, kinds: set[NodeKind], receiver: str | None = None) -> Node | None:
        """Heuristic symbol resolution.

        Tiers: same file > files imported by the caller > unique global. A call with a receiver
        (`obj.method()`) only resolves to a METHOD whose class name relates to the receiver, or to a
        plain function/class whose module name matches the receiver (`stack.detect_stack()`).
        `session.get()` must never resolve to `GraphCache.get` just because both are in scope.
        """
        bare = receiver is None or receiver in ("self", "this", "cls")
        local = [n for n in self._symbols_by_file[from_path].get(name, []) if n.kind in kinds]
        if receiver in ("self", "this", "cls"):
            methods = [n for n in local if n.kind == NodeKind.METHOD]
            if methods:
                return methods[0]
        imported = self._file_imports.get(from_path, set())
        from_imports = [n for n in self._symbols_by_name.get(name, []) if n.kind in kinds and n.path in imported]
        globals_ = [n for n in self._symbols_by_name.get(name, []) if n.kind in kinds]
        if bare:
            if local:
                return local[0]
            if from_imports:
                return from_imports[0]
            return globals_[0] if len(globals_) == 1 else None
        lang = _LANG_FAMILY.get(self._file_by_path[from_path].language, "")
        for tier in (local, from_imports):
            hit = self._match_receiver(tier, receiver, lang)
            if hit is not None:
                return hit
        if len(globals_) <= _MAX_CANDIDATES:
            return self._match_receiver(globals_, receiver, lang)
        return None

    @staticmethod
    def _match_receiver(candidates: list[Node], receiver: str | None, lang: str) -> Node | None:
        if not candidates or not receiver:
            return None
        r = receiver.split(".")[-1].split("(")[0].lower().replace("_", "")
        if not r:
            return None
        for n in candidates:
            if _LANG_FAMILY.get(n.language, "") != lang:
                continue  # a TS `api.graph.search()` must not resolve to a Python `graph.py::search`
            if n.kind == NodeKind.METHOD:
                cls = str(n.meta.get("class") or n.meta.get("receiver") or "").lower().replace("_", "")
                if cls and (cls == r or cls.startswith(r) or r.startswith(cls) or r.endswith(cls)):
                    return n
            else:
                module = n.path.rsplit("/", 1)[-1].split(".")[0].lower().replace("_", "")
                if module and module == r:
                    return n
        return None

    # ------------------------------------------------------------------ stats
    def _compute_stats(self) -> None:
        kinds: dict[str, int] = defaultdict(int)
        for n in self.g.nodes.values():
            kinds[str(n.kind)] += 1
        ekinds: dict[str, int] = defaultdict(int)
        for e in self.g.edges.values():
            ekinds[str(e.kind)] += 1
        self.g.stats = {
            "nodes": len(self.g.nodes),
            "edges": len(self.g.edges),
            **{f"node_{k}": v for k, v in kinds.items()},
            **{f"edge_{k}": v for k, v in ekinds.items()},
        }


def build_repo_graph(
    repo_name: str,
    extractions: list[FileExtraction],
    deps: list[Dependency],
    go_module: str = "",
    manifest_paths: list[str] | None = None,
) -> BuiltGraph:
    b = GraphBuilder(repo_name, go_module=go_module)
    b.add_dependencies(deps)
    for fx in extractions:
        b.add_file(fx)
    g = b.build()
    # A directory holding a package manifest is a package/service root: the map treats it as a component.
    for mp in manifest_paths or []:
        d = posixpath.dirname(mp)
        if d:
            node = g.nodes.get(make_id(NodeKind.DIRECTORY, d, d))
            if node is not None:
                node.meta.setdefault("manifests", []).append(posixpath.basename(mp))
    return g


__all__ = ["BuiltGraph", "GraphBuilder", "build_repo_graph", "make_id"]

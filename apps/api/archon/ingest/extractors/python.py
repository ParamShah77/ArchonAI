"""Python extractor: classes, functions, methods, imports, calls, FastAPI/Flask/Django routes, ORM tables."""

from __future__ import annotations

import re
import sys

from tree_sitter import Node as TSNode

from archon.graph.model import Edge, EdgeKind, FileExtraction, Node, NodeKind
from archon.ingest.extractors.base import Extractor
from archon.ingest.parsing import line_span, node_text

sys.setrecursionlimit(max(sys.getrecursionlimit(), 10000))

_ROUTE_DECORATOR = re.compile(
    r"@?(?P<obj>[\w.]+)\.(?P<method>get|post|put|patch|delete|options|head|route|api_route|websocket)"
    r"\(\s*[\"'](?P<route>[^\"']*)[\"']",
)
_METHODS_KW = re.compile(r"methods\s*=\s*[\[(]([^\])]*)[\])]")
_DJANGO_PATH = re.compile(r"\b(?:path|re_path|url)\(\s*r?[\"']([^\"']*)[\"']\s*,\s*([\w.]+)")
_ROUTER_PREFIX = re.compile(
    r"(?P<var>\w+)\s*=\s*(?:APIRouter|Blueprint)\([^)]*?(?:prefix|url_prefix)\s*=\s*[\"'](?P<prefix>[^\"']*)[\"']"
)
# A class is an ORM model (-> TABLE node) only if it declares __tablename__ or directly extends one of
# these. Deliberately excludes pydantic's BaseModel and any "*Base" naming convention: those are DTOs.
_ORM_BASES = {"Model", "Base", "db.Model", "models.Model", "SQLModel", "Document", "BaseTable"}


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


class PythonExtractor(Extractor):
    language = "python"

    def module_name(self, rel_path: str) -> str:
        mod = rel_path[:-3] if rel_path.endswith(".py") else rel_path
        if mod.endswith("/__init__"):
            mod = mod[: -len("/__init__")]
        return mod.replace("/", ".")

    def visit(self, root: TSNode, source: bytes, fx: FileExtraction, file_node: Node) -> None:
        text = source.decode("utf-8", errors="ignore")
        # router = APIRouter(prefix="/repos") / bp = Blueprint(..., url_prefix="/x") -> prefix its routes
        self._prefixes = {m.group("var"): m.group("prefix") for m in _ROUTER_PREFIX.finditer(text)}
        self._walk(root, source, fx, owner=file_node, cls=None)
        # Django URLconf: path("x/", views.foo) -> endpoint attached to the file
        if re.search(r"^\s*urlpatterns\s*[=+]", text, re.MULTILINE):
            for m in _DJANGO_PATH.finditer(text):
                line = text[: m.start()].count("\n") + 1
                ep = self._endpoint_at(fx, file_node, "ANY", "/" + m.group(1).lstrip("/"), line, handler_ref=m.group(2))
                fx.calls.append({"caller": ep.id, "callee": m.group(2).split(".")[-1], "receiver": None, "line": line})

    # ------------------------------------------------------------------
    def _walk(self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, cls: Node | None) -> None:
        for child in node.children:
            t = child.type
            if t == "decorated_definition":
                self._decorated(child, source, fx, owner, cls)
            elif t == "class_definition":
                self._class(child, source, fx, owner)
            elif t == "function_definition":
                self._function(child, source, fx, owner, cls)
            elif t in ("import_statement", "import_from_statement"):
                self._import(child, source, fx)
            elif t == "call":
                self._call(child, source, fx, owner)
                self._walk(child, source, fx, owner, cls)
            elif t in ("string", "concatenated_string"):
                self.record_sql(fx, owner, node_text(child, source))
            else:
                self._walk(child, source, fx, owner, cls)

    def _decorated(self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, cls: Node | None) -> None:
        decorators = [node_text(c, source) for c in node.children if c.type == "decorator"]
        definition = node.child_by_field_name("definition")
        if definition is None:
            return
        created: Node | None = None
        if definition.type == "function_definition":
            created = self._function(definition, source, fx, owner, cls, decorators=decorators)
        elif definition.type == "class_definition":
            created = self._class(definition, source, fx, owner, decorators=decorators)
        if created is None:
            return
        for deco in decorators:
            m = _ROUTE_DECORATOR.search(deco)
            if not m:
                continue
            method = m.group("method")
            if method in ("route", "api_route"):
                mk = _METHODS_KW.search(deco)
                methods = [s.strip(" \"'").upper() for s in mk.group(1).split(",")] if mk else ["GET"]
            elif method == "websocket":
                methods = ["WS"]
            else:
                methods = [method.upper()]
            prefix = getattr(self, "_prefixes", {}).get(m.group("obj").split(".")[0], "")
            route = (prefix.rstrip("/") + "/" + m.group("route").lstrip("/")).rstrip("/") or "/"
            for mth in methods:
                if mth:
                    self.add_endpoint(fx, created, mth, route, node)

    def _class(
        self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, decorators: list[str] | None = None
    ) -> Node | None:
        name_n = node.child_by_field_name("name")
        if name_n is None:
            return None
        name = node_text(name_n, source)
        bases: list[str] = []
        sup = node.child_by_field_name("superclasses")
        if sup is not None:
            bases = [node_text(c, source) for c in sup.children if c.type in ("identifier", "attribute", "subscript")]
        cls = self.add_symbol(
            fx,
            owner,
            NodeKind.CLASS,
            name,
            node,
            qualified=f"{fx.path}::{name}",
            meta={"bases": bases, "decorators": decorators or []},
        )
        for b in bases:
            fx.bases.append({"class": cls.id, "base": b.split("[")[0]})
        body = node.child_by_field_name("body")
        table_name = self._tablename(body, source) if body is not None else None
        is_orm_model = table_name is not None or any(b in _ORM_BASES for b in bases)
        if is_orm_model and "dataclass" not in " ".join(decorators or []):
            self._table(fx, cls, table_name or _snake(name), node)
        if body is not None:
            self._walk(body, source, fx, owner=cls, cls=cls)
        return cls

    def _function(
        self,
        node: TSNode,
        source: bytes,
        fx: FileExtraction,
        owner: Node,
        cls: Node | None,
        decorators: list[str] | None = None,
    ) -> Node | None:
        name_n = node.child_by_field_name("name")
        if name_n is None:
            return None
        name = node_text(name_n, source)
        kind = NodeKind.METHOD if cls is not None else NodeKind.FUNCTION
        qualified = f"{fx.path}::{cls.name}.{name}" if cls is not None else f"{fx.path}::{name}"
        if owner.kind in (NodeKind.FUNCTION, NodeKind.METHOD):
            qualified = f"{owner.qualified_name}.{name}"
        params = node.child_by_field_name("parameters")
        is_async = any(c.type == "async" for c in node.children) or node_text(node, source).startswith("async ")
        fn = self.add_symbol(
            fx,
            owner,
            kind,
            name,
            node,
            qualified=qualified,
            meta={
                "params": node_text(params, source) if params is not None else "()",
                "async": is_async,
                "decorators": decorators or [],
                "class": cls.name if cls is not None else None,
            },
        )
        body = node.child_by_field_name("body")
        if body is not None:
            self._walk(body, source, fx, owner=fn, cls=cls)
        return fn

    def _import(self, node: TSNode, source: bytes, fx: FileExtraction) -> None:
        line = line_span(node)[0]
        if node.type == "import_statement":
            for c in node.children:
                if c.type == "dotted_name":
                    fx.imports.append({"module": node_text(c, source), "names": [], "level": 0, "line": line})
                elif c.type == "aliased_import":
                    nm = c.child_by_field_name("name")
                    if nm is not None:
                        fx.imports.append({"module": node_text(nm, source), "names": [], "level": 0, "line": line})
            return
        mod_n = node.child_by_field_name("module_name")
        module, level = "", 0
        if mod_n is not None:
            raw = node_text(mod_n, source)
            level = len(raw) - len(raw.lstrip("."))
            module = raw.lstrip(".")
        names: list[str] = []
        for c in node.children_by_field_name("name"):
            if c.type == "dotted_name":
                names.append(node_text(c, source))
            elif c.type == "aliased_import":
                nm = c.child_by_field_name("name")
                if nm is not None:
                    names.append(node_text(nm, source))
        if any(c.type == "wildcard_import" for c in node.children):
            names.append("*")
        fx.imports.append({"module": module, "names": names, "level": level, "line": line})

    def _call(self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node) -> None:
        fn = node.child_by_field_name("function")
        if fn is None:
            return
        line = line_span(node)[0]
        if fn.type == "identifier":
            fx.calls.append({"caller": owner.id, "callee": node_text(fn, source), "receiver": None, "line": line})
        elif fn.type == "attribute":
            attr = fn.child_by_field_name("attribute")
            obj = fn.child_by_field_name("object")
            if attr is not None:
                fx.calls.append(
                    {
                        "caller": owner.id,
                        "callee": node_text(attr, source),
                        "receiver": node_text(obj, source) if obj is not None else None,
                        "line": line,
                    }
                )

    # ------------------------------------------------------------------
    @staticmethod
    def _tablename(body: TSNode, source: bytes) -> str | None:
        for stmt in body.children:
            asg = stmt
            if stmt.type == "expression_statement" and stmt.children:
                asg = stmt.children[0]
            if asg.type != "assignment":
                continue
            left = asg.child_by_field_name("left")
            right = asg.child_by_field_name("right")
            if left is not None and right is not None and node_text(left, source) == "__tablename__":
                return node_text(right, source).strip("\"'")
        return None

    def _table(self, fx: FileExtraction, cls: Node, table_name: str, ts: TSNode) -> None:
        start, end = line_span(ts)
        t = Node.create(
            NodeKind.TABLE,
            name=table_name,
            path=fx.path,
            qualified_name=f"table:{table_name}",
            language=fx.language,
            start_line=start,
            end_line=end,
            meta={"model": cls.name, "orm": True},
        )
        fx.nodes.append(t)
        fx.edges.append(Edge(cls.id, t.id, EdgeKind.CONTAINS, {"role": "model"}))

    @staticmethod
    def _endpoint_at(fx: FileExtraction, handler: Node, method: str, route: str, line: int, handler_ref: str) -> Node:
        label = f"{method} {route}"
        n = Node.create(
            NodeKind.ENDPOINT,
            name=label,
            path=fx.path,
            qualified_name=f"{fx.path}::{label}",
            language=fx.language,
            start_line=line,
            end_line=line,
            meta={"method": method, "route": route, "handler": handler_ref},
        )
        fx.nodes.append(n)
        fx.edges.append(Edge(handler.id, n.id, EdgeKind.EXPOSES))
        return n

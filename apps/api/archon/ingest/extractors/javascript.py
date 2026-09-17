"""JavaScript / TypeScript / TSX extractor.

Covers functions, arrow functions bound to variables, classes, methods, ES imports,
require(), Express-style routes, NestJS decorators, and Next.js route handlers.
"""

from __future__ import annotations

import re
import sys

from tree_sitter import Node as TSNode

from archon.graph.model import FileExtraction, Node, NodeKind
from archon.ingest.extractors.base import HTTP_METHODS, Extractor
from archon.ingest.parsing import line_span, node_text

sys.setrecursionlimit(max(sys.getrecursionlimit(), 10000))

_ROUTER_NAMES = {"app", "router", "server", "api", "route", "r", "fastify", "koa", "express"}
_NEST_DECORATOR = re.compile(r"@(Get|Post|Put|Patch|Delete|All|Controller)\(\s*(?:[\"'`]([^\"'`]*)[\"'`])?")
_NEXT_APP_ROUTE = re.compile(r"(?:^|/)app/(.*/)?route\.(ts|js|tsx|jsx)$")
_NEXT_PAGES_API = re.compile(r"(?:^|/)pages/api/(.+)\.(ts|js)$")
_FUNCTION_TYPES = {"function_declaration", "generator_function_declaration"}
_FUNC_VALUE_TYPES = {"arrow_function", "function_expression", "function", "generator_function"}
_CLASS_TYPES = {"class_declaration", "abstract_class_declaration", "class"}
_STRING_TYPES = {"string", "template_string"}


class JavaScriptExtractor(Extractor):
    def __init__(self, language: str) -> None:
        self.language = language

    def module_name(self, rel_path: str) -> str:
        return re.sub(r"\.(m|c)?(j|t)sx?$", "", rel_path)

    def visit(self, root: TSNode, source: bytes, fx: FileExtraction, file_node: Node) -> None:
        self._walk(root, source, fx, owner=file_node, cls=None, prefix="")
        self._next_routes(fx, file_node)

    # ------------------------------------------------------------------
    def _walk(
        self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, cls: Node | None, prefix: str
    ) -> None:
        for child in node.children:
            t = child.type
            if t == "export_statement":
                self._walk(child, source, fx, owner, cls, prefix)
            elif t in _FUNCTION_TYPES:
                self._function(child, source, fx, owner, cls, prefix)
            elif t in _CLASS_TYPES:
                self._class(child, source, fx, owner, prefix)
            elif t == "interface_declaration":
                self._interface(child, source, fx, owner)
            elif t == "method_definition":
                self._method(child, source, fx, owner, cls, prefix)
            elif t in ("lexical_declaration", "variable_declaration"):
                self._variable(child, source, fx, owner, cls, prefix)
            elif t == "import_statement":
                self._import(child, source, fx)
            elif t == "call_expression":
                self._call(child, source, fx, owner, cls, prefix)
            elif t in _STRING_TYPES:
                self.record_sql(fx, owner, node_text(child, source))
            else:
                self._walk(child, source, fx, owner, cls, prefix)

    def _decorators(self, node: TSNode, source: bytes) -> list[str]:
        decos = [node_text(c, source) for c in node.children if c.type == "decorator"]
        # decorators of an exported class live on the export_statement
        parent = node.parent
        if parent is not None and parent.type == "export_statement":
            decos += [node_text(c, source) for c in parent.children if c.type == "decorator"]
        return decos

    def _function(
        self,
        node: TSNode,
        source: bytes,
        fx: FileExtraction,
        owner: Node,
        cls: Node | None,
        prefix: str,
        name: str | None = None,
    ) -> Node | None:
        if name is None:
            name_n = node.child_by_field_name("name")
            if name_n is None:
                return None
            name = node_text(name_n, source)
        qualified = f"{owner.qualified_name}.{name}" if owner.kind != NodeKind.FILE else f"{fx.path}::{name}"
        params = node.child_by_field_name("parameters") or node.child_by_field_name("parameter")
        exported = node.parent is not None and node.parent.type == "export_statement"
        fn = self.add_symbol(
            fx,
            owner,
            NodeKind.FUNCTION,
            name,
            node,
            qualified=qualified,
            meta={
                "params": node_text(params, source) if params is not None else "()",
                "async": node_text(node, source).lstrip().startswith("async"),
                "exported": exported,
            },
        )
        body = node.child_by_field_name("body")
        if body is not None:
            self._walk(body, source, fx, owner=fn, cls=cls, prefix=prefix)
        return fn

    def _variable(
        self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, cls: Node | None, prefix: str
    ) -> None:
        for decl in node.children:
            if decl.type != "variable_declarator":
                continue
            name_n = decl.child_by_field_name("name")
            value = decl.child_by_field_name("value")
            if name_n is None or value is None:
                continue
            if value.type in _FUNC_VALUE_TYPES:
                self._function(value, source, fx, owner, cls, prefix, name=node_text(name_n, source))
            elif value.type == "call_expression":
                self._call(value, source, fx, owner, cls, prefix)
            else:
                self._walk(decl, source, fx, owner, cls, prefix)

    def _class(self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, prefix: str) -> Node | None:
        name_n = node.child_by_field_name("name")
        name = node_text(name_n, source) if name_n is not None else "AnonymousClass"
        decorators = self._decorators(node, source)
        bases: list[str] = []
        implements: list[str] = []
        for c in node.children:
            if c.type == "class_heritage":
                for h in c.children:
                    if h.type == "extends_clause":
                        bases += [
                            node_text(x, source)
                            for x in h.children
                            if x.type in ("identifier", "member_expression", "generic_type")
                        ]
                    elif h.type == "implements_clause":
                        implements += [
                            node_text(x, source) for x in h.children if x.type in ("type_identifier", "generic_type")
                        ]
                    elif h.type in ("identifier", "member_expression"):
                        bases.append(node_text(h, source))
        cls = self.add_symbol(
            fx,
            owner,
            NodeKind.CLASS,
            name,
            node,
            qualified=f"{fx.path}::{name}",
            meta={"bases": bases, "implements": implements, "decorators": decorators},
        )
        for b in bases:
            fx.bases.append({"class": cls.id, "base": b.split("<")[0]})
        for i in implements:
            fx.bases.append({"class": cls.id, "base": i.split("<")[0], "kind": "implements"})
        class_prefix = prefix
        for d in decorators:
            m = _NEST_DECORATOR.search(d)
            if m and m.group(1) == "Controller":
                class_prefix = prefix + "/" + (m.group(2) or "").strip("/")
        if any("@Entity" in d for d in decorators):
            self._entity(fx, cls, node, decorators)
        body = node.child_by_field_name("body")
        if body is not None:
            self._walk(body, source, fx, owner=cls, cls=cls, prefix=class_prefix)
        return cls

    def _interface(self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node) -> None:
        name_n = node.child_by_field_name("name")
        if name_n is None:
            return
        name = node_text(name_n, source)
        self.add_symbol(fx, owner, NodeKind.CLASS, name, node, qualified=f"{fx.path}::{name}", meta={"interface": True})

    def _method(
        self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, cls: Node | None, prefix: str
    ) -> None:
        name_n = node.child_by_field_name("name")
        if name_n is None:
            return
        name = node_text(name_n, source)
        decorators = self._decorators(node, source)
        qualified = f"{fx.path}::{cls.name}.{name}" if cls is not None else f"{owner.qualified_name}.{name}"
        params = node.child_by_field_name("parameters")
        m = self.add_symbol(
            fx,
            owner,
            NodeKind.METHOD,
            name,
            node,
            qualified=qualified,
            meta={
                "params": node_text(params, source) if params is not None else "()",
                "class": cls.name if cls else None,
                "decorators": decorators,
            },
        )
        for d in decorators:
            dm = _NEST_DECORATOR.search(d)
            if dm and dm.group(1) != "Controller":
                route = prefix + "/" + (dm.group(2) or "").strip("/")
                self.add_endpoint(fx, m, dm.group(1).upper(), route.replace("//", "/") or "/", node)
        body = node.child_by_field_name("body")
        if body is not None:
            self._walk(body, source, fx, owner=m, cls=cls, prefix=prefix)

    def _import(self, node: TSNode, source: bytes, fx: FileExtraction) -> None:
        src = node.child_by_field_name("source")
        if src is None:
            return
        names: list[str] = []
        for c in node.children:
            if c.type == "import_clause":
                for x in c.children:
                    if x.type == "identifier":
                        names.append("default")
                    elif x.type == "namespace_import":
                        names.append("*")
                    elif x.type == "named_imports":
                        for spec in x.children:
                            if spec.type == "import_specifier":
                                nm = spec.child_by_field_name("name")
                                if nm is not None:
                                    names.append(node_text(nm, source))
        fx.imports.append(
            {"module": self.string_value(src, source), "names": names, "level": 0, "line": line_span(node)[0]}
        )

    def _call(
        self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, cls: Node | None, prefix: str
    ) -> None:
        fn = node.child_by_field_name("function")
        args = node.child_by_field_name("arguments")
        line = line_span(node)[0]
        if fn is None:
            return
        arg_nodes = [a for a in args.children if a.is_named] if args is not None else []
        if fn.type == "identifier":
            callee = node_text(fn, source)
            if callee == "require" and arg_nodes and arg_nodes[0].type in _STRING_TYPES:
                fx.imports.append(
                    {"module": self.string_value(arg_nodes[0], source), "names": ["*"], "level": 0, "line": line}
                )
                return
            fx.calls.append({"caller": owner.id, "callee": callee, "receiver": None, "line": line})
        elif fn.type == "member_expression":
            prop = fn.child_by_field_name("property")
            obj = fn.child_by_field_name("object")
            if prop is not None:
                callee = node_text(prop, source)
                receiver = node_text(obj, source) if obj is not None else None
                fx.calls.append({"caller": owner.id, "callee": callee, "receiver": receiver, "line": line})
                if self._is_route_call(callee, receiver, arg_nodes):
                    route = self.string_value(arg_nodes[0], source)
                    handler_owner = owner
                    for a in arg_nodes[1:]:
                        if a.type in _FUNC_VALUE_TYPES:
                            handler_owner = (
                                self._function(
                                    a, source, fx, owner, cls, prefix, name=f"{callee.upper()} {route} handler"
                                )
                                or owner
                            )
                            break
                        if a.type == "identifier":
                            fx.calls.append(
                                {
                                    "caller": owner.id,
                                    "callee": node_text(a, source),
                                    "receiver": None,
                                    "line": line,
                                    "handler_for": f"{callee.upper()} {route}",
                                }
                            )
                    self.add_endpoint(fx, handler_owner, callee if callee != "use" else "USE", route, node)
                    for a in arg_nodes[1:]:
                        if a.type not in _FUNC_VALUE_TYPES:
                            self._walk(a, source, fx, owner, cls, prefix)
                    return
        # descend into arguments / callee expression
        self._walk(node, source, fx, owner, cls, prefix)

    @staticmethod
    def _is_route_call(callee: str, receiver: str | None, args: list[TSNode]) -> bool:
        if callee not in HTTP_METHODS or not args or args[0].type not in _STRING_TYPES or receiver is None:
            return False
        base = receiver.split(".")[-1]
        return base in _ROUTER_NAMES or base.lower().endswith("router") or base.lower().endswith("app")

    def _entity(self, fx: FileExtraction, cls: Node, ts: TSNode, decorators: list[str]) -> None:
        table = cls.name.lower()
        for d in decorators:
            m = re.search(r"@Entity\(\s*[\"'`]([^\"'`]+)[\"'`]", d)
            if m:
                table = m.group(1)
        start, end = line_span(ts)
        from archon.graph.model import Edge, EdgeKind

        t = Node.create(
            NodeKind.TABLE,
            name=table,
            path=fx.path,
            qualified_name=f"table:{table}",
            language=fx.language,
            start_line=start,
            end_line=end,
            meta={"model": cls.name, "orm": True},
        )
        fx.nodes.append(t)
        fx.edges.append(Edge(cls.id, t.id, EdgeKind.CONTAINS, {"role": "model"}))

    def _next_routes(self, fx: FileExtraction, file_node: Node) -> None:
        m = _NEXT_APP_ROUTE.search(fx.path)
        if m:
            route = "/" + (m.group(1) or "").rstrip("/")
            for n in list(fx.nodes):
                if (
                    n.kind == NodeKind.FUNCTION
                    and n.name in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
                    and n.meta.get("exported")
                ):
                    self.add_endpoint(fx, n, n.name, route or "/", _Span(n.start_line, n.end_line))
            return
        m = _NEXT_PAGES_API.search(fx.path)
        if m:
            route = "/api/" + re.sub(r"/index$", "", m.group(1))
            self.add_endpoint(fx, file_node, "ANY", route, _Span(1, file_node.end_line))


class _Span:
    """Minimal stand-in for a tree-sitter node when we only know the line span."""

    def __init__(self, start: int, end: int) -> None:
        self.start_point = (start - 1, 0)
        self.end_point = (end - 1, 0)

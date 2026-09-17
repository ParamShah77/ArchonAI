"""Go extractor: functions, methods (receiver-qualified), structs/interfaces, imports, calls, HTTP routes."""

from __future__ import annotations

import sys

from tree_sitter import Node as TSNode

from archon.graph.model import Edge, EdgeKind, FileExtraction, Node, NodeKind
from archon.ingest.extractors.base import Extractor
from archon.ingest.parsing import line_span, node_text

sys.setrecursionlimit(max(sys.getrecursionlimit(), 10000))

_ROUTE_FUNCS = {
    "HandleFunc": "ANY",
    "Handle": "ANY",
    "GET": "GET",
    "POST": "POST",
    "PUT": "PUT",
    "DELETE": "DELETE",
    "PATCH": "PATCH",
    "Get": "GET",
    "Post": "POST",
    "Put": "PUT",
    "Delete": "DELETE",
    "Patch": "PATCH",
    "Any": "ANY",
}
_STRING_TYPES = {"interpreted_string_literal", "raw_string_literal"}


class GoExtractor(Extractor):
    language = "go"

    def module_name(self, rel_path: str) -> str:
        return rel_path.rsplit("/", 1)[0] if "/" in rel_path else "."

    def visit(self, root: TSNode, source: bytes, fx: FileExtraction, file_node: Node) -> None:
        for c in root.children:
            if c.type == "package_clause":
                for x in c.children:
                    if x.type == "package_identifier":
                        file_node.meta["package"] = node_text(x, source)
        self._walk(root, source, fx, owner=file_node)
        self._attach_methods(fx, file_node)

    def _walk(self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node) -> None:
        for child in node.children:
            t = child.type
            if t == "import_declaration":
                for spec in self._iter_import_specs(child):
                    p = spec.child_by_field_name("path")
                    if p is not None:
                        fx.imports.append(
                            {
                                "module": self.string_value(p, source),
                                "names": ["*"],
                                "level": 0,
                                "line": line_span(spec)[0],
                            }
                        )
            elif t == "function_declaration":
                self._function(child, source, fx, owner, receiver=None)
            elif t == "method_declaration":
                recv = self._receiver_type(child, source)
                self._function(child, source, fx, owner, receiver=recv)
            elif t == "type_declaration":
                for spec in child.children:
                    if spec.type == "type_spec":
                        self._type(spec, source, fx, owner)
            elif t == "call_expression":
                self._call(child, source, fx, owner)
                self._walk(child, source, fx, owner)
            elif t in _STRING_TYPES:
                self.record_sql(fx, owner, node_text(child, source))
            else:
                self._walk(child, source, fx, owner)

    @staticmethod
    def _iter_import_specs(node: TSNode):
        for c in node.children:
            if c.type == "import_spec":
                yield c
            elif c.type == "import_spec_list":
                yield from (x for x in c.children if x.type == "import_spec")

    @staticmethod
    def _receiver_type(node: TSNode, source: bytes) -> str | None:
        recv = node.child_by_field_name("receiver")
        if recv is None:
            return None
        for p in recv.children:
            if p.type == "parameter_declaration":
                typ = p.child_by_field_name("type")
                if typ is not None:
                    return node_text(typ, source).lstrip("*").split("[")[0]
        return None

    def _function(self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, receiver: str | None) -> None:
        name_n = node.child_by_field_name("name")
        if name_n is None:
            return
        name = node_text(name_n, source)
        params = node.child_by_field_name("parameters")
        kind = NodeKind.METHOD if receiver else NodeKind.FUNCTION
        qualified = f"{fx.path}::{receiver}.{name}" if receiver else f"{fx.path}::{name}"
        fn = self.add_symbol(
            fx,
            owner,
            kind,
            name,
            node,
            qualified=qualified,
            meta={
                "params": node_text(params, source) if params is not None else "()",
                "receiver": receiver,
                "exported": name[:1].isupper(),
            },
        )
        body = node.child_by_field_name("body")
        if body is not None:
            self._walk(body, source, fx, owner=fn)

    def _type(self, spec: TSNode, source: bytes, fx: FileExtraction, owner: Node) -> None:
        name_n = spec.child_by_field_name("name")
        typ = spec.child_by_field_name("type")
        if name_n is None or typ is None:
            return
        name = node_text(name_n, source)
        if typ.type not in ("struct_type", "interface_type"):
            return
        embedded: list[str] = []
        if typ.type == "struct_type":
            for fld in typ.children:
                if fld.type == "field_declaration_list":
                    for f in fld.children:
                        if f.type == "field_declaration" and f.child_by_field_name("name") is None:
                            embedded.append(node_text(f, source).lstrip("*").split()[0])
        cls = self.add_symbol(
            fx,
            owner,
            NodeKind.CLASS,
            name,
            spec,
            qualified=f"{fx.path}::{name}",
            meta={"kind": typ.type.replace("_type", ""), "embedded": embedded},
        )
        for e in embedded:
            fx.bases.append({"class": cls.id, "base": e})

    def _call(self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node) -> None:
        fn = node.child_by_field_name("function")
        args = node.child_by_field_name("arguments")
        if fn is None:
            return
        line = line_span(node)[0]
        arg_nodes = [a for a in args.children if a.is_named] if args is not None else []
        if fn.type == "identifier":
            fx.calls.append({"caller": owner.id, "callee": node_text(fn, source), "receiver": None, "line": line})
        elif fn.type == "selector_expression":
            field = fn.child_by_field_name("field")
            operand = fn.child_by_field_name("operand")
            if field is None:
                return
            callee = node_text(field, source)
            receiver = node_text(operand, source) if operand is not None else None
            fx.calls.append({"caller": owner.id, "callee": callee, "receiver": receiver, "line": line})
            if callee in _ROUTE_FUNCS and arg_nodes and arg_nodes[0].type in _STRING_TYPES:
                route = self.string_value(arg_nodes[0], source)
                if route.startswith("/"):
                    for a in arg_nodes[1:]:
                        if a.type in ("identifier", "selector_expression"):
                            fx.calls.append(
                                {
                                    "caller": owner.id,
                                    "callee": node_text(a, source).split(".")[-1],
                                    "receiver": None,
                                    "line": line,
                                    "handler_for": f"{_ROUTE_FUNCS[callee]} {route}",
                                }
                            )
                    self.add_endpoint(fx, owner, _ROUTE_FUNCS[callee], route, node)

    @staticmethod
    def _attach_methods(fx: FileExtraction, file_node: Node) -> None:
        """Re-parent methods under their receiver type when it is declared in the same file."""
        classes = {n.name: n for n in fx.nodes if n.kind == NodeKind.CLASS}
        for n in fx.nodes:
            if n.kind != NodeKind.METHOD:
                continue
            cls = classes.get(n.meta.get("receiver") or "")
            if cls is None:
                continue
            fx.edges = [
                e
                for e in fx.edges
                if not (e.kind == EdgeKind.CONTAINS and e.source == file_node.id and e.target == n.id)
            ]
            fx.edges.append(Edge(cls.id, n.id, EdgeKind.CONTAINS))

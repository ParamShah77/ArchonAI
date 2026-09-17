"""Java extractor: classes/interfaces/enums/records, methods, imports, invocations,
Spring & JAX-RS routes, JPA entities."""

from __future__ import annotations

import re
import sys

from tree_sitter import Node as TSNode

from archon.graph.model import Edge, EdgeKind, FileExtraction, Node, NodeKind
from archon.ingest.extractors.base import Extractor
from archon.ingest.parsing import line_span, node_text

sys.setrecursionlimit(max(sys.getrecursionlimit(), 10000))

_SRC_ROOTS = re.compile(r"^(?:.*?/)?src/(?:main|test)/(?:java|kotlin)/")
_MAPPING = re.compile(
    r"@(Get|Post|Put|Patch|Delete|Request)Mapping\s*(?:\(\s*(?:value\s*=|path\s*=)?\s*\{?\s*\"([^\"]*)\"[^)]*\))?"
)
_REQUEST_METHOD = re.compile(r"RequestMethod\.(\w+)")
_JAXRS_PATH = re.compile(r"@Path\(\s*\"([^\"]*)\"")
_JAXRS_METHODS = {"@GET", "@POST", "@PUT", "@DELETE", "@PATCH", "@HEAD", "@OPTIONS"}
_TABLE = re.compile(r"@Table\s*\([^)]*name\s*=\s*\"([^\"]+)\"")
_TYPE_DECLS = {
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "annotation_type_declaration",
}


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


class JavaExtractor(Extractor):
    language = "java"

    def module_name(self, rel_path: str) -> str:
        p = _SRC_ROOTS.sub("", rel_path)
        return re.sub(r"\.java$", "", p).replace("/", ".")

    def visit(self, root: TSNode, source: bytes, fx: FileExtraction, file_node: Node) -> None:
        for c in root.children:
            if c.type == "package_declaration":
                for x in c.children:
                    if x.type in ("scoped_identifier", "identifier"):
                        file_node.meta["package"] = node_text(x, source)
        self._walk(root, source, fx, owner=file_node, cls=None, prefix="")

    def _walk(
        self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, cls: Node | None, prefix: str
    ) -> None:
        for child in node.children:
            t = child.type
            if t == "import_declaration":
                ident = next((x for x in child.children if x.type in ("scoped_identifier", "identifier")), None)
                if ident is not None:
                    wildcard = any(x.type == "asterisk" for x in child.children)
                    fx.imports.append(
                        {
                            "module": node_text(ident, source),
                            "names": ["*"] if wildcard else [],
                            "level": 0,
                            "line": line_span(child)[0],
                        }
                    )
            elif t in _TYPE_DECLS:
                self._type(child, source, fx, owner, prefix)
            elif t in ("method_declaration", "constructor_declaration"):
                self._method(child, source, fx, owner, cls, prefix)
            elif t == "method_invocation":
                self._invocation(child, source, fx, owner)
                self._walk(child, source, fx, owner, cls, prefix)
            elif t == "object_creation_expression":
                typ = child.child_by_field_name("type")
                if typ is not None:
                    fx.calls.append(
                        {
                            "caller": owner.id,
                            "callee": node_text(typ, source).split("<")[0].split(".")[-1],
                            "receiver": "new",
                            "line": line_span(child)[0],
                        }
                    )
                self._walk(child, source, fx, owner, cls, prefix)
            elif t in ("string_literal", "text_block"):
                self.record_sql(fx, owner, node_text(child, source))
            else:
                self._walk(child, source, fx, owner, cls, prefix)

    @staticmethod
    def _annotations(node: TSNode, source: bytes) -> list[str]:
        out: list[str] = []
        for c in node.children:
            if c.type == "modifiers":
                out += [node_text(a, source) for a in c.children if a.type in ("annotation", "marker_annotation")]
        return out

    def _type(self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, prefix: str) -> None:
        name_n = node.child_by_field_name("name")
        if name_n is None:
            return
        name = node_text(name_n, source)
        annotations = self._annotations(node, source)
        bases: list[str] = []
        implements: list[str] = []
        sup = node.child_by_field_name("superclass")
        if sup is not None:
            bases += [
                node_text(x, source).split("<")[0]
                for x in sup.children
                if x.type in ("type_identifier", "generic_type", "scoped_type_identifier")
            ]
        ifaces = node.child_by_field_name("interfaces")
        if ifaces is not None:
            for tl in ifaces.children:
                if tl.type == "type_list":
                    implements += [node_text(x, source).split("<")[0] for x in tl.children if x.is_named]
        if node.type == "interface_declaration":
            for c in node.children:
                if c.type == "extends_interfaces":
                    for tl in c.children:
                        if tl.type == "type_list":
                            bases += [node_text(x, source).split("<")[0] for x in tl.children if x.is_named]
        cls = self.add_symbol(
            fx,
            owner,
            NodeKind.CLASS,
            name,
            node,
            qualified=f"{fx.path}::{name}",
            meta={
                "kind": node.type.replace("_declaration", ""),
                "bases": bases,
                "implements": implements,
                "annotations": annotations,
            },
        )
        for b in bases:
            fx.bases.append({"class": cls.id, "base": b})
        for i in implements:
            fx.bases.append({"class": cls.id, "base": i, "kind": "implements"})
        class_prefix = prefix
        for a in annotations:
            m = _MAPPING.search(a)
            if m and m.group(1) == "Request" and m.group(2) is not None:
                class_prefix = prefix + "/" + m.group(2).strip("/")
            jm = _JAXRS_PATH.search(a)
            if jm:
                class_prefix = prefix + "/" + jm.group(1).strip("/")
        if any(a.startswith("@Entity") for a in annotations):
            table = _snake(name)
            for a in annotations:
                tm = _TABLE.search(a)
                if tm:
                    table = tm.group(1)
            start, end = line_span(node)
            t = Node.create(
                NodeKind.TABLE,
                name=table,
                path=fx.path,
                qualified_name=f"table:{table}",
                language=fx.language,
                start_line=start,
                end_line=end,
                meta={"model": name, "orm": True},
            )
            fx.nodes.append(t)
            fx.edges.append(Edge(cls.id, t.id, EdgeKind.CONTAINS, {"role": "model"}))
        body = node.child_by_field_name("body")
        if body is not None:
            self._walk(body, source, fx, owner=cls, cls=cls, prefix=class_prefix)

    def _method(
        self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node, cls: Node | None, prefix: str
    ) -> None:
        name_n = node.child_by_field_name("name")
        if name_n is None:
            return
        name = node_text(name_n, source)
        annotations = self._annotations(node, source)
        params = node.child_by_field_name("parameters")
        qualified = f"{fx.path}::{cls.name}.{name}" if cls is not None else f"{fx.path}::{name}"
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
                "annotations": annotations,
            },
        )
        jaxrs_methods = [a.strip("@") for a in annotations if a in _JAXRS_METHODS]
        for a in annotations:
            mm = _MAPPING.search(a)
            if mm:
                route = (prefix + "/" + (mm.group(2) or "").strip("/")).replace("//", "/") or "/"
                if mm.group(1) == "Request":
                    methods = _REQUEST_METHOD.findall(a) or ["ANY"]
                else:
                    methods = [mm.group(1).upper()]
                for http in methods:
                    self.add_endpoint(fx, m, http, route.rstrip("/") or "/", node)
            jm = _JAXRS_PATH.search(a)
            if jm and jaxrs_methods:
                route = (prefix + "/" + jm.group(1).strip("/")).replace("//", "/")
                for http in jaxrs_methods:
                    self.add_endpoint(fx, m, http, route.rstrip("/") or "/", node)
        if jaxrs_methods and not any(_JAXRS_PATH.search(a) for a in annotations):
            for http in jaxrs_methods:
                self.add_endpoint(fx, m, http, prefix or "/", node)
        body = node.child_by_field_name("body")
        if body is not None:
            self._walk(body, source, fx, owner=m, cls=cls, prefix=prefix)

    def _invocation(self, node: TSNode, source: bytes, fx: FileExtraction, owner: Node) -> None:
        name_n = node.child_by_field_name("name")
        obj = node.child_by_field_name("object")
        if name_n is None:
            return
        fx.calls.append(
            {
                "caller": owner.id,
                "callee": node_text(name_n, source),
                "receiver": node_text(obj, source) if obj is not None else None,
                "line": line_span(node)[0],
            }
        )

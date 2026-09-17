"""tree-sitter parsing (decisions.md D-002)."""

from __future__ import annotations

from functools import lru_cache

from tree_sitter import Node, Parser, Tree
from tree_sitter_language_pack import get_parser

PARSEABLE = {"python", "javascript", "typescript", "tsx", "go", "java"}


@lru_cache(maxsize=16)
def parser_for(language: str) -> Parser:
    return get_parser(language)  # type: ignore[arg-type]


def parse_source(language: str, source: bytes) -> Tree:
    return parser_for(language).parse(source)


def node_text(node: Node, source: bytes) -> str:
    return source[node.start_byte : node.end_byte].decode("utf-8", errors="ignore")


def walk(node: Node):
    """Pre-order traversal without recursion (deep trees blow the stack)."""
    stack = [node]
    while stack:
        n = stack.pop()
        yield n
        stack.extend(reversed(n.children))


def line_span(node: Node) -> tuple[int, int]:
    return node.start_point[0] + 1, node.end_point[0] + 1

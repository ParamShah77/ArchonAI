"""Language extractors: tree-sitter tree -> FileExtraction (nodes, edges, unresolved refs)."""

from __future__ import annotations

from archon.graph.model import FileExtraction
from archon.ingest.extractors.base import Extractor
from archon.ingest.extractors.go import GoExtractor
from archon.ingest.extractors.java import JavaExtractor
from archon.ingest.extractors.javascript import JavaScriptExtractor
from archon.ingest.extractors.python import PythonExtractor
from archon.ingest.extractors.sql import extract_prisma, extract_sql

_EXTRACTORS: dict[str, Extractor] = {
    "python": PythonExtractor(),
    "javascript": JavaScriptExtractor("javascript"),
    "typescript": JavaScriptExtractor("typescript"),
    "tsx": JavaScriptExtractor("tsx"),
    "go": GoExtractor(),
    "java": JavaExtractor(),
}


def extract_file(rel_path: str, language: str, source: bytes) -> FileExtraction | None:
    if language == "sql":
        return extract_sql(rel_path, source)
    if language == "prisma":
        return extract_prisma(rel_path, source)
    ext = _EXTRACTORS.get(language)
    if ext is None:
        return None
    return ext.extract(rel_path, source)

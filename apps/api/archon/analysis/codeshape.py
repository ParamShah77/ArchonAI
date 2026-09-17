"""Lightweight structural facts about a function body (shared by performance & debt analyzers)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from archon.graph.model import Node

_LOOP = {
    "python": re.compile(r"^\s*(for|while)\b.*:\s*(#.*)?$"),
    "js": re.compile(r"^\s*(for|while)\b.*\(|\.(forEach|map|filter|reduce|flatMap)\s*\("),
    "go": re.compile(r"^\s*for\b"),
    "java": re.compile(r"^\s*(for|while)\b\s*\("),
}
_BRANCH = re.compile(r"^\s*(if|elif|else|for|while|try|except|catch|switch|case|with)\b")
_QUERY_CALL = re.compile(
    r"(?i)\b(execute|executemany|fetch(all|one|many)?|query|find(One|Many|ById|All)?|filter|select|get_or_create|"
    r"first|all|count|save|create|update|delete|insert|aggregate|findOne|findMany|findUnique|upsert)\s*\(|"
    r"\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b"
)
_HTTP_CALL = re.compile(
    r"\b(requests\.(get|post|put|delete|patch)|httpx\.(get|post)|urlopen|fetch|axios\.\w+|http\.Get|http\.Post)\s*\("
)
_SYNC_SLEEP = re.compile(r"\btime\.sleep\(|\bsleep\(")
_STR_CONCAT_LOOP = re.compile(r"^\s*\w+\s*\+=\s*[\"'`f]|^\s*\w+\s*=\s*\w+\s*\+\s*[\"'`]")
_REGEX_COMPILE = re.compile(r"re\.compile\(|new RegExp\(|Pattern\.compile\(|regexp\.(Must)?Compile\(")
_SELECT_STAR = re.compile(r"(?i)\bSELECT\s+\*\s+FROM\b")
_NO_LIMIT_SELECT = re.compile(
    r"(?i)[\"'`]\s*SELECT\b(?![^\"'`]*\b(LIMIT|TOP|FETCH FIRST|WHERE\s+\w+\s*=\s*[?:$%])\b)[^\"'`]*FROM\b[^\"'`]*[\"'`]"
)
_AWAIT = re.compile(r"\bawait\b")
_TODO = re.compile(r"\b(TODO|FIXME|HACK|XXX)\b")
_MAGIC = re.compile(r"(?<![\w.])(?!0\b|1\b|2\b|10\b|100\b|1000\b)\d{2,}(?![\w.])")


def lang_family(language: str) -> str:
    if language == "python":
        return "python"
    if language in ("javascript", "typescript", "tsx"):
        return "js"
    return language if language in ("go", "java") else "js"


@dataclass(slots=True)
class Shape:
    lines: int = 0
    code_lines: int = 0
    max_nesting: int = 0
    branches: int = 0
    loops: int = 0
    max_loop_depth: int = 0
    queries_in_loop: list[int] = field(default_factory=list)
    http_in_loop: list[int] = field(default_factory=list)
    awaits_in_loop: list[int] = field(default_factory=list)
    sync_sleep_in_async: list[int] = field(default_factory=list)
    sync_http_in_async: list[int] = field(default_factory=list)
    str_concat_in_loop: list[int] = field(default_factory=list)
    regex_compile_in_loop: list[int] = field(default_factory=list)
    select_star: list[int] = field(default_factory=list)
    unbounded_select: list[int] = field(default_factory=list)
    todos: list[int] = field(default_factory=list)
    params: int = 0
    returns: int = 0
    cyclomatic: int = 1


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" \t"))


def analyze_body(node: Node, source: str) -> Shape:
    """Approximate, language-agnostic body analysis based on indentation (python) or braces (others)."""
    fam = lang_family(node.language)
    lines = source.splitlines()
    sh = Shape(lines=len(lines))
    is_async = bool(node.meta.get("async"))
    params = str(node.meta.get("params", ""))
    sh.params = (
        len([p for p in params.strip("()").split(",") if p.strip() and p.strip() not in ("self", "cls")])
        if params
        else 0
    )
    base_indent = _indent(lines[0]) if lines else 0
    loop_stack: list[int] = []  # indentation levels (python) or brace depth (others) where loops opened
    depth = 0
    loop_rx = _LOOP.get(fam, _LOOP["js"])
    for i, line in enumerate(lines, start=node.start_line):
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "//", "*", "/*")):
            if _TODO.search(stripped):
                sh.todos.append(i)
            continue
        sh.code_lines += 1
        if _TODO.search(stripped):
            sh.todos.append(i)
        if fam == "python":
            ind = _indent(line)
            depth = max(0, (ind - base_indent) // 4)
            while loop_stack and ind <= loop_stack[-1]:
                loop_stack.pop()
            if loop_rx.search(line):
                loop_stack.append(ind)
                sh.loops += 1
        else:
            # brace depth before this line's own closing braces
            opens, closes = line.count("{"), line.count("}")
            if loop_rx.search(line):
                loop_stack.append(depth + 1)
                sh.loops += 1
            depth += opens - closes
            while loop_stack and depth < loop_stack[-1]:
                loop_stack.pop()
        sh.max_nesting = max(sh.max_nesting, depth)
        sh.max_loop_depth = max(sh.max_loop_depth, len(loop_stack))
        if _BRANCH.search(line):
            sh.branches += 1
            sh.cyclomatic += 1
        sh.cyclomatic += len(re.findall(r"\b(and|or|&&|\|\|)\b", line))
        if stripped.startswith("return"):
            sh.returns += 1
        in_loop = bool(loop_stack) and not loop_rx.search(line)
        if in_loop:
            if _QUERY_CALL.search(line):
                sh.queries_in_loop.append(i)
            if _HTTP_CALL.search(line):
                sh.http_in_loop.append(i)
            if _AWAIT.search(line):
                sh.awaits_in_loop.append(i)
            if _STR_CONCAT_LOOP.search(line):
                sh.str_concat_in_loop.append(i)
            if _REGEX_COMPILE.search(line):
                sh.regex_compile_in_loop.append(i)
        if is_async:
            if _SYNC_SLEEP.search(line) and "asyncio.sleep" not in line and "await" not in line:
                sh.sync_sleep_in_async.append(i)
            if (
                fam == "python"
                and re.search(r"\b(requests\.\w+|urlopen|open)\(", line)
                and "await" not in line
                and "aiofiles" not in line
            ):
                sh.sync_http_in_async.append(i)
        if _SELECT_STAR.search(line):
            sh.select_star.append(i)
        if _NO_LIMIT_SELECT.search(line) and "COUNT(" not in line.upper():
            sh.unbounded_select.append(i)
    return sh

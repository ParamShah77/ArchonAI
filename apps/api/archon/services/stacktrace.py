"""Parse stack traces / error text from several runtimes into frames, and map frames onto graph nodes."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from archon.graph.model import Node, NodeKind
from archon.graph.query import RepoGraph

_PY = re.compile(r'File "(?P<path>[^"]+)", line (?P<line>\d+)(?:, in (?P<func>[\w<>.]+))?')
_JS = re.compile(
    r"at (?:(?P<func>[\w$.<>\[\] ]+?) \()?(?P<path>[^()\s:]+?\.(?:[cm]?[jt]sx?)):(?P<line>\d+)(?::\d+)?\)?"
)
_JAVA = re.compile(r"at (?P<func>[\w$.<>]+)\((?P<file>[\w$]+\.(?:java|kt)):(?P<line>\d+)\)")
_GO = re.compile(r"^\s*(?P<path>[\w./\\-]+\.go):(?P<line>\d+)", re.MULTILINE)
_GO_FUNC = re.compile(r"^(?P<func>[\w./]+(?:\.\(?\*?\w+\)?)?\.\w+)\(", re.MULTILINE)
_ERROR_LINE = re.compile(r"^(?P<type>[A-Z]\w*(?:Error|Exception|Panic|Fault|Failure)\b[^\n]*)$", re.MULTILINE)
_ANY_PATH = re.compile(r"(?<![\w/])((?:[\w.-]+/)+[\w.-]+\.(?:py|[cm]?[jt]sx?|go|java|kt|rb|rs|cs|php)):?(\d+)?")


@dataclass(slots=True)
class Frame:
    raw_path: str
    line: int
    func: str = ""
    path: str = ""  # repo-relative, when resolved
    node_id: str = ""
    node_name: str = ""
    kind: str = ""
    in_repo: bool = False


@dataclass(slots=True)
class ParsedError:
    error_type: str = ""
    message: str = ""
    frames: list[Frame] = field(default_factory=list)
    runtime: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "error_type": self.error_type,
            "message": self.message,
            "runtime": self.runtime,
            "frames": [asdict(f) for f in self.frames],
        }


def parse(text: str) -> ParsedError:
    pe = ParsedError()
    frames: list[Frame] = []
    if "Traceback (most recent call last)" in text or _PY.search(text):
        pe.runtime = "python"
        for m in _PY.finditer(text):
            frames.append(Frame(m.group("path"), int(m.group("line")), m.group("func") or ""))
        tail = [ln for ln in text.strip().splitlines() if ln.strip()]
        for ln in reversed(tail):
            em = re.match(r"^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)?)\s*:\s*(.*)$", ln.strip())
            if em and not ln.startswith(" "):
                pe.error_type, pe.message = em.group(1), em.group(2)
                break
    elif _JAVA.search(text):
        pe.runtime = "java"
        for m in _JAVA.finditer(text):
            frames.append(Frame(m.group("file"), int(m.group("line")), m.group("func")))
        first = text.strip().splitlines()[0] if text.strip() else ""
        em = re.match(r"^(?:Exception in thread \"[^\"]+\" )?([\w.$]+(?:Exception|Error))(?::\s*(.*))?", first)
        if em:
            pe.error_type, pe.message = em.group(1).split(".")[-1], em.group(2) or ""
    elif _JS.search(text):
        pe.runtime = "javascript"
        for m in _JS.finditer(text):
            frames.append(Frame(m.group("path"), int(m.group("line")), (m.group("func") or "").strip()))
        first = text.strip().splitlines()[0] if text.strip() else ""
        em = re.match(r"^(?:Uncaught )?([A-Z]\w*(?:Error|Exception)?)\s*:\s*(.*)$", first)
        if em:
            pe.error_type, pe.message = em.group(1), em.group(2)
    elif _GO.search(text):
        pe.runtime = "go"
        funcs = _GO_FUNC.findall(text)
        for i, m in enumerate(_GO.finditer(text)):
            frames.append(
                Frame(m.group("path"), int(m.group("line")), funcs[i].split(".")[-1] if i < len(funcs) else "")
            )
        em = re.search(r"panic: (.*)", text)
        if em:
            pe.error_type, pe.message = "panic", em.group(1)
    else:
        pe.runtime = "unknown"
        for m in _ANY_PATH.finditer(text):
            frames.append(Frame(m.group(1), int(m.group(2) or 0)))
        em = _ERROR_LINE.search(text)
        if em:
            head = em.group("type")
            pe.error_type, _, pe.message = head.partition(":")
            pe.message = pe.message.strip()
    if not pe.message and not pe.error_type:
        pe.message = text.strip().splitlines()[0][:200] if text.strip() else ""
    pe.frames = frames
    return pe


def _norm(p: str) -> str:
    return p.replace("\\", "/").lstrip("./")


def resolve_frames(rg: RepoGraph, pe: ParsedError) -> ParsedError:
    files = rg.by_kind(NodeKind.FILE)
    by_name: dict[str, list[Node]] = {}
    for f in files:
        by_name.setdefault(f.name, []).append(f)
    for fr in pe.frames:
        raw = _norm(fr.raw_path)
        cands = [f for f in files if raw.endswith(f.path) or f.path.endswith(raw)]
        if not cands:
            cands = by_name.get(raw.rsplit("/", 1)[-1], [])
        if not cands:
            continue
        # prefer the longest common suffix
        best = max(cands, key=lambda f: len(_common_suffix(raw, f.path)))
        fr.path, fr.in_repo = best.path, True
        owner = _owner(rg, best.path, fr.line, fr.func)
        if owner is not None:
            fr.node_id, fr.node_name, fr.kind = owner.id, owner.qualified_name.split("::")[-1], str(owner.kind)
        else:
            fr.node_id, fr.node_name, fr.kind = best.id, best.name, "file"
    return pe


def _common_suffix(a: str, b: str) -> str:
    i = 0
    while i < min(len(a), len(b)) and a[-1 - i] == b[-1 - i]:
        i += 1
    return a[len(a) - i :]


def _owner(rg: RepoGraph, path: str, line: int, func: str) -> Node | None:
    best, span = None, 10**9
    for n in rg.nodes.values():
        if n.path != path or n.kind not in (NodeKind.FUNCTION, NodeKind.METHOD, NodeKind.CLASS):
            continue
        if line and n.start_line <= line <= n.end_line and (n.end_line - n.start_line) < span:
            best, span = n, n.end_line - n.start_line
    if best is None and func:
        for n in rg.nodes.values():
            if n.path == path and n.name == func.split(".")[-1]:
                return n
    return best

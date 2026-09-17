"""Walk a repository and yield source files with their detected language."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pathspec

MAX_FILE_BYTES = 1_000_000

SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "target",
    "vendor",
    "coverage",
    ".idea",
    ".vscode",
    ".gradle",
    "bin",
    "obj",
    ".terraform",
    "site-packages",
}

EXT_LANGUAGE: dict[str, str] = {
    ".py": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".java": "java",
    ".sql": "sql",
    ".prisma": "prisma",
}

# Files that are not parsed but matter for manifests/stack detection.
MANIFEST_NAMES = {
    "package.json",
    "requirements.txt",
    "requirements-dev.txt",
    "pyproject.toml",
    "Pipfile",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Cargo.toml",
    "Gemfile",
    "composer.json",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
}


@dataclass(slots=True)
class SourceFile:
    path: Path  # absolute
    rel: str  # repo-relative, posix separators
    language: str
    size: int


def _load_gitignore(root: Path) -> pathspec.PathSpec | None:
    gi = root / ".gitignore"
    if not gi.is_file():
        return None
    try:
        return pathspec.PathSpec.from_lines(
            "gitwildmatch", gi.read_text(encoding="utf-8", errors="ignore").splitlines()
        )
    except Exception:
        return None


def walk_files(root: Path) -> Iterator[SourceFile]:
    spec = _load_gitignore(root)
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir(), key=lambda p: p.name)
        except (PermissionError, OSError):
            continue
        for entry in entries:
            rel = entry.relative_to(root).as_posix()
            if entry.is_dir():
                if entry.name in SKIP_DIRS or entry.name.startswith(".") and entry.name != ".github":
                    continue
                if spec and spec.match_file(rel + "/"):
                    continue
                stack.append(entry)
                continue
            if spec and spec.match_file(rel):
                continue
            lang = EXT_LANGUAGE.get(entry.suffix.lower())
            if lang is None and entry.name not in MANIFEST_NAMES:
                continue
            try:
                size = entry.stat().st_size
            except OSError:
                continue
            if size > MAX_FILE_BYTES:
                continue
            if entry.name.endswith((".min.js", ".min.css", ".d.ts")):
                continue
            yield SourceFile(path=entry, rel=rel, language=lang or "manifest", size=size)


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1", errors="ignore")

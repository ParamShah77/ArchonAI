"""Bring a repository into the local workspace: git clone (URL) or copy-free reference (local path)."""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from archon.config import get_settings

_URL_RE = re.compile(r"^(https?://|git@|ssh://|git://)")


class WorkspaceError(RuntimeError):
    pass


@dataclass(slots=True)
class Checkout:
    root: Path
    name: str
    branch: str
    commit: str
    is_clone: bool


def is_git_url(source: str) -> bool:
    return bool(_URL_RE.match(source.strip()))


def _repo_name_from_source(source: str) -> str:
    tail = source.rstrip("/").split("/")[-1]
    return tail[:-4] if tail.endswith(".git") else tail or "repo"


def _git(args: list[str], cwd: Path | None = None) -> str:
    try:
        out = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True, timeout=600)
    except FileNotFoundError as e:
        raise WorkspaceError("git is not installed or not on PATH") from e
    except subprocess.CalledProcessError as e:
        raise WorkspaceError(e.stderr.strip() or f"git {' '.join(args)} failed") from e
    return out.stdout.strip()


def _describe(root: Path) -> tuple[str, str]:
    try:
        branch = _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=root)
        commit = _git(["rev-parse", "HEAD"], cwd=root)
        return branch, commit
    except WorkspaceError:
        return "", ""


def clone_or_locate(source: str, repo_id: str) -> Checkout:
    """Clone a git URL into the workspace, or validate a local path and use it in place."""
    source = source.strip()
    if is_git_url(source):
        ws = get_settings().workspace_dir
        ws.mkdir(parents=True, exist_ok=True)
        dest = ws / repo_id
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        _git(["clone", "--depth", "1", source, str(dest)])
        branch, commit = _describe(dest)
        return Checkout(root=dest, name=_repo_name_from_source(source), branch=branch, commit=commit, is_clone=True)

    root = Path(source).expanduser()
    if not root.is_dir():
        raise WorkspaceError(f"Local path does not exist or is not a directory: {source}")
    root = root.resolve()
    branch, commit = _describe(root)
    return Checkout(root=root, name=root.name, branch=branch, commit=commit, is_clone=False)


def remove_checkout(repo_id: str) -> None:
    dest = get_settings().workspace_dir / repo_id
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)

"""Bring a repository into the local workspace: git clone (URL) or copy-free reference (local path)."""

from __future__ import annotations

import os
import re
import shutil
import stat
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


def _git(args: list[str], cwd: Path | None = None, ceiling: Path | None = None) -> str:
    """Run git. With `ceiling`, git may not look for a repository at or above that folder (decisions.md
    D-030): a broken clone inside the workspace must never resolve to a repository that contains it."""
    env = None
    if ceiling is not None:
        env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(ceiling.resolve())}
    try:
        out = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True, timeout=600, env=env)
    except FileNotFoundError as e:
        raise WorkspaceError("git is not installed or not on PATH") from e
    except subprocess.CalledProcessError as e:
        raise WorkspaceError(e.stderr.strip() or f"git {' '.join(args)} failed") from e
    return out.stdout.strip()


def _describe(root: Path, ceiling: Path | None = None) -> tuple[str, str]:
    try:
        branch = _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=root, ceiling=ceiling)
        commit = _git(["rev-parse", "HEAD"], cwd=root, ceiling=ceiling)
        return branch, commit
    except WorkspaceError:
        return "", ""


def _remove_tree(path: Path) -> None:
    """Delete a folder even when it holds read-only files (git marks its objects read-only on Windows,
    which made a plain rmtree fail silently and the next clone fail on the leftover folder)."""

    def _writable_retry(func, p, _exc) -> None:  # noqa: ANN001
        os.chmod(p, stat.S_IWRITE)
        func(p)

    if path.exists():
        shutil.rmtree(path, onexc=_writable_retry)


def _refresh_clone(dest: Path, source: str) -> bool:
    """Update an existing shallow clone in place (fetch + hard reset). Returns False if that is not possible.

    Safety (decisions.md D-030): the workspace lives inside other repositories (e.g. ARCHON's own checkout).
    If the clone's .git is damaged, git would walk up and run these commands on that outer repository — this
    once reset ARCHON's own branch. So: git may not search above the workspace folder, and nothing is changed
    unless git confirms the clone folder itself is the repository's top level."""
    if not (dest / ".git" / "HEAD").is_file():
        return False
    ceiling = dest.parent
    try:
        top = _git(["rev-parse", "--show-toplevel"], cwd=dest, ceiling=ceiling)
        if Path(top).resolve() != dest.resolve():
            return False
        _git(["remote", "set-url", "origin", source], cwd=dest, ceiling=ceiling)
        _git(["fetch", "--depth", "1", "origin"], cwd=dest, ceiling=ceiling)
        _git(["reset", "--hard", "FETCH_HEAD"], cwd=dest, ceiling=ceiling)
        _git(["clean", "-fdx"], cwd=dest, ceiling=ceiling)
        return True
    except WorkspaceError:
        return False


def clone_or_locate(source: str, repo_id: str) -> Checkout:
    """Clone a git URL into the workspace, or validate a local path and use it in place."""
    source = source.strip()
    if is_git_url(source):
        ws = get_settings().workspace_dir
        ws.mkdir(parents=True, exist_ok=True)
        dest = ws / repo_id
        if not _refresh_clone(dest, source):
            _remove_tree(dest)
            _git(["clone", "--depth", "1", source, str(dest)])
        branch, commit = _describe(dest, ceiling=ws)
        return Checkout(root=dest, name=_repo_name_from_source(source), branch=branch, commit=commit, is_clone=True)

    root = Path(source).expanduser()
    if not root.is_dir():
        raise WorkspaceError(f"Local path does not exist or is not a directory: {source}")
    root = root.resolve()
    branch, commit = _describe(root)
    return Checkout(root=root, name=root.name, branch=branch, commit=commit, is_clone=False)


def remove_checkout(repo_id: str) -> None:
    _remove_tree(get_settings().workspace_dir / repo_id)

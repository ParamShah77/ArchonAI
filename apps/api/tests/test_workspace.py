from __future__ import annotations

import stat
import subprocess
from pathlib import Path

from archon.ingest.workspace import _refresh_clone, _remove_tree, source_key


def test_remove_tree_deletes_read_only_files(tmp_path: Path):
    """git's object files are read-only on Windows; re-indexing a cloned repo must still clear the folder."""
    d = tmp_path / "clone" / ".git" / "objects"
    d.mkdir(parents=True)
    f = d / "pack.idx"
    f.write_text("x")
    f.chmod(stat.S_IREAD)
    _remove_tree(tmp_path / "clone")
    assert not (tmp_path / "clone").exists()


def _git(args: list[str], cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def test_refreshing_a_broken_clone_never_touches_the_enclosing_repo(tmp_path: Path):
    """Regression (decisions.md D-030): a half-deleted clone inside another repository made git walk up and
    reset that outer repository. Refreshing must refuse instead."""
    outer = tmp_path / "outer"
    outer.mkdir()
    _git(["init", "-q"], outer)
    (outer / "keep.txt").write_text("precious")
    _git(["add", "."], outer)
    _git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"], outer)
    head = _git(["rev-parse", "HEAD"], outer)
    dest = outer / "workspace" / "repo1"
    (dest / ".git").mkdir(parents=True)
    (dest / ".git" / "HEAD").write_text("ref: refs/heads/main\n")  # looks like a repository, but is broken
    assert _refresh_clone(dest, "https://example.invalid/other.git") is False
    assert _git(["rev-parse", "HEAD"], outer) == head
    assert "example.invalid" not in _git(["remote", "-v"], outer)
    assert (outer / "keep.txt").read_text() == "precious"


def test_source_key_matches_spellings_of_one_repository(tmp_path: Path):
    same = [
        "https://github.com/Org/Repo.git",
        "https://github.com/org/repo/",
        "git@github.com:org/repo.git",
        "ssh://git@github.com/org/repo",
    ]
    assert len({source_key(s) for s in same}) == 1
    assert source_key("https://github.com/org/repo") != source_key("https://github.com/org/other")
    assert source_key(str(tmp_path)) == source_key(str(tmp_path / "x" / ".."))

"""Has a repository changed since it was analyzed? (decisions.md D-034)

- Local folders: a fingerprint of every file the scanner reads (relative path, size, modification time),
  stored at ingestion and recomputed on demand. Stat calls only, no reading, so it is cheap.
- Git URLs: the remote's head commit (`git ls-remote`, short timeout) against the analyzed commit.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

from archon.ingest.scanner import walk_files


def tree_fingerprint(root: Path) -> str:
    h = hashlib.sha1()
    for sf in sorted(walk_files(root), key=lambda f: f.rel):
        try:
            st = sf.path.stat()
        except OSError:
            continue
        h.update(f"{sf.rel}\0{st.st_size}\0{st.st_mtime_ns}\n".encode())
    return h.hexdigest()


def remote_head(url: str, branch: str = "", timeout: float = 8.0) -> str | None:
    """The commit the remote's branch (or HEAD) points to; None when it cannot be reached in time."""
    ref = f"refs/heads/{branch}" if branch and branch != "HEAD" else "HEAD"
    try:
        out = subprocess.run(
            ["git", "ls-remote", url, ref],
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},  # never wait for credentials
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    return out.stdout.split()[0]

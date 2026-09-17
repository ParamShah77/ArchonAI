#!/usr/bin/env python
"""Quiz gate for major changes (see CLAUDE.md, Rule 3, and decisions.md D-006).

Usage:
  python scripts/quiz_gate.py pass "<action description>"   # record a passed quiz
  python scripts/quiz_gate.py status                         # show marker state
  python scripts/quiz_gate.py check                          # hook mode (reads JSON on stdin)

Hook mode: Claude Code PreToolUse hook for the Bash tool. Reads the tool input
from stdin, and if the command is a guarded git action (commit/push) and no
fresh marker exists, exits with code 2 to block the call.
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARKER = ROOT / ".archon" / "quiz-pass.json"
TTL_SECONDS = 30 * 60
GUARDED = re.compile(r"\bgit\s+(commit|push|merge)\b")


def _read_marker() -> dict | None:
    if not MARKER.exists():
        return None
    try:
        return json.loads(MARKER.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _fresh(marker: dict | None) -> bool:
    return bool(marker) and (time.time() - float(marker.get("ts", 0))) < TTL_SECONDS


def cmd_pass(action: str) -> int:
    MARKER.parent.mkdir(parents=True, exist_ok=True)
    MARKER.write_text(json.dumps({"ts": time.time(), "action": action}, indent=2), encoding="utf-8")
    print(f"quiz gate: PASS recorded for '{action}' (valid {TTL_SECONDS // 60} min)")
    return 0


def cmd_status() -> int:
    m = _read_marker()
    if not m:
        print("quiz gate: no marker")
        return 1
    age = int(time.time() - float(m.get("ts", 0)))
    state = "fresh" if _fresh(m) else "EXPIRED"
    print(f"quiz gate: {state} — action='{m.get('action')}' age={age}s")
    return 0 if _fresh(m) else 1


def cmd_check() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    command = str(payload.get("tool_input", {}).get("command", ""))
    if not GUARDED.search(command):
        return 0
    if _fresh(_read_marker()):
        return 0
    print(
        "BLOCKED by quiz gate: this command commits/pushes/merges code. "
        "Quiz the user on the changes first (CLAUDE.md Rule 3). After they pass, run: "
        'python scripts/quiz_gate.py pass "<action>"',
        file=sys.stderr,
    )
    return 2


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    sub = argv[1]
    if sub == "pass":
        return cmd_pass(" ".join(argv[2:]) or "unspecified")
    if sub == "status":
        return cmd_status()
    if sub == "check":
        return cmd_check()
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

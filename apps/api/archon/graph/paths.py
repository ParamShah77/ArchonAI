"""Path conventions shared by the graph builder and the analyzers."""

from __future__ import annotations

import re

# Test code and test fixtures: tests/ folders, test_*.py, *.test.ts, *_test.go, Test*.java, …
TEST_PATH_RE = re.compile(
    r"(^|/)(tests?|__tests__|spec|e2e)(/|$)|(^|/)test_[^/]+\.py$|[._](test|spec)\.[jt]sx?$|_test\.go$|Test\w*\.java$"
)

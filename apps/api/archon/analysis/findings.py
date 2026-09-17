"""The shared Finding model (decisions.md D-012)."""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class Severity(StrEnum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


SEVERITY_WEIGHT: dict[str, float] = {"critical": 10, "high": 5, "medium": 2, "low": 0.7, "info": 0.1}
SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"]


@dataclass(slots=True)
class Finding:
    analyzer: str
    category: str
    severity: Severity
    title: str
    description: str = ""
    path: str = ""
    start_line: int = 0
    end_line: int = 0
    node_id: str = ""
    evidence: str = ""
    recommendation: str = ""
    confidence: float = 0.7
    tags: list[str] = field(default_factory=list)

    @property
    def fingerprint(self) -> str:
        """Stable identity across runs: what + where (not the line number, which drifts)."""
        raw = "\x1f".join([self.analyzer, self.category, self.path, self.node_id or self.title, self.evidence[:80]])
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:40]

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["severity"] = str(self.severity)
        d["fingerprint"] = self.fingerprint
        return d


def sort_findings(findings: list[Finding]) -> list[Finding]:
    return sorted(findings, key=lambda f: (SEVERITY_ORDER.index(str(f.severity)), -f.confidence, f.path, f.start_line))

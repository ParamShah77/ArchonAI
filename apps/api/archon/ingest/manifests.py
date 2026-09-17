"""Detect external dependencies from package manifests -> DEPENDENCY nodes."""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

from archon.ingest.scanner import read_text


@dataclass(slots=True, frozen=True)
class Dependency:
    name: str
    ecosystem: str  # npm | pypi | go | maven | cargo | rubygems | composer
    version: str = ""
    dev: bool = False
    manifest: str = ""


_REQ_LINE = re.compile(r"^\s*([A-Za-z0-9_.\-\[\]]+)\s*([<>=!~]=?.*)?$")
_GO_REQUIRE = re.compile(r"^\s*([\w./\-]+)\s+(v[\w.\-+]+)", re.MULTILINE)
_GO_MODULE = re.compile(r"^module\s+(\S+)", re.MULTILINE)
_MAVEN_DEP = re.compile(r"<dependency>(.*?)</dependency>", re.DOTALL)
_MAVEN_TAG = re.compile(r"<(groupId|artifactId|version|scope)>([^<]*)</\1>")
_GRADLE_DEP = re.compile(
    r"(implementation|api|compileOnly|runtimeOnly|testImplementation)\s*[\(]?\s*[\"']([^\"']+)[\"']"
)
_GEM = re.compile(r"^\s*gem\s+[\"']([^\"']+)[\"'](?:\s*,\s*[\"']([^\"']+)[\"'])?", re.MULTILINE)


def _pypi_name(spec: str) -> tuple[str, str]:
    spec = spec.split(";")[0].strip()
    m = re.match(r"^([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*(.*)$", spec)
    if not m:
        return spec, ""
    return m.group(1).lower().replace("_", "-"), m.group(2).strip()


def _parse_package_json(path: Path, rel: str) -> list[Dependency]:
    try:
        data = json.loads(read_text(path))
    except json.JSONDecodeError:
        return []
    out: list[Dependency] = []
    for key, dev in (("dependencies", False), ("devDependencies", True), ("peerDependencies", False)):
        for name, ver in (data.get(key) or {}).items():
            out.append(Dependency(name, "npm", str(ver), dev, rel))
    return out


def _parse_requirements(path: Path, rel: str) -> list[Dependency]:
    out: list[Dependency] = []
    dev = "dev" in path.name or "test" in path.name
    for line in read_text(path).splitlines():
        line = line.split("#")[0].strip()
        if not line or line.startswith(("-", "git+", "http")):
            continue
        name, ver = _pypi_name(line)
        if name:
            out.append(Dependency(name, "pypi", ver, dev, rel))
    return out


def _parse_pyproject(path: Path, rel: str) -> list[Dependency]:
    try:
        data = tomllib.loads(read_text(path))
    except tomllib.TOMLDecodeError:
        return []
    out: list[Dependency] = []
    project = data.get("project") or {}
    for spec in project.get("dependencies") or []:
        name, ver = _pypi_name(spec)
        out.append(Dependency(name, "pypi", ver, False, rel))
    for group, specs in (project.get("optional-dependencies") or {}).items():
        for spec in specs:
            name, ver = _pypi_name(spec)
            out.append(Dependency(name, "pypi", ver, group in {"dev", "test", "lint"}, rel))
    poetry = (data.get("tool") or {}).get("poetry") or {}
    for key, dev in (("dependencies", False), ("dev-dependencies", True)):
        for name, ver in (poetry.get(key) or {}).items():
            if name.lower() == "python":
                continue
            v = ver if isinstance(ver, str) else str((ver or {}).get("version", ""))
            out.append(Dependency(name.lower(), "pypi", v, dev, rel))
    for group in (poetry.get("group") or {}).values():
        for name, ver in (group.get("dependencies") or {}).items():
            v = ver if isinstance(ver, str) else str((ver or {}).get("version", ""))
            out.append(Dependency(name.lower(), "pypi", v, True, rel))
    return out


def _parse_go_mod(path: Path, rel: str) -> list[Dependency]:
    text = read_text(path)
    return [Dependency(n, "go", v, False, rel) for n, v in _GO_REQUIRE.findall(text) if "/" in n]


def _parse_pom(path: Path, rel: str) -> list[Dependency]:
    out: list[Dependency] = []
    for block in _MAVEN_DEP.findall(read_text(path)):
        tags = dict(_MAVEN_TAG.findall(block))
        if "artifactId" in tags:
            name = f"{tags.get('groupId', '')}:{tags['artifactId']}".strip(":")
            out.append(Dependency(name, "maven", tags.get("version", ""), tags.get("scope") == "test", rel))
    return out


def _parse_gradle(path: Path, rel: str) -> list[Dependency]:
    out: list[Dependency] = []
    for conf, coord in _GRADLE_DEP.findall(read_text(path)):
        parts = coord.split(":")
        name = ":".join(parts[:2]) if len(parts) >= 2 else coord
        out.append(Dependency(name, "maven", parts[2] if len(parts) >= 3 else "", conf.startswith("test"), rel))
    return out


def _parse_cargo(path: Path, rel: str) -> list[Dependency]:
    try:
        data = tomllib.loads(read_text(path))
    except tomllib.TOMLDecodeError:
        return []
    out: list[Dependency] = []
    for key, dev in (("dependencies", False), ("dev-dependencies", True)):
        for name, ver in (data.get(key) or {}).items():
            v = ver if isinstance(ver, str) else str((ver or {}).get("version", ""))
            out.append(Dependency(name, "cargo", v, dev, rel))
    return out


def _parse_gemfile(path: Path, rel: str) -> list[Dependency]:
    return [Dependency(n, "rubygems", v or "", False, rel) for n, v in _GEM.findall(read_text(path))]


def _parse_composer(path: Path, rel: str) -> list[Dependency]:
    try:
        data = json.loads(read_text(path))
    except json.JSONDecodeError:
        return []
    out: list[Dependency] = []
    for key, dev in (("require", False), ("require-dev", True)):
        for name, ver in (data.get(key) or {}).items():
            if name != "php" and not name.startswith("ext-"):
                out.append(Dependency(name, "composer", str(ver), dev, rel))
    return out


_PARSERS = {
    "package.json": _parse_package_json,
    "pyproject.toml": _parse_pyproject,
    "go.mod": _parse_go_mod,
    "pom.xml": _parse_pom,
    "build.gradle": _parse_gradle,
    "build.gradle.kts": _parse_gradle,
    "Cargo.toml": _parse_cargo,
    "Gemfile": _parse_gemfile,
    "composer.json": _parse_composer,
}


def parse_manifest(path: Path, rel: str) -> list[Dependency]:
    if path.name.startswith("requirements") and path.suffix == ".txt":
        return _parse_requirements(path, rel)
    parser = _PARSERS.get(path.name)
    return parser(path, rel) if parser else []


def go_module_name(root: Path) -> str:
    gm = root / "go.mod"
    if gm.is_file():
        m = _GO_MODULE.search(read_text(gm))
        if m:
            return m.group(1)
    return ""

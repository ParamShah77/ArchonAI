"""Capability 5 — security auditor. Pattern rules over source + graph rules over endpoints."""

from __future__ import annotations

import re
from dataclasses import dataclass

from archon.analysis.base import AnalysisContext, Analyzer
from archon.analysis.findings import Finding, Severity
from archon.graph.model import NodeKind

PY = {"python"}
JS = {"javascript", "typescript", "tsx"}
ALL = PY | JS | {"go", "java"}


@dataclass(frozen=True, slots=True)
class Rule:
    id: str
    category: str
    severity: Severity
    title: str
    pattern: re.Pattern[str]
    languages: frozenset[str]
    recommendation: str
    confidence: float = 0.7
    skip_tests: bool = True


def _r(
    id: str,
    category: str,
    sev: Severity,
    title: str,
    rx: str,
    langs: set[str],
    rec: str,
    conf: float = 0.7,
    skip_tests: bool = True,
) -> Rule:
    return Rule(id, category, sev, title, re.compile(rx), frozenset(langs), rec, conf, skip_tests)


RULES: list[Rule] = [
    # ---- secrets
    _r(
        "SEC-AWS-KEY",
        "secrets",
        Severity.CRITICAL,
        "AWS access key committed",
        r"\bAKIA[0-9A-Z]{16}\b",
        ALL,
        "Revoke the key, rotate credentials, and load secrets from the environment or a secret manager.",
        0.95,
        False,
    ),
    _r(
        "SEC-PRIVATE-KEY",
        "secrets",
        Severity.CRITICAL,
        "Private key material in source",
        r"-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
        ALL,
        "Remove the key from the repository and its history; store keys outside source control.",
        0.95,
        False,
    ),
    _r(
        "SEC-GENERIC-SECRET",
        "secrets",
        Severity.HIGH,
        "Hard-coded secret or API key",
        r"(?i)\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd)\b\s*[:=]\s*[\"'][^\"'\s]{8,}[\"']",
        ALL,
        "Read the value from configuration/environment at runtime; never commit real credentials.",
        0.6,
    ),
    _r(
        "SEC-JWT-LITERAL",
        "secrets",
        Severity.HIGH,
        "JWT token literal in source",
        r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b",
        ALL,
        "Remove the token; tokens must be issued at runtime.",
        0.8,
    ),
    _r(
        "SEC-DB-URL",
        "secrets",
        Severity.HIGH,
        "Database URL with embedded credentials",
        r"(?i)\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp)://[^\s:/@\"']+:[^\s@\"']+@",
        ALL,
        "Use a DATABASE_URL environment variable; keep credentials out of code.",
        0.85,
    ),
    # ---- injection
    _r(
        "SEC-SQL-FSTRING",
        "injection",
        Severity.HIGH,
        "SQL built with f-string / format",
        r"(?i)\bf?[\"'](SELECT|INSERT|UPDATE|DELETE|DROP)\b[^\"']*\{[^}]+\}|[\"'](SELECT|INSERT|UPDATE|DELETE)\b[^\"']*[\"']\s*(%|\.format\()",
        PY,
        "Use parameterised queries (placeholders + params) instead of string interpolation.",
        0.8,
    ),
    _r(
        "SEC-SQL-CONCAT",
        "injection",
        Severity.HIGH,
        "SQL built by string concatenation / template",
        r"(?i)([\"'`](SELECT|INSERT|UPDATE|DELETE|DROP)\b[^\"'`]*[\"'`]\s*\+\s*\w)|(`(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{)",
        JS | {"java", "go"},
        "Use parameterised queries or a query builder that binds values.",
        0.8,
    ),
    _r(
        "SEC-EVAL",
        "code-execution",
        Severity.HIGH,
        "Dynamic code execution",
        r"(?<![\w.])(eval|exec)\s*\(",
        PY | JS,
        "Avoid eval/exec; parse input explicitly or use a safe expression evaluator.",
        0.7,
    ),
    _r(
        "SEC-SHELL",
        "command-injection",
        Severity.HIGH,
        "Shell command with shell=True / string command",
        r"subprocess\.\w+\([^)]*shell\s*=\s*True|os\.system\(|os\.popen\(",
        PY,
        "Pass an argument list without shell=True; validate any user-controlled parts.",
        0.75,
    ),
    _r(
        "SEC-CHILD-PROCESS",
        "command-injection",
        Severity.HIGH,
        "child_process exec with string command",
        r"\b(exec|execSync)\s*\(\s*[`\"'][^)]*\$\{",
        JS,
        "Use execFile/spawn with an argument array; never interpolate user input into a shell string.",
        0.8,
    ),
    _r(
        "SEC-PICKLE",
        "deserialization",
        Severity.HIGH,
        "Unsafe deserialization (pickle/marshal)",
        r"\b(pickle|marshal|cPickle)\.loads?\(",
        PY,
        "Do not unpickle untrusted data; use JSON or a schema-validated format.",
        0.7,
    ),
    _r(
        "SEC-YAML-LOAD",
        "deserialization",
        Severity.MEDIUM,
        "yaml.load without a safe Loader",
        r"yaml\.load\((?![^)]*SafeLoader)(?![^)]*safe_load)",
        PY,
        "Use yaml.safe_load or pass Loader=yaml.SafeLoader.",
        0.8,
    ),
    _r(
        "SEC-INNERHTML",
        "xss",
        Severity.MEDIUM,
        "innerHTML / dangerouslySetInnerHTML assignment",
        r"\.innerHTML\s*=|dangerouslySetInnerHTML|document\.write\(",
        JS,
        "Render text with textContent / JSX; sanitise HTML with a vetted sanitiser if HTML is required.",
        0.6,
    ),
    _r(
        "SEC-PATH-TRAVERSAL",
        "path-traversal",
        Severity.MEDIUM,
        "Filesystem path built from request input",
        r"(open|readFile|readFileSync|sendFile|createReadStream|os\.path\.join|path\.join)\([^)]*(req\.(params|query|body)|request\.(args|form|json|params)|params\[)",
        PY | JS,
        "Resolve the path and verify it stays inside an allowed base directory.",
        0.6,
    ),
    # ---- crypto / auth
    _r(
        "SEC-WEAK-HASH",
        "crypto",
        Severity.LOW,
        "Weak hash algorithm (MD5/SHA1)",
        r"\b(hashlib\.(md5|sha1)|createHash\(\s*[\"'](md5|sha1)[\"']|MessageDigest\.getInstance\(\s*\"(MD5|SHA-?1)\"|md5\.New\(|sha1\.New\()",
        ALL,
        "Fine for non-security fingerprints/cache keys; for integrity use SHA-256+, for passwords bcrypt/argon2/scrypt.",
        0.7,
    ),
    _r(
        "SEC-JWT-NOVERIFY",
        "auth",
        Severity.HIGH,
        "JWT signature verification disabled",
        r"verify_signature[\"']?\s*:\s*False|\.decode\([^)]*verify\s*=\s*False|algorithms\s*=\s*\[\s*[\"']none[\"']|jwt\.decode\((?!.*verify)",
        PY | JS,
        "Always verify signatures with an explicit algorithm allow-list.",
        0.7,
    ),
    _r(
        "SEC-INSECURE-RANDOM",
        "crypto",
        Severity.LOW,
        "Non-cryptographic randomness for a security value",
        r"\b(random\.(random|randint|choice)|Math\.random)\([^\n]*(token|secret|password|otp|nonce|session)",
        PY | JS,
        "Use secrets / crypto.randomBytes for tokens and secrets.",
        0.6,
    ),
    _r(
        "SEC-TLS-VERIFY",
        "transport",
        Severity.HIGH,
        "TLS certificate verification disabled",
        r"verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED",
        ALL,
        "Keep certificate verification on; pin or provide the CA bundle instead.",
        0.8,
    ),
    _r(
        "SEC-DEBUG",
        "configuration",
        Severity.MEDIUM,
        "Debug mode enabled in code",
        r"\bDEBUG\s*=\s*True\b|app\.run\([^)]*debug\s*=\s*True|\.debug\s*=\s*true",
        PY | JS,
        "Drive debug mode from the environment and default it to off.",
        0.6,
    ),
    _r(
        "SEC-CORS-ANY",
        "configuration",
        Severity.MEDIUM,
        "CORS allows any origin",
        r"allow_origins\s*=\s*\[\s*[\"']\*[\"']\s*\]|Access-Control-Allow-Origin[\"']?\s*[:,]\s*[\"']\*|cors\(\s*\)|origin\s*:\s*[\"']\*[\"']",
        PY | JS | {"go", "java"},
        "Restrict origins to the known frontends, especially when credentials are allowed.",
        0.55,
    ),
    _r(
        "SEC-BIND-ALL",
        "configuration",
        Severity.LOW,
        "Service binds to all interfaces",
        r"[\"']0\.0\.0\.0[\"']",
        ALL,
        "Bind to localhost in development; expose intentionally via the deployment layer.",
        0.4,
    ),
    _r(
        "SEC-HTTP-URL",
        "transport",
        Severity.LOW,
        "Plain HTTP URL to a non-local host",
        r"[\"']http://(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\{|\$)[a-z0-9.-]+\.[a-z]{2,}",
        ALL,
        "Use HTTPS for external calls.",
        0.4,
    ),
    _r(
        "SEC-REGEX-DOS",
        "dos",
        Severity.LOW,
        "Potentially catastrophic regex (nested quantifier)",
        r"re\.(compile|match|search|findall)\(\s*r?[\"'][^\"']*\([^)]*[+*]\)[+*]",
        PY,
        "Avoid nested quantifiers; anchor and bound the pattern.",
        0.5,
    ),
]

_REGEX_LINE = re.compile(
    r"re\.compile\(|new RegExp\(|Pattern\.compile\(|regexp\.(Must)?Compile\(|(?<!\w)r[\"'][^\"']*\\[bsdw]"
)
_AUTH_HINT = re.compile(
    r"(?i)auth|login|jwt|token|current_user|permission|require_?role|protected|guard|session|api_?key|bearer"
)
_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


class SecurityAnalyzer(Analyzer):
    name = "security"
    description = (
        "Secrets, injection, unsafe APIs, crypto, transport and configuration weaknesses; unauthenticated endpoints."
    )

    async def run(self, ctx: AnalysisContext) -> list[Finding]:
        out: list[Finding] = []
        for f in ctx.files():
            if f.language not in ALL:
                continue
            is_test = ctx.is_test_path(f.path)
            lines = ctx.lines(f.path)
            for rule in RULES:
                if f.language not in rule.languages or (rule.skip_tests and is_test):
                    continue
                for i, line in enumerate(lines, start=1):
                    if len(line) > 600 or not rule.pattern.search(line):
                        continue
                    if rule.category != "secrets" and _REGEX_LINE.search(line):
                        continue  # a rule/regex definition mentioning the pattern is not a use of it
                    if rule.id == "SEC-GENERIC-SECRET" and re.search(
                        r"(?i)(example|placeholder|changeme|your[_-]?|xxx|<|>|\$\{|os\.environ|process\.env|getenv)",
                        line,
                    ):
                        continue
                    out.append(
                        Finding(
                            analyzer=self.name,
                            category=rule.category,
                            severity=rule.severity,
                            title=rule.title,
                            description=f"Rule {rule.id} matched in {f.path}.",
                            path=f.path,
                            start_line=i,
                            end_line=i,
                            node_id=self._owner(ctx, f.path, i),
                            evidence=line.strip()[:300],
                            recommendation=rule.recommendation,
                            confidence=rule.confidence,
                            tags=[rule.id, f.language],
                        )
                    )
        out.extend(self._endpoint_rules(ctx))
        return out

    @staticmethod
    def _owner(ctx: AnalysisContext, path: str, line: int) -> str:
        best = ""
        best_span = 10**9
        for n in ctx.rg.nodes.values():
            if (
                n.path == path
                and n.kind in (NodeKind.FUNCTION, NodeKind.METHOD, NodeKind.CLASS)
                and n.start_line <= line <= n.end_line
            ):
                span = n.end_line - n.start_line
                if span < best_span:
                    best, best_span = n.id, span
        return best

    def _endpoint_rules(self, ctx: AnalysisContext) -> list[Finding]:
        out: list[Finding] = []
        stack = ctx.repo.stack or {}
        has_auth = bool(stack.get("auth"))
        endpoints = ctx.rg.by_kind(NodeKind.ENDPOINT)
        if not endpoints:
            return out
        unauth: list = []
        for ep in endpoints:
            handler_id = next((s for s, d in ctx.rg.in_edges(ep.id) if d["kind"] == "exposes"), None)
            handler = ctx.rg.node(handler_id) if handler_id else None
            if handler is None:
                continue
            decos = " ".join(handler.meta.get("decorators", []) + handler.meta.get("annotations", []))
            params = str(handler.meta.get("params", ""))
            body = ctx.source_of(handler, max_lines=60)
            protected = bool(_AUTH_HINT.search(decos + " " + params)) or bool(_AUTH_HINT.search(body[:1500]))
            if not protected and ep.meta.get("method") in _MUTATING:
                unauth.append((ep, handler))
        if unauth and (has_auth or len(unauth) < len(endpoints)):
            for ep, handler in unauth[:50]:
                out.append(
                    Finding(
                        analyzer=self.name,
                        category="authorization",
                        severity=Severity.MEDIUM if has_auth else Severity.LOW,
                        title=f"Mutating endpoint without visible authentication: {ep.name}",
                        description="No auth decorator, dependency, guard or token check was found on the handler or in its first lines.",
                        path=handler.path,
                        start_line=handler.start_line,
                        end_line=handler.end_line,
                        node_id=handler.id,
                        evidence=f"{ep.name} -> {handler.qualified_name.split('::')[-1]}{handler.meta.get('params', '')}",
                        recommendation="Require authentication/authorization on state-changing endpoints (dependency, middleware or guard).",
                        confidence=0.5 if has_auth else 0.35,
                        tags=["SEC-UNAUTH-MUTATION"],
                    )
                )
        return out

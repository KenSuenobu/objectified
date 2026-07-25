"""Secret scrubbing for import intake — IXH-1.4 (#5090), nucleus of MFI-29.6 (#4393).

Uploaded API descriptions routinely carry live credentials: a Postman collection
with a bearer token, an OpenAPI ``servers`` URL with basic-auth userinfo, an
example block with an AWS key, a connection string in a description. Intake
persists the *verbatim* source (``format_metadata.sourceContent``, MFI-23.9) and
echoes parser errors — which quote the offending line — into the job event log, so
without scrubbing a secret lands in the database and in every status poll.

This module is the scrubbing pass. It is deliberately **value-only**: each match
is replaced by :data:`REDACTION_MARKER` in place, so the document's structure —
and therefore its fingerprint-relevant shape — is untouched, satisfying the
MFI-29.6 acceptance criterion that scrubbing never alters structure. Findings
record *what* and *where* (secret type, line number), never the value itself.

Distinct from :func:`app.mcp_protocol_transcript.redact_text`, which scrubs short
free-text error strings and truncates them: that is right for a 200-character
transcript message and wrong for a document that must stay parseable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Pattern, Tuple

__all__ = [
    "REDACTION_MARKER",
    "ScrubFinding",
    "ScrubOutcome",
    "scrub_document_text",
    "scrub_message",
]

#: Replacement for every redacted value. Contains no quote or escape character, so
#: substituting it inside a JSON/YAML/XML string literal keeps the document valid.
REDACTION_MARKER = "«redacted»"


def _p(pattern: str, flags: int = 0) -> Pattern[str]:
    return re.compile(pattern, flags)


#: Credential patterns, each named by the secret *type* it recognizes. Group 1, when
#: present, is the span actually replaced — that keeps surrounding structure (the
#: key, the scheme, the URL host) intact so only the secret value is lost.
#:
#: Ordered most-specific first: a provider-shaped key is reported as that provider
#: rather than as a generic assignment.
_PATTERNS: Tuple[Tuple[str, Pattern[str]], ...] = (
    # --- provider-specific key shapes ------------------------------------------
    ("aws-access-key-id", _p(r"\b((?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16})\b")),
    ("github-token", _p(r"\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b")),
    ("slack-token", _p(r"\b(xox[abposr]-[A-Za-z0-9-]{10,})\b")),
    # {35,} not {35}: a trailing \b after a fixed count fails when the key runs longer,
    # which silently let a real-shaped key through.
    ("google-api-key", _p(r"\b(AIza[0-9A-Za-z_\-]{35,})")),
    ("stripe-key", _p(r"\b((?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,})\b")),
    ("jwt", _p(r"\b(eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+)")),
    ("private-key-block", _p(
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"
        r"([\s\S]*?)"
        r"-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"
    )),
    # --- credentials embedded in URLs (basic auth / connection strings) ---------
    # Replaces only the userinfo, keeping scheme and host so the URL stays readable.
    ("url-embedded-credential", _p(r"://[^/\s:@\"']+:([^/\s@\"']+)@")),
    # --- authorization headers and header-shaped values ------------------------
    ("authorization-header", _p(
        r"(?:\"|')?[Aa]uthorization(?:\"|')?\s*[:=]\s*(?:\"|')?"
        r"(?:Bearer|Basic|Token|ApiKey)\s+([^\"'\s,}\]]+)",
    )),
    ("bearer-token", _p(r"\b(?:Bearer|Basic)\s+([A-Za-z0-9_\-\.=+/]{12,})")),
    # --- cookie jars -----------------------------------------------------------
    # A ``Cookie``/``Set-Cookie`` header value is a credential in full: Postman and
    # HAR exports carry live session cookies. The whole value is replaced (cookie
    # values legitimately contain ``;`` and ``=``, so the span cannot be narrowed).
    ("cookie-header", _p(
        r"(?:\"|')?(?:set-)?cookie(?:\"|')?\s*[:=]\s*(?:\"|')?([^\"'\n]{4,})",
        re.IGNORECASE,
    )),
    # --- generic secret-named assignments (JSON/YAML/env/query) ----------------
    # The key must *name* a secret; a short or placeholder-looking value still gets
    # redacted, because deciding "this one is fake" is not intake's call.
    ("secret-assignment", _p(
        r"(?:\"|')?[A-Za-z0-9_\-]*"
        r"(?:password|passwd|secret|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token"
        r"|auth[-_]?token|client[-_]?secret|private[-_]?key|credential|passphrase"
        r"|session[-_]?id|sessionid|session)"
        r"[A-Za-z0-9_\-]*(?:\"|')?\s*[:=]\s*(?:\"|')?([^\"'\s,}\]&]{4,})",
        re.IGNORECASE,
    )),
)


@dataclass(frozen=True)
class ScrubFinding:
    """One redacted secret: what kind and where, never the value.

    Attributes:
        secret_type: The pattern name that matched (e.g. ``aws-access-key-id``).
        line: 1-based line number of the match within the document.
        occurrences: How many values of this type were redacted on that line.
    """

    secret_type: str
    line: int
    occurrences: int = 1

    def as_dict(self) -> Dict[str, object]:
        """Return the finding as a JSON-safe dict for the job summary."""
        return {
            "secret_type": self.secret_type,
            "line": self.line,
            "occurrences": self.occurrences,
        }


@dataclass
class ScrubOutcome:
    """Result of scrubbing one document.

    Attributes:
        text: The document with every detected secret value replaced by
            :data:`REDACTION_MARKER`. Identical to the input when nothing matched.
        findings: One entry per (secret type, line) pair that was redacted.
    """

    text: str
    findings: List[ScrubFinding] = field(default_factory=list)

    @property
    def scrubbed(self) -> bool:
        """Whether anything was redacted."""
        return bool(self.findings)

    @property
    def redaction_count(self) -> int:
        """Total number of redacted values."""
        return sum(finding.occurrences for finding in self.findings)

    def report(self) -> Dict[str, object]:
        """Build the job-summary scrub report (types and locations, no values)."""
        return {
            "scrubbed": self.scrubbed,
            "redactions": self.redaction_count,
            "secret_types": sorted({finding.secret_type for finding in self.findings}),
            "findings": [finding.as_dict() for finding in self.findings],
        }


def _line_of(text: str, index: int) -> int:
    """Return the 1-based line number containing ``index``."""
    return text.count("\n", 0, index) + 1


def scrub_document_text(text: str) -> ScrubOutcome:
    """Redact credential values in a source document, preserving its structure.

    Every pattern in :data:`_PATTERNS` is applied in order. Only the credential
    *value* is replaced (the naming key, URL scheme/host, and auth scheme survive),
    so the document remains parseable and structurally unchanged — values only, per
    the MFI-29.6 contract.

    Args:
        text: The raw document text.

    Returns:
        A :class:`ScrubOutcome` carrying the redacted text and per-line findings.
        When nothing matches, the text is returned unchanged with no findings.
    """
    if not text:
        return ScrubOutcome(text=text or "", findings=[])

    scrubbed = text
    # (secret_type, line) -> occurrences, so a report line is one entry per type.
    tally: Dict[Tuple[str, int], int] = {}

    for secret_type, pattern in _PATTERNS:
        def _replace(match: "re.Match[str]", _type: str = secret_type) -> str:
            # Group 1 is the secret span when the pattern defines one; otherwise the
            # whole match is the secret.
            target_group = 1 if match.re.groups >= 1 else 0
            value = match.group(target_group)
            if not value or REDACTION_MARKER in value:
                return match.group(0)
            key = (_type, _line_of(scrubbed, match.start(target_group)))
            tally[key] = tally.get(key, 0) + 1
            start, end = match.span(target_group)
            whole_start = match.start(0)
            return (
                match.group(0)[: start - whole_start]
                + REDACTION_MARKER
                + match.group(0)[end - whole_start :]
            )

        scrubbed = pattern.sub(_replace, scrubbed)

    findings = [
        ScrubFinding(secret_type=secret_type, line=line, occurrences=count)
        for (secret_type, line), count in sorted(tally.items(), key=lambda item: (item[0][1], item[0][0]))
    ]
    return ScrubOutcome(text=scrubbed, findings=findings)


def scrub_message(message: Optional[str]) -> Optional[str]:
    """Redact credentials from a free-text message before it is logged or stored.

    Parser errors quote the offending source span, so a malformed line carrying a
    token would otherwise reach the job event log and the server log verbatim.
    Unlike :func:`scrub_document_text` this makes no structural promises — it is
    for human-readable text.

    Args:
        message: The message to scrub; ``None`` passes through.

    Returns:
        The scrubbed message, or ``None`` when ``message`` was ``None``.
    """
    if message is None:
        return None
    return scrub_document_text(message).text

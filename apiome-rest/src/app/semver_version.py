"""Semantic-version parsing for version labels (``versions.version_id``).

Version labels are free-form ``VARCHAR(255)`` — most tenants use semver ("1.4.2", "v2.0.0"),
but nothing forces it. Every consumer therefore needs the same two answers: *is this label
semver at all*, and *what are its numeric parts*. This module is the one place that decides,
so the browse version ordering and the CTG-3.4 breaking-publish guardrail agree on what
"the major went up" means.

Deliberately tolerant in exactly one way — a leading ``v``/``V`` is stripped — and strict
otherwise: a label that is not ``MAJOR.MINOR.PATCH`` with optional pre-release/build parses
to ``None`` rather than guessing. Callers decide what an unparseable label means for them.
"""

from __future__ import annotations

import re
from typing import Optional, Tuple

__all__ = [
    "SemverParts",
    "parse_semver",
    "is_major_bump",
    "next_major_label",
]

#: Semver 2.0.0 core plus optional pre-release and build metadata.
_SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)

#: ``(major, minor, patch, prerelease_identifiers)``.
SemverParts = Tuple[int, int, int, Tuple[str, ...]]


def parse_semver(version_label: str) -> Optional[SemverParts]:
    """Parse a version label into its semver parts.

    Args:
        version_label: A version label such as ``1.2.3``, ``v2.0.0`` or ``3.0.0-rc.1``.
            A leading ``v``/``V`` is ignored; surrounding whitespace is trimmed.

    Returns:
        ``(major, minor, patch, prerelease)`` where ``prerelease`` is the dot-separated
        identifier tuple (empty for a release), or ``None`` when the label is not semver.
    """
    s = (version_label or "").strip().lstrip("vV")
    m = _SEMVER_RE.match(s)
    if not m:
        return None
    prerelease = tuple((m.group(4) or "").split(".")) if m.group(4) else ()
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), prerelease)


def is_major_bump(from_label: str, to_label: str) -> Optional[bool]:
    """Report whether ``to_label`` raises the major version above ``from_label``.

    Args:
        from_label: The baseline version label (e.g. the previous published version).
        to_label: The candidate version label.

    Returns:
        ``True`` when the candidate's major is strictly greater, ``False`` when it is not,
        and ``None`` when either label is not semver — "unknown", never a silent ``False``,
        so callers can degrade instead of accusing a tenant of a semver violation they may
        not have committed.
    """
    from_parts = parse_semver(from_label)
    to_parts = parse_semver(to_label)
    if from_parts is None or to_parts is None:
        return None
    return to_parts[0] > from_parts[0]


def next_major_label(from_label: str) -> Optional[str]:
    """Return the version label a major bump from ``from_label`` would produce.

    Args:
        from_label: The baseline version label.

    Returns:
        ``"<major+1>.0.0"``, or ``None`` when ``from_label`` is not semver.
    """
    parts = parse_semver(from_label)
    if parts is None:
        return None
    return f"{parts[0] + 1}.0.0"

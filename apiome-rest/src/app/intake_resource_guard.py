"""Resource guards for import intake — IXH-1.4 (#5090).

Import intake parsed every uploaded document with a bare ``json.loads`` /
``yaml.safe_load`` (:func:`app.import_ingestion.parse_document`) — no size cap,
no alias-expansion cap, no depth cap. A YAML alias bomb was therefore a straight
out-of-memory, and a 10^5-deep flow document a stack exhaustion, on a code path
that runs during *format detection* for every document and for every member of an
uploaded archive.

The limits are the ones the DCW-0.2 resource-limits artifact already publishes
(``src/app/data/oas_resource_limits.json``, whose ``appliesTo`` lists ``import``),
and the checks are :mod:`app.safe_oas_parse`'s exported primitives — this module
applies them at the intake seam rather than restating them:

* **size** — UTF-8 byte ceiling, checked before any parse;
* **expansion** — YAML alias-expansion cost, bounding billion-laughs blowups
  before materialization;
* **depth** — a cheap pre-parse bound, then an exact iterative check on the
  parsed value, which also rejects self-referential alias cycles.

Violations raise :class:`IntakeLimitError` carrying the intake-taxonomy code
(``INPUT_TOO_LARGE`` / ``INPUT_EXPANSION_LIMIT`` / ``INPUT_DEPTH_LIMIT``), so a
hostile document fails the job fast with actionable remediation instead of
hanging or being killed by the OOM reaper.

IXH-6.5 extends this with streaming intake limits, per-tenant configuration, and
metrics; this module is deliberately the smallest thing that makes the IXH-1.4
adversarial corpus terminate.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from .oas_resource_limits import resource_limit_values
from .safe_oas_parse import (
    PRE_SCAN_DEPTH_SLACK,
    analyze_nesting,
    pre_scan_depth_bound,
    yaml_alias_expansion_cost,
)

__all__ = [
    "IntakeLimits",
    "IntakeLimitError",
    "effective_intake_limits",
    "guard_document_size",
    "guard_document_text",
    "guard_parsed_document",
    "guard_payload_bytes",
]


class IntakeLimitError(Exception):
    """An intake resource limit was exceeded.

    Attributes:
        code: The intake-taxonomy code for the breached limit —
            ``INPUT_TOO_LARGE``, ``INPUT_EXPANSION_LIMIT``, or
            ``INPUT_DEPTH_LIMIT``.
    """

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class IntakeLimits:
    """The numeric intake bounds in force for one document.

    Attributes:
        max_bytes: UTF-8 byte ceiling for the document text.
        max_alias_cost: Bound on YAML alias-expansion cost.
        max_depth: Maximum collection nesting depth.
    """

    max_bytes: int
    max_alias_cost: int
    max_depth: int


def effective_intake_limits() -> IntakeLimits:
    """Return the intake limits from the published resource-limits artifact.

    Returns:
        The :class:`IntakeLimits` mirroring ``oas_resource_limits.json`` — one
        source of truth shared with the designer safe-parse wrapper, so import
        and source-review reject the same documents.
    """
    values = resource_limit_values()
    return IntakeLimits(
        max_bytes=values.max_document_bytes,
        max_alias_cost=values.max_alias_count,
        max_depth=values.max_nesting_depth,
    )


def _where(source_label: Optional[str]) -> str:
    return f" ({source_label})" if source_label else ""


def guard_document_size(
    text: str,
    *,
    source_label: Optional[str] = None,
    limits: Optional[IntakeLimits] = None,
) -> None:
    """Reject a document larger than the intake byte ceiling.

    Args:
        text: Raw document text.
        source_label: Optional label used to make the error specific.
        limits: Override bounds; defaults to :func:`effective_intake_limits`.

    Raises:
        IntakeLimitError: ``INPUT_TOO_LARGE`` when the text exceeds the ceiling.
    """
    bounds = limits or effective_intake_limits()
    size = len(text.encode("utf-8", errors="replace"))
    if size > bounds.max_bytes:
        raise IntakeLimitError(
            f"Source document is too large{_where(source_label)}: {size} bytes "
            f"exceeds the {bounds.max_bytes}-byte import limit",
            code="INPUT_TOO_LARGE",
        )


def guard_payload_bytes(
    raw: bytes,
    *,
    source_label: Optional[str] = None,
    limits: Optional[IntakeLimits] = None,
) -> None:
    """Reject an oversized payload by byte length, before it is decoded to text.

    The bytes-level twin of :func:`guard_document_size`. Decoding a payload to
    ``str`` roughly doubles its footprint, and text-only formats (protobuf,
    GraphQL, IDLs) never reach the JSON/YAML guard, so the ceiling is applied to
    the raw upload first.

    Args:
        raw: The decoded upload bytes.
        source_label: Optional label used to make the error specific.
        limits: Override bounds; defaults to :func:`effective_intake_limits`.

    Raises:
        IntakeLimitError: ``INPUT_TOO_LARGE`` when the payload exceeds the ceiling.
    """
    bounds = limits or effective_intake_limits()
    if len(raw) > bounds.max_bytes:
        raise IntakeLimitError(
            f"Source document is too large{_where(source_label)}: {len(raw)} bytes "
            f"exceeds the {bounds.max_bytes}-byte import limit",
            code="INPUT_TOO_LARGE",
        )


def guard_document_text(
    text: str,
    *,
    source_label: Optional[str] = None,
    limits: Optional[IntakeLimits] = None,
) -> None:
    """Run every pre-parse guard over raw document text.

    Checks size, YAML alias-expansion cost, and a conservative depth bound — all
    without materializing the document, so a bomb is rejected before it can
    consume memory.

    Args:
        text: Raw document text.
        source_label: Optional label used to make errors specific.
        limits: Override bounds; defaults to :func:`effective_intake_limits`.

    Raises:
        IntakeLimitError: For an oversized, over-expanding, or too-deep document.
    """
    bounds = limits or effective_intake_limits()
    guard_document_size(text, source_label=source_label, limits=bounds)

    # Alias expansion: weighted cost, bailing out as soon as the bound is passed.
    # A stream that does not scan as YAML is left to the caller's syntax handling.
    _documents, alias_cost, scan_failed = yaml_alias_expansion_cost(text, bounds.max_alias_cost)
    if not scan_failed and alias_cost > bounds.max_alias_cost:
        raise IntakeLimitError(
            f"Source document's aliases expand too far{_where(source_label)}: "
            f"expansion cost {alias_cost} exceeds the {bounds.max_alias_cost} limit",
            code="INPUT_EXPANSION_LIMIT",
        )

    # Depth: the pre-parse bound over-estimates, so it is applied with slack; the
    # exact check runs post-parse in guard_parsed_document.
    bound = pre_scan_depth_bound(text)
    if bound > bounds.max_depth * PRE_SCAN_DEPTH_SLACK:
        raise IntakeLimitError(
            f"Source document nests too deeply{_where(source_label)}: at least "
            f"{bound} levels far exceeds the {bounds.max_depth}-level import limit",
            code="INPUT_DEPTH_LIMIT",
        )


def guard_parsed_document(
    parsed: Any,
    *,
    source_label: Optional[str] = None,
    limits: Optional[IntakeLimits] = None,
) -> None:
    """Run the exact post-parse depth and cycle guard over a parsed document.

    Args:
        parsed: The parsed JSON/YAML value.
        source_label: Optional label used to make errors specific.
        limits: Override bounds; defaults to :func:`effective_intake_limits`.

    Raises:
        IntakeLimitError: ``INPUT_DEPTH_LIMIT`` when the value nests past the
            limit or contains a self-referential alias cycle (which no bounded
            consumer can safely walk).
    """
    bounds = limits or effective_intake_limits()
    depth, circular = analyze_nesting(parsed)
    if circular:
        raise IntakeLimitError(
            f"Source document contains a circular reference{_where(source_label)}: "
            "a YAML alias points at one of its own ancestors",
            code="INPUT_DEPTH_LIMIT",
        )
    if depth > bounds.max_depth:
        raise IntakeLimitError(
            f"Source document nests too deeply{_where(source_label)}: {depth} "
            f"levels exceeds the {bounds.max_depth}-level import limit",
            code="INPUT_DEPTH_LIMIT",
        )

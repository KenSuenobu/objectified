"""Safe OpenAPI source parsing under the DCW-0.2 resource limits — DCW-2.1 (private-suite#2352).

Python mirror of the designer's ``safe-oas-parse.ts``: it wraps YAML/JSON parsing
so any limit violation or syntax error produces **structured, non-mutating
diagnostics** — never a raw exception and never a partial document. The limits
come from the field-for-field artifact mirror in :mod:`app.oas_resource_limits`.

Failure classes and their stable diagnostic codes (identical to the TS wrapper):

* ``OAS_LIMIT_DOCUMENT_BYTES`` — UTF-8 size gate, checked before parsing.
* ``OAS_LIMIT_ALIAS_COUNT``    — YAML alias-expansion bound (anti billion-laughs).
* ``OAS_LIMIT_NESTING_DEPTH``  — collection nesting bound (pre-scan + exact check).
* ``OAS_MULTIPLE_DOCUMENTS``   — multi-document YAML streams are rejected.
* ``OAS_DUPLICATE_KEY``        — duplicate mapping keys, with line/column. Unlike
  the designer (where ``JSON.parse`` cannot see duplicates — the gap documented
  in the artifact's ``duplicateKeyPolicy``), this backend parser rejects
  duplicate keys in **JSON as well**, via an ``object_pairs_hook``.
* ``OAS_CIRCULAR_ALIAS``       — self-referential aliases produce a circular
  document no OpenAPI surface can process.
* ``OAS_YAML_SYNTAX`` / ``OAS_JSON_SYNTAX`` — plain syntax errors.

The contract is all-or-nothing: ``ok`` with a complete document and no
diagnostics, or not-``ok`` with at least one diagnostic and no document, so no
caller can act on a partial parse (the DCW-0.2
``failure-injection-no-partial-mutation`` parser rule).

Everything here is pure: no DB, no network, no mutation of anything.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Tuple

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .oas_resource_limits import OasResourceLimitValues, resource_limit_values

__all__ = [
    "OasParseDiagnostic",
    "SafeOasParseResult",
    "analyze_nesting",
    "pre_scan_depth_bound",
    "safe_oas_parse",
    "yaml_alias_expansion_cost",
]


class OasParseDiagnostic(BaseModel):
    """One structured, human-readable parse diagnostic (mirror of the TS shape)."""

    model_config = ConfigDict(extra="forbid")

    code: Literal[
        "OAS_LIMIT_DOCUMENT_BYTES",
        "OAS_LIMIT_ALIAS_COUNT",
        "OAS_LIMIT_NESTING_DEPTH",
        "OAS_MULTIPLE_DOCUMENTS",
        "OAS_DUPLICATE_KEY",
        "OAS_CIRCULAR_ALIAS",
        "OAS_YAML_SYNTAX",
        "OAS_JSON_SYNTAX",
    ] = Field(description="Stable machine-readable code for the failure class.")
    message: str = Field(description="Human-readable message; never a raw traceback.")
    severity: Literal["error"] = Field(
        default="error", description="Every limit or parse failure blocks the document."
    )
    line: Optional[int] = Field(default=None, description="1-based line when known.")
    col: Optional[int] = Field(default=None, description="1-based column when known.")
    limit: Optional[int] = Field(default=None, description="Configured bound for OAS_LIMIT_* codes.")
    actual: Optional[int] = Field(default=None, description="Measured value when cheaply known.")


class SafeOasParseResult(BaseModel):
    """Result of one safe parse: a document or diagnostics, never both partial."""

    model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)

    ok: bool = Field(description="True iff parsing succeeded within every limit.")
    document: Optional[Any] = Field(
        default=None, description="Present iff ok. Any diagnostic means no document at all."
    )
    diagnostics: List[OasParseDiagnostic] = Field(
        default_factory=list, description="Empty iff ok."
    )


def _failure(*diagnostics: OasParseDiagnostic) -> SafeOasParseResult:
    return SafeOasParseResult(ok=False, diagnostics=list(diagnostics))


def _pre_scan_depth_bound(text: str) -> int:
    """Conservative pre-parse upper bound on nesting depth.

    The larger of the maximum leading-whitespace run (block nesting grows at
    most one level per indentation space) and the running open-bracket depth
    outside quoted spans (flow nesting). Protects the recursive parsers from
    stack exhaustion on pathological input; the exact iterative post-parse
    check enforces the real limit. Direct port of the TS ``preScanDepthBound``.
    """
    max_indent = 0
    indent = 0
    at_line_start = True
    bracket_depth = 0
    max_bracket_depth = 0
    quote: Optional[str] = None
    in_comment = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\n":
            at_line_start = True
            indent = 0
            in_comment = False
            i += 1
            continue
        if in_comment:
            i += 1
            continue
        if quote is not None:
            if ch == quote:
                quote = None
            elif ch == "\\" and quote == '"':
                i += 1
            i += 1
            continue
        if at_line_start and ch == " ":
            indent += 1
            if indent > max_indent:
                max_indent = indent
            i += 1
            continue
        at_line_start = False
        if ch == "#":
            in_comment = True
        elif ch in ('"', "'"):
            quote = ch
        elif ch in ("[", "{"):
            bracket_depth += 1
            if bracket_depth > max_bracket_depth:
                max_bracket_depth = bracket_depth
        elif ch in ("]", "}"):
            bracket_depth = max(0, bracket_depth - 1)
        i += 1
    return max(max_indent, max_bracket_depth)


# The pre-parse scan runs against the limit with this slack factor, so
# conservative over-estimates (indented block scalars, brackets in plain
# scalars) never reject legitimate documents; the exact post-parse check
# enforces the real limit. Same constant as the TS wrapper.
_PRE_SCAN_DEPTH_SLACK = 4


def _analyze_materialized(root: Any) -> Tuple[int, bool]:
    """Exact maximum nesting depth plus circularity of a parsed value, iterative.

    Returns:
        ``(depth, circular)``. Depth counts collection nesting levels (a scalar
        document has depth 0). Circularity detection uses an on-path id set, so
        shared (diamond) subtrees are fine but a self-referential alias is not.
    """
    max_depth = 0
    on_path: set[int] = set()
    # (value, depth, entered)
    stack: List[List[Any]] = [[root, 0, False]]
    while stack:
        frame = stack[-1]
        value, depth, entered = frame[0], frame[1], frame[2]
        if not isinstance(value, (dict, list)):
            if depth > max_depth:
                max_depth = depth
            stack.pop()
            continue
        if not entered:
            if id(value) in on_path:
                return max_depth, True
            on_path.add(id(value))
            frame[2] = True
            if depth > max_depth:
                max_depth = depth
            children = value if isinstance(value, list) else list(value.values())
            for child in children:
                stack.append([child, depth + 1, False])
        else:
            on_path.discard(id(value))
            stack.pop()
    return max_depth, False


class _DuplicateKeyError(Exception):
    """Raised by the checking loader when a mapping repeats a key."""

    def __init__(self, key: Any, mark: Any) -> None:
        self.key = key
        self.mark = mark
        super().__init__(f"duplicate key {key!r}")


class _LimitCheckingLoader(yaml.SafeLoader):
    """``SafeLoader`` that rejects duplicate mapping keys with their position."""

    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> Dict[Any, Any]:
        seen: set[Any] = set()
        for key_node, _value_node in node.value:
            # YAML merge keys (`<<`) are handled by SafeLoader's flatten step and
            # have no plain-value constructor; they cannot be duplicate data keys.
            if key_node.tag == "tag:yaml.org,2002:merge":
                continue
            key = self.construct_object(key_node, deep=True)
            try:
                hashable = key if not isinstance(key, (dict, list)) else repr(key)
            except Exception:  # pragma: no cover - defensive
                hashable = repr(key)
            if hashable in seen:
                raise _DuplicateKeyError(key, key_node.start_mark)
            seen.add(hashable)
        return super().construct_mapping(node, deep=deep)


def _mark_position(mark: Any) -> Tuple[Optional[int], Optional[int]]:
    """1-based (line, col) from a PyYAML mark, or (None, None)."""
    if mark is None:
        return None, None
    return mark.line + 1, mark.column + 1


def _count_yaml_stream(text: str, max_alias_count: int) -> Tuple[int, int, Optional[OasParseDiagnostic]]:
    """Scan the YAML event stream counting documents and alias expansion cost.

    Aliases are counted with an expansion-cost weight: each ``*alias`` event
    adds the number of events its anchor's subtree recorded, so nested
    anchor-in-anchor chains (billion laughs) blow past the bound immediately
    even though each individual alias is a single token. This mirrors the yaml
    library's ``maxAliasCount`` count*aliasCount product semantics.

    Returns:
        ``(document_count, alias_cost, diagnostic)`` where ``diagnostic`` is a
        syntax diagnostic if the stream could not be scanned (the caller maps it
        directly), else ``None``.
    """
    document_count = 0
    alias_cost = 0
    # Anchor name -> number of scalar/collection events recorded inside it.
    anchor_weight: Dict[str, int] = {}
    # Stack of (anchor_name or None, running_event_count) for open collections.
    open_anchors: List[List[Any]] = []
    try:
        for event in yaml.parse(text, Loader=yaml.SafeLoader):
            if isinstance(event, yaml.DocumentStartEvent):
                document_count += 1
                continue
            if isinstance(event, yaml.AliasEvent):
                weight = anchor_weight.get(event.anchor, 1)
                alias_cost += weight
                for frame in open_anchors:
                    frame[1] += weight
                if alias_cost > max_alias_count:
                    # Stop scanning immediately: the bound exists precisely so a
                    # crafted stream cannot force unbounded work.
                    return document_count, alias_cost, None
                continue
            is_open = isinstance(event, (yaml.MappingStartEvent, yaml.SequenceStartEvent))
            is_close = isinstance(event, (yaml.MappingEndEvent, yaml.SequenceEndEvent))
            if isinstance(event, yaml.ScalarEvent):
                for frame in open_anchors:
                    frame[1] += 1
                if event.anchor:
                    anchor_weight[event.anchor] = 1
            elif is_open:
                for frame in open_anchors:
                    frame[1] += 1
                open_anchors.append([getattr(event, "anchor", None), 1])
            elif is_close:
                frame = open_anchors.pop()
                if frame[0]:
                    anchor_weight[frame[0]] = frame[1]
    except yaml.YAMLError as exc:
        line, col = _mark_position(getattr(exc, "problem_mark", None))
        return document_count, alias_cost, OasParseDiagnostic(
            code="OAS_YAML_SYNTAX",
            message=str(getattr(exc, "problem", None) or exc).strip() or "Invalid YAML",
            line=line,
            col=col,
        )
    return document_count, alias_cost, None


# ===========================================================================
# Shared limit primitives (IXH-1.4)
# ===========================================================================
#
# The three checks below are the reusable core of this module: a pre-parse depth
# bound, a YAML alias-expansion cost, and an exact post-parse depth/circularity
# analysis. :mod:`app.intake_resource_guard` applies the same primitives to
# *import* intake (the resource-limits artifact lists ``import`` in its
# ``appliesTo``), so they are exported rather than duplicated there.


def pre_scan_depth_bound(text: str) -> int:
    """Conservative pre-parse upper bound on a document's nesting depth.

    Args:
        text: Raw JSON/YAML source text.

    Returns:
        An over-estimate of the collection nesting depth, cheap enough to run
        before parsing. Callers apply slack (see :data:`PRE_SCAN_DEPTH_SLACK`)
        because block scalars and brackets in plain scalars inflate it.
    """
    return _pre_scan_depth_bound(text)


#: Slack factor callers apply to :func:`pre_scan_depth_bound` results.
PRE_SCAN_DEPTH_SLACK = _PRE_SCAN_DEPTH_SLACK


def yaml_alias_expansion_cost(text: str, max_alias_count: int) -> Tuple[int, int, bool]:
    """Scan a YAML stream for document count and alias-expansion cost.

    Each ``*alias`` is weighted by the event count of the subtree its anchor
    recorded, so an anchor-in-anchor "billion laughs" chain exceeds the bound
    within a few levels instead of after materialization.

    Args:
        text: Raw YAML source text.
        max_alias_count: Bound at which scanning stops early.

    Returns:
        ``(document_count, alias_cost, scan_failed)``. ``scan_failed`` is ``True``
        when the stream is not valid YAML, in which case the counts are partial
        and the caller should fall through to its own syntax handling.
    """
    document_count, alias_cost, diagnostic = _count_yaml_stream(text, max_alias_count)
    return document_count, alias_cost, diagnostic is not None


def analyze_nesting(root: Any) -> Tuple[int, bool]:
    """Exact nesting depth and circularity of an already-parsed value.

    Args:
        root: A parsed JSON/YAML value.

    Returns:
        ``(depth, circular)``; depth counts collection levels (a scalar is 0),
        and ``circular`` is ``True`` for a self-referential (alias cycle)
        structure. Iterative, so analyzing hostile input cannot recurse.
    """
    return _analyze_materialized(root)


def safe_oas_parse(
    text: str,
    source_format: Literal["yaml", "json"] = "yaml",
    limits: Optional[OasResourceLimitValues] = None,
) -> SafeOasParseResult:
    """Parse OpenAPI source text under the versioned resource limits.

    The contract is all-or-nothing: ``ok`` with a complete document and no
    diagnostics, or not-``ok`` with at least one structured diagnostic and no
    document. The function never raises for any covered failure class, so
    callers cannot accidentally act on a partial parse.

    Args:
        text: The OpenAPI source text.
        source_format: ``"yaml"`` (default) or ``"json"``.
        limits: Optional limit overrides (tests, tighter surfaces); defaults to
            the artifact values from :func:`app.oas_resource_limits.resource_limit_values`.

    Returns:
        The parse result; see :class:`SafeOasParseResult`.
    """
    if limits is None:
        limits = resource_limit_values()

    # Size gate before any parsing.
    byte_length = len(text.encode("utf-8"))
    if byte_length > limits.max_document_bytes:
        return _failure(
            OasParseDiagnostic(
                code="OAS_LIMIT_DOCUMENT_BYTES",
                message=(
                    f"Document is {byte_length} bytes; "
                    f"the limit is {limits.max_document_bytes} bytes."
                ),
                limit=limits.max_document_bytes,
                actual=byte_length,
            )
        )

    # Depth gate before parsing: reject clearly pathological nesting while the
    # recursive parsers are still safe to skip entirely.
    depth_bound = _pre_scan_depth_bound(text)
    if depth_bound > limits.max_nesting_depth * _PRE_SCAN_DEPTH_SLACK:
        return _failure(
            OasParseDiagnostic(
                code="OAS_LIMIT_NESTING_DEPTH",
                message=(
                    f"Document nesting reaches at least depth {depth_bound}; "
                    f"the limit is {limits.max_nesting_depth}."
                ),
                limit=limits.max_nesting_depth,
                actual=depth_bound,
            )
        )

    if source_format == "json":
        return _parse_json(text, limits)
    return _parse_yaml(text, limits)


def _parse_json(text: str, limits: OasResourceLimitValues) -> SafeOasParseResult:
    """JSON branch of :func:`safe_oas_parse` (duplicate keys rejected here too)."""
    import json as _json

    duplicate: List[str] = []

    def _reject_duplicates(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for key, value in pairs:
            if key in out and not duplicate:
                duplicate.append(key)
            out[key] = value
        return out

    try:
        document = _json.loads(text, object_pairs_hook=_reject_duplicates)
    except RecursionError:
        return _failure(
            OasParseDiagnostic(
                code="OAS_LIMIT_NESTING_DEPTH",
                message=(
                    "Document nesting exhausted the parser; "
                    f"the limit is {limits.max_nesting_depth}."
                ),
                limit=limits.max_nesting_depth,
            )
        )
    except _json.JSONDecodeError as exc:
        return _failure(
            OasParseDiagnostic(
                code="OAS_JSON_SYNTAX",
                message=exc.msg,
                line=exc.lineno,
                col=exc.colno,
            )
        )
    if duplicate:
        return _failure(
            OasParseDiagnostic(
                code="OAS_DUPLICATE_KEY",
                message=f"Duplicate object key {duplicate[0]!r}.",
            )
        )
    depth, _circular = _analyze_materialized(document)
    if depth > limits.max_nesting_depth:
        return _failure(
            OasParseDiagnostic(
                code="OAS_LIMIT_NESTING_DEPTH",
                message=(
                    f"Document nesting reaches depth {depth}; "
                    f"the limit is {limits.max_nesting_depth}."
                ),
                limit=limits.max_nesting_depth,
                actual=depth,
            )
        )
    return SafeOasParseResult(ok=True, document=document)


def _parse_yaml(text: str, limits: OasResourceLimitValues) -> SafeOasParseResult:
    """YAML branch of :func:`safe_oas_parse`."""
    # Event-stream scan first: document count and alias expansion cost are both
    # knowable without constructing anything.
    document_count, alias_cost, scan_diagnostic = _count_yaml_stream(
        text, limits.max_alias_count
    )
    if scan_diagnostic is not None:
        return _failure(scan_diagnostic)
    if document_count > limits.max_yaml_documents_per_source:
        return _failure(
            OasParseDiagnostic(
                code="OAS_MULTIPLE_DOCUMENTS",
                message=(
                    f"Source contains {document_count} YAML documents; "
                    "an OpenAPI source is exactly one document."
                ),
                limit=limits.max_yaml_documents_per_source,
                actual=document_count,
            )
        )
    if alias_cost > limits.max_alias_count:
        return _failure(
            OasParseDiagnostic(
                code="OAS_LIMIT_ALIAS_COUNT",
                message=(
                    "YAML alias expansion exceeds the configured bound of "
                    f"{limits.max_alias_count}."
                ),
                limit=limits.max_alias_count,
                actual=alias_cost,
            )
        )

    try:
        document = yaml.load(text, Loader=_LimitCheckingLoader)
    except _DuplicateKeyError as exc:
        line, col = _mark_position(exc.mark)
        return _failure(
            OasParseDiagnostic(
                code="OAS_DUPLICATE_KEY",
                message=f"Duplicate mapping key {exc.key!r}.",
                line=line,
                col=col,
            )
        )
    except RecursionError:
        return _failure(
            OasParseDiagnostic(
                code="OAS_LIMIT_NESTING_DEPTH",
                message=(
                    "Document nesting exhausted the parser; "
                    f"the limit is {limits.max_nesting_depth}."
                ),
                limit=limits.max_nesting_depth,
            )
        )
    except yaml.YAMLError as exc:
        line, col = _mark_position(getattr(exc, "problem_mark", None))
        return _failure(
            OasParseDiagnostic(
                code="OAS_YAML_SYNTAX",
                message=str(getattr(exc, "problem", None) or exc).strip() or "Invalid YAML",
                line=line,
                col=col,
            )
        )

    depth, circular = _analyze_materialized(document)
    if circular:
        return _failure(
            OasParseDiagnostic(
                code="OAS_CIRCULAR_ALIAS",
                message=(
                    "Self-referential YAML aliases produce a circular document, "
                    "which no OpenAPI surface can process."
                ),
            )
        )
    if depth > limits.max_nesting_depth:
        return _failure(
            OasParseDiagnostic(
                code="OAS_LIMIT_NESTING_DEPTH",
                message=(
                    f"Document nesting reaches depth {depth}; "
                    f"the limit is {limits.max_nesting_depth}."
                ),
                limit=limits.max_nesting_depth,
                actual=depth,
            )
        )
    return SafeOasParseResult(ok=True, document=document)

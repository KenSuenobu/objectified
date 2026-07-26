"""Validate a JSON instance against a JSON Schema, with bounded ``$ref`` resolution — IXH-5.1 (#5113).

Apiome could lint and score a schema but never answer the question every API developer actually
asks: *does this payload satisfy this schema?* The only validation in the codebase ran inside the
export path (:mod:`app.export_validation` re-parses an emitted artifact) and the mock runtime —
neither is a first-class capability over a cataloged schema. This module is that capability's
pure core: schema in, instance in, ordered structured findings out. No I/O, no clock, no network.

**Findings.** Every failure carries the five facts the acceptance criteria name — the JSON
Pointer into the *instance*, the failing *keyword*, what the schema *expected*, what the instance
*actually* held, and a human-readable message — plus the JSON Pointer into the *schema* so a UI
can jump to the offending constraint. ``anyOf`` / ``oneOf`` / ``not`` failures are reported as the
headline branch failure **and** its underlying branch errors (bounded by
:data:`MAX_CONTEXT_DEPTH`), because "matched none of 3 branches" alone is never actionable.

**Order is part of the contract.** ``jsonschema`` yields errors in an order that depends on
keyword iteration and, for branch keywords, on branch order. Callers diff these reports across
revisions, so :func:`validate_json_instance` sorts every finding by instance pointer (numeric
array indices ordered numerically, not lexically), then schema pointer, keyword, and message.
Equal inputs therefore produce byte-equal reports.

**References are bounded, cycle-safe, and never fetched from the network.** A schema's external
``$ref``s are resolved *before* validation by :func:`build_reference_registry`, breadth-first
through an injected retriever, with a depth ceiling (:data:`MAX_REF_DEPTH`), a fan-out ceiling
(:data:`MAX_REF_FANOUT`), and a seen-set that makes a reference cycle terminate on its second
visit. The retriever is the **only** way a document enters the registry: this module performs no
HTTP itself, so there is no code path by which validating an instance can reach the network
(the SSRF guard in :mod:`app.ssrf_guard` governs the paths that legitimately do fetch). A ``$ref``
that no retriever can satisfy becomes an ``INPUT_REFERENCE_UNRESOLVED`` diagnostic naming the ref
and its location — it is reported, never swallowed, and never silently treated as "matches
anything".
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple
from urllib.parse import urldefrag, urljoin

from jsonschema.exceptions import SchemaError, ValidationError
from jsonschema.validators import (
    Draft4Validator,
    Draft6Validator,
    Draft7Validator,
    Draft201909Validator,
    Draft202012Validator,
)
from pydantic import BaseModel, ConfigDict, Field
from referencing import Registry, Resource
from referencing.exceptions import Unresolvable
from referencing.jsonschema import DRAFT4, DRAFT6, DRAFT7, DRAFT201909, DRAFT202012

from .schema_validation import DRAFT_2020_12, derive_draft

__all__ = [
    "DEFAULT_MAX_FINDINGS",
    "MAX_CONTEXT_DEPTH",
    "MAX_FINDINGS_CEILING",
    "MAX_REF_DEPTH",
    "MAX_REF_FANOUT",
    "MAX_SCHEMA_NODES",
    "SUPPORTED_DIALECTS",
    "InstanceFinding",
    "JsonValidationResult",
    "SchemaRetriever",
    "ValidationDiagnostic",
    "build_reference_registry",
    "validate_json_instance",
]

#: Maximum number of findings returned by default. Reports are for humans and for diffing; a
#: payload that fails 40 000 times has one root cause, and the caller can raise this.
DEFAULT_MAX_FINDINGS = 100

#: Hard ceiling on ``max_findings``, whatever the caller asks for.
MAX_FINDINGS_CEILING = 1000

#: How deep branch-keyword (``anyOf`` / ``oneOf`` / ``not``) sub-errors are flattened. Four
#: levels covers real polymorphic schemas; beyond that the sub-errors describe branches of
#: branches and stop being actionable.
MAX_CONTEXT_DEPTH = 4

#: Maximum ``$ref`` hops followed away from the root document (root = depth 0).
MAX_REF_DEPTH = 8

#: Maximum number of distinct external documents pulled in across the whole resolution.
MAX_REF_FANOUT = 64

#: Maximum schema nodes visited while collecting ``$ref``s from one document.
MAX_SCHEMA_NODES = 100_000

#: Longest JSON serialization kept verbatim in a finding's ``expected`` / ``actual``.
_MAX_RENDERED_CHARS = 512

#: Dialect token → (``jsonschema`` validator class, ``referencing`` specification).
#:
#: The tokens are the ones :func:`app.schema_validation.derive_draft` produces from a ``$schema``
#: URI, so this map covers exactly the drafts the type registry already accepts. Draft-03 is
#: deliberately absent: ``jsonschema`` ships no Draft-03 validator, and no adapter emits it.
SUPPORTED_DIALECTS: Dict[str, Tuple[Any, Any]] = {
    "04": (Draft4Validator, DRAFT4),
    "06": (Draft6Validator, DRAFT6),
    "07": (Draft7Validator, DRAFT7),
    "2019-09": (Draft201909Validator, DRAFT201909),
    DRAFT_2020_12: (Draft202012Validator, DRAFT202012),
}

#: Resolves an absolute schema URI to its document, or ``None`` when it is not resolvable.
#: The service injects a tenant-scoped, registry-backed lookup; tests inject a dict.
SchemaRetriever = Callable[[str], Optional[Dict[str, Any]]]


class InstanceFinding(BaseModel):
    """One structured way an instance failed its schema.

    Attributes:
        pointer: RFC 6901 JSON Pointer to the offending value **in the instance**
            (``""`` for the document root).
        keyword: The schema keyword that failed (``required``, ``type``, ``pattern``, …).
        schema_pointer: JSON Pointer to the failing keyword **in the schema**, so a UI can
            link the finding to the constraint that produced it.
        expected: What the schema demanded — the keyword's value, rendered (and summarized
            when large, see :attr:`truncated`).
        actual: What the instance held at :attr:`pointer`, rendered the same way.
        message: Human-readable description of the failure.
        line: 1-based line number, when the validator reports one (XML instances only).
        column: 1-based column number, when the validator reports one (XML instances only).
        truncated: ``True`` when :attr:`expected` or :attr:`actual` was summarized rather than
            reproduced verbatim, so a caller never mistakes a summary for the real value.
    """

    model_config = ConfigDict(extra="forbid")

    pointer: str = Field(description="JSON Pointer to the offending value in the instance.")
    keyword: str = Field(description="The schema keyword that failed.")
    schema_pointer: str = Field(
        default="", description="JSON Pointer to the failing keyword in the schema."
    )
    expected: Optional[Any] = Field(
        default=None, description="What the schema required, rendered."
    )
    actual: Optional[Any] = Field(
        default=None, description="What the instance held at ``pointer``, rendered."
    )
    message: str = Field(description="Human-readable failure description.")
    line: Optional[int] = Field(default=None, description="1-based line number when known.")
    column: Optional[int] = Field(default=None, description="1-based column number when known.")
    truncated: bool = Field(
        default=False,
        description="Whether ``expected``/``actual`` were summarized rather than reproduced.",
    )


class ValidationDiagnostic(BaseModel):
    """Something that limited the validation, as opposed to a failure of the instance.

    An unresolvable ``$ref``, a bound that tripped, a scalar the canonical projection could not
    constrain, or a toolchain that is not installed. Diagnostics are reported separately from
    findings so a caller never confuses "your payload is wrong" with "we could not fully check
    your payload".

    Attributes:
        code: Stable :mod:`app.intake_error_taxonomy` code (e.g. ``INPUT_REFERENCE_UNRESOLVED``).
        message: Human-readable explanation, naming the specific ref/limit/tool.
        pointer: JSON Pointer into the schema where the condition arose, when known.
    """

    model_config = ConfigDict(extra="forbid")

    code: str = Field(description="Stable intake-taxonomy code for the condition.")
    message: str = Field(description="Human-readable explanation.")
    pointer: Optional[str] = Field(
        default=None, description="JSON Pointer into the schema, when the condition has a site."
    )


@dataclass
class JsonValidationResult:
    """The outcome of validating one JSON instance against one schema.

    Attributes:
        valid: ``True`` when the validator ran and found nothing. ``None`` when it could not
            run at all (an unusable schema) — never conflated with "valid".
        validated: Whether a validator actually executed over the instance.
        validator: Identifier of the validator that ran (``jsonschema/2020-12``).
        dialect: The resolved JSON Schema dialect token.
        findings: Ordered findings (see the module docstring for the ordering contract).
        diagnostics: Conditions that limited the validation.
        total_findings: How many findings the validator produced before ``max_findings``
            truncation — so a caller sees the true failure count.
        truncated: Whether ``findings`` was cut short by ``max_findings``.
    """

    valid: Optional[bool]
    validated: bool
    validator: str
    dialect: str
    findings: List[InstanceFinding] = field(default_factory=list)
    diagnostics: List[ValidationDiagnostic] = field(default_factory=list)
    total_findings: int = 0
    truncated: bool = False


# ===========================================================================
# Reference resolution
# ===========================================================================


def build_reference_registry(
    schema: Dict[str, Any],
    *,
    base_uri: str = "",
    retrieve: Optional[SchemaRetriever] = None,
    max_depth: int = MAX_REF_DEPTH,
    max_fanout: int = MAX_REF_FANOUT,
) -> Tuple[Registry, List[ValidationDiagnostic]]:
    """Pre-resolve a schema's external ``$ref``s into an offline :class:`referencing.Registry`.

    Walks the schema breadth-first, and for every ``$ref`` that leaves the current document asks
    ``retrieve`` for the target. Resolution stops at ``max_depth`` hops and ``max_fanout``
    documents; a URI already fetched is never fetched twice, which is what makes a reference
    cycle (``a.json`` → ``b.json`` → ``a.json``) terminate.

    The returned registry is **closed**: it contains only what ``retrieve`` supplied. Handing it
    to a validator therefore guarantees the validator cannot reach out for anything else — an
    unsatisfied ``$ref`` surfaces as a diagnostic here, not as a network call later.

    Args:
        schema: The root schema document.
        base_uri: Absolute URI the root document's relative refs resolve against. Empty when
            the schema has no location (a projected canonical type), in which case only
            absolute refs can leave the document.
        retrieve: Resolver for an absolute URI. ``None`` means "nothing is resolvable", which
            is the correct default for a schema that should be self-contained.
        max_depth: Maximum ``$ref`` hops away from the root document.
        max_fanout: Maximum number of distinct external documents pulled in.

    Returns:
        ``(registry, diagnostics)`` — the registry to validate with, and one diagnostic per
        unresolvable ref, depth breach, or fan-out breach.
    """
    diagnostics: List[ValidationDiagnostic] = []
    registry: Registry = Registry()
    root_uri = urldefrag(base_uri or "").url

    # Seed with the root so relative refs resolve against it. A schema with its own ``$id``
    # is *also* reachable under that id, which is how a self-referential ``$id``-anchored
    # ``$ref`` finds its way home.
    seen: Set[str] = {root_uri}
    registry = _with_resource(registry, root_uri, schema)
    declared_id = schema.get("$id")
    if isinstance(declared_id, str) and declared_id:
        resolved_id = urldefrag(urljoin(root_uri, declared_id)).url
        if resolved_id not in seen:
            seen.add(resolved_id)
            registry = _with_resource(registry, resolved_id, schema)

    fetched = 0
    # Queue entries are (document, the URI it was loaded from, hops from the root).
    queue: List[Tuple[Dict[str, Any], str, int]] = [(schema, root_uri, 0)]
    while queue:
        document, document_uri, depth = queue.pop(0)
        for ref, pointer in _iter_refs(document):
            target = _external_target(ref, document_uri)
            if target is None:
                continue  # a same-document fragment — the validator resolves it locally
            if target in seen:
                continue  # already loaded (or already reported); this is the cycle guard
            if depth >= max_depth:
                seen.add(target)
                diagnostics.append(
                    ValidationDiagnostic(
                        code="INPUT_DEPTH_LIMIT",
                        message=(
                            f"Reference {ref!r} was not followed: it sits more than "
                            f"{max_depth} reference hops from the schema root."
                        ),
                        pointer=pointer,
                    )
                )
                continue
            if fetched >= max_fanout:
                seen.add(target)
                diagnostics.append(
                    ValidationDiagnostic(
                        code="INPUT_EXPANSION_LIMIT",
                        message=(
                            f"Reference {ref!r} was not followed: this schema already pulls in "
                            f"the maximum of {max_fanout} referenced documents."
                        ),
                        pointer=pointer,
                    )
                )
                continue

            seen.add(target)
            loaded = retrieve(target) if retrieve is not None else None
            if not isinstance(loaded, dict):
                diagnostics.append(
                    ValidationDiagnostic(
                        code="INPUT_REFERENCE_UNRESOLVED",
                        message=(
                            f"Reference {ref!r} could not be resolved to a schema "
                            f"({target!r}). Nothing was fetched over the network; only "
                            "schemas stored in this tenant's registry are resolvable."
                        ),
                        pointer=pointer,
                    )
                )
                continue

            fetched += 1
            registry = _with_resource(registry, target, loaded)
            queue.append((loaded, target, depth + 1))

    return registry, diagnostics


def _with_resource(registry: Registry, uri: str, document: Dict[str, Any]) -> Registry:
    """Add ``document`` to ``registry`` under ``uri``, defaulting an unmarked doc to 2020-12."""
    try:
        resource = Resource.from_contents(document)
    except Exception:  # noqa: BLE001 — no ``$schema``: fall back to the service default dialect
        resource = DRAFT202012.create_resource(document)
    return registry.with_resource(uri=uri, resource=resource)


def _external_target(ref: Any, document_uri: str) -> Optional[str]:
    """Return the absolute, fragment-free URI a ``$ref`` leaves the document for.

    Args:
        ref: The ``$ref`` value as written.
        document_uri: URI of the document the ref was written in.

    Returns:
        The absolute target URI, or ``None`` when the ref stays inside its own document
        (a bare fragment, or a resolved URI equal to the document's own).
    """
    if not isinstance(ref, str) or not ref or ref.startswith("#"):
        return None
    resolved = urldefrag(urljoin(document_uri, ref)).url
    if not resolved or resolved == urldefrag(document_uri).url:
        return None
    return resolved


def _iter_refs(document: Any) -> List[Tuple[str, str]]:
    """Collect every ``$ref`` in a schema document with its JSON Pointer, depth-bounded.

    Args:
        document: The schema (or any subtree of one).

    Returns:
        ``(ref, pointer)`` pairs in a deterministic (document) order. At most
        :data:`MAX_SCHEMA_NODES` nodes are visited; a schema larger than that has already
        failed the intake guards, so the bound is a backstop against a hand-crafted store row.
    """
    found: List[Tuple[str, str]] = []
    # Explicit stack: a schema nested thousands deep must not exhaust the interpreter stack.
    stack: List[Tuple[Any, str]] = [(document, "")]
    visited = 0
    while stack and visited < MAX_SCHEMA_NODES:
        node, pointer = stack.pop()
        visited += 1
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str):
                found.append((ref, f"{pointer}/$ref"))
            # Reversed so the pop order above reproduces document order.
            for key in reversed(list(node)):
                stack.append((node[key], f"{pointer}/{_escape_token(key)}"))
        elif isinstance(node, list):
            for index in reversed(range(len(node))):
                stack.append((node[index], f"{pointer}/{index}"))
    return found


def _escape_token(token: Any) -> str:
    """Escape one JSON Pointer reference token per RFC 6901 (``~`` → ``~0``, ``/`` → ``~1``)."""
    return str(token).replace("~", "~0").replace("/", "~1")


# ===========================================================================
# Validation
# ===========================================================================


def validate_json_instance(
    schema: Dict[str, Any],
    instance: Any,
    *,
    dialect: Optional[str] = None,
    base_uri: str = "",
    retrieve: Optional[SchemaRetriever] = None,
    max_findings: int = DEFAULT_MAX_FINDINGS,
    assert_formats: bool = False,
) -> JsonValidationResult:
    """Validate one JSON instance against one JSON Schema.

    Args:
        schema: The schema document.
        instance: The parsed JSON value to check.
        dialect: Dialect token to validate under. ``None`` derives it from the schema's
            ``$schema`` (:func:`app.schema_validation.derive_draft`). An unsupported token
            falls back to draft 2020-12 with a diagnostic saying so.
        base_uri: Absolute URI the schema's relative ``$ref``s resolve against.
        retrieve: Resolver for external ``$ref`` targets; see
            :func:`build_reference_registry`. ``None`` means nothing external is resolvable.
        max_findings: Cap on returned findings, clamped to :data:`MAX_FINDINGS_CEILING`.
        assert_formats: When ``True``, ``format`` is asserted rather than annotated. Off by
            default because ``format`` is an annotation in every modern draft, and because
            ``jsonschema`` silently skips checkers whose optional dependency is absent — an
            asserted-format pass is therefore weaker evidence than a keyword pass.

    Returns:
        The :class:`JsonValidationResult`. ``valid`` is ``None`` (and ``validated`` is
        ``False``) only when the schema itself is unusable — never as a stand-in for a pass.
    """
    limit = max(1, min(int(max_findings), MAX_FINDINGS_CEILING))
    diagnostics: List[ValidationDiagnostic] = []

    token = (dialect or derive_draft(schema)).strip()
    if token not in SUPPORTED_DIALECTS:
        diagnostics.append(
            ValidationDiagnostic(
                code="FORMAT_VERSION_UNSUPPORTED",
                message=(
                    f"JSON Schema dialect {token!r} is not supported; the instance was "
                    f"validated under draft {DRAFT_2020_12} instead. Supported dialects: "
                    + ", ".join(sorted(SUPPORTED_DIALECTS))
                    + "."
                ),
            )
        )
        token = DRAFT_2020_12
    validator_cls, _specification = SUPPORTED_DIALECTS[token]
    validator_id = f"jsonschema/{token}"

    # A schema that is not itself a legal schema cannot produce trustworthy findings. Saying so
    # is the honest answer; running anyway would report the schema's bugs as the payload's.
    try:
        validator_cls.check_schema(schema)
    except SchemaError as exc:
        diagnostics.append(
            ValidationDiagnostic(
                code="INPUT_SEMANTIC_INVALID",
                message=(
                    f"The stored schema is not a valid draft {token} schema and cannot "
                    f"validate anything: {exc.message}"
                ),
                pointer=_pointer_from_parts(exc.absolute_path),
            )
        )
        return JsonValidationResult(
            valid=None,
            validated=False,
            validator=validator_id,
            dialect=token,
            diagnostics=diagnostics,
        )

    registry, ref_diagnostics = build_reference_registry(
        schema, base_uri=base_uri, retrieve=retrieve
    )
    diagnostics.extend(ref_diagnostics)

    validator = validator_cls(
        schema,
        registry=registry,
        format_checker=validator_cls.FORMAT_CHECKER if assert_formats else None,
    )

    collected: List[InstanceFinding] = []
    try:
        for error in validator.iter_errors(instance):
            _collect_error(error, collected, depth=0)
    except Unresolvable as exc:
        # The validator tripped over a ref the pre-pass could not satisfy. Reported, not
        # swallowed: the caller learns the check was incomplete rather than getting a false
        # pass. When the pre-pass already named the ref (with its pointer, which this exception
        # lacks) that diagnostic stands alone rather than being restated less precisely.
        if not any(d.code == "INPUT_REFERENCE_UNRESOLVED" for d in diagnostics):
            diagnostics.append(
                ValidationDiagnostic(
                    code="INPUT_REFERENCE_UNRESOLVED",
                    message=(
                        "Validation stopped because a schema reference could not be resolved: "
                        f"{exc}. Nothing was fetched over the network."
                    ),
                )
            )
        return JsonValidationResult(
            valid=None,
            validated=False,
            validator=validator_id,
            dialect=token,
            findings=_order_findings(collected)[:limit],
            diagnostics=diagnostics,
            total_findings=len(collected),
            truncated=len(collected) > limit,
        )

    ordered = _order_findings(collected)
    return JsonValidationResult(
        valid=not ordered,
        validated=True,
        validator=validator_id,
        dialect=token,
        findings=ordered[:limit],
        diagnostics=diagnostics,
        total_findings=len(ordered),
        truncated=len(ordered) > limit,
    )


def _collect_error(
    error: ValidationError,
    sink: List[InstanceFinding],
    *,
    depth: int,
) -> None:
    """Append ``error`` — and, for branch keywords, its sub-errors — to ``sink``.

    ``jsonschema`` reports a failed ``anyOf`` / ``oneOf`` / ``not`` as one error whose
    ``context`` holds the per-branch errors. Those sub-errors carry a ``parent`` link, so their
    ``absolute_path`` / ``absolute_schema_path`` already resolve against the original instance
    and schema — no prefix threading is needed, and adding one would double the branch segment.
    """
    instance_path = tuple(error.absolute_path)
    schema_path = tuple(error.absolute_schema_path)
    expected, expected_truncated = _render_value(error.validator_value)
    actual, actual_truncated = _render_value(error.instance)
    sink.append(
        InstanceFinding(
            pointer=_pointer_from_parts(instance_path),
            keyword=str(error.validator) if error.validator is not None else "schema",
            schema_pointer=_pointer_from_parts(schema_path),
            expected=expected,
            actual=actual,
            message=error.message,
            truncated=expected_truncated or actual_truncated,
        )
    )
    if depth >= MAX_CONTEXT_DEPTH:
        return
    for sub in error.context or ():
        _collect_error(sub, sink, depth=depth + 1)


def _order_findings(findings: List[InstanceFinding]) -> List[InstanceFinding]:
    """Sort findings into the deterministic order the API contract promises."""
    return sorted(findings, key=_finding_sort_key)


def _finding_sort_key(finding: InstanceFinding) -> Tuple[Any, ...]:
    """Sort key: instance pointer (array indices numerically), then schema pointer/keyword/message."""
    return (
        _pointer_sort_key(finding.pointer),
        _pointer_sort_key(finding.schema_pointer),
        finding.keyword,
        finding.message,
    )


def _pointer_sort_key(pointer: str) -> Tuple[Tuple[int, int, str], ...]:
    """Turn a JSON Pointer into a tuple that sorts array indices numerically.

    ``/items/10`` must sort after ``/items/2``, which plain string comparison gets wrong. Each
    token becomes ``(0, index, "")`` when it is an integer and ``(1, 0, token)`` otherwise, so
    numeric and string tokens never compare against each other's payloads.
    """
    key: List[Tuple[int, int, str]] = []
    for token in (pointer or "").split("/")[1:]:
        unescaped = token.replace("~1", "/").replace("~0", "~")
        if unescaped.isdigit():
            key.append((0, int(unescaped), ""))
        else:
            key.append((1, 0, unescaped))
    return tuple(key)


def _pointer_from_parts(parts: Sequence[Any]) -> str:
    """Build an RFC 6901 JSON Pointer from a sequence of path tokens (``()`` → ``""``)."""
    return "".join(f"/{_escape_token(part)}" for part in parts)


def _render_value(value: Any) -> Tuple[Any, bool]:
    """Render a value for a finding, summarizing anything too large to reproduce.

    Args:
        value: The schema keyword value or instance value to render.

    Returns:
        ``(rendered, truncated)``. ``rendered`` is the value itself when its JSON serialization
        fits in :data:`_MAX_RENDERED_CHARS`; otherwise a summary dict naming the JSON type and
        size, with ``truncated`` ``True`` so a caller never mistakes the summary for the value.
    """
    try:
        serialized = json.dumps(value, default=str)
    except (TypeError, ValueError):
        return (f"<unrenderable {type(value).__name__}>", True)
    if len(serialized) <= _MAX_RENDERED_CHARS:
        return (value, False)
    return ({"summary": _describe(value), "truncated": True}, True)


def _describe(value: Any) -> str:
    """One-line description of a value too large to reproduce (``object with 42 properties``)."""
    if isinstance(value, dict):
        return f"object with {len(value)} propert{'y' if len(value) == 1 else 'ies'}"
    if isinstance(value, list):
        return f"array with {len(value)} item{'' if len(value) == 1 else 's'}"
    if isinstance(value, str):
        return f"string of {len(value)} characters"
    return type(value).__name__

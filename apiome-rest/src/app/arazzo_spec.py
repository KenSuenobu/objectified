"""Arazzo version and document-shape knowledge — FMT-3.1 (#5426).

The Arazzo pipeline is spread over five modules (detection, normalization, lint,
emit, persistence) and every one of them needs the same three answers:

* **which versions do we read?** — Arazzo ``1.0.x`` and, since the May 2026
  revision, ``1.1.x``. Anything else is a *version* rejection, not a format
  mismatch, so the taxonomy code is ``FORMAT_VERSION_UNSUPPORTED``;
* **what does a step actually call?** — ``operationId`` (bare, or the
  ``$sourceDescriptions.<name>.<operationId>`` runtime expression), ``operationRef``
  (a ``#/sourceDescriptions/<name-or-index>`` pointer), ``operationPath``, a sibling
  ``workflowId``, or Apiome Studio's older ``request: {source, operationId}`` spelling.
  A step that names *none* of them has nothing to invoke and is semantically invalid;
* **is this step synchronous?** — Arazzo 1.1 added ``sourceDescriptions[].type:
  asyncapi``, so a step may target an event on a broker instead of an HTTP
  operation. Such a step reads its criteria and outputs from ``$message.*`` rather
  than ``$response.*``.

Keeping that in one module means detection, lint and emit cannot drift apart about
what a 1.1 document means.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

__all__ = [
    "ARAZZO_VERSION_1_0",
    "ARAZZO_VERSION_1_1",
    "SOURCE_TYPE_ARAZZO",
    "SOURCE_TYPE_ASYNCAPI",
    "SOURCE_TYPE_OPENAPI",
    "STEP_TARGET_FIELDS",
    "SUPPORTED_ARAZZO_VERSIONS",
    "ArazzoSemanticError",
    "ArazzoVersionError",
    "StepTarget",
    "default_arazzo_version",
    "is_arazzo_marker",
    "parse_arazzo_version",
    "resolve_step_target",
    "source_description_names",
    "source_description_types",
    "step_is_async",
    "supports_async_sources",
    "validate_arazzo_semantics",
    "validate_arazzo_version",
]

#: The version emitted for a model whose sources are all synchronous and which
#: carries no version of its own. Matches the 1.0 line's final patch release.
ARAZZO_VERSION_1_0 = "1.0.1"

#: The version emitted for a model that uses an AsyncAPI source description —
#: expressible only from Arazzo 1.1 onwards.
ARAZZO_VERSION_1_1 = "1.1.0"

#: ``(major, minor)`` pairs this adapter reads and writes, in ascending order.
SUPPORTED_ARAZZO_VERSIONS: Tuple[Tuple[int, int], ...] = ((1, 0), (1, 1))

SOURCE_TYPE_OPENAPI = "openapi"
SOURCE_TYPE_ASYNCAPI = "asyncapi"
SOURCE_TYPE_ARAZZO = "arazzo"

#: Every field a step may use to name what it invokes, in resolution order. ``request`` is
#: Apiome Studio's older spelling, still present in the shipped 1.0 corpus.
STEP_TARGET_FIELDS: Tuple[str, ...] = (
    "operationId",
    "operationRef",
    "operationPath",
    "workflowId",
    "request",
)

#: ``$sourceDescriptions.<name>.<operationId>`` — the reference form Arazzo 1.1
#: documents use in place of a bare ``operationId``.
_SOURCE_EXPRESSION = re.compile(
    r"^\$sourceDescriptions\.(?P<source>[A-Za-z0-9_-]+)\.(?P<operation>.+)$"
)

#: ``{$sourceDescriptions.<name>.url}#/paths/...`` — the ``operationPath`` spelling.
_SOURCE_PATH_EXPRESSION = re.compile(
    r"^\{\$sourceDescriptions\.(?P<source>[A-Za-z0-9_-]+)\.url\}"
)

#: ``#/sourceDescriptions/<name-or-index>`` — the ``operationRef`` pointer form.
_SOURCE_POINTER = re.compile(r"^#/sourceDescriptions/(?P<token>[^/]+)")

#: A ``major.minor`` prefix, with any remaining patch/pre-release suffix ignored.
_VERSION = re.compile(r"^(?P<major>\d+)\.(?P<minor>\d+)(?:[.\-+].*)?$")

#: Runtime-expression prefixes that only exist for an asynchronous (AsyncAPI) step:
#: a message received from a channel rather than an HTTP response.
_ASYNC_EXPRESSION_PREFIX = "$message"


class ArazzoVersionError(ValueError):
    """The document's ``arazzo`` marker names a version this adapter cannot read."""


class ArazzoSemanticError(ValueError):
    """The document parses as Arazzo but describes something unrunnable."""


def is_arazzo_marker(value: Any) -> bool:
    """Whether ``value`` is a usable top-level ``arazzo:`` version marker.

    Detection deliberately claims *any* version marker, including one this adapter
    cannot read: a document that says ``arazzo: 2.0.0`` is an Arazzo document, and
    reporting it as an unrecognized format would send the user hunting for the wrong
    problem. The version itself is rejected later, by
    :func:`validate_arazzo_version`.

    Args:
        value: The document's ``arazzo`` value.

    Returns:
        ``True`` when the value is a non-blank string.
    """
    return isinstance(value, str) and bool(value.strip())


def parse_arazzo_version(value: Any) -> Tuple[int, int]:
    """Return the ``(major, minor)`` pair a version marker names.

    Args:
        value: The document's ``arazzo`` value (for example ``"1.1.0"``).

    Returns:
        The parsed major and minor numbers; the patch component is ignored, because
        Arazzo's compatibility contract is per minor version.

    Raises:
        ArazzoVersionError: When the marker is missing, blank, or not ``M.N[.P]``.
    """
    if not is_arazzo_marker(value):
        raise ArazzoVersionError(
            "not an Arazzo document (missing or unsupported `arazzo` version marker)"
        )
    match = _VERSION.match(str(value).strip())
    if match is None:
        raise ArazzoVersionError(
            f"`arazzo: {value}` is not a recognizable Arazzo version "
            "(expected `major.minor[.patch]`, for example `1.1.0`)."
        )
    return int(match.group("major")), int(match.group("minor"))


def validate_arazzo_version(value: Any) -> Tuple[int, int]:
    """Parse a version marker and require it to be one this adapter reads.

    Args:
        value: The document's ``arazzo`` value.

    Returns:
        The accepted ``(major, minor)`` pair.

    Raises:
        ArazzoVersionError: When the marker is unparseable or names a version outside
            :data:`SUPPORTED_ARAZZO_VERSIONS`.
    """
    version = parse_arazzo_version(value)
    if version not in SUPPORTED_ARAZZO_VERSIONS:
        supported = ", ".join(f"{major}.{minor}.x" for major, minor in SUPPORTED_ARAZZO_VERSIONS)
        raise ArazzoVersionError(
            f"Arazzo {value} is not supported; this importer reads {supported}."
        )
    return version


def supports_async_sources(version: Tuple[int, int]) -> bool:
    """Whether a version can express an AsyncAPI ``sourceDescription``.

    Args:
        version: A ``(major, minor)`` pair from :func:`parse_arazzo_version`.

    Returns:
        ``True`` from Arazzo 1.1 onwards, which is where ``type: asyncapi`` was added.
    """
    return version >= (1, 1)


def default_arazzo_version(*, has_async_sources: bool) -> str:
    """The version to write for a model that carries no version of its own.

    Args:
        has_async_sources: Whether the model declares an AsyncAPI source description.

    Returns:
        :data:`ARAZZO_VERSION_1_1` when an async source must be expressible, otherwise
        :data:`ARAZZO_VERSION_1_0` — a model that needs nothing from 1.1 is not
        silently pushed onto a newer version than its consumers may accept.
    """
    return ARAZZO_VERSION_1_1 if has_async_sources else ARAZZO_VERSION_1_0


def source_description_names(source_descriptions: Any) -> List[str]:
    """Declared ``sourceDescriptions[].name`` values, in declaration order.

    Args:
        source_descriptions: The document's ``sourceDescriptions`` value.

    Returns:
        The names, with unnamed or malformed entries represented by ``""`` so an
        entry's list index still matches its position in the source document (an
        ``operationRef`` may point at a source by index).
    """
    if not isinstance(source_descriptions, list):
        return []
    names: List[str] = []
    for entry in source_descriptions:
        name = entry.get("name") if isinstance(entry, dict) else None
        names.append(name if isinstance(name, str) and name.strip() else "")
    return names


def source_description_types(source_descriptions: Any) -> Dict[str, str]:
    """Map each named source description to its declared ``type``.

    Args:
        source_descriptions: The document's ``sourceDescriptions`` value.

    Returns:
        ``{name: type}`` for every entry that declares both. Entries with no declared
        ``type`` are omitted rather than defaulted, so an unknown type stays unknown
        instead of being reported as OpenAPI.
    """
    types: Dict[str, str] = {}
    if not isinstance(source_descriptions, list):
        return types
    for entry in source_descriptions:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        kind = entry.get("type")
        if isinstance(name, str) and name.strip() and isinstance(kind, str) and kind.strip():
            types[name] = kind.strip()
    return types


@dataclass(frozen=True)
class StepTarget:
    """What a workflow step invokes, and where that thing is described.

    Attributes:
        kind: Which field named the target — ``operationId``, ``operationRef``,
            ``operationPath``, ``workflowId`` or ``request`` (the Apiome Studio
            spelling).
        source_name: The ``sourceDescriptions`` entry the target lives in, when the
            step names one; ``None`` for a bare ``operationId`` or a sibling workflow.
        operation_id: The operation identifier within that source, when the step
            spells one out; ``None`` for pointer/path forms.
    """

    kind: str
    source_name: Optional[str] = None
    operation_id: Optional[str] = None


def _pointer_source(reference: str, names: Sequence[str]) -> Optional[str]:
    """Resolve a ``#/sourceDescriptions/<token>`` pointer to a source name."""
    match = _SOURCE_POINTER.match(reference)
    if match is None:
        return None
    token = match.group("token")
    if token.isdigit():
        index = int(token)
        return names[index] if 0 <= index < len(names) else None
    return token


def resolve_step_target(
    step: Mapping[str, Any], *, source_names: Sequence[str] = ()
) -> Optional[StepTarget]:
    """Work out what a step calls, across every spelling Arazzo admits.

    Args:
        step: One workflow step mapping.
        source_names: Declared source-description names in declaration order, used to
            resolve an ``operationRef`` that points at a source by index.

    Returns:
        The resolved :class:`StepTarget`, or ``None`` when the step names nothing to
        invoke (which :func:`validate_arazzo_semantics` treats as invalid).
    """
    operation_id = step.get("operationId")
    if isinstance(operation_id, str) and operation_id.strip():
        match = _SOURCE_EXPRESSION.match(operation_id.strip())
        if match is not None:
            return StepTarget(
                kind="operationId",
                source_name=match.group("source"),
                operation_id=match.group("operation"),
            )
        return StepTarget(kind="operationId", operation_id=operation_id.strip())

    operation_ref = step.get("operationRef")
    if isinstance(operation_ref, str) and operation_ref.strip():
        return StepTarget(
            kind="operationRef",
            source_name=_pointer_source(operation_ref.strip(), source_names),
        )

    operation_path = step.get("operationPath")
    if isinstance(operation_path, str) and operation_path.strip():
        match = _SOURCE_PATH_EXPRESSION.match(operation_path.strip())
        return StepTarget(
            kind="operationPath",
            source_name=match.group("source") if match is not None else None,
        )

    workflow_id = step.get("workflowId")
    if isinstance(workflow_id, str) and workflow_id.strip():
        return StepTarget(kind="workflowId")

    request = step.get("request")
    if isinstance(request, dict) and (request.get("operationId") or request.get("source")):
        # Apiome Studio's older spelling, still present in the shipped 1.0 corpus.
        source = request.get("source")
        request_operation = request.get("operationId")
        return StepTarget(
            kind="request",
            source_name=source if isinstance(source, str) and source.strip() else None,
            operation_id=(
                request_operation
                if isinstance(request_operation, str) and request_operation.strip()
                else None
            ),
        )
    return None


def _iter_expression_strings(value: Any) -> Iterable[str]:
    """Yield every string nested anywhere inside ``value``."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from _iter_expression_strings(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _iter_expression_strings(nested)


def step_is_async(
    step: Mapping[str, Any],
    *,
    target: Optional[StepTarget] = None,
    source_types: Optional[Mapping[str, str]] = None,
) -> bool:
    """Whether a step waits on a message rather than calling an HTTP operation.

    Two independent signals, either of which is enough: the step targets a
    ``sourceDescriptions`` entry declared ``type: asyncapi``, or it reads a
    ``$message.*`` runtime expression in its criteria or outputs. The second is what
    makes the classification survive a document whose source types are omitted.

    Args:
        step: One workflow step mapping.
        target: The step's resolved target, when the caller already has it.
        source_types: ``{name: type}`` from :func:`source_description_types`.

    Returns:
        ``True`` when the step has asynchronous semantics.
    """
    if target is not None and target.source_name and source_types:
        if source_types.get(target.source_name) == SOURCE_TYPE_ASYNCAPI:
            return True
    for key in ("successCriteria", "outputs"):
        for text in _iter_expression_strings(step.get(key)):
            if text.strip().startswith(_ASYNC_EXPRESSION_PREFIX):
                return True
    return False


def validate_arazzo_semantics(document: Mapping[str, Any]) -> None:
    """Reject a well-formed Arazzo document that describes nothing runnable.

    The one rule enforced here is the one a workflow runner cannot work around: every
    step must name something to invoke. Structural shape beyond that is left to the
    normalizer, which is deliberately tolerant so a partially-authored document still
    imports and can be inspected.

    Args:
        document: The parsed Arazzo document.

    Raises:
        ArazzoSemanticError: When a step names no ``operationId``, ``operationRef``,
            ``operationPath``, ``workflowId`` or ``request``.
    """
    workflows = document.get("workflows")
    if not isinstance(workflows, list):
        return
    names = source_description_names(document.get("sourceDescriptions"))
    for workflow_index, workflow in enumerate(workflows):
        if not isinstance(workflow, dict):
            continue
        workflow_id = workflow.get("workflowId") or workflow.get("name") or workflow_index
        steps = workflow.get("steps")
        if not isinstance(steps, list):
            continue
        for step_index, step in enumerate(steps):
            if not isinstance(step, dict):
                continue
            if resolve_step_target(step, source_names=names) is not None:
                continue
            step_id = step.get("stepId") or step.get("name") or step_index
            spellings = ", ".join(f"`{field}`" for field in STEP_TARGET_FIELDS[:-1])
            raise ArazzoSemanticError(
                f"Workflow {workflow_id!r} step {step_id!r} names nothing to invoke: "
                f"a step must declare one of {spellings}."
            )

"""Arazzo lint pack — MFI-30.2 (#4395), FMT-3.1 (#5426).

Quality signals for Arazzo workflow documents, layered on the canonical lint engine
(MFI-4.1 :mod:`app.lint_engine`) and the shared scoring formula (MFI-4.2
:mod:`app.schema_lint`). The native :class:`ArazzoRulePack` runs purely over the
:class:`~app.canonical_model.CanonicalApi` produced by :mod:`app.arazzo_normalizer` and
flags:

* **unresolvable operation references** — a step's ``operationId`` is absent from every
  embedded ``sourceDescriptions`` OpenAPI document;
* **unused workflow inputs** — a workflow declares ``inputs`` but no step parameter/body
  references them;
* **missing success criteria** — a step declares no ``successCriteria``;
* **async sources before 1.1** — a ``1.0.x`` document declares an AsyncAPI
  ``sourceDescription``, which only Arazzo 1.1 admits.

**Arazzo 1.1 reference forms (FMT-3.1).** Reference checking runs through
:func:`app.arazzo_spec.resolve_step_target`, so the three spellings a 1.1 document uses —
the ``$sourceDescriptions.<name>.<operationId>`` runtime expression, an ``operationRef``
that points at a source *by index*, and an ``operationPath`` templated on a source's
``url`` — are understood rather than reported as dangling. ``operationId`` membership is
checked **per source description** (and against AsyncAPI operations as well as OpenAPI
ones) so an async step is not measured against the REST API's operation list.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Set, Tuple

from .arazzo_spec import (
    SOURCE_TYPE_ASYNCAPI,
    ArazzoVersionError,
    parse_arazzo_version,
    resolve_step_target,
    source_description_names,
    source_description_types,
    supports_async_sources,
)
from .canonical_model import CanonicalApi, Operation, Service
from .lint_engine import LintRule, RulePack, lint_canonical_model
from .schema_lint import LintResult

__all__ = [
    "ArazzoRulePack",
    "collect_embedded_operation_ids",
    "embedded_operation_ids_by_source",
    "lint_arazzo_result",
    "lint_arazzo",
]

_HTTP_METHODS = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
)

_INPUT_REF = re.compile(r"\$inputs\.([A-Za-z0-9_.-]+)")


def _services_sorted(api: CanonicalApi) -> List[Service]:
    return sorted(api.services, key=lambda s: s.key)


def _operations_sorted(service: Service) -> List[Operation]:
    return sorted(service.operations, key=lambda o: o.key)


def embedded_operation_ids_by_source(*source_lists: Any) -> Dict[str, Set[str]]:
    """Map each source description name to the operation ids its document declares.

    Args:
        *source_lists: One or more ``sourceDescriptions``-shaped lists. Entries may carry
            their document inline as ``content`` (an Arazzo document may embed it) or via
            the ``resolvedSources`` bag a fileset import produces.

    Returns:
        ``{source name: {operationId, ...}}`` for every named source whose document could
        be read. Sources with no readable document are absent, which is what lets the
        reference rules stay silent instead of guessing.
    """
    by_source: Dict[str, Set[str]] = {}
    for source_descriptions in source_lists:
        if not isinstance(source_descriptions, list):
            continue
        for entry in source_descriptions:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            content = entry.get("content")
            if not isinstance(name, str) or not name.strip() or not isinstance(content, dict):
                continue
            ids = _operation_ids_from_document(content)
            if ids:
                by_source.setdefault(name, set()).update(ids)
    return by_source


def collect_embedded_operation_ids(source_descriptions: Any) -> Set[str]:
    """Return ``operationId`` values declared in embedded source documents.

    Args:
        source_descriptions: A ``sourceDescriptions``-shaped list.

    Returns:
        The union of every embedded document's operation ids, across OpenAPI/Swagger
        and AsyncAPI sources.
    """
    ids: Set[str] = set()
    for source_ids in embedded_operation_ids_by_source(source_descriptions).values():
        ids.update(source_ids)
    return ids


def _operation_ids_from_document(document: Dict[str, Any]) -> Set[str]:
    """Operation ids declared by an embedded OpenAPI/Swagger or AsyncAPI document."""
    if isinstance(document.get("openapi"), str) or isinstance(document.get("swagger"), str):
        return _operation_ids_from_openapi(document)
    if isinstance(document.get("asyncapi"), str):
        return _operation_ids_from_asyncapi(document)
    return set()


def _operation_ids_from_openapi(document: Dict[str, Any]) -> Set[str]:
    ids: Set[str] = set()
    for path_item in (document.get("paths") or {}).values():
        if not isinstance(path_item, dict):
            continue
        for method, operation in path_item.items():
            if method not in _HTTP_METHODS or not isinstance(operation, dict):
                continue
            operation_id = operation.get("operationId")
            if isinstance(operation_id, str) and operation_id.strip():
                ids.add(operation_id)
    return ids


def _operation_ids_from_asyncapi(document: Dict[str, Any]) -> Set[str]:
    """Operation names an AsyncAPI document declares (FMT-3.1).

    AsyncAPI 3 keys its ``operations`` map by name; AsyncAPI 2 spells the same thing as
    an ``operationId`` on each channel's ``publish``/``subscribe``. Both are accepted, so
    an Arazzo 1.1 step that names an event operation resolves against either revision.
    """
    ids: Set[str] = set()
    operations = document.get("operations")
    if isinstance(operations, dict):
        ids.update(name for name in operations if isinstance(name, str) and name.strip())
    channels = document.get("channels")
    if isinstance(channels, dict):
        for channel in channels.values():
            if not isinstance(channel, dict):
                continue
            for action in ("publish", "subscribe"):
                operation = channel.get(action)
                if isinstance(operation, dict):
                    operation_id = operation.get("operationId")
                    if isinstance(operation_id, str) and operation_id.strip():
                        ids.add(operation_id)
    return ids


def _iter_steps(api: CanonicalApi) -> Iterable[Tuple[Service, Operation]]:
    for service in _services_sorted(api):
        for operation in _operations_sorted(service):
            yield service, operation


def _step_path(service: Service, operation: Operation) -> str:
    return f"services.{service.key}.operations.{operation.key}"


def _known_operation_ids(api: CanonicalApi) -> Dict[str, Set[str]]:
    """Operation ids per source description, from embedded and resolved documents."""
    return embedded_operation_ids_by_source(
        api.extras.get("sourceDescriptions"), api.extras.get("resolvedSources")
    )


def _check_dangling_operation_ref(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Flag a step whose ``operationId`` no readable source document declares.

    A bare ``operationId`` is checked against every readable source; the Arazzo 1.1
    ``$sourceDescriptions.<name>.<operationId>`` form is checked against *that* source
    only, because naming the source is precisely what makes the reference unambiguous.
    Sources whose document is not available are not guessed at: a step that names one is
    left alone rather than reported against the sources that happen to be readable.
    """
    by_source = _known_operation_ids(api)
    if not by_source:
        return
    source_names = source_description_names(api.extras.get("sourceDescriptions"))
    for service, operation in _iter_steps(api):
        target = resolve_step_target(operation.extras, source_names=source_names)
        if target is None or not target.operation_id:
            continue
        if target.source_name is not None:
            known = by_source.get(target.source_name)
            if known is None:
                continue
            scope = f"sourceDescription {target.source_name!r}"
        else:
            known = set().union(*by_source.values())
            scope = "any embedded sourceDescription document"
        if target.operation_id not in known:
            yield (
                _step_path(service, operation),
                f"Step references unknown operationId {target.operation_id!r}; it is not "
                f"declared in {scope}.",
            )


def _check_unresolvable_operation_ref(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Flag an ``operationRef`` that does not resolve to a declared source description.

    A pointer may name its source either by name (``#/sourceDescriptions/orders``) or by
    position (``#/sourceDescriptions/1``); both are legal, so an index within range is
    accepted and only an out-of-range one is reported (FMT-3.1, #5426).
    """
    declared = source_description_names(api.extras.get("sourceDescriptions"))
    known_names = {name for name in declared if name}
    for service, operation in _iter_steps(api):
        operation_ref = operation.extras.get("operationRef")
        if not isinstance(operation_ref, str) or not operation_ref.strip():
            continue
        if not operation_ref.startswith("#/sourceDescriptions/"):
            yield (
                _step_path(service, operation),
                f"Step operationRef {operation_ref!r} is not a sourceDescriptions pointer.",
            )
            continue
        parts = operation_ref.split("/")
        if len(parts) < 3 or not parts[2]:
            yield (
                _step_path(service, operation),
                f"Step operationRef {operation_ref!r} is malformed.",
            )
            continue
        token = parts[2]
        if token.isdigit():
            if declared and not 0 <= int(token) < len(declared):
                yield (
                    _step_path(service, operation),
                    f"Step operationRef {operation_ref!r} points at sourceDescription index "
                    f"{token}, but only {len(declared)} are declared.",
                )
            continue
        if known_names and token not in known_names:
            yield (
                _step_path(service, operation),
                f"Step operationRef {operation_ref!r} points at unknown sourceDescription "
                f"{token!r}.",
            )


def _referenced_input_names(value: Any) -> Set[str]:
    names: Set[str] = set()
    if isinstance(value, str):
        names.update(_INPUT_REF.findall(value))
    elif isinstance(value, dict):
        for nested in value.values():
            names.update(_referenced_input_names(nested))
    elif isinstance(value, list):
        for nested in value:
            names.update(_referenced_input_names(nested))
    return names


def _check_unused_workflow_inputs(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    for service in _services_sorted(api):
        inputs = service.extras.get("inputs")
        if not isinstance(inputs, dict):
            continue
        properties = inputs.get("properties")
        if not isinstance(properties, dict) or not properties:
            continue
        declared = {name for name in properties if isinstance(name, str)}
        referenced: Set[str] = set()
        for operation in _operations_sorted(service):
            referenced.update(_referenced_input_names(operation.extras.get("parameters")))
            referenced.update(_referenced_input_names(operation.extras.get("requestBody")))
        unused = sorted(declared - referenced)
        if unused:
            yield (
                f"services.{service.key}",
                f"Workflow inputs {', '.join(unused)} are never referenced by any step.",
            )


def _check_missing_success_criteria(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    for service, operation in _iter_steps(api):
        criteria = operation.extras.get("successCriteria")
        if not criteria:
            yield (
                _step_path(service, operation),
                "Step declares no successCriteria; workflow runners cannot verify completion.",
            )


def _check_async_source_before_1_1(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Flag an AsyncAPI source description in a document that declares Arazzo 1.0.

    ``sourceDescriptions[].type: asyncapi`` — and with it a workflow spanning a
    synchronous and an asynchronous API — arrived in Arazzo 1.1 (FMT-3.1, #5426). A 1.0
    document that uses it will be rejected by a conforming 1.0 runner, so the fix is to
    declare ``arazzo: 1.1.0``, not to drop the source.
    """
    try:
        version = parse_arazzo_version(api.extras.get("arazzo"))
    except ArazzoVersionError:
        return
    if supports_async_sources(version):
        return
    async_sources = sorted(
        name
        for name, kind in source_description_types(api.extras.get("sourceDescriptions")).items()
        if kind == SOURCE_TYPE_ASYNCAPI
    )
    if async_sources:
        yield (
            "sourceDescriptions",
            f"Source description(s) {', '.join(async_sources)} declare `type: asyncapi`, "
            f"which Arazzo {api.extras.get('arazzo')} does not define; declare `arazzo: 1.1.0`.",
        )


class ArazzoRulePack(RulePack, register=True):
    """Native hygiene rules for Arazzo workflow artifacts."""

    format = "arazzo"
    pack_id = "arazzo"

    _RULES: Tuple[LintRule, ...] = (
        LintRule(
            rule_id="arazzo.dangling-operation-id",
            category="reference",
            severity="error",
            description="Step operationId must resolve to an embedded sourceDescription.",
            check=_check_dangling_operation_ref,
        ),
        LintRule(
            rule_id="arzzo.unresolvable-operation-ref",
            category="reference",
            severity="error",
            description="Step operationRef must point at a declared sourceDescription.",
            check=_check_unresolvable_operation_ref,
        ),
        LintRule(
            rule_id="arazzo.unused-workflow-input",
            category="structure",
            severity="warning",
            description="Workflow inputs should be referenced by at least one step.",
            check=_check_unused_workflow_inputs,
        ),
        LintRule(
            rule_id="arazzo.missing-success-criteria",
            category="structure",
            severity="warning",
            description="Every workflow step should declare successCriteria.",
            check=_check_missing_success_criteria,
        ),
        LintRule(
            rule_id="arazzo.async-source-before-1-1",
            category="version",
            severity="error",
            description="An AsyncAPI sourceDescription requires Arazzo 1.1 or newer.",
            check=_check_async_source_before_1_1,
        ),
    )

    def rules(self) -> List[LintRule]:
        return list(self._RULES)


def lint_arazzo_result(model: CanonicalApi) -> LintResult:
    """Lint a normalized Arazzo artifact through the shared engine."""
    return lint_canonical_model(model)


def lint_arazzo(raw: str) -> LintResult:
    """Parse, normalize, and lint raw Arazzo source end-to-end."""
    from .arazzo_import_source import ArazzoImportSource

    adapter = ArazzoImportSource()
    native = adapter.parse(raw)
    model = adapter.normalize(native)
    return lint_arazzo_result(model)

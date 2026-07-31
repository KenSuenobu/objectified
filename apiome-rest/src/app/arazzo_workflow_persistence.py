"""Persist Arazzo workflows as Workflow / WorkflowStep entities — REPO-3.4 (#2773).

MFI-30.2 taught Apiome to *read* Arazzo (detect → parse → normalize → lint → emit → diff).
This module is the missing write: it turns the canonical model an Arazzo import produces into
rows in the V225 ``api_workflows`` / ``api_workflow_steps`` tables, so an orchestration is a
queryable entity rather than an opaque blob on the catalog item.

The shape mirrors the source document:

* each canonical :class:`~app.canonical_model.Service` (one per Arazzo ``workflows[]`` entry)
  becomes a :class:`WorkflowRow`;
* each of its operations (one per ``steps[]`` entry) becomes a :class:`WorkflowStepRow`,
  ordered by ``order_index``.

The interesting part is **operationRef resolution**. An Arazzo step points at an operation in
some OpenAPI document; when that document was imported in the same repository scan, the
operation already exists internally as a ``path_operation`` row and the two can be joined. So
each step is matched against an :class:`OperationIndex` built from the scan's path operations:

* a hit sets ``resolved_path_operation_id`` and ``resolution_status='resolved'``;
* a miss keeps the raw ``operationRef``/``operationId`` string exactly as written, leaves the
  FK NULL, and records why (``resolution_status`` + ``resolution_reason``) plus a human-readable
  warning — an unresolved reference is normal (the target spec may simply live elsewhere), not
  an import failure.

A step that cannot be read at all is isolated as ``parse_error`` and its siblings still import,
matching the per-channel isolation REPO-3.3 established for AsyncAPI.

Everything above :func:`persist_arazzo_workflows` is pure — no database, no I/O — so the
mapping and the ref grammar are unit-testable without a live Postgres.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import unquote

from .canonical_model import CanonicalApi, Operation, Service

__all__ = [
    "ARAZZO_WORKFLOW_FORMATS",
    "OperationIndex",
    "OperationTarget",
    "WorkflowImportResult",
    "WorkflowRow",
    "WorkflowStepRow",
    "build_workflow_rows",
    "load_arazzo_workflows",
    "parse_operation_ref",
    "persist_arazzo_workflows",
    "resolve_workflow_steps",
]

#: Canonical ``format`` labels this module writes workflow rows for.
ARAZZO_WORKFLOW_FORMATS = frozenset({"arazzo"})

# `resolution_status` values (mirrors the V225 CHECK constraint).
STATUS_RESOLVED = "resolved"
STATUS_UNRESOLVED = "unresolved"
STATUS_NOT_APPLICABLE = "not_applicable"
STATUS_PARSE_ERROR = "parse_error"

# `resolution_reason` values (stable machine strings, never free text).
REASON_NO_TARGET = "no-operation-target"
REASON_UNKNOWN = "unknown-operation"
REASON_AMBIGUOUS = "ambiguous-operation"
REASON_UNPARSABLE = "unparsable-ref"
REASON_MALFORMED_STEP = "malformed-step"
REASON_CALLS_WORKFLOW = "calls-workflow"

# HTTP methods an Arazzo `#/paths/…/{method}` pointer may end with.
_HTTP_METHODS = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
)


@dataclass(frozen=True)
class OperationTarget:
    """What an ``operationRef`` / ``operationId`` string points at.

    Attributes:
        operation_id: The referenced ``operationId``, when the reference names one.
        http_path: Route template (e.g. ``/pets/{petId}``) from a ``#/paths/…`` pointer.
        http_method: Upper-case HTTP verb accompanying ``http_path``; ``None`` when the pointer
            named a route only, in which case the route must carry exactly one operation to
            resolve unambiguously.
        document_hint: The source document the reference came from (a ``sourceDescriptions``
            name, a relative filename, or a URL). Used only to disambiguate between otherwise
            equally good candidates.
    """

    operation_id: Optional[str] = None
    http_path: Optional[str] = None
    http_method: Optional[str] = None
    document_hint: Optional[str] = None

    @property
    def is_empty(self) -> bool:
        """True when the reference yielded nothing to look up."""
        return not self.operation_id and not self.http_path


@dataclass
class WorkflowStepRow:
    """One ``api_workflow_steps`` row, before it is written.

    Attributes:
        step_id: Source ``stepId`` (or a synthesized ``step{n}`` when absent).
        order_index: Zero-based position within the workflow.
        description: Source ``description``/``summary``.
        operation_ref: Raw ``operationRef``, retained verbatim even when unresolved.
        operation_id: Raw ``operationId``, retained verbatim even when unresolved.
        resolved_path_operation_id: Internal ``path_operation.id`` when resolution succeeded.
        resolution_status: ``resolved`` | ``unresolved`` | ``not_applicable`` | ``parse_error``.
        resolution_reason: Stable machine reason when not ``resolved``.
        parameters: Source ``parameters`` array, verbatim.
        success_criteria: Source ``successCriteria`` array, verbatim.
        on_failure: Source ``onFailure`` array, verbatim.
        outputs: Source ``outputs`` map, verbatim.
        depends_on: Source ``dependsOn`` array, verbatim.
        extras: Remaining step attributes (``requestBody``, ``onSuccess``, ``workflowId``, …).
    """

    step_id: str
    order_index: int
    description: Optional[str] = None
    operation_ref: Optional[str] = None
    operation_id: Optional[str] = None
    resolved_path_operation_id: Optional[str] = None
    resolution_status: str = STATUS_UNRESOLVED
    resolution_reason: Optional[str] = REASON_NO_TARGET
    parameters: List[Any] = field(default_factory=list)
    success_criteria: List[Any] = field(default_factory=list)
    on_failure: List[Any] = field(default_factory=list)
    outputs: Dict[str, Any] = field(default_factory=dict)
    depends_on: List[Any] = field(default_factory=list)
    extras: Dict[str, Any] = field(default_factory=dict)


@dataclass
class WorkflowRow:
    """One ``api_workflows`` row and its ordered steps.

    Attributes:
        workflow_id: Source ``workflowId``.
        summary: Source ``summary``.
        description: Source ``description``.
        inputs: Workflow-level ``inputs`` JSON Schema, verbatim.
        outputs: Workflow-level ``outputs`` map, verbatim.
        ordinal: Zero-based declaration order within the document.
        extras: Remaining workflow attributes (``dependsOn``, ``successActions``, …).
        steps: The workflow's steps in source order.
    """

    workflow_id: str
    summary: Optional[str] = None
    description: Optional[str] = None
    inputs: Dict[str, Any] = field(default_factory=dict)
    outputs: Dict[str, Any] = field(default_factory=dict)
    ordinal: int = 0
    extras: Dict[str, Any] = field(default_factory=dict)
    steps: List[WorkflowStepRow] = field(default_factory=list)


@dataclass
class WorkflowImportResult:
    """Outcome of mapping (and optionally resolving) an Arazzo document.

    Attributes:
        workflows: The mapped workflow rows, in source order.
        warnings: Human-readable notes — one per unresolved reference or isolated step.
    """

    workflows: List[WorkflowRow] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    @property
    def step_count(self) -> int:
        """Total number of steps across all workflows."""
        return sum(len(workflow.steps) for workflow in self.workflows)

    @property
    def resolved_count(self) -> int:
        """Number of steps whose reference resolved to an internal operation."""
        return sum(
            1
            for workflow in self.workflows
            for step in workflow.steps
            if step.resolution_status == STATUS_RESOLVED
        )


def _unescape_pointer_token(token: str) -> str:
    """Decode one JSON-Pointer token (RFC 6901 ``~1``/``~0``, plus percent-encoding)."""
    return unquote(token).replace("~1", "/").replace("~0", "~")


def _split_ref(ref: str) -> Tuple[str, str]:
    """Split ``ref`` into its document part and its fragment (without the ``#``)."""
    document, separator, fragment = ref.partition("#")
    return document.strip(), (fragment if separator else "")


def _document_hint(document: str) -> Optional[str]:
    """Reduce a reference's document part to a comparable hint.

    ``$sourceDescriptions.petStore.url`` → ``petStore``; a path or URL → its final segment
    (``./specs/petstore.yaml`` → ``petstore.yaml``). Returns ``None`` when there is nothing
    useful to compare.
    """
    if not document:
        return None
    # `operationPath` wraps the expression in braces:
    # `{$sourceDescriptions.petStore.url}#/paths/~1pet`.
    document = document.strip().lstrip("{").rstrip("}")
    if document.startswith("$sourceDescriptions."):
        parts = document.split(".")
        return parts[1] if len(parts) > 1 else None
    # `openapi:cart` (the roadmap's shorthand) and plain URLs/paths both reduce to a last
    # segment; strip any query string so `petstore.yaml?raw=1` still compares equal.
    tail = document.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    tail = tail.split(":")[-1] if ":" in tail else tail
    return tail or None


def parse_operation_ref(
    *, operation_ref: Optional[str] = None, operation_id: Optional[str] = None
) -> OperationTarget:
    """Interpret a step's target into something the operation index can look up.

    Handles the reference spellings Arazzo documents use in practice:

    * ``$sourceDescriptions.petStore.url#/paths/~1pets~1{petId}/get`` — pointer into a source
      description, yielding a route + verb;
    * ``{$sourceDescriptions.petStore.url}#/paths/~1pet~1findByStatus`` — the ``operationPath``
      spelling the official *LoginAndRetrievePets* bundle uses, yielding a route with no verb
      (which resolves only when the route carries exactly one operation);
    * ``./petstore.yaml#/paths/~1pets/post`` — relative document, same pointer form;
    * ``openapi:cart#/createCart`` — the roadmap's shorthand, yielding an ``operationId``;
    * a bare ``operationId``, optionally prefixed ``$sourceDescriptions.<name>.``.

    Args:
        operation_ref: The step's raw ``operationRef`` / ``operationPath``, if any.
        operation_id: The step's raw ``operationId``, if any.

    Returns:
        An :class:`OperationTarget`; :attr:`OperationTarget.is_empty` is True when neither
        input named something resolvable.
    """
    if isinstance(operation_id, str) and operation_id.strip():
        raw = operation_id.strip()
        hint: Optional[str] = None
        if raw.startswith("$sourceDescriptions."):
            parts = raw.split(".")
            # $sourceDescriptions.<name>.<operationId>
            hint = parts[1] if len(parts) > 2 else None
            raw = parts[-1]
        return OperationTarget(operation_id=raw, document_hint=hint)

    if not isinstance(operation_ref, str) or not operation_ref.strip():
        return OperationTarget()

    document, fragment = _split_ref(operation_ref.strip())
    hint = _document_hint(document)
    tokens = [token for token in fragment.split("/") if token]

    if len(tokens) >= 3 and tokens[0] == "paths":
        # /paths/<escaped route>/<method>[/…] — the method is the token after the route.
        method = tokens[2].lower()
        if method in _HTTP_METHODS:
            return OperationTarget(
                http_path=_unescape_pointer_token(tokens[1]),
                http_method=method.upper(),
                document_hint=hint,
            )
    if len(tokens) == 2 and tokens[0] == "paths":
        # /paths/<escaped route> — a route with no verb (the `operationPath` spelling).
        return OperationTarget(
            http_path=_unescape_pointer_token(tokens[1]), document_hint=hint
        )
    if len(tokens) == 1:
        # `#/createCart` — a bare operationId fragment.
        return OperationTarget(
            operation_id=_unescape_pointer_token(tokens[0]), document_hint=hint
        )
    if not fragment and document and not document.startswith("$sourceDescriptions."):
        # A document with no fragment names a file, not an operation.
        return OperationTarget(document_hint=hint)
    return OperationTarget(document_hint=hint)


class OperationIndex:
    """Lookup of the internal ``path_operation`` rows an Arazzo scan may reference.

    Built from rows shaped like
    ``{"id", "operation", "pathname", "operation_id", "source_path", "project_id",
    "version_id"}`` — exactly what
    :meth:`app.database.Database.get_scan_path_operation_index` returns.
    """

    def __init__(self, rows: Iterable[Dict[str, Any]] = ()) -> None:
        """Index ``rows`` by operationId and by (route, method).

        Args:
            rows: Path-operation records from the scan scope. Rows missing an id are skipped.
        """
        self._by_operation_id: Dict[str, List[Dict[str, Any]]] = {}
        self._by_route: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        self._by_path: Dict[str, List[Dict[str, Any]]] = {}
        for row in rows:
            operation_row_id = row.get("id")
            if not operation_row_id:
                continue
            record = dict(row)
            record["id"] = str(operation_row_id)
            operation_id = record.get("operation_id")
            if isinstance(operation_id, str) and operation_id.strip():
                self._by_operation_id.setdefault(operation_id.strip(), []).append(record)
            pathname = record.get("pathname")
            method = record.get("operation")
            if isinstance(pathname, str):
                self._by_path.setdefault(pathname.strip(), []).append(record)
                if isinstance(method, str):
                    self._by_route.setdefault(
                        (pathname.strip(), method.strip().upper()), []
                    ).append(record)

    def __len__(self) -> int:
        """Number of distinct indexed operations."""
        seen = {
            record["id"]
            for records in self._by_operation_id.values()
            for record in records
        }
        seen.update(
            record["id"] for records in self._by_route.values() for record in records
        )
        return len(seen)

    @staticmethod
    def _narrow_by_hint(
        candidates: Sequence[Dict[str, Any]], hint: Optional[str]
    ) -> Sequence[Dict[str, Any]]:
        """Prefer candidates whose source file matches ``hint``.

        A hint that matches nothing is ignored rather than treated as a miss: repository paths
        and ``sourceDescriptions`` names often differ in spelling, and the route/operationId
        match is already strong evidence.
        """
        if not hint or len(candidates) < 2:
            return candidates
        needle = hint.lower()
        narrowed = [
            candidate
            for candidate in candidates
            if isinstance(candidate.get("source_path"), str)
            and needle in candidate["source_path"].lower()
        ]
        return narrowed or candidates

    def resolve(self, target: OperationTarget) -> Tuple[Optional[str], str, Optional[str]]:
        """Resolve ``target`` to a ``path_operation`` id.

        Args:
            target: The parsed step target.

        Returns:
            ``(path_operation_id, resolution_status, resolution_reason)``. On a miss the id is
            ``None`` and the reason explains which kind of miss it was.
        """
        if target.is_empty:
            return None, STATUS_UNRESOLVED, REASON_UNPARSABLE

        if target.operation_id:
            candidates = self._by_operation_id.get(target.operation_id, [])
        elif target.http_method:
            candidates = self._by_route.get(
                (target.http_path or "", target.http_method.upper()), []
            )
        else:
            # A route-only pointer resolves when the route carries exactly one operation;
            # otherwise `resolve` reports it ambiguous below.
            candidates = self._by_path.get(target.http_path or "", [])

        candidates = self._narrow_by_hint(candidates, target.document_hint)
        distinct = {candidate["id"] for candidate in candidates}
        if not distinct:
            return None, STATUS_UNRESOLVED, REASON_UNKNOWN
        if len(distinct) > 1:
            return None, STATUS_UNRESOLVED, REASON_AMBIGUOUS
        return distinct.pop(), STATUS_RESOLVED, None


def _as_list(value: Any) -> List[Any]:
    """Coerce ``value`` to a JSON-safe list (a lone mapping/scalar becomes a one-item list)."""
    if value is None:
        return []
    if isinstance(value, list):
        return list(value)
    return [value]


def _as_dict(value: Any) -> Dict[str, Any]:
    """Coerce ``value`` to a JSON-safe dict; anything else becomes ``{}``."""
    return dict(value) if isinstance(value, dict) else {}


# Step extras the row stores in dedicated columns; the rest ride in `extras`.
_STEP_COLUMN_EXTRAS = frozenset(
    {
        "stepId",
        "stepIndex",
        "operationId",
        "operationRef",
        "parameters",
        "successCriteria",
        "onFailure",
        "outputs",
        "dependsOn",
    }
)

# Workflow extras the row stores in dedicated columns; the rest ride in `extras`.
_WORKFLOW_COLUMN_EXTRAS = frozenset(
    {"workflowId", "workflowIndex", "summary", "inputs", "outputs"}
)


def _source_index(extras: Dict[str, Any], key: str, fallback: int) -> int:
    """Read a recorded declaration index from ``extras``, falling back to ``fallback``.

    The canonical model sorts services and operations by key (``normalize_ordering``), so the
    Arazzo normalizer records the source position separately. Entity rows must reflect the
    document's order, not the sorted one.
    """
    value = extras.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return fallback
    return value


def _build_step_row(operation: Operation, fallback_index: int) -> WorkflowStepRow:
    """Map one canonical step operation onto a :class:`WorkflowStepRow`.

    Args:
        operation: The canonical operation the Arazzo normalizer produced for a step.
        fallback_index: Position to use when the operation carries no recorded ``stepIndex``.

    Returns:
        The mapped row, with resolution left at its default (``unresolved``) — the caller
        resolves references separately so mapping stays database-free.
    """
    extras = dict(operation.extras or {})
    order_index = _source_index(extras, "stepIndex", fallback_index)
    step_id = extras.get("stepId") or operation.name or f"step{order_index}"
    row = WorkflowStepRow(
        step_id=str(step_id)[:512],
        order_index=order_index,
        description=operation.description,
        # `operationPath` is Arazzo 1.0.0's pointer spelling; it lands in the same column as
        # `operationRef` and stays in `extras` too, so the original spelling is never lost.
        operation_ref=extras.get("operationRef") or extras.get("operationPath"),
        operation_id=extras.get("operationId"),
        parameters=_as_list(extras.get("parameters")),
        success_criteria=_as_list(extras.get("successCriteria")),
        on_failure=_as_list(extras.get("onFailure")),
        outputs=_as_dict(extras.get("outputs")),
        depends_on=_as_list(extras.get("dependsOn")),
        extras={k: v for k, v in extras.items() if k not in _STEP_COLUMN_EXTRAS},
    )
    if extras.get("workflowId"):
        # The step calls a sibling workflow; there is no operation to point at.
        row.resolution_status = STATUS_NOT_APPLICABLE
        row.resolution_reason = REASON_CALLS_WORKFLOW
    elif row.operation_ref or row.operation_id:
        row.resolution_reason = REASON_UNKNOWN
    return row


def _build_workflow_row(service: Service, fallback_ordinal: int) -> WorkflowRow:
    """Map one canonical service (an Arazzo workflow) onto a :class:`WorkflowRow`.

    Args:
        service: The canonical service the Arazzo normalizer produced for a workflow.
        fallback_ordinal: Position to use when the service carries no ``workflowIndex``.

    Returns:
        The mapped workflow row, with no steps yet.
    """
    extras = dict(service.extras or {})
    workflow_id = extras.get("workflowId") or service.key or service.name
    return WorkflowRow(
        workflow_id=str(workflow_id)[:512],
        summary=extras.get("summary"),
        description=service.description,
        inputs=_as_dict(extras.get("inputs")),
        outputs=_as_dict(extras.get("outputs")),
        ordinal=_source_index(extras, "workflowIndex", fallback_ordinal),
        extras={k: v for k, v in extras.items() if k not in _WORKFLOW_COLUMN_EXTRAS},
        steps=[],
    )


def build_workflow_rows(model: CanonicalApi) -> WorkflowImportResult:
    """Map an Arazzo-normalized canonical model onto workflow/step rows.

    Pure: no database access, no resolution. A workflow or step that cannot be read is
    isolated — the workflow is skipped with a warning, or the step is recorded with
    ``resolution_status='parse_error'`` — so one malformed entry never aborts the import.

    Args:
        model: The canonical model produced by :class:`app.arazzo_normalizer.ArazzoNormalizer`.

    Returns:
        A :class:`WorkflowImportResult` whose steps are all still unresolved.
    """
    result = WorkflowImportResult()
    for ordinal, service in enumerate(model.services or []):
        try:
            workflow = _build_workflow_row(service, ordinal)
        except Exception as exc:  # pragma: no cover - defensive; mapping is total
            result.warnings.append(
                f"Workflow at position {ordinal} could not be read and was skipped: {exc}"
            )
            continue
        for order_index, operation in enumerate(service.operations or []):
            try:
                workflow.steps.append(_build_step_row(operation, order_index))
            except Exception as exc:
                # AC: a single bad step is isolated, its siblings still import.
                workflow.steps.append(
                    WorkflowStepRow(
                        step_id=f"step{order_index}",
                        order_index=order_index,
                        resolution_status=STATUS_PARSE_ERROR,
                        resolution_reason=REASON_MALFORMED_STEP,
                    )
                )
                result.warnings.append(
                    f"Step {order_index} of workflow {workflow.workflow_id!r} could not be "
                    f"read and was marked parse_error: {exc}"
                )
        # The canonical model sorts operations by key; restore the document's step order.
        workflow.steps.sort(key=lambda step: step.order_index)
        result.workflows.append(workflow)
    # Likewise for the workflows themselves.
    result.workflows.sort(key=lambda workflow: workflow.ordinal)
    return result


def resolve_workflow_steps(
    result: WorkflowImportResult, index: OperationIndex
) -> WorkflowImportResult:
    """Resolve every step's reference against ``index``, in place.

    Steps already marked ``not_applicable`` or ``parse_error`` are left alone. Each miss keeps
    the raw reference string and appends a warning naming the workflow, the step, and the
    reference that could not be matched.

    Args:
        result: Rows from :func:`build_workflow_rows`.
        index: The scan's path operations.

    Returns:
        The same ``result`` instance, mutated.
    """
    for workflow in result.workflows:
        for step in workflow.steps:
            if step.resolution_status in (STATUS_NOT_APPLICABLE, STATUS_PARSE_ERROR):
                continue
            if not step.operation_ref and not step.operation_id:
                step.resolution_status = STATUS_UNRESOLVED
                step.resolution_reason = REASON_NO_TARGET
                result.warnings.append(
                    f"Step {step.step_id!r} of workflow {workflow.workflow_id!r} names no "
                    f"operationId or operationRef; nothing to resolve."
                )
                continue
            target = parse_operation_ref(
                operation_ref=step.operation_ref, operation_id=step.operation_id
            )
            operation_row_id, status, reason = index.resolve(target)
            step.resolved_path_operation_id = operation_row_id
            step.resolution_status = status
            step.resolution_reason = reason
            if status != STATUS_RESOLVED:
                reference = step.operation_ref or step.operation_id
                result.warnings.append(
                    f"Step {step.step_id!r} of workflow {workflow.workflow_id!r} references "
                    f"{reference!r} which did not resolve to an imported operation "
                    f"({reason}); the raw reference was kept."
                )
    return result


def _soft_delete_live_workflows(cursor: Any, *, tenant_id: str, version_id: str) -> None:
    """Soft-delete the live workflows and steps for ``version_id``.

    Mirrors :func:`app.canonical_persistence._soft_delete_live_artifact` so a re-import
    replaces the previous orchestration instead of accumulating duplicates.
    """
    cursor.execute(
        """
        UPDATE apiome.api_workflow_steps
        SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE version_id = %s::uuid AND deleted_at IS NULL
        """,
        (version_id,),
    )
    cursor.execute(
        """
        UPDATE apiome.api_workflows
        SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = %s::uuid AND version_id = %s::uuid AND deleted_at IS NULL
        """,
        (tenant_id, version_id),
    )


def _insert_workflows(
    cursor: Any,
    *,
    tenant_id: str,
    project_id: Optional[str],
    version_id: str,
    artifact_id: str,
    workflows: Sequence[WorkflowRow],
) -> int:
    """Insert ``workflows`` and their steps; return the number of steps written."""
    step_count = 0
    for workflow in workflows:
        cursor.execute(
            """
            INSERT INTO apiome.api_workflows (
                tenant_id, project_id, version_id, artifact_id,
                workflow_id, summary, description, inputs, outputs, ordinal, extras
            ) VALUES (
                %s::uuid, %s::uuid, %s::uuid, %s::uuid,
                %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s::jsonb
            )
            RETURNING id
            """,
            (
                tenant_id,
                project_id,
                version_id,
                artifact_id,
                workflow.workflow_id,
                workflow.summary,
                workflow.description,
                json.dumps(workflow.inputs or {}),
                json.dumps(workflow.outputs or {}),
                workflow.ordinal,
                json.dumps(workflow.extras or {}),
            ),
        )
        row = cursor.fetchone()
        workflow_row_id = str(row["id"] if isinstance(row, dict) else row[0])

        for step in workflow.steps:
            cursor.execute(
                """
                INSERT INTO apiome.api_workflow_steps (
                    tenant_id, version_id, workflow_id, step_id, order_index, description,
                    operation_ref, operation_id, resolved_path_operation_id,
                    resolution_status, resolution_reason,
                    parameters, success_criteria, on_failure, outputs, depends_on, extras
                ) VALUES (
                    %s::uuid, %s::uuid, %s::uuid, %s, %s, %s,
                    %s, %s, %s::uuid,
                    %s, %s,
                    %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb
                )
                """,
                (
                    tenant_id,
                    version_id,
                    workflow_row_id,
                    step.step_id,
                    step.order_index,
                    step.description,
                    step.operation_ref,
                    step.operation_id,
                    step.resolved_path_operation_id,
                    step.resolution_status,
                    step.resolution_reason,
                    json.dumps(step.parameters or []),
                    json.dumps(step.success_criteria or []),
                    json.dumps(step.on_failure or []),
                    json.dumps(step.outputs or {}),
                    json.dumps(step.depends_on or []),
                    json.dumps(step.extras or {}),
                ),
            )
            step_count += 1
    return step_count


def persist_arazzo_workflows(
    db: Any,
    *,
    tenant_id: str,
    project_id: Optional[str],
    version_id: str,
    artifact_id: str,
    model: CanonicalApi,
    index: Optional[OperationIndex] = None,
) -> WorkflowImportResult:
    """Map, resolve, and write an Arazzo model's workflows for one version.

    Replaces any live workflows for ``version_id`` (soft delete) and inserts the mapped rows in
    a single transaction, so a re-import of the same version is idempotent.

    Args:
        db: Database handle exposing :meth:`connect`.
        tenant_id: Owning tenant UUID.
        project_id: Owning project UUID; may be ``None`` when the caller has no project context.
        version_id: Target ``versions.id`` UUID (not the display version string).
        artifact_id: The ``api_artifacts.id`` these workflows hang off.
        model: The Arazzo-normalized canonical model.
        index: Path operations to resolve references against. ``None`` means "resolve against
            nothing", which leaves every reference unresolved with a warning.

    Returns:
        The :class:`WorkflowImportResult` that was written, including its warnings.
    """
    result = build_workflow_rows(model)
    resolve_workflow_steps(result, index or OperationIndex())
    if not result.workflows:
        return result

    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            _soft_delete_live_workflows(
                cursor, tenant_id=tenant_id, version_id=version_id
            )
            _insert_workflows(
                cursor,
                tenant_id=tenant_id,
                project_id=project_id,
                version_id=version_id,
                artifact_id=artifact_id,
                workflows=result.workflows,
            )
        conn.commit()
        return result
    except Exception:
        conn.rollback()
        raise


def _row_value(row: Any, key: str, position: int) -> Any:
    """Read ``key`` from a dict row, falling back to ``position`` on a tuple row."""
    if isinstance(row, dict):
        return row.get(key)
    return row[position]


def _json_value(value: Any, fallback: Any) -> Any:
    """Return a JSONB column as Python, tolerating drivers that hand back raw text."""
    if value is None:
        return fallback
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return fallback
    return value


def load_arazzo_workflows(
    db: Any, *, tenant_id: str, version_id: str
) -> List[WorkflowRow]:
    """Read the live workflows (and their ordered steps) for ``version_id``.

    The inverse of :func:`persist_arazzo_workflows`, used by the round-trip tests and by
    readers that want the orchestration without re-parsing the source document.

    Args:
        db: Database handle exposing :meth:`connect`.
        tenant_id: Owning tenant UUID.
        version_id: The ``versions.id`` to read.

    Returns:
        Workflow rows in declaration order, each with its steps in ``order_index`` order.
        Empty when the version has no live workflows.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, workflow_id, summary, description, inputs, outputs, ordinal, extras
            FROM apiome.api_workflows
            WHERE tenant_id = %s::uuid AND version_id = %s::uuid AND deleted_at IS NULL
            ORDER BY ordinal, workflow_id
            """,
            (tenant_id, version_id),
        )
        workflow_rows = cursor.fetchall() or []

        workflows: List[WorkflowRow] = []
        for raw in workflow_rows:
            workflow_row_id = str(_row_value(raw, "id", 0))
            workflow = WorkflowRow(
                workflow_id=str(_row_value(raw, "workflow_id", 1)),
                summary=_row_value(raw, "summary", 2),
                description=_row_value(raw, "description", 3),
                inputs=_json_value(_row_value(raw, "inputs", 4), {}),
                outputs=_json_value(_row_value(raw, "outputs", 5), {}),
                ordinal=int(_row_value(raw, "ordinal", 6) or 0),
                extras=_json_value(_row_value(raw, "extras", 7), {}),
            )
            cursor.execute(
                """
                SELECT step_id, order_index, description, operation_ref, operation_id,
                       resolved_path_operation_id, resolution_status, resolution_reason,
                       parameters, success_criteria, on_failure, outputs, depends_on, extras
                FROM apiome.api_workflow_steps
                WHERE workflow_id = %s::uuid AND deleted_at IS NULL
                ORDER BY order_index
                """,
                (workflow_row_id,),
            )
            for step_raw in cursor.fetchall() or []:
                resolved = _row_value(step_raw, "resolved_path_operation_id", 5)
                workflow.steps.append(
                    WorkflowStepRow(
                        step_id=str(_row_value(step_raw, "step_id", 0)),
                        order_index=int(_row_value(step_raw, "order_index", 1) or 0),
                        description=_row_value(step_raw, "description", 2),
                        operation_ref=_row_value(step_raw, "operation_ref", 3),
                        operation_id=_row_value(step_raw, "operation_id", 4),
                        resolved_path_operation_id=str(resolved) if resolved else None,
                        resolution_status=str(
                            _row_value(step_raw, "resolution_status", 6)
                            or STATUS_UNRESOLVED
                        ),
                        resolution_reason=_row_value(step_raw, "resolution_reason", 7),
                        parameters=_json_value(_row_value(step_raw, "parameters", 8), []),
                        success_criteria=_json_value(
                            _row_value(step_raw, "success_criteria", 9), []
                        ),
                        on_failure=_json_value(_row_value(step_raw, "on_failure", 10), []),
                        outputs=_json_value(_row_value(step_raw, "outputs", 11), {}),
                        depends_on=_json_value(_row_value(step_raw, "depends_on", 12), []),
                        extras=_json_value(_row_value(step_raw, "extras", 13), {}),
                    )
                )
            workflows.append(workflow)
    return workflows

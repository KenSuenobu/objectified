"""Saved schema test suites and regression tracking — IXH-5.7 (#5119).

A payload validated once (IXH-5.1) is worth keeping. This module defines what a saved *suite*
is — a named, tenant-scoped set of payloads plus expected verdicts, attached to a stable schema
reference — and everything that happens to one: creation, mutation, execution against a
revision, regression comparison against the previous run, and round-tripping through the
IXH-1.1 corpus manifest format.

The pieces it deliberately reuses rather than re-implements:

* **Reference grammar** — :mod:`app.schema_reference`. A suite stores the version-independent
  part (``kind``/``artifact``[/``type``]); a run supplies the version and the two are joined
  back into an ordinary IXH-5.1 reference.
* **Validation** — :func:`app.schema_instance_service.validate_schema_instance`, exactly the
  endpoint the Test Bench calls, so a suite run and a bench check can never disagree.
* **Verdict vocabulary** — the CLI's judge (``apiome schema test``): ``passed`` when the
  validator's verdict matches the expectation, ``failed`` when it contradicts it, ``error``
  when no verdict was produced at all.

Regression semantics (the ticket's core): each run's per-payload verdict is compared, by
payload *name*, against the suite's most recent prior **completed** run — whatever revision
that run targeted, because "this used to pass and now does not" is precisely a cross-revision
statement. A regression is strictly the flip ``passed → failed``. A flip to ``error`` is not a
regression — no verdict was produced, so there is no evidence the schema broke the payload —
but it stays visible through ``previous_status``.
"""

from __future__ import annotations

import logging
import posixpath
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

from . import schema_suite_store as store
from .config import settings
from .schema_instance_service import (
    MEDIA_TYPE_JSON,
    MEDIA_TYPE_XML,
    SchemaInstanceValidationRequest,
    SchemaInstanceValidationResponse,
    validate_schema_instance,
)
from .schema_instance_validation import MAX_FINDINGS_CEILING
from .schema_reference import (
    KIND_CATALOG,
    KIND_PROJECT,
    KIND_REGISTRY,
    LATEST_VERSION_TOKEN,
    SchemaReference,
    SchemaReferenceError,
    resolve_revision_model,
)

logger = logging.getLogger(__name__)

__all__ = [
    "STATUS_ERROR",
    "STATUS_FAILED",
    "STATUS_PASSED",
    "SchemaTestSuiteCreateRequest",
    "SchemaTestSuiteModel",
    "SchemaTestSuiteUpdateRequest",
    "SuiteExportEnvelope",
    "SuiteImportRequest",
    "SuiteNameConflictError",
    "SuitePayloadModel",
    "SuitePayloadsReplaceRequest",
    "SuiteRunDetailModel",
    "SuiteRunRequest",
    "SuiteRunResultModel",
    "SuiteRunSummaryModel",
    "SuiteValidationError",
    "create_suite",
    "delete_suite",
    "export_suite",
    "get_run_detail",
    "get_suite_detail",
    "import_suite",
    "list_runs",
    "list_suites",
    "replace_payloads",
    "run_suite",
    "update_suite",
]

# Re-exported so the route maps it to 409 without importing the store.
SuiteNameConflictError = store.SuiteNameConflictError

#: Verdict vocabulary, mirroring the CLI's ``apiome schema test`` judge.
STATUS_PASSED = "passed"
STATUS_FAILED = "failed"
STATUS_ERROR = "error"

#: Per-payload byte bound, mirroring the V240 CHECK so the refusal is friendly, not a driver error.
PAYLOAD_MAX_BYTES = 262_144

#: IXH-1.1 corpus vocabulary a payload can carry; ``valid`` is the only class expected to validate.
VALIDITY_CLASSES = ("valid", "invalid", "adversarial", "scale")

#: The corpus feature that marks an entry as an instance payload (the CLI's suite selector).
INSTANCE_PAYLOAD_FEATURE = "instance-payload"

#: Directory rows for exported manifests, copied from ``examples/corpus.manifest.json`` so an
#: exported suite validates against the corpus schema without inventing taxonomy.
_CORPUS_DIRECTORIES = {
    "json-schema": {
        "label": "JSON Schema",
        "category": "data-schema",
        "paradigm": "data_schema",
        "marker": "`$schema` / `type` + `properties`",
    },
    "xsd": {
        "label": "XML Schema (XSD)",
        "category": "data-schema",
        "paradigm": "data_schema",
        "marker": "`xs:schema` root element",
    },
}


class SuiteValidationError(Exception):
    """A suite request is well-formed JSON but violates a suite invariant.

    Attributes:
        status_code: The HTTP status the route surfaces (400 unless stated otherwise).
    """

    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


# ===========================================================================
# Models
# ===========================================================================


class SuitePayloadModel(BaseModel):
    """One payload of a suite: the instance text plus its expected verdict."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200, description="Payload name, unique within the suite.")
    payload_text: str = Field(description="The instance document text (JSON or XML).")
    media_type: Literal["application/json", "application/xml"] = Field(
        default=MEDIA_TYPE_JSON, description="How the payload text should be read."
    )
    validity_class: Literal["valid", "invalid", "adversarial", "scale"] = Field(
        default="valid",
        description=(
            "IXH-1.1 corpus class. The expected verdict derives from it: ``valid`` payloads "
            "must validate; every other class must not."
        ),
    )
    synthetic: bool = Field(
        default=False, description="Whether the payload came from IXH-5.2 synthesis."
    )
    notes: Optional[str] = Field(default=None, description="Free-text notes, carried to export.")
    position: Optional[int] = Field(
        default=None, ge=0, description="Execution order; defaults to list order."
    )

    @property
    def expected_valid(self) -> bool:
        """Whether this payload is expected to validate (``validity_class == 'valid'``)."""
        return self.validity_class == "valid"


class SchemaTestSuiteCreateRequest(BaseModel):
    """A new suite: a name, a stable schema reference, and optional initial payloads."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200, description="Suite name, unique per tenant.")
    description: Optional[str] = Field(default=None, description="Optional description.")
    ref: str = Field(
        description=(
            "The schema reference the suite is attached to. Either the stable form "
            "``{kind}/{artifact}[/latest/{type}]`` or a full IXH-5.1 reference "
            "``{kind}/{artifact}/{version}[/{type}]`` — the version segment is discarded, "
            "because a suite outlives any one revision. ``registry/…`` is rejected: registry "
            "types have no revisions, so there is nothing to track a regression across."
        )
    )
    payloads: List[SuitePayloadModel] = Field(default_factory=list)


class SchemaTestSuiteUpdateRequest(BaseModel):
    """A metadata patch: rename and/or re-describe. Payload edits use the payloads route."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = Field(default=None)
    clear_description: bool = Field(
        default=False, description="Set the description to null (distinct from omitting it)."
    )


class SuitePayloadsReplaceRequest(BaseModel):
    """The full replacement payload set; applying it bumps ``suite_version``."""

    model_config = ConfigDict(extra="forbid")

    payloads: List[SuitePayloadModel] = Field(default_factory=list)


class SuiteRunRequest(BaseModel):
    """What to run a suite against."""

    model_config = ConfigDict(extra="forbid")

    version: str = Field(
        default=LATEST_VERSION_TOKEN,
        min_length=1,
        description="A version label, a revision id, or ``latest``.",
    )
    trigger: Literal["manual", "revision"] = Field(
        default="manual",
        description="``manual`` for a user-initiated run; ``revision`` when fired for a new revision.",
    )
    max_findings: int = Field(
        default=0,
        ge=0,
        description=(
            "Findings persisted per payload; 0 uses the server default "
            "(``APIOME_SCHEMA_SUITE_RESULT_FINDINGS_CAP``)."
        ),
    )


class SuiteRunResultModel(BaseModel):
    """One payload's verdict in one run, with its diff against the baseline run."""

    model_config = ConfigDict(extra="forbid")

    payload_id: Optional[str] = Field(default=None, description="Source payload id; null once deleted.")
    payload_name: str = Field(description="Payload name at run time (the regression join key).")
    expected_valid: bool = Field(description="The expected verdict, derived from validity_class.")
    valid: Optional[bool] = Field(
        default=None, description="IXH-5.1 tri-state outcome; null when no validator ran."
    )
    validated: bool = Field(description="Whether a validator actually executed.")
    status: Literal["passed", "failed", "error"] = Field(description="The judged verdict.")
    previous_status: Optional[Literal["passed", "failed", "error"]] = Field(
        default=None, description="The same payload's verdict in the baseline run, when it had one."
    )
    regression: bool = Field(
        description="True iff the payload passed in the baseline run and failed in this one."
    )
    findings: List[Dict[str, Any]] = Field(
        default_factory=list, description="Capped copy of the IXH-5.1 findings."
    )
    message: Optional[str] = Field(default=None, description="Human-readable judgement.")


class SuiteRunSummaryModel(BaseModel):
    """One run of a suite, without its per-payload results."""

    model_config = ConfigDict(extra="forbid")

    id: str
    suite_version: int = Field(description="Suite content version the run executed.")
    requested_ref: str = Field(description="The concrete reference the run was asked to target.")
    resolved_revision_id: Optional[str] = Field(
        default=None, description="The pinned revision; null when resolution failed."
    )
    resolved_version_label: Optional[str] = Field(default=None)
    trigger: Literal["manual", "revision"]
    status: Literal["completed", "error"] = Field(
        description="completed = every payload judged; error = the run could not execute."
    )
    total: int
    passed: int
    failed: int
    errored: int
    regression: bool = Field(description="True when any payload previously passed and now failed.")
    baseline_run_id: Optional[str] = Field(
        default=None, description="The prior completed run the verdict diff was computed against."
    )
    message: Optional[str] = Field(default=None)
    created_at: Optional[datetime] = Field(default=None)


class SuiteRunDetailModel(SuiteRunSummaryModel):
    """A run with its per-payload results."""

    results: List[SuiteRunResultModel] = Field(default_factory=list)


class SchemaTestSuiteModel(BaseModel):
    """A suite as every read returns it."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    description: Optional[str] = None
    ref: str = Field(description="The stable reference: ``{kind}/{artifact}[/{type}]``.")
    ref_kind: Literal["project", "catalog"]
    ref_artifact: str
    ref_artifact_id: Optional[str] = None
    ref_type: Optional[str] = None
    suite_version: int
    payload_count: int = 0
    payloads: Optional[List[SuitePayloadModel]] = Field(
        default=None, description="Populated on detail reads; omitted from listings."
    )
    latest_run: Optional[SuiteRunSummaryModel] = Field(
        default=None, description="The newest run, so listings can feed the regression badge."
    )
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class SuiteFileModel(BaseModel):
    """One exported payload file: the manifest entry's path plus its content."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, description="Path relative to the manifest, POSIX separators.")
    content: str = Field(description="The payload text.")


class SuiteExportEnvelope(BaseModel):
    """A suite in the IXH-1.1 corpus manifest format: the manifest plus the payload files.

    Materialize ``files[*].content`` at ``files[*].path`` next to a ``manifest.json`` holding
    ``manifest`` and the set runs in CI unchanged: ``apiome schema test --schema <ref> --suite
    manifest.json``.
    """

    model_config = ConfigDict(extra="forbid")

    suite: SchemaTestSuiteModel
    manifest: Dict[str, Any] = Field(description="An IXH-1.1 corpus manifest document.")
    files: List[SuiteFileModel] = Field(default_factory=list)


class SuiteImportRequest(BaseModel):
    """A suite to create from a corpus manifest plus its payload files."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200, description="Name for the created suite.")
    description: Optional[str] = Field(default=None)
    ref: str = Field(description="The schema reference to attach the suite to (create-form grammar).")
    manifest: Dict[str, Any] = Field(description="An IXH-1.1 corpus manifest document.")
    files: List[SuiteFileModel] = Field(default_factory=list)


# ===========================================================================
# Reference handling
# ===========================================================================


def parse_suite_reference(raw: str) -> Tuple[str, str, Optional[str]]:
    """Parse a suite's stable reference, tolerating (and discarding) a version segment.

    Accepted forms::

        {kind}/{artifact}                    — stable, whole revision
        {kind}/{artifact}/{version}          — 5.1-shaped; version discarded
        {kind}/{artifact}/{version}/{type}   — 5.1-shaped; version discarded, type kept

    A three-segment tail is always read as ``version`` (never as ``type``): it is exactly the
    IXH-5.1 grammar, so a reference copied from the Test Bench or the validate endpoint means
    the same thing here. To attach a type without caring about a version, write
    ``{kind}/{artifact}/latest/{type}``.

    Args:
        raw: The reference as the caller wrote it.

    Returns:
        ``(kind, artifact, type_name)``.

    Raises:
        SchemaReferenceError: 400 for a malformed reference or a ``registry`` reference.
    """
    segments = [segment for segment in (raw or "").strip("/").split("/") if segment]
    if not segments:
        raise SchemaReferenceError("A schema reference is required.", status_code=400)
    kind = segments[0]
    if kind == KIND_REGISTRY:
        raise SchemaReferenceError(
            "A test suite tracks verdicts across revisions, and registry types have no "
            "revisions. Attach the suite to the project or catalog artifact the type "
            "belongs to instead.",
            status_code=400,
        )
    if kind not in (KIND_PROJECT, KIND_CATALOG):
        raise SchemaReferenceError(
            f"Unknown schema reference kind {kind!r}. Supported forms: "
            "`project/{artifact}[/{version}[/{type}]]`, `catalog/{artifact}[/{version}[/{type}]]`.",
            status_code=400,
        )
    if len(segments) < 2 or len(segments) > 4:
        raise SchemaReferenceError(
            f"A {kind} suite reference needs an artifact and may carry a version and a type, "
            f"for example `{kind}/petstore`, `{kind}/petstore/latest/Pet`.",
            status_code=400,
        )
    artifact = segments[1]
    type_name = segments[3] if len(segments) == 4 else None
    return kind, artifact, type_name


def stable_ref(ref_kind: str, ref_artifact: str, ref_type: Optional[str]) -> str:
    """The stable display form of a suite's reference: ``{kind}/{artifact}[/{type}]``."""
    parts = [ref_kind, ref_artifact]
    if ref_type:
        parts.append(ref_type)
    return "/".join(parts)


def concrete_ref(
    ref_kind: str, ref_artifact: str, version: str, ref_type: Optional[str]
) -> str:
    """Join a suite's stable reference with a version into an ordinary IXH-5.1 reference."""
    parts = [ref_kind, ref_artifact, version]
    if ref_type:
        parts.append(ref_type)
    return "/".join(parts)


# ===========================================================================
# Row -> model shaping
# ===========================================================================


def _opt_str(value: Any) -> Optional[str]:
    """Stringify a row value (UUIDs come back typed), preserving ``None``."""
    return None if value is None else str(value)


def _payload_model(row: Dict[str, Any]) -> SuitePayloadModel:
    """Shape a payload row into its model."""
    return SuitePayloadModel(
        name=row["name"],
        payload_text=row["payload_text"],
        media_type=row.get("media_type") or MEDIA_TYPE_JSON,
        validity_class=row.get("validity_class") or "valid",
        synthetic=bool(row.get("synthetic")),
        notes=row.get("notes"),
        position=row.get("position"),
    )


def _run_summary_from_row(row: Dict[str, Any]) -> SuiteRunSummaryModel:
    """Shape a run row into its summary model."""
    return SuiteRunSummaryModel(
        id=str(row["id"]),
        suite_version=int(row["suite_version"]),
        requested_ref=row["requested_ref"],
        resolved_revision_id=_opt_str(row.get("resolved_revision_id")),
        resolved_version_label=row.get("resolved_version_label"),
        trigger=row.get("trigger") or "manual",
        status=row["status"],
        total=int(row.get("total") or 0),
        passed=int(row.get("passed") or 0),
        failed=int(row.get("failed") or 0),
        errored=int(row.get("errored") or 0),
        regression=bool(row.get("regression")),
        baseline_run_id=_opt_str(row.get("baseline_run_id")),
        message=row.get("message"),
        created_at=row.get("created_at"),
    )


def _latest_run_from_listing(row: Dict[str, Any]) -> Optional[SuiteRunSummaryModel]:
    """Extract the ``latest_run_*`` columns of a listing row, when the suite has run at all."""
    if row.get("latest_run_id") is None:
        return None
    prefixed = {
        key[len("latest_run_"):]: value
        for key, value in row.items()
        if key.startswith("latest_run_")
    }
    return _run_summary_from_row(prefixed)


def _suite_model(
    row: Dict[str, Any],
    *,
    payloads: Optional[List[Dict[str, Any]]] = None,
    latest_run: Optional[SuiteRunSummaryModel] = None,
    payload_count: Optional[int] = None,
) -> SchemaTestSuiteModel:
    """Shape a suite row (plus optional payloads and latest run) into its model."""
    payload_models = [_payload_model(payload) for payload in payloads] if payloads is not None else None
    count = payload_count
    if count is None:
        count = len(payload_models) if payload_models is not None else int(row.get("payload_count") or 0)
    return SchemaTestSuiteModel(
        id=str(row["id"]),
        name=row["name"],
        description=row.get("description"),
        ref=stable_ref(row["ref_kind"], row["ref_artifact"], row.get("ref_type")),
        ref_kind=row["ref_kind"],
        ref_artifact=row["ref_artifact"],
        ref_artifact_id=_opt_str(row.get("ref_artifact_id")),
        ref_type=row.get("ref_type"),
        suite_version=int(row["suite_version"]),
        payload_count=count,
        payloads=payload_models,
        latest_run=latest_run,
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


# ===========================================================================
# Payload-set validation
# ===========================================================================


def _check_payloads(payloads: List[SuitePayloadModel]) -> None:
    """Refuse a payload set that violates a suite bound, with the friendly message.

    Raises:
        SuiteValidationError: On a duplicate name, an over-cap set, or an oversize payload.
    """
    cap = settings.schema_suite_max_payloads
    if cap > 0 and len(payloads) > cap:
        raise SuiteValidationError(
            f"A suite holds at most {cap} payloads (APIOME_SCHEMA_SUITE_MAX_PAYLOADS); "
            f"{len(payloads)} were supplied."
        )
    seen: set = set()
    for payload in payloads:
        if payload.name in seen:
            raise SuiteValidationError(f"Duplicate payload name {payload.name!r} in the suite.")
        seen.add(payload.name)
        size = len(payload.payload_text.encode("utf-8"))
        if size > PAYLOAD_MAX_BYTES:
            raise SuiteValidationError(
                f"Payload {payload.name!r} is {size} bytes; the bound is "
                f"{PAYLOAD_MAX_BYTES} bytes per payload."
            )
        if payload.media_type == MEDIA_TYPE_XML and not payload.payload_text.strip():
            raise SuiteValidationError(f"Payload {payload.name!r} is empty.")


def _payload_rows(payloads: List[SuitePayloadModel]) -> List[Dict[str, Any]]:
    """Shape payload models into the dict rows the database methods insert."""
    return [
        {
            "name": payload.name,
            "payload_text": payload.payload_text,
            "media_type": payload.media_type,
            "validity_class": payload.validity_class,
            "synthetic": payload.synthetic,
            "notes": payload.notes,
            "position": payload.position if payload.position is not None else index,
        }
        for index, payload in enumerate(payloads)
    ]


# ===========================================================================
# CRUD
# ===========================================================================


def create_suite(
    request: SchemaTestSuiteCreateRequest, *, tenant_id: str
) -> SchemaTestSuiteModel:
    """Create a suite from a create request.

    The artifact id is resolved best-effort (at ``latest``) so listings can later be narrowed
    by artifact id as well as by slug; an artifact with no revision yet still gets its suite —
    the id is simply left NULL and the first run resolves it.

    Args:
        request: The validated request body.
        tenant_id: The caller's authenticated tenant.

    Returns:
        The created suite.

    Raises:
        SchemaReferenceError: 400 for a malformed or registry reference.
        SuiteValidationError: 400 for a payload-set violation.
        SuiteNameConflictError: When the tenant already has a suite with this name.
    """
    ref_kind, ref_artifact, ref_type = parse_suite_reference(request.ref)
    _check_payloads(request.payloads)

    ref_artifact_id: Optional[str] = None
    try:
        reference = SchemaReference(
            kind=ref_kind,
            raw=concrete_ref(ref_kind, ref_artifact, LATEST_VERSION_TOKEN, ref_type),
            artifact=ref_artifact,
            version=LATEST_VERSION_TOKEN,
            type_name=ref_type,
        )
        resolved = resolve_revision_model(reference, tenant_id=tenant_id)
        ref_artifact_id = _opt_str(resolved.coordinates.get("artifact_id"))
    except SchemaReferenceError:
        # The artifact may not exist yet, or may have no revision; the suite is still
        # creatable — attachment is by the textual reference, the id is a convenience.
        logger.info("Suite reference %r not resolvable at creation; storing without id", request.ref)

    row = store.create_suite(
        tenant_id=tenant_id,
        name=request.name,
        description=request.description,
        ref_kind=ref_kind,
        ref_artifact=ref_artifact,
        ref_artifact_id=ref_artifact_id,
        ref_type=ref_type,
        payloads=_payload_rows(request.payloads),
    )
    if row is None:
        raise SuiteValidationError("No tenant context for this credential.", status_code=403)
    return _suite_model(row, payloads=store.list_payloads(tenant_id, str(row["id"])))


def list_suites(
    tenant_id: str, *, ref: Optional[str] = None
) -> List[SchemaTestSuiteModel]:
    """Suites for the tenant, optionally narrowed to one stable reference's artifact.

    Args:
        tenant_id: The caller's authenticated tenant.
        ref: A suite reference in the create-form grammar; when given, only suites attached
            to its ``kind``/``artifact`` are returned (the type segment does not narrow,
            since one artifact's suites all feed the same surfaces).

    Returns:
        The suites, each with its newest run summary.
    """
    ref_kind = ref_artifact = None
    if ref:
        ref_kind, ref_artifact, _ = parse_suite_reference(ref)
    rows = store.list_suites(tenant_id, ref_kind=ref_kind, ref_artifact=ref_artifact)
    return [
        _suite_model(
            row,
            latest_run=_latest_run_from_listing(row),
            payload_count=int(row.get("payload_count") or 0),
        )
        for row in rows
    ]


def get_suite_detail(tenant_id: str, suite_id: str) -> Optional[SchemaTestSuiteModel]:
    """One suite with its payloads and newest run, or ``None`` when not visible."""
    row = store.get_suite(tenant_id, suite_id)
    if row is None:
        return None
    latest = store.latest_completed_run(tenant_id, suite_id)
    # The badge wants the newest run of any status; latest_completed is the baseline. For
    # the detail surface the newest run row is fetched from history (limit 1).
    newest = store.list_runs(tenant_id, suite_id, limit=1)
    latest_summary = _run_summary_from_row(newest[0]) if newest else (
        _run_summary_from_row(latest) if latest else None
    )
    return _suite_model(
        row,
        payloads=store.list_payloads(tenant_id, suite_id),
        latest_run=latest_summary,
    )


def update_suite(
    tenant_id: str, suite_id: str, request: SchemaTestSuiteUpdateRequest
) -> Optional[SchemaTestSuiteModel]:
    """Apply a metadata patch. Returns ``None`` when the suite is not visible."""
    row = store.update_suite_meta(
        tenant_id,
        suite_id,
        name=request.name,
        description=request.description,
        clear_description=request.clear_description,
    )
    if row is None:
        return None
    return _suite_model(row, payloads=store.list_payloads(tenant_id, suite_id))


def replace_payloads(
    tenant_id: str, suite_id: str, request: SuitePayloadsReplaceRequest
) -> Optional[SchemaTestSuiteModel]:
    """Replace the payload set (bumps ``suite_version``). ``None`` when not visible.

    Raises:
        SuiteValidationError: 400 for a payload-set violation.
    """
    _check_payloads(request.payloads)
    row = store.replace_payloads(tenant_id, suite_id, _payload_rows(request.payloads))
    if row is None:
        return None
    return _suite_model(row, payloads=store.list_payloads(tenant_id, suite_id))


def delete_suite(tenant_id: str, suite_id: str) -> bool:
    """Delete a suite and its history. Returns whether anything was deleted."""
    return store.delete_suite(tenant_id, suite_id)


# ===========================================================================
# Run execution
# ===========================================================================


def _judge(
    expected_valid: bool, response: SchemaInstanceValidationResponse
) -> Tuple[str, str]:
    """Judge one validate response against a payload's expectation.

    Mirrors the CLI's ``case_from_validation`` exactly, so a suite run in the UI and
    ``apiome schema test`` can never disagree about a verdict.

    Returns:
        ``(status, message)``.
    """
    if not response.ok:
        detail = response.error.message if response.error else "the request was not serviceable"
        return STATUS_ERROR, detail
    if response.valid is None:
        reasons = "; ".join(diag.message for diag in response.diagnostics) or "no validator ran"
        return STATUS_ERROR, reasons
    if bool(response.valid) == expected_valid:
        return STATUS_PASSED, ("valid" if response.valid else "invalid, as expected")
    if expected_valid:
        count = response.total_findings or len(response.findings)
        plural = "" if count == 1 else "s"
        return STATUS_FAILED, f"expected valid but the validator reported {count} finding{plural}"
    return STATUS_FAILED, "expected invalid but the payload validated cleanly"


async def run_suite(
    tenant_id: str, suite_id: str, request: SuiteRunRequest
) -> Optional[SuiteRunDetailModel]:
    """Execute a suite against one revision and record the run.

    The reference is resolved **once** and then pinned to the resolved revision id, so every
    payload validates against the same revision even if ``latest`` moves mid-run. When the
    reference cannot be resolved at all, the run is still recorded — with ``status='error'``
    and no results — because "the suite could not run against this revision" is history the
    ticket requires to be visible, not an exception to swallow.

    Args:
        tenant_id: The caller's authenticated tenant.
        suite_id: The suite to execute.
        request: The version to target and run options.

    Returns:
        The recorded run with its results, or ``None`` when the suite is not visible.
    """
    suite_row = store.get_suite(tenant_id, suite_id)
    if suite_row is None:
        return None
    payload_rows = store.list_payloads(tenant_id, suite_id)
    ref_kind = suite_row["ref_kind"]
    ref_artifact = suite_row["ref_artifact"]
    ref_type = suite_row.get("ref_type")
    requested = concrete_ref(ref_kind, ref_artifact, request.version, ref_type)
    suite_version = int(suite_row["suite_version"])

    # Pin the revision first: one resolution, one revision, however long the run takes.
    try:
        reference = SchemaReference(
            kind=ref_kind,
            raw=requested,
            artifact=ref_artifact,
            version=request.version,
            type_name=ref_type,
        )
        resolved = resolve_revision_model(reference, tenant_id=tenant_id)
        revision_id = _opt_str(resolved.coordinates.get("revision_id"))
        version_label = resolved.coordinates.get("version_label")
    except SchemaReferenceError as exc:
        run_row = store.insert_run(
            suite_id=suite_id,
            tenant_id=tenant_id,
            suite_version=suite_version,
            requested_ref=requested,
            resolved_revision_id=None,
            resolved_version_label=None,
            trigger=request.trigger,
            status="error",
            total=0,
            passed=0,
            failed=0,
            errored=0,
            regression=False,
            baseline_run_id=None,
            message=str(exc),
            results=[],
        )
        if run_row is None:
            return None
        return SuiteRunDetailModel(**_run_summary_from_row(run_row).model_dump(), results=[])

    pinned_ref = concrete_ref(ref_kind, ref_artifact, revision_id or request.version, ref_type)

    # The baseline is the newest *completed* run, whatever revision it targeted: "used to
    # pass, now fails" is a cross-revision statement, and that is the point of the feature.
    baseline_run = store.latest_completed_run(tenant_id, suite_id)
    baseline_status: Dict[str, str] = {}
    if baseline_run is not None:
        for result in store.list_run_results(str(baseline_run["id"])):
            baseline_status[result["payload_name"]] = result["status"]

    findings_cap = request.max_findings or settings.schema_suite_result_findings_cap
    findings_cap = max(1, min(int(findings_cap), MAX_FINDINGS_CEILING))

    results: List[Dict[str, Any]] = []
    counts = {STATUS_PASSED: 0, STATUS_FAILED: 0, STATUS_ERROR: 0}
    any_regression = False
    for index, payload_row in enumerate(payload_rows):
        expected_valid = (payload_row.get("validity_class") or "valid") == "valid"
        validation_request = SchemaInstanceValidationRequest(
            instance_text=payload_row["payload_text"],
            media_type=payload_row.get("media_type") or MEDIA_TYPE_JSON,
            max_findings=findings_cap,
        )
        try:
            response = await validate_schema_instance(
                pinned_ref, validation_request, tenant_id=tenant_id
            )
            status, message = _judge(expected_valid, response)
            valid = response.valid
            validated = response.validated
            findings = [
                finding.model_dump(exclude_none=True)
                for finding in response.findings[:findings_cap]
            ]
        except SchemaReferenceError as exc:
            # The revision disappeared mid-run (deleted underneath us): judge what we can.
            status, message = STATUS_ERROR, str(exc)
            valid, validated, findings = None, False, []

        previous_status = baseline_status.get(payload_row["name"])
        regression = previous_status == STATUS_PASSED and status == STATUS_FAILED
        any_regression = any_regression or regression
        counts[status] += 1
        results.append(
            {
                "payload_id": _opt_str(payload_row.get("id")),
                "payload_name": payload_row["name"],
                "expected_valid": expected_valid,
                "valid": valid,
                "validated": validated,
                "status": status,
                "previous_status": previous_status,
                "regression": regression,
                "findings": findings,
                "message": message,
                "position": index,
            }
        )

    run_row = store.insert_run(
        suite_id=suite_id,
        tenant_id=tenant_id,
        suite_version=suite_version,
        requested_ref=requested,
        resolved_revision_id=revision_id,
        resolved_version_label=version_label,
        trigger=request.trigger,
        status="completed",
        total=len(results),
        passed=counts[STATUS_PASSED],
        failed=counts[STATUS_FAILED],
        errored=counts[STATUS_ERROR],
        regression=any_regression,
        baseline_run_id=_opt_str(baseline_run["id"]) if baseline_run else None,
        message=None,
        results=results,
    )
    if run_row is None:
        return None
    return SuiteRunDetailModel(
        **_run_summary_from_row(run_row).model_dump(),
        results=[_result_model(result) for result in store.list_run_results(str(run_row["id"]))],
    )


def _result_model(row: Dict[str, Any]) -> SuiteRunResultModel:
    """Shape a result row into its model."""
    return SuiteRunResultModel(
        payload_id=_opt_str(row.get("payload_id")),
        payload_name=row["payload_name"],
        expected_valid=bool(row["expected_valid"]),
        valid=row.get("valid"),
        validated=bool(row.get("validated")),
        status=row["status"],
        previous_status=row.get("previous_status"),
        regression=bool(row.get("regression")),
        findings=row.get("findings") or [],
        message=row.get("message"),
    )


def list_runs(
    tenant_id: str, suite_id: str, *, limit: int = 20, offset: int = 0
) -> Optional[List[SuiteRunSummaryModel]]:
    """A suite's run history, newest first; ``None`` when the suite is not visible."""
    if store.get_suite(tenant_id, suite_id) is None:
        return None
    rows = store.list_runs(tenant_id, suite_id, limit=limit, offset=offset)
    return [_run_summary_from_row(row) for row in rows]


def get_run_detail(
    tenant_id: str, suite_id: str, run_id: str
) -> Optional[SuiteRunDetailModel]:
    """One run with its results; ``None`` when not visible."""
    row = store.get_run(tenant_id, suite_id, run_id)
    if row is None:
        return None
    return SuiteRunDetailModel(
        **_run_summary_from_row(row).model_dump(),
        results=[_result_model(result) for result in store.list_run_results(run_id)],
    )


# ===========================================================================
# Corpus manifest export / import (IXH-1.1 round trip)
# ===========================================================================


def _fixture_stem(label: str) -> str:
    """A safe kebab-case file stem, mirroring the Test Bench's ``fixtureFileStem``."""
    stem = "".join(ch if ch.isalnum() else "-" for ch in label.lower())
    while "--" in stem:
        stem = stem.replace("--", "-")
    stem = stem.strip("-")
    return stem or "payload"


def export_suite(tenant_id: str, suite_id: str) -> Optional[SuiteExportEnvelope]:
    """Export a suite as an IXH-1.1 corpus manifest plus payload files.

    Entry shaping mirrors the Test Bench's ``buildCorpusFixture`` (IXH-5.3), extended with
    the suite's validity classes: a ``valid`` payload is ``expected_outcome: imports``,
    everything else ``rejects``. The manifest is exactly what the CLI's suite mode reads
    (entries with the ``instance-payload`` feature; ``expected_valid`` derived from
    ``validity_class``), so the export runs in CI once its files are materialized.

    Returns:
        The envelope, or ``None`` when the suite is not visible.
    """
    suite_row = store.get_suite(tenant_id, suite_id)
    if suite_row is None:
        return None
    payload_rows = store.list_payloads(tenant_id, suite_id)
    suite = _suite_model(suite_row, payloads=payload_rows)
    display_ref = suite.ref

    entries: List[Dict[str, Any]] = []
    files: List[SuiteFileModel] = []
    used_paths: set = set()
    used_directories: Dict[str, Dict[str, Any]] = {}
    for row in payload_rows:
        is_xml = (row.get("media_type") or MEDIA_TYPE_JSON) == MEDIA_TYPE_XML
        directory = "xsd" if is_xml else "json-schema"
        extension = "xml" if is_xml else "json"
        stem = _fixture_stem(row["name"])
        path = f"{directory}/test-bench/{stem}.{extension}"
        serial = 2
        while path in used_paths:
            path = f"{directory}/test-bench/{stem}-{serial}.{extension}"
            serial += 1
        used_paths.add(path)
        used_directories[directory] = _CORPUS_DIRECTORIES[directory]

        validity_class = row.get("validity_class") or "valid"
        synthetic = bool(row.get("synthetic"))
        entry: Dict[str, Any] = {
            "path": path,
            "format": directory,
            "adapter_key": None,
            "validity_class": validity_class,
            "expected_detection": {
                "format": "xml" if is_xml else "json",
                "min_confidence": 0.5,
            },
            "features": [INSTANCE_PAYLOAD_FEATURE, "test-bench"],
            "expected_outcome": "imports" if validity_class == "valid" else "rejects",
            "source": "synthesized" if synthetic else "hand-authored",
            "license": "Apache-2.0",
            "provenance": (
                f"Exported from schema test suite {suite.name!r} attached to `{display_ref}`"
                f"{' (synthesized by IXH-5.2 payload synthesis)' if synthetic else ''}."
            ),
        }
        if row.get("notes"):
            entry["notes"] = row["notes"]
        entries.append(entry)
        files.append(SuiteFileModel(path=path, content=row["payload_text"]))

    manifest = {
        "$schema": "./corpus.schema.json",
        "manifest_version": 1,
        "directories": used_directories,
        "entries": sorted(entries, key=lambda entry: entry["path"]),
    }
    return SuiteExportEnvelope(suite=suite, manifest=manifest, files=files)


def import_suite(
    request: SuiteImportRequest, *, tenant_id: str
) -> SchemaTestSuiteModel:
    """Create a suite from a corpus manifest plus its payload files.

    Reads the manifest exactly as the CLI's suite mode does: entries carrying the
    ``instance-payload`` feature are payloads; the expected verdict derives from
    ``validity_class``. Non-payload entries (spec documents sharing the manifest) are
    ignored, not an error.

    Args:
        request: The manifest, files, and the suite's name and reference.
        tenant_id: The caller's authenticated tenant.

    Returns:
        The created suite.

    Raises:
        SuiteValidationError: 400 when the manifest names a payload file that is missing,
            or the resulting payload set violates a bound.
        SchemaReferenceError: 400 for a malformed or registry reference.
        SuiteNameConflictError: When the tenant already has a suite with this name.
    """
    entries = request.manifest.get("entries")
    if not isinstance(entries, list):
        raise SuiteValidationError("The manifest has no `entries` list.")
    content_by_path = {file.path: file.content for file in request.files}

    payloads: List[SuitePayloadModel] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        features = entry.get("features") or []
        if INSTANCE_PAYLOAD_FEATURE not in features:
            continue
        path = entry.get("path")
        if not isinstance(path, str) or not path:
            raise SuiteValidationError("A payload entry has no `path`.")
        content = content_by_path.get(path)
        if content is None:
            raise SuiteValidationError(
                f"The manifest names `{path}` as a payload but no file with that path "
                "was supplied."
            )
        validity_class = entry.get("validity_class")
        if validity_class not in VALIDITY_CLASSES:
            raise SuiteValidationError(
                f"Entry `{path}` has validity_class {validity_class!r}; expected one of "
                f"{', '.join(VALIDITY_CLASSES)}."
            )
        name = posixpath.splitext(posixpath.basename(path))[0]
        is_xml = path.lower().endswith(".xml")
        payloads.append(
            SuitePayloadModel(
                name=name,
                payload_text=content,
                media_type=MEDIA_TYPE_XML if is_xml else MEDIA_TYPE_JSON,
                validity_class=validity_class,
                synthetic=entry.get("source") == "synthesized",
                notes=entry.get("notes"),
                position=len(payloads),
            )
        )

    if not payloads:
        raise SuiteValidationError(
            f"The manifest names no `{INSTANCE_PAYLOAD_FEATURE}` entries — only instance "
            "payloads (the shape the Test Bench and suite export produce) can populate a suite."
        )
    create_request = SchemaTestSuiteCreateRequest(
        name=request.name,
        description=request.description,
        ref=request.ref,
        payloads=payloads,
    )
    return create_suite(create_request, tenant_id=tenant_id)


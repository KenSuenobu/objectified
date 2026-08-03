"""``/v1/tenants/{tenant_slug}/schema-suites`` — IXH-5.7 (#5119).

The REST surface of saved schema test suites (:mod:`app.schema_suite_service`): CRUD over
suites and their payloads, run execution with regression tracking, queryable history, and the
IXH-1.1 corpus round trip.

Permission mapping follows the rest of the 5.x surface (``types``): reads and runs are
``types:view`` — running a suite reads schemas and checks payloads, exactly what the 5.1
validate endpoint lets a viewer do; the bookkeeping row it leaves behind is history *about*
that read, not a mutation of anything a viewer cannot already see. Creating, editing and
deleting suites are the corresponding write actions.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from .auth import validate_authentication
from .database import db
from .permissions import Action, Resource, enforce_permission
from .schema_reference import SchemaReferenceError
from .schema_suite_service import (
    SchemaTestSuiteCreateRequest,
    SchemaTestSuiteModel,
    SchemaTestSuiteUpdateRequest,
    SuiteExportEnvelope,
    SuiteImportRequest,
    SuiteNameConflictError,
    SuitePayloadsReplaceRequest,
    SuiteRunDetailModel,
    SuiteRunRequest,
    SuiteRunSummaryModel,
    SuiteValidationError,
    create_suite,
    delete_suite,
    export_suite,
    get_run_detail,
    get_suite_detail,
    import_suite,
    list_runs,
    list_suites,
    replace_payloads,
    run_suite,
    update_suite,
)

__all__ = ["router"]

router = APIRouter(prefix="/v1/tenants", tags=["schema-test-suites"])


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """The authenticated tenant, which scopes every lookup (the URL slug never does)."""
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="No tenant context for this credential.")
    return str(tenant_id)


def _map_reference_error(exc: SchemaReferenceError) -> HTTPException:
    """Shape an addressing fault exactly like the 5.1 validate route does."""
    detail: Dict[str, Any] = {"message": str(exc)}
    if exc.candidates:
        detail["candidates"] = exc.candidates
    return HTTPException(status_code=exc.status_code, detail=detail)


@router.post(
    "/{tenant_slug}/schema-suites",
    response_model=SchemaTestSuiteModel,
    status_code=201,
    summary="Create a saved schema test suite",
    description=(
        "Persist a named set of payloads plus expected verdicts, attached to a stable schema "
        "reference (IXH-5.7). The reference survives revisions: either the stable form "
        "``{kind}/{artifact}``, or a full IXH-5.1 reference whose version segment is "
        "discarded (``{kind}/{artifact}/{version}[/{type}]``). ``registry/…`` is rejected — "
        "registry types have no revisions to track a regression across. Payload expectations "
        "use the IXH-1.1 corpus vocabulary: a ``valid`` payload must validate, every other "
        "class must not."
    ),
)
async def create_schema_test_suite(
    tenant_slug: str,
    body: SchemaTestSuiteCreateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SchemaTestSuiteModel:
    """Create a suite.

    Raises:
        HTTPException: 400 for a malformed reference or payload set, 403 without
            ``types:create``, 409 for a duplicate suite name.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.CREATE)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug
    try:
        return create_suite(body, tenant_id=tenant_id)
    except SchemaReferenceError as exc:
        raise _map_reference_error(exc) from exc
    except SuiteValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except SuiteNameConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get(
    "/{tenant_slug}/schema-suites",
    response_model=List[SchemaTestSuiteModel],
    summary="List saved schema test suites",
    description=(
        "Suites for the authenticated tenant, newest first, each carrying its newest run "
        "summary — including the ``regression`` flag the version and catalog detail surfaces "
        "badge on. ``ref`` narrows to the suites attached to one artifact "
        "(``{kind}/{artifact}`` — a version or type segment is tolerated and ignored)."
    ),
)
async def list_schema_test_suites(
    tenant_slug: str,
    ref: Optional[str] = Query(default=None, description="Narrow to one artifact's suites."),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> List[SchemaTestSuiteModel]:
    """List suites, optionally narrowed to one artifact.

    Raises:
        HTTPException: 400 for a malformed ``ref``, 403 without ``types:view``.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.VIEW)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug
    try:
        return list_suites(tenant_id, ref=ref)
    except SchemaReferenceError as exc:
        raise _map_reference_error(exc) from exc


@router.post(
    "/{tenant_slug}/schema-suites/import",
    response_model=SchemaTestSuiteModel,
    status_code=201,
    summary="Import a suite from an IXH-1.1 corpus manifest",
    description=(
        "Create a suite from a corpus manifest plus its payload files — the inverse of the "
        "export endpoint, and the same reading the CLI's ``--suite`` mode performs: entries "
        "carrying the ``instance-payload`` feature become payloads, expected verdicts derive "
        "from ``validity_class``, and non-payload entries are ignored."
    ),
)
async def import_schema_test_suite(
    tenant_slug: str,
    body: SuiteImportRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SchemaTestSuiteModel:
    """Import a suite from a manifest envelope.

    Raises:
        HTTPException: 400 for a malformed manifest, reference, or payload set, 403 without
            ``types:create``, 409 for a duplicate suite name.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.CREATE)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug
    try:
        return import_suite(body, tenant_id=tenant_id)
    except SchemaReferenceError as exc:
        raise _map_reference_error(exc) from exc
    except SuiteValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except SuiteNameConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get(
    "/{tenant_slug}/schema-suites/{suite_id}",
    response_model=SchemaTestSuiteModel,
    summary="One suite with its payloads",
)
async def get_schema_test_suite(
    tenant_slug: str,
    suite_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SchemaTestSuiteModel:
    """Read one suite in full.

    Raises:
        HTTPException: 403 without ``types:view``, 404 when the suite is not visible.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.VIEW)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug
    suite = get_suite_detail(tenant_id, suite_id)
    if suite is None:
        raise HTTPException(status_code=404, detail="Test suite not found.")
    return suite


@router.patch(
    "/{tenant_slug}/schema-suites/{suite_id}",
    response_model=SchemaTestSuiteModel,
    summary="Rename or re-describe a suite",
)
async def update_schema_test_suite(
    tenant_slug: str,
    suite_id: str,
    body: SchemaTestSuiteUpdateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SchemaTestSuiteModel:
    """Apply a metadata patch (payload edits use the payloads route).

    Raises:
        HTTPException: 403 without ``types:edit``, 404 when not visible, 409 for a
            duplicate name.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.EDIT)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug
    try:
        suite = update_suite(tenant_id, suite_id, body)
    except SuiteNameConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if suite is None:
        raise HTTPException(status_code=404, detail="Test suite not found.")
    return suite


@router.put(
    "/{tenant_slug}/schema-suites/{suite_id}/payloads",
    response_model=SchemaTestSuiteModel,
    summary="Replace a suite's payload set",
    description=(
        "Replace-all semantics, bumping ``suite_version`` so every run can state which "
        "content version it executed. Partial edits are a client-side concern: read, modify, "
        "put back."
    ),
)
async def replace_schema_test_suite_payloads(
    tenant_slug: str,
    suite_id: str,
    body: SuitePayloadsReplaceRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SchemaTestSuiteModel:
    """Replace the payload set.

    Raises:
        HTTPException: 400 for a payload-set violation, 403 without ``types:edit``,
            404 when not visible.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.EDIT)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug
    try:
        suite = replace_payloads(tenant_id, suite_id, body)
    except SuiteValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    if suite is None:
        raise HTTPException(status_code=404, detail="Test suite not found.")
    return suite


@router.delete(
    "/{tenant_slug}/schema-suites/{suite_id}",
    status_code=204,
    summary="Delete a suite and its history",
)
async def delete_schema_test_suite(
    tenant_slug: str,
    suite_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Response:
    """Delete a suite; payloads, runs and results follow.

    Raises:
        HTTPException: 403 without ``types:delete``, 404 when the suite is not visible.
    """
    # NB: return a Response (not `-> None`) — under `from __future__ import annotations`
    # FastAPI evaluates a `None` return annotation to NoneType and asserts that a 204
    # cannot carry a body. Mirrors the export-job and spec-import cancel routes.
    enforce_permission(db, auth_data, Resource.TYPES, Action.DELETE)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug
    if not delete_suite(tenant_id, suite_id):
        raise HTTPException(status_code=404, detail="Test suite not found.")
    return Response(status_code=204)


@router.post(
    "/{tenant_slug}/schema-suites/{suite_id}/runs",
    response_model=SuiteRunDetailModel,
    status_code=201,
    summary="Run a suite against a revision",
    description=(
        "Execute every payload against the schema the suite is attached to, at the requested "
        "``version`` (a label, a revision id, or ``latest``), judge each verdict against its "
        "expectation, and record the run. The reference is resolved once and pinned to the "
        "resolved revision, so a moving ``latest`` cannot split a run across revisions. Each "
        "verdict is diffed against the suite's previous completed run: a payload that passed "
        "there and failed here is flagged as a **regression**, on the result and on the run. "
        "An unresolvable reference records a run with ``status: error`` — that the suite "
        "could not run against a revision is history, not an exception.\n\n"
        "Gated on ``types:view``, like the 5.1 validate endpoint this run repeats payload by "
        "payload: the run reads schemas and leaves bookkeeping about that read behind."
    ),
)
async def run_schema_test_suite(
    tenant_slug: str,
    suite_id: str,
    body: SuiteRunRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SuiteRunDetailModel:
    """Execute a suite and record the run.

    Raises:
        HTTPException: 403 without ``types:view``, 404 when the suite is not visible.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.VIEW)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug
    run = await run_suite(tenant_id, suite_id, body)
    if run is None:
        raise HTTPException(status_code=404, detail="Test suite not found.")
    return run


@router.get(
    "/{tenant_slug}/schema-suites/{suite_id}/runs",
    response_model=List[SuiteRunSummaryModel],
    summary="A suite's run history",
    description="Newest first. ``limit`` is clamped to 1..100.",
)
async def list_schema_test_suite_runs(
    tenant_slug: str,
    suite_id: str,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> List[SuiteRunSummaryModel]:
    """Read run history.

    Raises:
        HTTPException: 403 without ``types:view``, 404 when the suite is not visible.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.VIEW)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug
    runs = list_runs(tenant_id, suite_id, limit=limit, offset=offset)
    if runs is None:
        raise HTTPException(status_code=404, detail="Test suite not found.")
    return runs


@router.get(
    "/{tenant_slug}/schema-suites/{suite_id}/runs/{run_id}",
    response_model=SuiteRunDetailModel,
    summary="One run with its per-payload results",
    description=(
        "The full verdict record: per payload, the expectation, the tri-state validation "
        "outcome, the judged status, the previous run's status for the same payload, the "
        "regression flag, and the capped findings."
    ),
)
async def get_schema_test_suite_run(
    tenant_slug: str,
    suite_id: str,
    run_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SuiteRunDetailModel:
    """Read one run in full.

    Raises:
        HTTPException: 403 without ``types:view``, 404 when the run is not visible.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.VIEW)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug
    run = get_run_detail(tenant_id, suite_id, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Test suite run not found.")
    return run


@router.get(
    "/{tenant_slug}/schema-suites/{suite_id}/export",
    response_model=SuiteExportEnvelope,
    summary="Export a suite in the IXH-1.1 corpus manifest format",
    description=(
        "The suite as a corpus manifest plus payload files. Materialize each "
        "``files[*].content`` at its ``files[*].path`` next to a ``manifest.json`` holding "
        "``manifest``, and the set runs in CI unchanged: ``apiome schema test --schema "
        "<ref> --suite manifest.json``."
    ),
)
async def export_schema_test_suite(
    tenant_slug: str,
    suite_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SuiteExportEnvelope:
    """Export a suite as a corpus envelope.

    Raises:
        HTTPException: 403 without ``types:view``, 404 when the suite is not visible.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.VIEW)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug
    envelope = export_suite(tenant_id, suite_id)
    if envelope is None:
        raise HTTPException(status_code=404, detail="Test suite not found.")
    return envelope

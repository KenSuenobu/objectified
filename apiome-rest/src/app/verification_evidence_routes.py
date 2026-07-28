"""``/v1/tenants/{tenant_slug}/verification-runs`` — ECA-1.3 (#4731).

The REST surface of verification evidence: record what a run did, read it back, and export it as
JSON or JUnit.

**Authorization** uses the ``verification_evidence`` RBAC resource added by apiome-db V212.
Recording is what a CI runner does on every build, so ``create`` is granted to the Editor grid a
runner's API key resolves to; reading and exporting need ``view``. There is deliberately no update
route — evidence is immutable, and V212 rejects an UPDATE at the database — and no delete route:
the only legitimate removal is the retention sweep.

**Recording is idempotent.** A runner that uploads evidence and loses the response repeats the
request with the same ``idempotency_key`` and gets the original run back with ``200`` instead of a
duplicate under a new id. A fresh record answers ``201``.

**Exports reproduce the stored record**, they do not recompute it: the JUnit counters come from the
stored counts and the case list is the stored one in stored order. See
:mod:`app.verification_evidence_export`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from .auth import validate_authentication
from .database import db
from .permissions import Action, Resource, enforce_permission
from .verification_evidence import (
    CODE_RUN_NOT_FOUND,
    CODE_TARGET_NOT_FOUND,
    RUN_OUTCOMES,
    EvidenceValidationError,
    VerificationRunInput,
    VerificationRunRecord,
    VerificationRunSummary,
)
from .verification_evidence_export import (
    EXPORT_FORMAT_JSON,
    EXPORT_FORMATS,
    EXPORT_MEDIA_TYPES,
    export_run,
)
from .verification_evidence_store import actor_from_auth, get_run, list_runs, record_run

__all__ = ["router"]

router = APIRouter(prefix="/v1/tenants", tags=["contract-assurance"])

# A refusal maps onto the HTTP status that matches *what kind* of refusal it is, so a client can
# act on the status and read the code for the detail.
_STATUS_BY_CODE = {
    CODE_RUN_NOT_FOUND: 404,
    CODE_TARGET_NOT_FOUND: 404,
}


class VerificationRunListResponse(BaseModel):
    """A page of run summaries."""

    model_config = ConfigDict(extra="forbid")

    runs: List[VerificationRunSummary] = Field(
        default_factory=list, description="Matching runs, newest first."
    )
    count: int = Field(description="How many runs were returned.")


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """Return the authenticated tenant id, or refuse.

    Args:
        auth_data: The resolved auth context.

    Returns:
        The tenant id.

    Raises:
        HTTPException: 403 when the credential carries no tenant.
    """
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="No tenant context for this credential.")
    return str(tenant_id)


def _http_error(exc: EvidenceValidationError) -> HTTPException:
    """Translate a taxonomy error into the HTTP error a client sees.

    Args:
        exc: The refusal.

    Returns:
        The ``HTTPException`` to raise — 404 for an unknown run or target, 400 for every
        submission fault, always carrying ``{"code", "message"}`` so a client branches on the code
        rather than the prose.
    """
    return HTTPException(
        status_code=_STATUS_BY_CODE.get(exc.code, 400),
        detail={"code": exc.code, "message": str(exc)},
    )


@router.post(
    "/{tenant_slug}/verification-runs",
    response_model=VerificationRunRecord,
    status_code=201,
    summary="Record verification evidence for a finished run",
    description=(
        "Record one finished contract run as **immutable** evidence: the executed suite digest, "
        "the target identity, timing, per-case outcomes, per-assertion detail, and references to "
        "redacted artifacts.\n\n"
        "**The verdict is derived, not accepted.** Case counts and the run outcome are computed "
        "from the submitted case records; a declared `outcome` that disagrees is refused. Only "
        "`cancelled` — which no set of records can imply — is taken on the runner's word.\n\n"
        "**A failure must say why.** A case recorded as `failed` or `errored` needs a "
        "`failure_code`, and a failed assertion needs a `code`; an outcome with no stated reason "
        "cannot be compared across runs or gated on.\n\n"
        "**Artifacts are linked, never embedded.** An artifact reference carries a URI, a size, "
        "and a content hash — a `data:` URI is refused, as is one embedding `user:pass@` "
        "credentials — and every free-text field is scrubbed for credentials before storage.\n\n"
        "**Recording is idempotent.** Repeating the request with the same `idempotency_key` "
        "returns the originally stored run with `200` rather than creating a duplicate.\n\n"
        "Requires `verification_evidence:create`."
    ),
)
async def create_verification_run(
    tenant_slug: str,
    body: VerificationRunInput,
    response: Response,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationRunRecord:
    """Record one finished run.

    Args:
        tenant_slug: The tenant in the URL (the authenticated tenant is what actually scopes it).
        body: The submitted run.
        response: Used to answer ``200`` when an idempotency key replayed an existing run.
        auth_data: The authenticated principal — a user or a CI runner.

    Returns:
        The stored evidence, read back in full.

    Raises:
        HTTPException: 400 for a rejected submission, 404 when the named target does not exist,
            403 without ``verification_evidence:create``.
    """
    user_id = enforce_permission(
        db, auth_data, Resource.VERIFICATION_EVIDENCE, Action.CREATE, target=body.target_ref
    )
    _ = tenant_slug
    try:
        recorded = record_run(
            _tenant_id(auth_data), body, actor=actor_from_auth(auth_data, user_id)
        )
    except EvidenceValidationError as exc:
        raise _http_error(exc) from exc
    if not recorded.created:
        # An idempotency key replayed an existing run: nothing was created, so saying 201 would
        # tell a runner it had just written evidence that in fact predates this request.
        response.status_code = 200
    return recorded.record


@router.get(
    "/{tenant_slug}/verification-runs",
    response_model=VerificationRunListResponse,
    summary="List verification runs",
    description=(
        "Recorded runs, newest first, without per-case detail.\n\n"
        "The filters are the questions a gate asks: the newest evidence for *this* compiled "
        "suite (`suite_digest`), everything that ran against *this* target (`target_id`), or "
        "only the failures (`outcome`).\n\n"
        "Requires `verification_evidence:view`."
    ),
)
async def list_verification_runs(
    tenant_slug: str,
    target_id: Optional[str] = Query(default=None, description="Restrict to one target."),
    suite_digest: Optional[str] = Query(
        default=None, description="Restrict to one compiled suite digest (`sha256:<hex>`)."
    ),
    outcome: Optional[str] = Query(
        default=None, description=f"Restrict to one verdict: {', '.join(RUN_OUTCOMES)}."
    ),
    limit: int = Query(default=50, ge=1, le=200, description="Maximum runs to return."),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationRunListResponse:
    """List the tenant's runs.

    Args:
        tenant_slug: The tenant in the URL.
        target_id: Restrict to one target.
        suite_digest: Restrict to one compiled suite.
        outcome: Restrict to one verdict.
        limit: Maximum runs.
        auth_data: The authenticated principal.

    Returns:
        The summaries.

    Raises:
        HTTPException: 403 without ``verification_evidence:view``.
    """
    enforce_permission(db, auth_data, Resource.VERIFICATION_EVIDENCE, Action.VIEW)
    _ = tenant_slug
    runs = list_runs(
        _tenant_id(auth_data),
        target_id=target_id,
        suite_digest=suite_digest,
        outcome=outcome,
        limit=limit,
    )
    return VerificationRunListResponse(runs=runs, count=len(runs))


@router.get(
    "/{tenant_slug}/verification-runs/{run_id}",
    response_model=VerificationRunRecord,
    summary="Read one verification run",
    description=(
        "One run in full: every case record, its assertions, and the references to its redacted "
        "artifacts.\n\n"
        "The target identity is the **snapshot taken at run time**, not a live read of the "
        "target — a target that has since been renamed, repointed, or retired cannot rewrite what "
        "this run says it did.\n\n"
        "Requires `verification_evidence:view`."
    ),
)
async def read_verification_run(
    tenant_slug: str,
    run_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationRunRecord:
    """Read one run.

    Args:
        tenant_slug: The tenant in the URL.
        run_id: The run id.
        auth_data: The authenticated principal.

    Returns:
        The complete record.

    Raises:
        HTTPException: 404 when nothing matches, 403 without ``verification_evidence:view``.
    """
    enforce_permission(db, auth_data, Resource.VERIFICATION_EVIDENCE, Action.VIEW)
    _ = tenant_slug
    try:
        return get_run(_tenant_id(auth_data), run_id)
    except EvidenceValidationError as exc:
        raise _http_error(exc) from exc


@router.get(
    "/{tenant_slug}/verification-runs/{run_id}/export",
    summary="Export one verification run as JSON or JUnit",
    description=(
        "Export the stored evidence.\n\n"
        "* `json` — the whole record (`application/json`), keys sorted so two exports of the same "
        "run are byte-identical and can be diffed without a semantic differ.\n"
        "* `junit` — JUnit XML (`application/xml`), which GitHub Actions, GitLab, Jenkins, and "
        "Buildkite render natively. One `<testcase>` per stored case in stored order; a contract "
        "violation becomes `<failure>` and an unexecutable case becomes `<error>`, because that "
        "is the distinction contract verification needs. The suite digest and target identity "
        "travel as `<properties>`.\n\n"
        "Neither exporter recomputes a verdict: the counters come from the stored counts, so an "
        "export can never disagree with the run it exports.\n\n"
        "Requires `verification_evidence:view`."
    ),
    responses={
        200: {
            "description": "The exported evidence.",
            "content": {"application/json": {}, "application/xml": {}},
        }
    },
)
async def export_verification_run(
    tenant_slug: str,
    run_id: str,
    export_format: str = Query(
        default=EXPORT_FORMAT_JSON,
        alias="format",
        description=f"Export format: {', '.join(EXPORT_FORMATS)}.",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Response:
    """Export one run.

    Args:
        tenant_slug: The tenant in the URL.
        run_id: The run id.
        export_format: ``json`` or ``junit``.
        auth_data: The authenticated principal.

    Returns:
        The rendered export, with the media type its format is served as and a
        ``Content-Disposition`` filename a CI job can save directly.

    Raises:
        HTTPException: 404 when nothing matches, 400 for an unsupported format, 403 without
            ``verification_evidence:view``.
    """
    enforce_permission(db, auth_data, Resource.VERIFICATION_EVIDENCE, Action.VIEW)
    _ = tenant_slug
    try:
        record = get_run(_tenant_id(auth_data), run_id)
        body = export_run(record, export_format)
    except EvidenceValidationError as exc:
        raise _http_error(exc) from exc
    extension = "xml" if export_format != EXPORT_FORMAT_JSON else "json"
    return Response(
        content=body,
        media_type=EXPORT_MEDIA_TYPES[export_format],
        headers={
            "Content-Disposition": f'attachment; filename="verification-run-{run_id}.{extension}"'
        },
    )

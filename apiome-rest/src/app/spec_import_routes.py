"""
Specification file import — REST contract for CLI (#3329).

Content negotiation
-------------------
* ``POST …/imports`` accepts ``application/json`` with base64-encoded bytes
  (:class:`SpecImportStartJsonRequest`). Prefer this for automation and smaller specs.
* ``POST …/imports/upload`` accepts ``multipart/form-data`` with a binary ``file`` part plus a
  ``metadata`` string field containing JSON for :class:`SpecImportStartMetadata`. Prefer this for
  large documents.

Implementation note
-------------------
Jobs run a ``tsx`` worker in ``apiome-ui`` that shares the same ``DATABASE_URL`` as this API,
using incremental import mode so results are persisted without a separate commit step. Two-phase
preview commit/rollback (pending-approval) is not exposed yet for REST callers.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import ValidationError

from .auth import get_authenticated_user_id, validate_authentication
from .database import db
from .import_preflight import run_import_preflight
from .permissions import enforce_permission, Resource, Action
from .models import (
    ImportPreflightReport,
    ImportPreflightRequest,
    SpecImportCommitResponse,
    SpecImportJobAccepted,
    SpecImportJobListResponse,
    SpecImportJobStatus,
    SpecImportRollbackResponse,
    SpecImportStartJsonRequest,
    SpecImportStartMetadata,
)
from .spec_import_engine import (
    cancel_spec_import_job as engine_cancel_spec_import_job,
    commit_spec_import_job as engine_commit_spec_import_job,
    get_spec_import_status as engine_get_spec_import_status,
    list_spec_import_jobs as engine_list_spec_import_jobs,
    rollback_spec_import_job as engine_rollback_spec_import_job,
    schedule_spec_import,
    schedule_spec_import_multipart,
)

router = APIRouter(prefix="/v1/tenants", tags=["spec-import"])


def _require_tenant_and_user(auth_data: Dict[str, Any]) -> tuple[str, str]:
    uid = get_authenticated_user_id(auth_data)
    if not uid:
        raise HTTPException(
            status_code=403,
            detail=(
                "An authenticated user id is required for specification import "
                "(ensure API keys set created_by_user_id or use a JWT session)."
            ),
        )
    tid = auth_data.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="Tenant id missing from authentication context.")
    return str(tid), uid


@router.post(
    "/{tenant_slug}/import/preflight",
    response_model=ImportPreflightReport,
    summary="Pre-flight a candidate document (lint and rank, no write)",
    description=(
        "Score a candidate document **before** importing it (IXH-2.1). Runs the same "
        "detect → parse → normalize → fingerprint → lint pipeline a real import runs, with "
        "dry-run semantics, and returns the detected adapter and confidence, the routing "
        "decision, canonical entity counts, the revision fingerprint, the full lint report "
        "with findings ranked by severity then rule weight, the resolved style guide, and an "
        "(advisory, until IXH-2.3) policy verdict. Nothing is persisted: no catalog item, "
        "project, version, type row, or import job.\n\n"
        "A document that cannot be imported is **not** an HTTP error — the response is a 200 "
        "with ``ok: false`` and a stable intake-taxonomy ``error`` code plus remediation, so "
        "callers key off the code rather than parsing exception strings. Repeated pre-flights "
        "of identical bytes are served from a tenant-scoped cache and report ``cache.hit``."
    ),
)
async def preflight_import_candidate(
    tenant_slug: str,
    body: ImportPreflightRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ImportPreflightReport:
    # Gated on ``imports:create`` rather than a view action: pre-flight is the first step of
    # the import flow, and a caller who may not import has no use for its verdict. It writes
    # nothing itself.
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.CREATE)
    tenant_id, user_id = _require_tenant_and_user(auth_data)
    return await run_import_preflight(
        body, tenant_id=tenant_id, tenant_slug=tenant_slug, user_id=user_id
    )


@router.get(
    "/{tenant_slug}/imports",
    response_model=SpecImportJobListResponse,
    summary="List specification import jobs",
    description=(
        "Jobs tracked in this API process for the tenant (in-memory). "
        "After restart the list is empty; use GET …/imports/{job_id} for full event history."
    ),
)
async def list_spec_import_jobs(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SpecImportJobListResponse:
    _ = auth_data
    return await engine_list_spec_import_jobs(tenant_slug)


@router.post(
    "/{tenant_slug}/imports",
    status_code=202,
    response_model=SpecImportJobAccepted,
    summary="Start specification import (JSON + base64)",
    description=(
        "Create an asynchronous import job using a JSON body. "
        "The document is sent as standard base64 in ``document_base64``."
    ),
)
async def start_spec_import_json(
    tenant_slug: str,
    body: SpecImportStartJsonRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SpecImportJobAccepted:
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.CREATE)
    tenant_id, user_id = _require_tenant_and_user(auth_data)
    return await schedule_spec_import(tenant_slug, tenant_id, user_id, body)


@router.post(
    "/{tenant_slug}/imports/upload",
    status_code=202,
    response_model=SpecImportJobAccepted,
    summary="Start specification import (multipart file)",
    description=(
        "Create an asynchronous import job using multipart upload. "
        "The ``metadata`` field must be a JSON string matching "
        "``SpecImportStartMetadata`` (same structure as the ``metadata`` object in the JSON "
        "endpoint). The ``file`` part carries raw spec bytes."
    ),
)
async def start_spec_import_multipart(
    tenant_slug: str,
    file: UploadFile = File(..., description="Raw specification file bytes."),
    metadata: str = Form(
        ...,
        description="JSON string matching SpecImportStartMetadata (project, version, source_kind, options).",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SpecImportJobAccepted:
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.CREATE)
    tenant_id, user_id = _require_tenant_and_user(auth_data)
    try:
        meta = SpecImportStartMetadata.model_validate_json(metadata)
    except (ValidationError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    raw = await file.read()
    return await schedule_spec_import_multipart(
        tenant_slug,
        tenant_id,
        user_id,
        meta,
        raw,
        file.filename,
        file.content_type,
    )


@router.get(
    "/{tenant_slug}/imports/{job_id}",
    response_model=SpecImportJobStatus,
    summary="Get specification import job status",
)
async def get_spec_import_status(
    tenant_slug: str,
    job_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SpecImportJobStatus:
    _ = auth_data
    return await engine_get_spec_import_status(tenant_slug, job_id)


@router.delete(
    "/{tenant_slug}/imports/{job_id}",
    status_code=204,
    summary="Cancel specification import job",
)
async def cancel_spec_import_job(
    tenant_slug: str,
    job_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Response:
    # NB: return a Response (not `-> None`) — under `from __future__ import annotations`
    # FastAPI evaluates a `None` return annotation to NoneType and asserts that a 204
    # cannot carry a body. Mirrors the draft-lock release routes.
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.DELETE)
    _ = auth_data
    await engine_cancel_spec_import_job(tenant_slug, job_id)
    return Response(status_code=204)


@router.post(
    "/{tenant_slug}/imports/{job_id}/commit",
    response_model=SpecImportCommitResponse,
    summary="Commit a previewed specification import",
)
async def commit_spec_import_job(
    tenant_slug: str,
    job_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SpecImportCommitResponse:
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.CREATE)
    _ = auth_data
    return await engine_commit_spec_import_job(tenant_slug, job_id)


@router.post(
    "/{tenant_slug}/imports/{job_id}/rollback",
    response_model=SpecImportRollbackResponse,
    summary="Rollback a committed specification import",
)
async def rollback_spec_import_job(
    tenant_slug: str,
    job_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SpecImportRollbackResponse:
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.CREATE)
    _ = auth_data
    return engine_rollback_spec_import_job(tenant_slug, job_id)

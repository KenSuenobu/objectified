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
using incremental import mode so results are persisted without a separate commit step. Commit and
rollback are served from the owning instance's in-memory record or, on a non-owning instance, from
the shared ``async_job`` store (IXH-6.2). Two-phase preview commit/rollback
(``pending-approval``) still requires an owner-held preview transaction that REST does not hold;
callers receive a documented 501 naming constraint ``held_preview_transaction`` rather than a bare
404, and sticky owner routing is not available in this deployment.
"""

from __future__ import annotations

import base64
import binascii
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import ValidationError

from .auth import get_authenticated_user_id, validate_authentication
from .database import db
from .import_export_quality_policy import QualityGateError, enforce_import_quality_gate
from .import_preflight import run_import_preflight
from .import_preview_manifest import (
    ImportPreviewManifestRequest,
    ImportPreviewManifestResponse,
    run_import_preview_manifest,
)
from .intake_error_taxonomy import descriptor_for
from .models import (
    REPOSITORY_AUTO_IMPORT_SOURCE_KIND,
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
from .permissions import Action, Resource, enforce_permission
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


async def _enforce_quality_gate(
    *,
    tenant_id: str,
    tenant_slug: str,
    user_id: str,
    raw: bytes,
    metadata: SpecImportStartMetadata,
    filename: Optional[str],
    content_type: Optional[str],
) -> None:
    """Refuse a start request the tenant's import quality policy blocks (IXH-2.3, #5098).

    The wizard's quality step already shows the verdict, but a policy enforced only in a client
    is not enforced — the CLI, a script, and a stale browser tab all reach this endpoint. This
    is the server-side gate, and it runs *before* the job exists so a blocked import costs
    nothing to clean up.

    Skipped for a dry run (which persists nothing to gate) and for a repository auto-refresh
    (whose document and importer come from the stored spec, not this request). A tenant on the
    default advisory policy pays nothing: the gate returns before it looks at the document.

    Args:
        tenant_id: The importing tenant.
        tenant_slug: Its slug.
        user_id: The acting user.
        raw: The candidate document bytes.
        metadata: The start request's metadata (source kind + options).
        filename: Upload filename, when known.
        content_type: Upload content type, when known.

    Raises:
        HTTPException: 409 with the ``QUALITY_POLICY_BLOCKED`` taxonomy code and the full
            verdict when policy refuses the import.
    """
    options = metadata.options
    if options.dry_run or metadata.source_kind == REPOSITORY_AUTO_IMPORT_SOURCE_KIND:
        return
    try:
        await enforce_import_quality_gate(
            tenant_id=tenant_id,
            tenant_slug=tenant_slug,
            user_id=user_id,
            raw=raw,
            filename=filename,
            content_type=content_type,
            source_kind=metadata.source_kind,
            import_target=options.import_target,
            input_kind=options.input_kind,
            archive_root=options.archive_root,
        )
    except QualityGateError as exc:
        descriptor = descriptor_for("QUALITY_POLICY_BLOCKED")
        raise HTTPException(
            status_code=409,
            detail={
                "code": "QUALITY_POLICY_BLOCKED",
                "category": descriptor.category.value if descriptor else "policy",
                "message": exc.verdict.reason,
                "remediation": descriptor.remediation if descriptor else "",
                "retriable": False,
                "policy": exc.verdict.as_dict(),
            },
        ) from exc


@router.post(
    "/{tenant_slug}/import/preflight",
    response_model=ImportPreflightReport,
    summary="Pre-flight a candidate document (lint and rank, no write)",
    description=(
        "Score a candidate document **before** importing it (IXH-2.1). Runs the same "
        "detect → parse → normalize → fingerprint → lint pipeline a real import runs, with "
        "dry-run semantics, and returns the detected adapter and confidence, the routing "
        "decision, canonical entity counts, the revision fingerprint, the full lint report "
        "with findings ranked by severity then rule weight, the resolved style guide, and the "
        "tenant quality policy verdict (IXH-2.3) with the resolution tier that produced it. "
        "Nothing is persisted: no catalog item, project, version, type row, or import job.\n\n"
        "A document that cannot be imported is **not** an HTTP error — the response is a 200 "
        "with ``ok: false`` and a stable intake-taxonomy ``error`` code plus remediation, so "
        "callers key off the code rather than parsing exception strings. Repeated pre-flights "
        "of identical bytes are served from a tenant-scoped cache and report ``cache.hit``; the "
        "policy verdict is always re-evaluated, so a waiver recorded between two calls is "
        "reflected immediately."
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


@router.post(
    "/{tenant_slug}/import/preview-manifest",
    response_model=ImportPreviewManifestResponse,
    summary="Preview manifest for a candidate document (entity tree + coverage ledger, no write)",
    description=(
        "Describe **what an import would create** before committing it (IXH-3.1). Extends the "
        "IXH-2.1 pre-flight: the same detect → parse → normalize → fingerprint → lint pipeline "
        "runs with dry-run semantics, and the response adds the canonical entity tree (services → "
        "operations, types, channels) with stable canonical keys and source locations, per-entity "
        "provenance back to the source construct, a coverage ledger that classifies source "
        "constructs as mapped / partially-mapped / unsupported-by-canonical-model / "
        "not-parsed-by-adapter (the last two are never conflated, and every not-parsed entry "
        "names its CLX-2.4 capability-registry reference), the adapter capability reference, and "
        "the routing decision (on the embedded pre-flight report). The graph reuses the CPDO-1.3 "
        "projection-manifest node/edge vocabulary, so the import graph and the conversion graph "
        "share one contract.\n\n"
        "The manifest is deterministic and byte-stable for a fixed input, adapter version, and "
        "options (`manifest_hash` is the snapshot id), and is cursor-paginated over the entity "
        "tree for large inputs — truncation is stated in the payload (`truncated`, `total_*`), "
        "never silent. A candidate that cannot be imported is still a 200: `ok` is false, "
        "`manifest` is null, and the embedded pre-flight report carries the stable "
        "intake-taxonomy error. Nothing is persisted.\n\n"
        "When the request names the catalog `project_slug` the commit would use and an existing "
        "catalog item lives under it, the response also carries the IXH-3.4 **re-import delta**: "
        "`canonical_diff` between the current revision's canonical model and the candidate, "
        "grouped/counted by entity family, with breaking-change grades joined where the format's "
        "classifier is available, and an explicit no-op verdict (matching fingerprints) when the "
        "re-import would create an empty revision. First-time imports have `reimport = null`."
    ),
)
async def preview_import_manifest(
    tenant_slug: str,
    body: ImportPreviewManifestRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ImportPreviewManifestResponse:
    # Same gate as the pre-flight (IXH-2.1): the manifest is the first step of the import
    # flow, and a caller who may not import has no use for it. It writes nothing itself.
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.CREATE)
    tenant_id, user_id = _require_tenant_and_user(auth_data)
    try:
        return await run_import_preview_manifest(
            body, tenant_id=tenant_id, tenant_slug=tenant_slug, user_id=user_id
        )
    except ValueError as exc:
        # A malformed pagination cursor is a client error, not a pre-flight verdict.
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get(
    "/{tenant_slug}/imports",
    response_model=SpecImportJobListResponse,
    summary="List specification import jobs",
    description=(
        "Paginated tenant import jobs from the shared store (IXH-6.3), newest first. "
        "Supports ``state`` and ``created_after`` / ``created_before`` filters. "
        "Default page size is 50 (max 200)."
    ),
)
async def list_spec_import_jobs(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
    limit: int = Query(50, ge=1, le=200, description="Page size (default 50, max 200)."),
    offset: int = Query(0, ge=0, description="Number of matching jobs to skip."),
    state: Optional[str] = Query(
        None, description="Exact job state filter (e.g. completed, failed, running)."
    ),
    created_after: Optional[datetime] = Query(
        None, description="Inclusive lower bound on job created_at (ISO-8601)."
    ),
    created_before: Optional[datetime] = Query(
        None, description="Inclusive upper bound on job created_at (ISO-8601)."
    ),
) -> SpecImportJobListResponse:
    _ = auth_data
    return await engine_list_spec_import_jobs(
        tenant_slug,
        limit=limit,
        offset=offset,
        state=state,
        created_after=created_after,
        created_before=created_before,
    )


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
    try:
        raw = base64.standard_b64decode(body.document_base64)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(
            status_code=422, detail=f"document_base64 is not valid base64: {exc}"
        ) from exc
    await _enforce_quality_gate(
        tenant_id=tenant_id,
        tenant_slug=tenant_slug,
        user_id=user_id,
        raw=raw,
        metadata=body.metadata,
        filename=body.filename,
        content_type=body.content_type,
    )
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
    await _enforce_quality_gate(
        tenant_id=tenant_id,
        tenant_slug=tenant_slug,
        user_id=user_id,
        raw=raw,
        metadata=meta,
        filename=file.filename,
        content_type=file.content_type,
    )
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
    return await engine_rollback_spec_import_job(tenant_slug, job_id)

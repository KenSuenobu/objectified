"""Async export job REST surface — MFX-3.1 (#3844).

The job counterpart of the synchronous export endpoints in :mod:`app.export_routes`:
where ``POST /export/{tenant_slug}/document`` emits inline and ``POST …/preview``
predicts fidelity inline, ``POST /export/{tenant_slug}/jobs`` runs the same pipeline
asynchronously — submit, poll, terminal state — for large or toolchain-backed exports.

The route layout and status contract deliberately mirror the spec-import surface
(:mod:`app.spec_import_routes`):

* ``POST   /v1/export/{tenant_slug}/jobs``          → 202 + ``{job_id, status_path}``
* ``GET    /v1/export/{tenant_slug}/jobs``          → summary list (in-memory, per process)
* ``GET    /v1/export/{tenant_slug}/jobs/{job_id}`` → ``{job_id, state, percent, events, progress, result, error}``
* ``GET    /v1/export/{tenant_slug}/jobs/{job_id}/download`` → the emitted artifact, streamed (MFX-4.1/4.2; 4.3)
* ``DELETE /v1/export/{tenant_slug}/jobs/{job_id}`` → 204 cancel request

All routes are tenant-scoped (JWT or API key) via :func:`app.auth.validate_authentication`,
like the sibling export endpoints.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse

from .auth import validate_authentication
from .export_job_engine import (
    ExportJobAccepted,
    ExportJobListResponse,
    ExportJobStartRequest,
    ExportJobStatus,
    iter_download_chunks,
    schedule_export_job,
)
from .export_job_engine import (
    cancel_export_job as engine_cancel_export_job,
)
from .export_job_engine import (
    get_export_job_status as engine_get_export_job_status,
)
from .export_job_engine import (
    list_export_jobs as engine_list_export_jobs,
)
from .export_job_engine import (
    resolve_export_download as engine_resolve_export_download,
)
from .export_service import ExportError

router = APIRouter(prefix="/v1/export", tags=["export-jobs"])


@router.post(
    "/{tenant_slug}/jobs",
    status_code=202,
    response_model=ExportJobAccepted,
    summary="Start an asynchronous export job",
    description=(
        "Submit an export of one artifact/version to one target through the async job "
        "pipeline: load source → fidelity report → emit → validate → package. "
        "``dry_run: true`` stops after the fidelity report (no artifact), the async twin "
        "of ``POST …/preview``. Poll the returned ``status_path`` for progress; the "
        "status contract matches the spec-import job surface."
    ),
)
async def start_export_job(
    tenant_slug: str,
    request: ExportJobStartRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportJobAccepted:
    """Accept an export job for background execution.

    Args:
        tenant_slug: The tenant slug (scopes the job and the artifact lookup).
        request: Source coordinates + target + options + dry-run flag.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The 202 acceptance payload (job id + poll path).

    Raises:
        HTTPException: 400 when the target is unknown; 422 when the emit options are
            invalid for the target. Source-related failures (unknown artifact/version,
            no reconstructable source) surface asynchronously in the job status.
    """
    tenant_id = str(auth_data["tenant_id"])
    try:
        return await schedule_export_job(tenant_slug, tenant_id, request)
    except ExportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get(
    "/{tenant_slug}/jobs",
    response_model=ExportJobListResponse,
    summary="List export jobs",
    description=(
        "Jobs tracked in this API process for the tenant (in-memory). After a restart "
        "the list is empty; use GET …/jobs/{job_id} for a job's full event history."
    ),
)
async def list_export_jobs(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportJobListResponse:
    """List the tenant's export jobs known to this process.

    Args:
        tenant_slug: The tenant slug the jobs were submitted under.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        Summary rows (state, percent, progress) without event logs or fidelity envelopes.
    """
    _ = auth_data
    return await engine_list_export_jobs(tenant_slug)


@router.get(
    "/{tenant_slug}/jobs/{job_id}",
    response_model=ExportJobStatus,
    summary="Get export job status",
    description=(
        "Poll payload for one export job: state, percent, structured events, and coarse "
        "progress. A terminal job is self-describing — a completed real export carries a "
        "``result`` (resolved coordinates, fidelity envelope, transcode guard, emitted-file "
        "manifest, and a ``download_path`` for the artifact bytes); a dry-run carries the "
        "report only (no ``download_path``); a failed job carries a structured ``error``."
    ),
)
async def get_export_job_status(
    tenant_slug: str,
    job_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportJobStatus:
    """Return the current status of one export job.

    Args:
        tenant_slug: The tenant slug the job was submitted under.
        job_id: The job id from the 202 acceptance payload.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The job's poll payload.

    Raises:
        HTTPException: 404 when the job is unknown for this tenant (or the process restarted).
    """
    _ = auth_data
    return await engine_get_export_job_status(tenant_slug, job_id)


@router.get(
    "/{tenant_slug}/jobs/{job_id}/download",
    summary="Download a completed export job's artifact",
    description=(
        "Serve the artifact a completed export job produced — the target the poller was handed "
        "via ``result.download_path``. The bytes come from the job's retained emit result (no "
        "re-emit) and are **streamed** in fixed-size chunks with an up-front ``Content-Length`` "
        "(MFX-4.3), so a large bundle is not buffered whole. A **single-file** export (MFX-4.1) "
        "is served inline with the emitted file's content type and a ``Content-Disposition`` "
        "filename, byte-identical to the size the job manifest reported. A **multi-file** export "
        "(protobuf packages, WSDL+XSD, per-subject Avro) is served as an ``application/zip`` "
        "bundle (MFX-4.2) carrying every emitted file plus a root ``manifest.json``. A job that "
        "is not completed or is a dry-run (no artifact) is rejected with 409; a completed job "
        "whose retained artifact has passed its retention window (MFX-4.3) is 410 Gone."
    ),
    response_class=StreamingResponse,
)
async def download_export_job_artifact(
    tenant_slug: str,
    job_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StreamingResponse:
    """Stream a completed export job's emitted artifact as a download.

    The body is streamed in fixed-size chunks (:func:`iter_download_chunks`) with an explicit
    ``Content-Length`` so a client can show progress without the response layer buffering a
    large bundle whole (MFX-4.3).

    Args:
        tenant_slug: The tenant slug the job was submitted under.
        job_id: The job id from the 202 acceptance payload.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The emitted artifact — a single document, or an ``application/zip`` bundle for a
        multi-file target — streamed with its content type and a ``Content-Disposition``
        filename.

    Raises:
        HTTPException: 404 when the job is unknown for this tenant; 409 when the job has no
            downloadable artifact (not completed, or a dry-run that emitted nothing); 410 when
            the retained artifact has passed its retention window (MFX-4.3).
    """
    _ = auth_data
    artifact = engine_resolve_export_download(tenant_slug, job_id)
    headers = {
        "Content-Disposition": f'attachment; filename="{artifact.filename}"',
        "Content-Length": str(artifact.content_length),
    }
    if artifact.content_sha256:
        from .export_artifact_store import content_sha256_hex_only, digest_header_value

        headers["Digest"] = digest_header_value(artifact.content_sha256)
        headers["X-Content-SHA256"] = content_sha256_hex_only(artifact.content_sha256)
    return StreamingResponse(
        iter_download_chunks(artifact),
        media_type=artifact.media_type,
        headers=headers,
    )


@router.delete(
    "/{tenant_slug}/jobs/{job_id}",
    status_code=204,
    summary="Cancel an export job",
    description=(
        "Request cancellation. The pipeline stops at its next stage boundary; a job "
        "already in a terminal state is left unchanged (the request is a no-op)."
    ),
)
async def cancel_export_job(
    tenant_slug: str,
    job_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Response:
    # NB: return a Response (not `-> None`) — under `from __future__ import annotations`
    # FastAPI evaluates a `None` return annotation to NoneType and asserts that a 204
    # cannot carry a body. Mirrors the spec-import cancel route.
    _ = auth_data
    await engine_cancel_export_job(tenant_slug, job_id)
    return Response(status_code=204)

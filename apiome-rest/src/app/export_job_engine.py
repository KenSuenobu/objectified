"""Async export jobs — the export-side mirror of :mod:`app.spec_import_engine` — MFX-3.1 (#3844).

Large exports (multi-file, toolchain-backed targets) need the same asynchronous job
lifecycle the spec-import path has: submit → poll → terminal state. This module is that
engine. A job is submitted with the source coordinates (artifact/version), a target
(emitter key or format key), optional per-target emit options, and a ``dry_run`` flag,
and then runs through the export pipeline in the background:

1. **load source** — rebuild the revision's :class:`~app.canonical_model.CanonicalApi`
   (:func:`app.export_source.load_export_source`, the MFX-2.5 loader);
2. **analyze fidelity** — compute the full :class:`~app.export_fidelity.ExportFidelity`
   envelope (:func:`app.export_fidelity.build_export_fidelity`), byte-identical to what
   ``POST /export/preview`` returns for the same inputs;
3. **dry-run gate** — a ``dry_run`` job completes here: the result carries the fidelity
   report and **no artifact**;
4. **emit** — run the registered emitter through the Emitter SPI
   (:func:`app.export_service.emit_canonical`), with field-identity persistence;
5. **validate** — the MFX-EPIC-5 check (:func:`app.export_validation.validate_emitted_artifact`,
   MFX-5.1): feed the emitted output back through its matching MFI import parser. A buggy
   emitter's illegal output fails the job here (``EMITTED_ARTIFACT_INVALID``) before delivery;
   a format whose parser needs an unavailable toolchain is reported *skipped*, not failed;
6. **package** — the MFX-EPIC-4 seam (:func:`build_result_manifest`): reduce the emitted
   files to a download manifest. The raw :class:`~app.emitter.EmitResult` stays on the
   in-memory job record (:func:`get_export_job_emit_result`) so the delivery routes can
   serve bytes without re-emitting — a single file inline (MFX-4.1) or, for a multi-file
   target (protobuf packages, WSDL+XSD, per-subject Avro), a **zip bundle** carrying every
   emitted file plus a ``manifest.json`` (MFX-4.2, :func:`build_export_zip`).

The retained artifact is **temporary** (MFX-4.3): a completed job records an expiry
(``export_artifact_retention_hours`` after emit, or never when that setting is non-positive),
surfaced to the poller on ``result.download_expires_at``. Past the deadline the bytes are
dropped from the record and the download route answers ``410 Gone`` — a lazy sweep
(:func:`_expire_stale_artifacts`) also drops any other expired artifacts on each download
resolve, so memory is reclaimed without a background reaper. The download itself is
**streamed** in fixed-size chunks (:func:`iter_download_chunks`) rather than buffered whole,
so a large bundle does not force a second full copy through the response layer.

The status/polling contract deliberately matches the import engine's: the same job-record
store (in-memory, per-process, tenant-scoped), the same state vocabulary (a subset —
exports have no two-phase commit, so no ``pending-approval``/``committing``/``rolled-back``),
the ``{job_id, state, percent, events, progress, result}`` poll payload shape, and the
same 202-accepted + ``status_path`` submission response.

Terminal jobs make the poll payload self-describing for UI/CLI pollers (MFX-3.4): a
``completed`` real export carries a ``result`` whose ``download_path`` points at the
delivery route (MFX-4.x) that serves the retained bytes, alongside the fidelity report;
a ``failed`` job carries a structured :class:`ExportJobError` (``code``/``message``/
``context``) on ``status.error`` — the machine-readable twin of the terminal error event —
so a poller renders the failure without scraping the event log.

Unlike imports (which shell out to the ``apiome-ui`` ``tsx`` worker for OpenAPI), the whole
export pipeline is in-process Python. Jobs are driven on the engine's own process-lifetime
event loop (a daemon thread), never on the submitting request's loop, so a job always
outlives its request; blocking stages run via :func:`asyncio.to_thread` so that loop stays
responsive, and a cancel request takes effect at the next stage boundary.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterator, List, Literal, Optional, Union

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .config import settings
from .emitter import EmitResult
from .export_fidelity import ExportFidelity, build_export_fidelity
from .export_service import (
    ExportError,
    ExportPersistenceContext,
    emit_canonical,
    resolve_emit_format,
    resolve_emit_options,
    resolve_emitter,
)
from .export_source import ExportSource, ExportSourceError, load_export_source
from .export_validation import EmittedArtifactValidation, validate_emitted_artifact
from .export_validation_gate import EmittedValidationReport, build_validation_report
from .lossiness import LossinessSeverity
from .projection_telemetry import projection_telemetry
from .transcoding_guards import TranscodeGuard, classify_transcode

logger = logging.getLogger(__name__)

__all__ = [
    "ExportJobState",
    "ExportJobEvent",
    "ExportJobProgress",
    "ExportJobStartRequest",
    "ExportJobFile",
    "ExportJobResult",
    "ExportJobError",
    "ExportJobStatus",
    "ExportJobListItem",
    "ExportJobListResponse",
    "ExportJobAccepted",
    "schedule_export_job",
    "get_export_job_status",
    "list_export_jobs",
    "cancel_export_job",
    "get_export_job_emit_result",
    "build_validation_events",
    "build_result_manifest",
    "build_bundle_manifest",
    "build_export_zip",
    "serialize_file_content",
    "ExportDownloadArtifact",
    "resolve_export_download",
    "iter_download_chunks",
    "DOWNLOAD_CHUNK_SIZE",
]


# ===========================================================================
# Job models (the poll contract — field-for-field the import job shapes)
# ===========================================================================

# The import state vocabulary minus the two-phase-commit states: an export never holds an
# open transaction, so there is nothing to approve, commit, or roll back.
ExportJobState = Literal["queued", "running", "completed", "failed", "canceled"]

# A pending event as (level, code, message, context), before it is sequenced onto a job.
_EventTuple = tuple[str, str, str, Optional[Dict[str, Any]]]

_TERMINAL_STATES = frozenset({"completed", "failed", "canceled"})

# Pipeline stages in run order, with the percent the job reports while the stage runs.
# ``finalizing`` percent is implicit (100 on completion).
_STAGE_PERCENT = {
    "loading-source": 10,
    "analyzing-fidelity": 30,
    "emitting": 55,
    "validating": 75,
    "packaging": 90,
}
_STAGES: List[str] = list(_STAGE_PERCENT)


class ExportJobEvent(BaseModel):
    """Structured log line from an export job (same shape as an import job event)."""

    model_config = ConfigDict(extra="allow")

    id: str
    ts: int
    level: Literal["info", "warn", "error"]
    code: str
    message: str
    context: Optional[Dict[str, Any]] = None


class ExportJobProgress(BaseModel):
    """Coarse-grained progress snapshot (mirrors the import job's progress shape)."""

    model_config = ConfigDict(extra="forbid")

    phase: Literal[
        "loading-source",
        "analyzing-fidelity",
        "emitting",
        "validating",
        "packaging",
    ]
    total: int = Field(description="Total pipeline stages for this job.")
    completed: int = Field(description="Stages finished so far.")
    current_item: Optional[str] = Field(
        default=None, description="Human hint for the stage (e.g. the target key)."
    )


class ExportJobStartRequest(BaseModel):
    """Submit an export job: source coordinates + target + options + dry-run flag.

    The source half matches ``POST /export/preview`` / ``POST /export/document``
    (MFX-2.5/11.5); ``dry_run`` selects the preview-only path (fidelity report, no
    artifact), the async twin of the synchronous ``/export/preview`` endpoint.
    """

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id to export.")
    version: Optional[str] = Field(
        default=None,
        description="Revision UUID, version label (``1.0.0``), or null for the latest revision.",
    )
    target: str = Field(
        description="Target emitter key (``openapi``) or format key (``openapi-3.1``).",
    )
    options: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Per-target emit options (MFX-1.4); null or empty applies the target defaults.",
    )
    dry_run: bool = Field(
        default=False,
        description="When true, stop after the fidelity report: no artifact is emitted.",
    )
    confirm: bool = Field(
        default=False,
        description="When true, proceed with a **severe** conversion (MFX-3.3) the transcoding "
        "guard would otherwise fail the job on. Ignored for non-severe conversions and dry-runs.",
    )
    acknowledged_snapshot: Optional[str] = Field(
        default=None,
        description="The projection snapshot hash (``fidelity.projection.manifest_hash``) the "
        "caller previewed and acknowledged (EFP-2.1). When set, the job recomputes the snapshot "
        "for its actual inputs and **fails with `STALE_PREVIEW`** if the hashes differ — the "
        "source revision, options, emitter version, or registry changed since the preview, so "
        "the acknowledgement no longer describes what would be generated. Null skips the check.",
    )
    min_severity: LossinessSeverity = Field(
        default=LossinessSeverity.INFO,
        description="Lowest loss severity that raises the advisory (MFX-2.4); does not affect "
        "the report or counts.",
    )


class ExportJobFile(BaseModel):
    """One emitted file's manifest entry — metadata only, never the content.

    The delivery epics (MFX-4.x) serve the bytes; the job result carries just enough
    for a caller to show what was produced and how large it is.
    """

    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="Relative path within the output bundle.")
    media_type: Optional[str] = Field(
        default=None, description="The file's media type when it differs from the bundle default."
    )
    size_bytes: int = Field(description="Serialized size of the file's content in bytes.")
    subject: Optional[str] = Field(
        default=None,
        description="Schema Registry subject when the target assigns one (e.g. Avro).",
    )


class ExportJobResult(BaseModel):
    """What a terminal ``completed`` export job produced.

    Carries the resolved source coordinates, the resolved target, the full
    :class:`~app.export_fidelity.ExportFidelity` envelope (identical to a ``/export/preview``
    of the same inputs), and — for a real (non-dry-run) export — the emitted file manifest.
    """

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id the job exported.")
    version_record_id: str = Field(description="The resolved revision (``versions.id``).")
    version_label: Optional[str] = Field(
        default=None, description="The resolved revision's version label (e.g. ``1.0.0``)."
    )
    target: str = Field(description="The resolved target format key (e.g. ``openapi-3.1``).")
    dry_run: bool = Field(description="True when the job stopped after the fidelity report.")
    snapshot_hash: str = Field(
        default="",
        description="The projection snapshot hash this job computed (EFP-2.1) — the same "
        "``fidelity.projection.manifest_hash`` a preview/verify of identical inputs returns. "
        "Recorded so the completed job is attributable to one exact snapshot.",
    )
    options: Optional[Dict[str, Any]] = Field(
        default=None,
        description="The per-target emit options the job was submitted with (EFP-2.1) — the "
        "configuration half of the snapshot record; null when the target defaults applied.",
    )
    fidelity: ExportFidelity = Field(
        description="The full fidelity envelope (target + tier + report + advisory).",
    )
    guard: TranscodeGuard = Field(
        description="The pre-flight transcoding guard (MFX-3.3): the conversion band and why. "
        "A severe conversion only completes when it was submitted with ``confirm``.",
    )
    validation: Optional[EmittedValidationReport] = Field(
        default=None,
        description="The emitted-artifact validation gate + report (MFX-5.3). Set on a "
        "completed real export after the MFX-5.1 re-parse; null for a dry-run (no artifact).",
    )
    files: List[ExportJobFile] = Field(
        default_factory=list,
        description="Manifest of emitted files; empty for a dry-run.",
    )
    media_type: Optional[str] = Field(
        default=None,
        description="The bundle's primary media type; null for a dry-run.",
    )
    download_path: Optional[str] = Field(
        default=None,
        description="Relative URL a poller dereferences to fetch the emitted artifact "
        "bundle (served by the delivery epics, MFX-4.x). Set once a real export completes; "
        "null for a dry-run (no artifact was emitted).",
    )
    download_expires_at: Optional[int] = Field(
        default=None,
        description="Epoch-ms deadline after which the retained artifact is dropped and the "
        "download route returns 410 (MFX-4.3, temp artifact retention). Null for a dry-run "
        "(no artifact) or when retention is disabled (retained for the process lifetime).",
    )


class ExportJobError(BaseModel):
    """Structured terminal error for a ``failed`` export job (MFX-3.4).

    The machine-readable twin of a job's terminal error event: a poller shows ``message``
    and branches on ``code`` (e.g. distinguish ``TRANSCODE_CONFIRMATION_REQUIRED`` — resubmit
    with ``confirm`` — from ``SOURCE_LOAD_FAILED``) without scraping the free-form event log.
    """

    model_config = ConfigDict(extra="forbid")

    code: str = Field(description="Stable error code (same code as the terminal error event).")
    message: str = Field(description="Human-readable failure description.")
    context: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Structured detail (e.g. an upstream ``status_code`` or guard reasons).",
    )


class ExportJobStatus(BaseModel):
    """Poll payload for an export job (same shape as the import job status).

    A terminal job is self-describing: ``completed`` carries ``result`` (with a
    ``download_path`` for a real export), ``failed`` carries a structured ``error`` (MFX-3.4).
    """

    job_id: str
    state: ExportJobState
    percent: int = Field(0, ge=0, le=100)
    events: List[ExportJobEvent] = Field(default_factory=list)
    progress: Optional[ExportJobProgress] = None
    result: Optional[ExportJobResult] = None
    error: Optional[ExportJobError] = Field(
        default=None,
        description="Structured failure detail; set only in the ``failed`` terminal state.",
    )


class ExportJobListItem(BaseModel):
    """Summary row for GET …/jobs (no event log, no full fidelity envelope)."""

    model_config = ConfigDict(extra="forbid")

    job_id: str
    state: ExportJobState
    percent: int = Field(0, ge=0, le=100)
    status_path: str = Field(description="Relative URL for GET …/jobs/{job_id}.")
    artifact: str = Field(description="The artifact (project) id being exported.")
    target: str = Field(description="The requested target (as submitted).")
    dry_run: bool = Field(description="True when the job is a fidelity-only dry-run.")
    progress: Optional[ExportJobProgress] = None


class ExportJobListResponse(BaseModel):
    """Paginated tenant-scoped export jobs (IXH-6.3)."""

    model_config = ConfigDict(extra="forbid")

    jobs: List[ExportJobListItem]
    total: int = Field(0, ge=0, description="Total jobs matching the filter (not just this page).")
    limit: int = Field(50, ge=1, le=200, description="Page size applied to this response.")
    offset: int = Field(0, ge=0, description="Number of matching jobs skipped before this page.")


class ExportJobAccepted(BaseModel):
    """Returned when a job is accepted (HTTP 202) — mirrors the import acceptance."""

    job_id: str
    status_path: str = Field(
        description="Relative URL path for GET …/jobs/{job_id} until the job reaches a terminal state.",
    )


# ===========================================================================
# In-memory job store (per-process, tenant-scoped — same model as imports)
# ===========================================================================


@dataclass
class ExportDownloadArtifact:
    """The materialized bytes of an export ready to serve (MFX-4.1 / MFX-4.2).

    Produced by :func:`resolve_export_download` from a completed job's retained
    :class:`~app.emitter.EmitResult` (owner fast path) or the shared artifact store
    (IXH-6.1, any instance); the delivery route wraps it in an HTTP download response
    (content-type + ``Content-Disposition`` filename + integrity headers).

    Two shapes flow through the same dataclass:

    * a **single-file** export (MFX-4.1) — ``body`` is the serialized document *text*
      (UTF-8 encodable), byte-identical to what the job manifest's ``size_bytes`` measured,
      served with the emitted file's media type;
    * a **multi-file** export (MFX-4.2) — ``body`` is the ``application/zip`` *bytes* of a
      bundle carrying every emitted file plus a ``manifest.json``, served with a ``.zip``
      filename.

    Attributes:
        filename: The download filename (a single file's basename, or ``<target>.zip``).
        media_type: The response content type (the file's, the bundle's, ``application/zip``,
            or a default).
        body: The response payload — serialized document ``str`` (single file) or zip
            ``bytes`` (multi-file bundle). FastAPI's ``Response`` accepts either.
        content_sha256: ``sha256:<hex>`` over the exact download body bytes (IXH-6.1);
            exposed on the download response for integrity checking.
    """

    filename: str
    media_type: str
    body: Union[str, bytes]
    content_sha256: Optional[str] = None

    @property
    def content_length(self) -> int:
        """The download body's size in bytes (a ``str`` body measured as UTF-8).

        Lets the streaming delivery route advertise a ``Content-Length`` up front — a
        chunked :class:`~fastapi.responses.StreamingResponse` otherwise sends none, so a
        client could not show download progress for a large bundle (MFX-4.3).
        """
        body = self.body
        return len(body.encode("utf-8")) if isinstance(body, str) else len(body)


@dataclass
class _ExportJobRecord:
    """One tracked export job. Mutated only under :data:`_jobs_lock`."""

    tenant_slug: str
    tenant_id: str
    job_id: str
    state: str
    status: ExportJobStatus
    request: ExportJobStartRequest
    cancel_requested: bool = False
    # Sequence for event ids ("export-1", "export-2", …) within this job.
    event_seq: int = 0
    # The raw emit result, retained so the delivery epics (MFX-4.x) can serve the
    # emitted bytes without re-running the emitter. None until emit succeeds, and dropped
    # back to None once the retention window (below) elapses (MFX-4.3).
    emit_result: Optional[EmitResult] = None
    # Epoch-ms deadline after which the retained artifact expires and is dropped; None means
    # no expiry (retention disabled) or no artifact yet (MFX-4.3).
    artifact_expires_at_ms: Optional[int] = None
    # Snapshot + version provenance for multi-file zip manifests (EFP-3.1); set at packaging.
    bundle_provenance: Optional[Dict[str, Any]] = None


_jobs: Dict[str, _ExportJobRecord] = {}
# A *threading* lock, not an asyncio one: critical sections are short, purely synchronous
# dict/model mutations (no awaits while held), and the job store is touched from the
# caller's event loop, the engine loop (below), and worker threads alike. An asyncio.Lock
# would additionally bind to whichever event loop first contends on it.
_jobs_lock = threading.Lock()

# Kind discriminator for the shared async-job store (apiome.async_job, migration V158).
# The in-memory _jobs dict above lives only on the instance that received the POST; under a
# round-robin deployment, polls balanced to any other instance 404 without this shared mirror.
_SHARED_JOB_KIND = "export"


def _mirror_export_job(job_id: str) -> None:
    """Best-effort mirror of a job's current poll payload into the shared store.

    Called (off the lock) after each :func:`_publish` so any instance can answer GET/list from
    Postgres. Synchronous — it runs inside a ``to_thread`` worker on the engine loop's blocking
    path — and never raises: a mirror failure must not disturb the running export.
    """
    with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is None:
            return
        tenant_slug = rec.tenant_slug
        state = rec.state
        status_json = rec.status.model_dump(mode="json")
        request_json = rec.request.model_dump(mode="json")
    # List rows carry request metadata that isn't part of the poll payload; stash the fields
    # the list endpoint needs so any instance can render its rows from the shared store.
    extra = {
        "artifact": request_json.get("artifact"),
        "target": request_json.get("target"),
        "dry_run": request_json.get("dry_run"),
    }
    try:
        from .database import db

        db.upsert_async_job(
            job_id=job_id,
            kind=_SHARED_JOB_KIND,
            tenant_slug=tenant_slug,
            state=state,
            status=status_json,
            extra=extra,
        )
    except Exception:  # noqa: BLE001 - mirroring is best-effort
        logger.warning("Failed to mirror export job %s to shared store", job_id, exc_info=True)


def _sync_export_cancel_flag(job_id: str) -> None:
    """Pull a cross-instance cancel request into the in-memory record (best-effort).

    A ``DELETE …/jobs/{job_id}`` may land on an instance that does not drive the job; it sets
    ``cancel_requested`` in the shared store. The driver calls this at each :func:`_publish`
    boundary so the flag it already honors reflects the request.
    """
    try:
        from .database import db

        requested = db.async_job_cancel_requested(job_id)
    except Exception:  # noqa: BLE001 - cancel propagation is best-effort
        return
    if requested:
        with _jobs_lock:
            rec = _jobs.get(job_id)
            if rec is not None:
                rec.cancel_requested = True

# The dedicated, process-lifetime event loop that drives job pipelines. Jobs must not run
# on the submitting HTTP request's loop: a pipeline with real blocking stages outlives the
# request, and under some server/test harnesses (per-request portals) that loop is torn
# down when the response is sent, which would strand the job mid-flight. Lazily started as
# a daemon thread on first submission.
_engine_loop: Optional[asyncio.AbstractEventLoop] = None
_engine_loop_lock = threading.Lock()


def _get_engine_loop() -> asyncio.AbstractEventLoop:
    """Return the engine's own event loop, starting its daemon thread on first use."""
    global _engine_loop
    with _engine_loop_lock:
        if _engine_loop is None or _engine_loop.is_closed():
            loop = asyncio.new_event_loop()
            thread = threading.Thread(
                target=loop.run_forever, name="export-job-engine", daemon=True
            )
            thread.start()
            _engine_loop = loop
        return _engine_loop


def _now_ms() -> int:
    """Current wall-clock time in epoch milliseconds (event timestamps)."""
    return int(time.time() * 1000)


def _artifact_expiry_from(now_ms: int) -> Optional[int]:
    """The retention deadline for an artifact retained at ``now_ms`` (MFX-4.3).

    Reads ``export_artifact_retention_hours`` at call time so a config change (or a test
    override) takes effect on the next completed job. A non-positive setting disables expiry
    (the artifact is kept for the process lifetime), signalled by ``None``.

    Args:
        now_ms: The epoch-ms instant the artifact became available.

    Returns:
        The epoch-ms deadline after which the artifact expires, or ``None`` when retention
        is disabled.
    """
    hours = settings.export_artifact_retention_hours
    if hours <= 0:
        return None
    return now_ms + hours * 3_600_000


def _expire_stale_artifacts(now_ms: int) -> None:
    """Drop every retained emit result whose retention window has elapsed. Call under lock.

    A lazy reaper (MFX-4.3): rather than run a background thread, each download resolve sweeps
    the store so expired artifacts free their memory even if their own job is never polled
    again. A record keeps its metadata (status, manifest) — only the heavy retained bytes go.
    """
    for rec in _jobs.values():
        exp = rec.artifact_expires_at_ms
        if exp is not None and rec.emit_result is not None and now_ms >= exp:
            rec.emit_result = None


def _next_event(rec: _ExportJobRecord, level: str, code: str, message: str,
                context: Optional[Dict[str, Any]] = None) -> ExportJobEvent:
    """Build the next sequenced event for ``rec``. Call under :data:`_jobs_lock`."""
    rec.event_seq += 1
    return ExportJobEvent(
        id=f"export-{rec.event_seq}",
        ts=_now_ms(),
        level=level,  # type: ignore[arg-type]
        code=code,
        message=message,
        context=context,
    )


def _log_event(job_id: str, event: ExportJobEvent) -> None:
    """Mirror a job event into the REST log at its level (like import event logging)."""
    line = f"export job={job_id} [{event.code}] {event.message}"
    if event.level == "error":
        logger.error(line)
    elif event.level == "warn":
        logger.warning(line)
    else:
        logger.info(line)


async def _publish(
    job_id: str,
    *,
    state: Optional[str] = None,
    percent: Optional[int] = None,
    stage: Optional[str] = None,
    event: Optional[_EventTuple] = None,
    result: Optional[ExportJobResult] = None,
    error: Optional[ExportJobError] = None,
) -> bool:
    """Apply one snapshot update to the job record; return False if the job is gone/canceled.

    ``event`` is ``(level, code, message, context)``; ``stage`` updates the progress
    snapshot (its position in :data:`_STAGES` gives total/completed); ``error`` attaches the
    structured terminal failure (MFX-3.4). A job whose cancel flag is set is finalized to
    ``canceled`` here — the single stage-boundary cancel point.
    """
    # Honor a cross-instance cancel request before applying this snapshot.
    await asyncio.to_thread(_sync_export_cancel_flag, job_id)
    logged: Optional[ExportJobEvent] = None
    canceled = False
    with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is None:
            return False
        if rec.cancel_requested and rec.state not in _TERMINAL_STATES:
            rec.state = "canceled"
            rec.status = ExportJobStatus(
                job_id=job_id,
                state="canceled",
                percent=rec.status.percent,
                events=rec.status.events,
                progress=rec.status.progress,
            )
            canceled = True
        else:
            if state is not None:
                rec.state = state
                rec.status.state = state  # type: ignore[assignment]
            if percent is not None:
                rec.status.percent = percent
            if stage is not None:
                rec.status.progress = ExportJobProgress(
                    phase=stage,  # type: ignore[arg-type]
                    total=len(_STAGES),
                    completed=_STAGES.index(stage),
                    current_item=rec.request.target,
                )
            if event is not None:
                level, code, message, context = event
                logged = _next_event(rec, level, code, message, context)
                rec.status.events.append(logged)
            if result is not None:
                rec.status.result = result
            if error is not None:
                rec.status.error = error
    # Log outside the lock (logging handlers can block).
    if logged is not None:
        _log_event(job_id, logged)
    # Mirror the new snapshot to the shared store so any instance can serve polls.
    await asyncio.to_thread(_mirror_export_job, job_id)
    return not canceled


async def _fail(job_id: str, code: str, message: str,
                context: Optional[Dict[str, Any]] = None) -> None:
    """Move a job to ``failed`` with one terminal error event and structured error (MFX-3.4).

    The same ``(code, message, context)`` is recorded twice — as an ``error``-level event on
    the log and as the structured :class:`ExportJobError` on ``status.error`` — so a poller
    can render the failure from either surface.
    """
    await _publish(
        job_id,
        state="failed",
        event=("error", code, message, context),
        error=ExportJobError(code=code, message=message, context=context),
    )


# ===========================================================================
# EPIC seams (replaced/extended by later roadmap tickets)
# ===========================================================================


def build_validation_events(validation: EmittedArtifactValidation) -> List[_EventTuple]:
    """Translate a **non-failing** emitted-artifact validation into job event tuples (MFX-5.1).

    The failing case (a validator ran and rejected the artifact) is handled by the pipeline as
    a terminal ``EMITTED_ARTIFACT_INVALID`` failure, never here. This builds the log line for
    the three cases the job survives:

    * **passed** — the artifact re-parsed cleanly through its matching MFI import parser;
    * **skipped** — a matching parser exists but its toolchain was unavailable, so the artifact
      was not re-validated (a ``warn``: the export ships without this guarantee);
    * **not applicable** — no importer matches the format (the sample no-op target).

    Args:
        validation: A validation whose :attr:`~app.export_validation.EmittedArtifactValidation.failed`
            is ``False``.

    Returns:
        A single event tuple ``(level, code, message, context)`` for the job's event log.
    """
    target = validation.target
    if not validation.applicable:
        return [(
            "info",
            "VALIDATION_NOT_APPLICABLE",
            validation.detail
            or f"No import parser matches the {target!r} target; the artifact was not re-validated.",
            {"target": target},
        )]
    if not validation.validated:
        return [(
            "warn",
            "VALIDATION_SKIPPED",
            validation.detail
            or f"The emitted {target!r} artifact could not be re-validated in this runtime.",
            {"target": target},
        )]
    return [(
        "info",
        "ARTIFACT_VALIDATED",
        f"The emitted {target!r} artifact re-parsed cleanly through its matching import parser.",
        {"target": target},
    )]


def serialize_file_content(content: Any) -> str:
    """Serialize one emitted file's content to its canonical download string form.

    A structured (``dict``) document is pretty-printed JSON (two-space indent, non-ASCII
    preserved); any other payload (plain text such as a ``.proto`` or GraphQL SDL) is its
    verbatim string form. This is the single source of truth for the emitted bytes: both the
    manifest's :func:`_serialized_size` and the single-file download (MFX-4.1) go through it,
    so the byte count a poller reads in the manifest matches the bytes the download serves.

    Args:
        content: An :class:`~app.emitter.EmittedFile` ``content`` value.

    Returns:
        The serialized document as a string, ready to be UTF-8 encoded for the wire.
    """
    if isinstance(content, dict):
        return json.dumps(content, indent=2, ensure_ascii=False)
    return str(content)


def _serialized_size(content: Any) -> int:
    """Byte size of an emitted file's content as it would be serialized for download."""
    return len(serialize_file_content(content).encode("utf-8"))


def build_result_manifest(result: EmitResult) -> List[ExportJobFile]:
    """Packaging seam (MFX-EPIC-4): reduce an emit result to a download manifest.

    MFX-4.1/4.2 add single-file download and zip bundling on top of the retained
    :class:`~app.emitter.EmitResult`; the job result itself carries only this metadata
    manifest so poll payloads stay small.

    Args:
        result: The emitter's output bundle.

    Returns:
        One :class:`ExportJobFile` per emitted file, in the emitter's (path-sorted) order.
    """
    return [
        ExportJobFile(
            path=f.path,
            media_type=f.media_type,
            size_bytes=_serialized_size(f.content),
            subject=f.subject,
        )
        for f in result.files
    ]


# The media type and in-bundle manifest name for a multi-file zip delivery (MFX-4.2).
BUNDLE_MEDIA_TYPE = "application/zip"
_BUNDLE_MANIFEST_NAME = "manifest.json"
# A fixed DOS epoch for every zip entry's timestamp so the same emit result always packages
# to byte-identical bundle bytes (zip stores an mtime per entry; without pinning it the
# bundle would differ on every call). 1980-01-01 is the earliest a DOS timestamp can encode.
_ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)


def _bundle_manifest_name(result: EmitResult) -> str:
    """The manifest filename to use inside the zip, disambiguated from emitted paths.

    Emitters do not emit a ``manifest.json`` today, but a target could in principle claim
    that path; rather than let the manifest overwrite (or be overwritten by) an emitted
    file, pick a deterministic non-colliding name.
    """
    taken = {f.path for f in result.files}
    if _BUNDLE_MANIFEST_NAME not in taken:
        return _BUNDLE_MANIFEST_NAME
    candidate = "export-manifest.json"
    counter = 1
    while candidate in taken:
        counter += 1
        candidate = f"export-manifest-{counter}.json"
    return candidate


def build_bundle_manifest(
    result: EmitResult,
    target_format: str,
    *,
    manifest_name: str = _BUNDLE_MANIFEST_NAME,
    provenance: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build the ``manifest.json`` document embedded at the root of a zip bundle (MFX-4.2).

    A machine-readable table of contents for the bundle: the resolved target, the bundle's
    primary media type, and one entry per emitted file (path, media type, serialized size,
    Schema Registry subject) — the same per-file metadata the job's poll manifest carries
    (:func:`build_result_manifest`), so a consumer sees identical file facts whether it reads
    the job status or unzips the bundle. The manifest describes the *emitted* files only; it
    never lists itself.

    When ``provenance`` is set (EFP-3.1), the manifest also records the projection snapshot
    hash and the minimum auditable version metadata (emitter/registry/apiome versions, source
    revision, options) that produced the bundle — without retaining unredacted source content.

    Args:
        result: The emitter's output bundle.
        target_format: The resolved target format key (e.g. ``protobuf-3``).
        manifest_name: The manifest's own filename within the bundle (recorded so a reader
            knows which entry to skip); defaults to ``manifest.json``.
        provenance: Optional snapshot + version provenance block for the export job.

    Returns:
        The manifest as a JSON-serializable dict.
    """
    files = build_result_manifest(result)
    manifest: Dict[str, Any] = {
        "target": target_format,
        "media_type": result.media_type,
        "manifest": manifest_name,
        "file_count": len(files),
        "files": [f.model_dump() for f in files],
    }
    if provenance:
        manifest["provenance"] = provenance
    return manifest


def _write_zip_entry(archive: zipfile.ZipFile, name: str, text: str) -> None:
    """Write one UTF-8 text entry to ``archive`` with a pinned timestamp (deterministic bytes)."""
    info = zipfile.ZipInfo(filename=name, date_time=_ZIP_EPOCH)
    info.compress_type = zipfile.ZIP_DEFLATED
    # 0o644 (rw-r--r--) in the high 16 bits, the conventional Unix mode for a zip entry.
    info.external_attr = 0o644 << 16
    archive.writestr(info, text.encode("utf-8"))


def build_export_zip(
    result: EmitResult,
    target_format: str,
    *,
    provenance: Optional[Dict[str, Any]] = None,
) -> bytes:
    """Package a multi-file emit result into a deterministic zip bundle (MFX-4.2).

    The bundle carries every emitted file at its bundle-relative path — each serialized by
    :func:`serialize_file_content`, so its bytes match the size the manifest reported — plus a
    root ``manifest.json`` table of contents (:func:`build_bundle_manifest`). Entries are
    written in the emitter's (path-sorted) order with a pinned timestamp, so the same emit
    result always packages to byte-identical bundle bytes.

    Args:
        result: The emitter's output bundle (typically multi-file, but valid for one file too).
        target_format: The resolved target format key, recorded in the manifest.
        provenance: Optional snapshot + version provenance for the bundle manifest (EFP-3.1).

    Returns:
        The zip archive as raw bytes, ready to serve as ``application/zip``.
    """
    manifest_name = _bundle_manifest_name(result)
    manifest = build_bundle_manifest(
        result, target_format, manifest_name=manifest_name, provenance=provenance
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for emitted in result.files:
            _write_zip_entry(archive, emitted.path, serialize_file_content(emitted.content))
        _write_zip_entry(
            archive, manifest_name, json.dumps(manifest, indent=2, ensure_ascii=False)
        )
    return buffer.getvalue()


def _bundle_filename(target_format: str) -> str:
    """The download filename for a zip bundle, derived from the resolved target format."""
    stem = _download_filename(target_format)
    if stem == "document":  # _download_filename's fallback when the input is unusable
        stem = "export"
    return f"{stem}.zip"


# ===========================================================================
# Pipeline
# ===========================================================================


async def _drive_export_job(job_id: str) -> None:
    """Run one export job through the pipeline, publishing progress after each stage.

    Every blocking stage (DB-backed source load, fidelity walk, emit) runs in a worker
    thread; the cancel flag is honoured at each stage boundary via :func:`_publish`.
    Any fault is converted to a terminal ``failed`` status — this task never raises.
    """
    with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is None:
            return
        request = rec.request
        tenant_id = rec.tenant_id
        tenant_slug = rec.tenant_slug

    try:
        if not await _publish(
            job_id,
            state="running",
            percent=_STAGE_PERCENT["loading-source"],
            stage="loading-source",
            event=(
                "info",
                "EXPORT_STARTED",
                f"Export to {request.target!r} started"
                + (" (dry-run: fidelity report only)" if request.dry_run else ""),
                {"artifact": request.artifact, "target": request.target,
                 "dry_run": request.dry_run},
            ),
        ):
            return

        # --- Stage 1: load the source canonical model (DB-bound) -------------------
        try:
            source: ExportSource = await asyncio.to_thread(
                load_export_source, tenant_id, request.artifact, request.version
            )
        except ExportSourceError as exc:
            await _fail(job_id, "SOURCE_LOAD_FAILED", str(exc),
                        {"status_code": exc.status_code})
            return

        if not await _publish(
            job_id,
            percent=_STAGE_PERCENT["analyzing-fidelity"],
            stage="analyzing-fidelity",
            event=(
                "info",
                "SOURCE_LOADED",
                f"Loaded revision {source.version_record_id} "
                f"(version {source.version_label or 'latest'}) of artifact {source.artifact_id}",
                {"version_record_id": source.version_record_id,
                 "version_label": source.version_label},
            ),
        ):
            return

        # --- Stage 2: fidelity envelope (pure CPU; same builder as /export/preview) -
        try:
            emitter_cls = type(resolve_emitter(request.target))
            target_format = resolve_emit_format(request.target)
        except ExportError as exc:
            # The submit path validates the target, but the registry is re-consulted
            # here; a mid-flight registry change must fail the job, not crash the task.
            await _fail(job_id, "UNSUPPORTED_TARGET", str(exc),
                        {"status_code": exc.status_code})
            return

        fidelity: ExportFidelity = await asyncio.to_thread(
            build_export_fidelity,
            source.api,
            emitter_cls,
            min_severity=request.min_severity,
            options=request.options,
        )
        # --- Stale-acknowledgement gate (EFP-2.1) ------------------------------------
        # The snapshot hash folds source content, target, normalized options, and the
        # emitter/registry versions; if the caller acknowledged a different snapshot than
        # the one these inputs produce, the acknowledgement no longer describes what would
        # be generated — reject with a structured error so the caller re-previews.
        snapshot_hash = fidelity.projection.manifest_hash
        if (
            request.acknowledged_snapshot is not None
            and request.acknowledged_snapshot != snapshot_hash
        ):
            projection_telemetry.record("stale_acknowledgement")
            await _fail(
                job_id,
                "STALE_PREVIEW",
                "The acknowledged preview snapshot no longer matches this export's inputs "
                "(the source revision, options, emitter, or capability registry changed). "
                "Request a new preview and acknowledge the current snapshot.",
                {
                    "acknowledged_snapshot": request.acknowledged_snapshot,
                    "current_snapshot": snapshot_hash,
                },
            )
            return

        # Classify the conversion off the envelope's report (MFX-3.3), so the job's guard and
        # the /preview guard agree and the pre-flight gate can refuse a severe conversion.
        guard: TranscodeGuard = classify_transcode(
            source.api, emitter_cls, report=fidelity.report
        )

        if not await _publish(
            job_id,
            event=(
                "info",
                "FIDELITY_COMPUTED",
                f"Fidelity: {fidelity.summary.tier.value}, "
                f"{fidelity.summary.preserved_percent}% preserved "
                f"({fidelity.summary.total} constructs); transcode guard: {guard.verdict.value}",
                {"tier": fidelity.summary.tier.value,
                 "preserved_percent": fidelity.summary.preserved_percent,
                 "guard": guard.verdict.value},
            ),
        ):
            return

        # --- Dry-run gate: report only, no artifact ---------------------------------
        if request.dry_run:
            result = ExportJobResult(
                artifact=source.artifact_id,
                version_record_id=source.version_record_id,
                version_label=source.version_label,
                target=target_format,
                dry_run=True,
                snapshot_hash=snapshot_hash,
                options=request.options,
                fidelity=fidelity,
                guard=guard,
                files=[],
                media_type=None,
            )
            await _publish(
                job_id,
                state="completed",
                percent=100,
                result=result,
                event=("info", "DRY_RUN_COMPLETED",
                       "Dry-run finished: fidelity report attached, no artifact emitted.",
                       None),
            )
            return

        # --- Transcode guard gate (MFX-3.3): a severe conversion needs explicit confirmation ---
        if guard.requires_confirmation and not request.confirm:
            await _fail(
                job_id,
                "TRANSCODE_CONFIRMATION_REQUIRED",
                guard.message,
                {"verdict": guard.verdict.value,
                 "reasons": guard.reasons,
                 "preserved_percent": guard.preserved_percent},
            )
            return

        # --- Stage 3: emit through the Emitter SPI ----------------------------------
        if not await _publish(job_id, percent=_STAGE_PERCENT["emitting"], stage="emitting"):
            return
        try:
            emit_result: EmitResult = await asyncio.to_thread(
                emit_canonical,
                source.api,
                request.target,
                opts=request.options,
                persistence=ExportPersistenceContext(
                    tenant_id=tenant_id, artifact_id=source.artifact_id
                ),
            )
        except ExportError as exc:
            await _fail(job_id, "EMIT_FAILED", str(exc), {"status_code": exc.status_code})
            return

        if not emit_result.files:
            await _fail(
                job_id,
                "EMPTY_EMIT",
                f"Target {request.target!r} produced no document for this source.",
                None,
            )
            return

        if not await _publish(
            job_id,
            percent=_STAGE_PERCENT["validating"],
            stage="validating",
            event=("info", "EMITTED",
                   f"Emitted {len(emit_result.files)} file(s)",
                   {"files": [f.path for f in emit_result.files]}),
        ):
            return

        # --- Stage 4: validate the emitted artifact (MFX-5.1) -----------------------
        # Feed the emitted output back through its matching MFI import parser: a buggy emitter
        # that produced illegal output is caught here and fails the job before delivery. A
        # format whose parser needs an unavailable toolchain is reported skipped (not failed).
        validation = await validate_emitted_artifact(target_format, emit_result, api=source.api)
        validation_report = build_validation_report(validation)
        if validation_report.blocks_delivery:
            findings_payload = [f.model_dump(exclude_none=True) for f in validation_report.findings]
            await _fail(
                job_id,
                "EMITTED_ARTIFACT_INVALID",
                validation_report.message,
                {
                    "target": target_format,
                    "errors": validation.errors,
                    "findings": findings_payload,
                    "validation": validation_report.model_dump(exclude_none=True),
                },
            )
            return
        for level, code, message, context in build_validation_events(validation):
            if not await _publish(job_id, event=(level, code, message, context)):
                return

        # --- Stage 5: packaging seam (MFX-EPIC-4) -----------------------------------
        if not await _publish(job_id, percent=_STAGE_PERCENT["packaging"], stage="packaging"):
            return
        manifest = build_result_manifest(emit_result)
        bundle_provenance = {
            "snapshot_hash": snapshot_hash,
            "version_record_id": source.version_record_id,
            "version_label": source.version_label,
            "options": request.options,
            "emitter_version": fidelity.projection.target.emitter_version,
            "registry_version": fidelity.projection.target.registry_version,
            "apiome_version": fidelity.projection.target.apiome_version,
        }

        # Retain the artifact under a temp-retention window (MFX-4.3): compute the expiry once
        # so the record and the poller-facing result advertise the same deadline.
        artifact_expires_at = _artifact_expiry_from(_now_ms())

        # Materialize delivery bytes and persist to the shared artifact store (IXH-6.1) so a
        # non-owning instance can serve the download. Fail the job on size-cap / store errors
        # rather than completing with an undeliverable artifact.
        try:
            download = _materialize_download_artifact(
                emit_result,
                target_format=target_format,
                bundle_provenance=bundle_provenance,
            )
            from .export_artifact_store import (
                ExportArtifactStoreNotConfigured,
                ExportArtifactTooLarge,
                body_as_bytes,
                put_export_artifact,
            )

            stored = await asyncio.to_thread(
                put_export_artifact,
                job_id=job_id,
                tenant_slug=tenant_slug,
                body=body_as_bytes(download.body),
                media_type=download.media_type,
                filename=download.filename,
                expires_at_ms=artifact_expires_at,
            )
            download.content_sha256 = stored.content_sha256
        except ExportArtifactTooLarge as exc:
            await _fail(
                job_id,
                "EXPORT_ARTIFACT_TOO_LARGE",
                str(exc),
                {"size_bytes": exc.size_bytes, "max_bytes": exc.max_bytes},
            )
            return
        except ExportArtifactStoreNotConfigured as exc:
            await _fail(
                job_id,
                "EXPORT_ARTIFACT_STORE_UNAVAILABLE",
                str(exc),
                {"size_bytes": exc.size_bytes, "db_max_bytes": exc.db_max_bytes},
            )
            return
        except Exception as exc:  # noqa: BLE001 - persist failure must fail the job, not hang
            logger.exception("Failed to persist export artifact job=%s", job_id)
            await _fail(
                job_id,
                "EXPORT_ARTIFACT_PERSIST_FAILED",
                f"Failed to persist the export artifact for download: {exc}",
                None,
            )
            return

        result = ExportJobResult(
            artifact=source.artifact_id,
            version_record_id=source.version_record_id,
            version_label=source.version_label,
            target=target_format,
            dry_run=False,
            snapshot_hash=snapshot_hash,
            options=request.options,
            fidelity=fidelity,
            guard=guard,
            validation=validation_report,
            files=manifest,
            media_type=emit_result.media_type,
            download_path=_download_path(tenant_slug, job_id),
            download_expires_at=artifact_expires_at,
        )

        with _jobs_lock:
            rec = _jobs.get(job_id)
            if rec is not None:
                rec.emit_result = emit_result
                rec.artifact_expires_at_ms = artifact_expires_at
                rec.bundle_provenance = bundle_provenance

        await _publish(
            job_id,
            state="completed",
            percent=100,
            result=result,
            event=("info", "EXPORT_COMPLETED",
                   f"Export to {target_format!r} completed "
                   f"({len(manifest)} file(s), {sum(f.size_bytes for f in manifest)} bytes)",
                   None),
        )
    except Exception as exc:  # noqa: BLE001 - a background task must never raise
        logger.exception("export job crashed job=%s", job_id)
        await _fail(job_id, "EXPORT_EXCEPTION", str(exc), None)


# ===========================================================================
# Public engine API (mirrors the spec-import engine's surface)
# ===========================================================================


def _get_record_locked(tenant_slug: str, job_id: str) -> _ExportJobRecord:
    """Look up a job scoped to the tenant while :data:`_jobs_lock` is held."""
    rec = _jobs.get(job_id)
    if rec is None or rec.tenant_slug != tenant_slug:
        raise HTTPException(status_code=404, detail="Export job not found")
    return rec


def _get_record(tenant_slug: str, job_id: str) -> _ExportJobRecord:
    """Look up a job scoped to the tenant; 404 when unknown or cross-tenant."""
    with _jobs_lock:
        return _get_record_locked(tenant_slug, job_id)


def _status_path(tenant_slug: str, job_id: str) -> str:
    """Relative poll URL for a job (matches the router's path layout)."""
    return f"/v1/export/{tenant_slug}/jobs/{job_id}"


def _download_path(tenant_slug: str, job_id: str) -> str:
    """Relative URL for the emitted artifact of a completed job (MFX-3.4 → MFX-4.x seam).

    The reference a poller puts on a completed job's ``result.download_path``; the delivery
    routes serve the retained bytes at this path — a single file inline (MFX-4.1) or a zip
    bundle for a multi-file target (MFX-4.2).
    """
    return f"/v1/export/{tenant_slug}/jobs/{job_id}/download"


async def schedule_export_job(
    tenant_slug: str,
    tenant_id: str,
    request: ExportJobStartRequest,
) -> ExportJobAccepted:
    """Accept an export job and start it in the background.

    The target and its options are validated **synchronously** so an unknown target or
    invalid options are rejected at submit time (400/422, matching the sibling
    ``/export/document`` route) rather than surfacing as an async failure. The source
    load — the DB-heavy part — happens inside the job.

    Args:
        tenant_slug: The tenant slug (job scoping + status path).
        tenant_id: The authenticated tenant id (scopes the source lookup).
        request: The submitted job request.

    Returns:
        The 202 acceptance payload (job id + poll path).

    Raises:
        ExportError: When the target is unknown (400) or its options are invalid (422).
    """
    # Fail fast on a bad target/options; also warms the emitter registry.
    resolve_emit_options(request.target, request.options)

    job_id = str(uuid.uuid4())
    initial = ExportJobStatus(job_id=job_id, state="queued", percent=0)
    with _jobs_lock:
        _jobs[job_id] = _ExportJobRecord(
            tenant_slug=tenant_slug,
            tenant_id=tenant_id,
            job_id=job_id,
            state="queued",
            status=initial,
            request=request,
        )
    # Mirror the initial 'queued' row before returning 202 so the first poll — which
    # round-robin may route to any instance — already finds the job in the shared store.
    await asyncio.to_thread(_mirror_export_job, job_id)
    # Run on the engine's own loop (not the request's) so the job survives the request.
    asyncio.run_coroutine_threadsafe(_drive_export_job(job_id), _get_engine_loop())
    return ExportJobAccepted(job_id=job_id, status_path=_status_path(tenant_slug, job_id))


async def get_export_job_status(tenant_slug: str, job_id: str) -> ExportJobStatus:
    """Return the current poll payload for a job (404 when unknown for this tenant).

    Fast path: this instance drives the job, so its in-memory record is authoritative and
    freshest. Otherwise (round-robin: another instance drives it) consult the shared store so
    the poll still resolves instead of 404-ing.
    """
    with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is not None and rec.tenant_slug == tenant_slug:
            return rec.status.model_copy(deep=True)
    from .database import db

    try:
        row = await asyncio.to_thread(db.get_async_job, job_id, tenant_slug, _SHARED_JOB_KIND)
    except Exception:  # noqa: BLE001 - shared store is best-effort; degrade to 404 below
        logger.warning("Failed to read export job %s from shared store", job_id, exc_info=True)
        row = None
    if row is not None:
        return ExportJobStatus.model_validate(row["status"])
    raise HTTPException(status_code=404, detail="Export job not found")


async def list_export_jobs(
    tenant_slug: str,
    *,
    limit: int = 50,
    offset: int = 0,
    state: Optional[str] = None,
    created_after: Optional[datetime] = None,
    created_before: Optional[datetime] = None,
) -> ExportJobListResponse:
    """List a tenant's export jobs from the shared store (summary rows, no event logs).

    Paginated with stable newest-first ordering (IXH-6.3). Falls back to this process's
    in-memory jobs if the shared store is unreachable (same filters/pagination applied).
    """
    from .database import db

    page_limit = max(1, min(int(limit), 200))
    page_offset = max(0, int(offset))

    def _item(st: ExportJobStatus, artifact: Any, target: Any, dry_run: Any) -> ExportJobListItem:
        return ExportJobListItem(
            job_id=st.job_id,
            state=st.state,
            percent=st.percent,
            status_path=_status_path(tenant_slug, st.job_id),
            artifact=artifact,
            target=target,
            dry_run=dry_run,
            progress=st.progress,
        )

    def _state_matches(job_state: str) -> bool:
        return state is None or not str(state).strip() or job_state == str(state).strip()

    def _created_ms(st: ExportJobStatus) -> int:
        return int(getattr(st, "created_at_ms", None) or getattr(st, "updated_at_ms", None) or 0)

    try:
        page = await asyncio.to_thread(
            lambda: db.list_async_jobs(
                tenant_slug,
                _SHARED_JOB_KIND,
                limit=page_limit,
                offset=page_offset,
                state=state,
                created_after=created_after,
                created_before=created_before,
            )
        )
    except Exception:  # noqa: BLE001 - shared store is best-effort; degrade to local view
        logger.warning("Falling back to in-memory export job list for %s", tenant_slug, exc_info=True)
        with _jobs_lock:
            local = [
                (r.status, r.request.artifact, r.request.target, r.request.dry_run)
                for r in _jobs.values()
                if r.tenant_slug == tenant_slug and _state_matches(r.status.state)
            ]
        local.sort(key=lambda t: (_created_ms(t[0]), t[0].job_id), reverse=True)
        total = len(local)
        slice_rows = local[page_offset : page_offset + page_limit]
        return ExportJobListResponse(
            jobs=[_item(st, a, t, d) for (st, a, t, d) in slice_rows],
            total=total,
            limit=page_limit,
            offset=page_offset,
        )
    items: List[ExportJobListItem] = []
    for row in page["jobs"]:
        st = ExportJobStatus.model_validate(row["status"])
        extra = row.get("extra") or {}
        items.append(_item(st, extra.get("artifact"), extra.get("target"), extra.get("dry_run")))
    return ExportJobListResponse(
        jobs=items,
        total=int(page["total"]),
        limit=int(page["limit"]),
        offset=int(page["offset"]),
    )


async def cancel_export_job(tenant_slug: str, job_id: str) -> None:
    """Request cancellation of a job; a no-op when it is already terminal.

    Sets the shared cancel flag so the driving instance (possibly a different process) honours
    it at its next stage boundary — an in-flight blocking stage (source load / emit) finishes
    its thread first, then the job finalizes to ``canceled`` without further progress or result.
    If this instance owns the job, the flag is also set locally for the immediate next boundary.
    """
    from .database import db

    matched = await asyncio.to_thread(
        db.request_async_job_cancel, job_id, tenant_slug, _SHARED_JOB_KIND
    )
    owned = False
    with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is not None and rec.tenant_slug == tenant_slug:
            owned = True
            if rec.state not in _TERMINAL_STATES:
                rec.cancel_requested = True
    if not matched and not owned:
        raise HTTPException(status_code=404, detail="Export job not found")


def get_export_job_emit_result(tenant_slug: str, job_id: str) -> Optional[EmitResult]:
    """The retained raw emit result for a completed job, for the delivery routes (MFX-4.x).

    Returns ``None`` while the job is running, after a failure/cancel, for a dry-run, or once
    the retention window has elapsed (MFX-4.3) — in which case the expired bytes are dropped.

    Raises:
        HTTPException: 404 when the job is unknown for this tenant.
    """
    with _jobs_lock:
        rec = _get_record_locked(tenant_slug, job_id)
        exp = rec.artifact_expires_at_ms
        if exp is not None and rec.emit_result is not None and _now_ms() >= exp:
            rec.emit_result = None
        emit_result = rec.emit_result
        return None if emit_result is None else emit_result.model_copy(deep=True)


def _download_filename(path: str) -> str:
    """Derive the download filename from an emitted file's relative path (basename only)."""
    basename = (path or "").replace("\\", "/").rsplit("/", 1)[-1]
    sanitized = basename.translate({ord('"'): None, ord("\r"): None, ord("\n"): None})
    return sanitized or "document"


def _materialize_download_artifact(
    emit_result: "EmitResult",
    *,
    target_format: str,
    bundle_provenance: Optional[Dict[str, Any]] = None,
) -> ExportDownloadArtifact:
    """Build the download filename/media_type/body from a retained EmitResult (no I/O).

    Same shape the delivery route streams: single-file serialized text, or a multi-file zip.
    """
    if len(emit_result.files) > 1:
        return ExportDownloadArtifact(
            filename=_bundle_filename(target_format),
            media_type=BUNDLE_MEDIA_TYPE,
            body=build_export_zip(emit_result, target_format, provenance=bundle_provenance),
        )

    primary = emit_result.files[0]
    default_media = "application/json" if isinstance(primary.content, dict) else "text/plain"
    return ExportDownloadArtifact(
        filename=_download_filename(primary.path),
        media_type=primary.media_type or emit_result.media_type or default_media,
        body=serialize_file_content(primary.content),
    )


def _artifact_from_local_emit(
    emit_result: "EmitResult",
    *,
    target_format: str,
    bundle_provenance: Optional[Dict[str, Any]],
) -> ExportDownloadArtifact:
    """Materialize from the owner fast path and attach a content hash."""
    from .export_artifact_store import body_as_bytes, content_sha256_hex

    artifact = _materialize_download_artifact(
        emit_result,
        target_format=target_format,
        bundle_provenance=bundle_provenance,
    )
    artifact.content_sha256 = content_sha256_hex(body_as_bytes(artifact.body))
    return artifact


def _resolve_download_from_shared_store(tenant_slug: str, job_id: str) -> ExportDownloadArtifact:
    """Serve a download from the shared artifact store + async_job status (non-owner path)."""
    from .database import db
    from .export_artifact_store import (
        ExportArtifactExpired,
        ExportArtifactNotFound,
        get_export_artifact,
    )

    try:
        row = db.get_async_job(job_id, tenant_slug, _SHARED_JOB_KIND)
    except Exception:  # noqa: BLE001 - shared store is best-effort
        logger.warning(
            "Failed to read export job %s from shared store for download", job_id, exc_info=True
        )
        row = None

    if row is None:
        raise HTTPException(status_code=404, detail="Export job not found")

    status = ExportJobStatus.model_validate(row["status"])
    state = status.state
    extra = row.get("extra") or {}
    dry_run = bool(extra.get("dry_run"))
    if status.result is not None:
        dry_run = bool(status.result.dry_run)

    if state == "completed" and dry_run:
        raise HTTPException(
            status_code=409,
            detail="This export job produced no artifact to download (dry-run).",
        )
    if state != "completed":
        raise HTTPException(
            status_code=409,
            detail=f"Export job is not downloadable in state {state!r}; "
            "no artifact has been emitted.",
        )

    try:
        record = get_export_artifact(tenant_slug, job_id)
    except ExportArtifactExpired:
        raise HTTPException(
            status_code=410,
            detail="This export artifact has expired and is no longer available for "
            "download; resubmit the export job to regenerate it.",
        ) from None
    except ExportArtifactNotFound:
        # Completed non-dry-run but no shared bytes: treat as expired/gone (410), not a bare 404.
        expires = status.result.download_expires_at if status.result else None
        if expires is not None and _now_ms() >= expires:
            raise HTTPException(
                status_code=410,
                detail="This export artifact has expired and is no longer available for "
                "download; resubmit the export job to regenerate it.",
            )
        raise HTTPException(
            status_code=409,
            detail="This export job produced no artifact to download (dry-run).",
        ) from None

    # Shared store always holds delivery bytes; serve them as bytes (single-file or zip).
    body: Union[str, bytes] = record.content or b""
    if record.media_type != BUNDLE_MEDIA_TYPE and isinstance(body, (bytes, bytearray)):
        try:
            body = body.decode("utf-8")
        except UnicodeDecodeError:
            body = bytes(body)

    return ExportDownloadArtifact(
        filename=record.filename,
        media_type=record.media_type,
        body=body,
        content_sha256=record.content_sha256,
    )


def resolve_export_download(tenant_slug: str, job_id: str) -> ExportDownloadArtifact:
    """Materialize a completed export job's artifact for download (MFX-4.1 / MFX-4.2 / IXH-6.1).

    Serves the artifact the poller was pointed at via ``result.download_path``:

    * **Owner fast path** — retained :class:`~app.emitter.EmitResult` on this process's
      ``_jobs`` record (no re-emit).
    * **Shared store** — when this instance does not own the job (round-robin), load the
      delivery payload from ``apiome.export_job_artifact`` (IXH-6.1).

    Delivery shape:

    * a **single-file** export is served inline (MFX-4.1);
    * a **multi-file** export is served as a zip bundle (MFX-4.2).

    Args:
        tenant_slug: The tenant slug the job was submitted under (scopes the lookup).
        job_id: The job id from the 202 acceptance payload.

    Returns:
        The artifact's filename, media type, body, and content hash.

    Raises:
        HTTPException: 404 when the job is unknown for this tenant; 409 when the job has no
            downloadable artifact (not completed, or a dry-run that emitted nothing); 410 when
            the artifact was emitted but its retention window has since elapsed (MFX-4.3).
    """
    with _jobs_lock:
        # Sweep the local store first so expired bytes are reclaimed even for jobs no one polls.
        now_ms = _now_ms()
        _expire_stale_artifacts(now_ms)
        rec = _jobs.get(job_id)
        if rec is not None and rec.tenant_slug == tenant_slug:
            state = rec.state
            request_dry_run = rec.request.dry_run
            emit_result = rec.emit_result
            artifact_expired = (
                rec.artifact_expires_at_ms is not None and now_ms >= rec.artifact_expires_at_ms
            )
            result_target = rec.status.result.target if rec.status.result else None
            bundle_provenance = rec.bundle_provenance
        else:
            rec = None

    if rec is not None:
        if state == "completed" and not request_dry_run and artifact_expired:
            raise HTTPException(
                status_code=410,
                detail="This export artifact has expired and is no longer available for "
                "download; resubmit the export job to regenerate it.",
            )

        if state != "completed":
            raise HTTPException(
                status_code=409,
                detail=f"Export job is not downloadable in state {state!r}; "
                "no artifact has been emitted.",
            )
        if request_dry_run or emit_result is None or not emit_result.files:
            raise HTTPException(
                status_code=409,
                detail="This export job produced no artifact to download (dry-run).",
            )

        return _artifact_from_local_emit(
            emit_result,
            target_format=result_target or "export",
            bundle_provenance=bundle_provenance,
        )

    # Non-owning instance (or job already dropped from local memory): shared store.
    return _resolve_download_from_shared_store(tenant_slug, job_id)


# The chunk size the delivery route streams a download body in (MFX-4.3). 64 KiB keeps the
# in-flight slice small for a large bundle while staying well above per-chunk overhead.
DOWNLOAD_CHUNK_SIZE = 64 * 1024


def iter_download_chunks(
    artifact: ExportDownloadArtifact, chunk_size: int = DOWNLOAD_CHUNK_SIZE
) -> Iterator[bytes]:
    """Yield an export download body as fixed-size UTF-8 byte chunks (MFX-4.3, streaming).

    The delivery route feeds this to a :class:`~fastapi.responses.StreamingResponse` so a
    large bundle is written to the socket in slices rather than handed to the response layer
    as one buffer (which would force a second full copy of the bytes). A single-file body is a
    document ``str`` (encoded here); a multi-file bundle is already zip ``bytes``. The
    concatenated chunks are byte-identical to :attr:`ExportDownloadArtifact.body`.

    Args:
        artifact: The resolved download artifact (:func:`resolve_export_download`).
        chunk_size: The maximum size of each yielded chunk in bytes; defaults to
            :data:`DOWNLOAD_CHUNK_SIZE`.

    Yields:
        Successive byte slices of the encoded body, in order. An empty body yields nothing.
    """
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    body = artifact.body
    data = body.encode("utf-8") if isinstance(body, str) else body
    for start in range(0, len(data), chunk_size):
        yield data[start:start + chunk_size]

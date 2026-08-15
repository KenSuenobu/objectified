"""
Async spec-import jobs: schedule work and run the apiome-ui tsx worker (#3329).

The worker uses incremental import mode so the open transaction is not held across
HTTP requests; commit/rollback endpoints are idempotent or return 409 when N/A.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence

from fastapi import HTTPException

from .config import settings
from .import_source import (
    ImportSource,
    available_import_sources,
    get_import_source,
    resolve_import_source_key,
)
from .import_source_pipeline import (
    ADAPTER_PHASE_EVENT_CODES,
    build_job_error,
    run_adapter_import_job,
)
from .logging_config import bind_contextvars
from .models import (
    SpecImportCommitResponse,
    SpecImportEvent,
    SpecImportJobAccepted,
    SpecImportJobListItem,
    SpecImportJobListResponse,
    SpecImportJobStatus,
    SpecImportRollbackResponse,
    SpecImportStartJsonRequest,
    SpecImportStartMetadata,
)
from .version_quality_capture import capture_version_quality_score

logger = logging.getLogger(__name__)

# Import milestone / benchmark-phase event codes surfaced at INFO so the phase timings are
# easy to follow in the REST logs as the import runs. Other (e.g. per-row DEBUG_*) events are
# logged at DEBUG. Warnings/errors are always logged regardless of code.
_IMPORT_PHASE_EVENT_CODES = frozenset(
    {
        "PHASE_TIMING",
        "BENCHMARK",
        "INCREMENTAL_MODE",
        "INIT",
        "PROJECT_CREATED",
        "EXISTING_PROJECT",
        "VERSION_CREATED",
        "CREATING_PROPERTIES",
        "PROPERTIES_READY",
        "IMPORTING_PATHS",
        "PATHS_IMPORTED",
        "PENDING_APPROVAL",
        "IMPORT_SKIPPED_NOOP",
        "DUPLICATE_VERSION_SKIPPED",
    }
    # The in-process ImportSource adapter pipeline (MFI-1.2) emits its own per-phase
    # codes; surface those at INFO too so an adapter import reads the same as a worker run.
    | ADAPTER_PHASE_EVENT_CODES
)

# Adapter keys whose imports still run on the ``apiome-ui`` ``tsx`` worker rather than
# the in-process :func:`run_adapter_import_job` pipeline. The OpenAPI/Swagger path persists a
# full catalog project/version and carries its own benchmark instrumentation, so it stays on
# the worker (and its existing tests are unchanged); every other registered source runs
# in-process. A source kind that resolves to no adapter also falls through to the worker.
_WORKER_BACKED_ADAPTER_KEYS = frozenset({"openapi"})


def _take_new_import_events(rec: "_JobRecord", status: SpecImportJobStatus) -> List[SpecImportEvent]:
    """Return import events not yet seen for this job (marking them seen). Cheap; call under lock."""
    fresh: List[SpecImportEvent] = []
    for ev in status.events or []:
        if ev.id in rec.logged_event_ids:
            continue
        rec.logged_event_ids.add(ev.id)
        fresh.append(ev)
    return fresh


def _log_import_events(events: List[SpecImportEvent], job_id: str) -> None:
    """Log streamed import events so benchmark phases are visible as the import runs.

    Phase/milestone and benchmark events go to INFO; warnings/errors to their level; the
    high-cardinality per-row DEBUG_* events go to DEBUG to keep the running log readable.

    ``PHASE_TIMING`` events additionally feed the IXH-6.6 stage metrics here — this is
    the one seam every fresh event passes exactly once (``_take_new_import_events``
    dedupes across streamed snapshots), so the worker path and the in-process adapter
    path converge on the same per-stage aggregates without double counting.
    """
    for ev in events:
        code = ev.code or ""
        line = f"spec import job={job_id} [{code}] {ev.message}"
        if ev.level == "error":
            logger.error(line)
        elif ev.level == "warn":
            logger.warning(line)
        elif code in _IMPORT_PHASE_EVENT_CODES:
            logger.info(line)
        else:
            logger.debug(line)
        if code == "PHASE_TIMING":
            _record_phase_timing_metric(ev)


def _record_phase_timing_metric(ev: SpecImportEvent) -> None:
    """Feed one ``PHASE_TIMING`` event into the stage metrics (best-effort)."""
    context = ev.context if isinstance(ev.context, dict) else None
    if not context:
        return
    try:
        duration_ms = float(context.get("ms"))
    except (TypeError, ValueError):
        return
    try:
        from .import_export_metrics import import_export_metrics

        import_export_metrics.record_stage(
            kind="import",
            stage=str(context.get("phase") or ""),
            duration_ms=duration_ms,
            outcome=str(context.get("outcome") or "completed"),
        )
    except Exception:  # noqa: BLE001 - metrics must never affect the job
        logger.debug("Failed to record import stage metric", exc_info=True)


# The capture helper lives in :mod:`app.version_quality_capture` (#5259) so revision-creating
# pushes/forks and the lint route share one implementation; the private name is kept as the
# import-engine seam (and patch target).
_capture_version_quality_score = capture_version_quality_score

_REPO_ROOT = Path(__file__).resolve().parents[3]
# Path segments relative to the ``apiome-ui`` package (yarn workspace cwd).
_WORKER_SCRIPT_UI_REL = Path("scripts") / "rest-spec-import-worker.ts"

# Override with JSON argv, e.g. ["yarn","workspace","apiome-ui","exec","tsx","scripts/rest-spec-import-worker.ts"]
_WORKER_ARGV_ENV_KEYS = ("SPEC_IMPORT_WORKER_ARGV", "APIOME_SPEC_IMPORT_WORKER_ARGV")

# asyncio subprocess StreamReader default limit is 64KiB; ``readline()`` raises
# ``ValueError: Separator is found, but chunk is longer than limit`` when one NDJSON
# line from the worker exceeds that. Large status payloads need a higher ceiling.
_DEFAULT_WORKER_STREAM_LIMIT = 256 * 1024 * 1024
_ENV_WORKER_STREAM_LIMIT_KEYS = (
    "SPEC_IMPORT_WORKER_STREAM_LIMIT",
    "APIOME_SPEC_IMPORT_WORKER_STREAM_LIMIT",
)

# Test hook: monkeypatch ``_worker_runner`` to an async callable(payload) -> dict (worker JSON).
_worker_runner: Optional[Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]]] = None


def _resolve_worker_subprocess_stream_limit() -> int:
    """Max bytes per line (excluding newline) for stdout/stderr StreamReaders."""
    for key in _ENV_WORKER_STREAM_LIMIT_KEYS:
        raw = (os.environ.get(key) or "").strip()
        if not raw:
            continue
        try:
            n = int(raw, 10)
        except ValueError:
            logger.warning("Ignoring invalid %s=%r (expected integer bytes)", key, raw)
            continue
        if n < 65536:
            logger.warning(
                "Ignoring %s=%s (below minimum 65536); using default stream limit",
                key,
                raw,
            )
            continue
        return n
    return _DEFAULT_WORKER_STREAM_LIMIT


def _parse_worker_argv_env(raw: str) -> List[str]:
    parsed = json.loads(raw)
    if not isinstance(parsed, list) or not parsed:
        raise ValueError("must be a non-empty JSON array")
    if not all(isinstance(x, str) and x for x in parsed):
        raise ValueError("must be a JSON array of non-empty strings")
    return list(parsed)


def resolve_spec_import_worker_invocation() -> tuple[List[str], Path]:
    """Argv and working directory for the UI ``tsx`` worker subprocess.

    ``FileNotFoundError`` / errno 2 from asyncio subprocess almost always means the *executable*
    (first argv element) is missing from ``PATH`` — not the uploaded spec path.

    Resolution order:

    1. ``SPEC_IMPORT_WORKER_ARGV`` or ``APIOME_SPEC_IMPORT_WORKER_ARGV`` — JSON array;
       cwd is always the monorepo root (``_REPO_ROOT``).
    2. ``yarn workspace apiome-ui exec tsx …`` from repo root if ``yarn`` is on ``PATH``.
    3. ``corepack yarn workspace …`` from repo root if ``corepack`` is on ``PATH``.
    4. ``npm exec --workspace=apiome-ui -- tsx …`` from repo root if ``npm`` is on ``PATH``.
    5. ``apiome-ui/node_modules/.bin/tsx`` if present (after ``yarn install``).
    6. Global ``tsx`` on ``PATH``, cwd ``apiome-ui/``.
    7. ``npx --yes tsx …``, cwd ``apiome-ui/``.

    If nothing matches, raises ``RuntimeError`` with remediation hints (no silent fallback to a
    missing ``yarn`` binary).
    """
    repo = _REPO_ROOT
    ui_root = repo / "apiome-ui"
    worker_rel = _WORKER_SCRIPT_UI_REL

    for key in _WORKER_ARGV_ENV_KEYS:
        raw = (os.environ.get(key) or "").strip()
        if raw:
            return _parse_worker_argv_env(raw), repo

    tail_yarn = ["workspace", "apiome-ui", "exec", "tsx", str(worker_rel)]
    candidates_repo_cwd: Sequence[List[str]] = (
        ["yarn", *tail_yarn],
        ["corepack", "yarn", *tail_yarn],
        ["npm", "exec", "--workspace=apiome-ui", "--", "tsx", str(worker_rel)],
    )
    for argv in candidates_repo_cwd:
        if shutil.which(argv[0]):
            return list(argv), repo

    local_tsx = ui_root / "node_modules" / ".bin" / "tsx"
    if local_tsx.is_file():
        return [str(local_tsx), str(worker_rel)], ui_root

    tsx_global = shutil.which("tsx")
    if tsx_global:
        return [tsx_global, str(worker_rel)], ui_root

    npx = shutil.which("npx")
    if npx:
        return [npx, "--yes", "tsx", str(worker_rel)], ui_root

    wr = worker_rel.as_posix()
    raise RuntimeError(
        "Cannot run the specification import worker: no usable Node runner found. "
        "Checked PATH for yarn, corepack, npm, tsx, and npx, and looked for "
        f"{local_tsx} (run `yarn install` at the monorepo root if this file is missing). "
        "Install Node.js + Yarn or npm on the API host, install workspace dependencies, "
        "or set SPEC_IMPORT_WORKER_ARGV (or APIOME_SPEC_IMPORT_WORKER_ARGV) to a JSON argv "
        "array whose first element is an absolute path to an executable, e.g. "
        f'["/usr/bin/yarn","workspace","apiome-ui","exec","tsx","{wr}"].'
    )


def resolve_spec_import_worker_argv() -> List[str]:
    """Argv only (cwd is ``_REPO_ROOT`` for env overrides and yarn/npm; else see invocation)."""
    argv, _cwd = resolve_spec_import_worker_invocation()
    return argv


def _format_worker_spawn_errno2_message(argv: List[str], cwd: Path, exc: OSError) -> str:
    exe = argv[0] if argv else "(empty argv)"
    return (
        f"{exc}; failed to execute {exe!r} while spawning spec import worker (cwd={cwd}). "
        "Errno 2 means the program was not found on PATH or is not executable — "
        "not your uploaded spec path. Install Node tooling on the API host, run `yarn install` "
        "at the monorepo root so apiome-ui/node_modules/.bin/tsx exists, or set "
        "SPEC_IMPORT_WORKER_ARGV to a JSON argv array whose first token is an absolute path "
        '(example: ["/usr/bin/yarn","workspace","apiome-ui","exec","tsx",'
        f'"{_WORKER_SCRIPT_UI_REL.as_posix()}"].)'
    )


@dataclass
class _JobRecord:
    tenant_slug: str
    job_id: str
    state: str
    status: SpecImportJobStatus
    proc: Optional[asyncio.subprocess.Process] = None
    cancel_requested: bool = False
    commit_response: Optional[SpecImportCommitResponse] = None
    rollback_response: Optional[SpecImportRollbackResponse] = None
    # IDs of import events already written to the REST log (dedupe across streamed snapshots).
    logged_event_ids: set = field(default_factory=set)
    # IXH-6.6: correlation id of the request that started the job (the middleware-minted
    # request id), stamped onto every stored status so pollers and log lines agree.
    correlation_id: Optional[str] = None
    # IXH-6.6: whole-job wall clock + source size for the terminal job metrics.
    started_monotonic: float = 0.0
    bytes_in: Optional[int] = None


def _set_status(
    rec: _JobRecord, status: SpecImportJobStatus, *, state: Optional[str] = None
) -> None:
    """Store a status on the record, stamping the job's correlation id (IXH-6.6).

    Statuses are rebuilt wholesale by the in-process pipeline and by the tsx worker —
    neither of which knows the REST correlation id — so the engine stamps it at the one
    place every status passes before a poller or the shared-store mirror can see it.

    Args:
        rec: The in-memory job record (caller holds ``_jobs_lock``).
        status: The new poll payload.
        state: Optional state override (e.g. ``canceled`` while the status says else).
    """
    status.correlation_id = rec.correlation_id
    if status.error is not None and not status.error.correlation_id:
        status.error.correlation_id = rec.correlation_id
    rec.state = state or status.state
    rec.status = status


_jobs: Dict[str, _JobRecord] = {}
_jobs_lock = asyncio.Lock()

# Kind discriminator for the shared async-job store (apiome.async_job, migration V158).
_SHARED_JOB_KIND = "spec_import"

# Recorded in ``async_job.extra`` when commit/rollback needs an owner-held preview transaction
# that this REST deployment does not expose (and has no sticky owner routing for).
_OWNER_RESOURCE_CONSTRAINT = "held_preview_transaction"

_PREVIEW_OWNER_CONSTRAINT_DETAIL = (
    "Preview import commit/rollback requires an owner-held resource "
    f"(constraint: {_OWNER_RESOURCE_CONSTRAINT}); this REST deployment runs incremental "
    "imports without a held-open preview transaction and does not expose sticky owner routing."
)


def _build_shared_extra(rec: _JobRecord) -> Optional[Dict[str, Any]]:
    """Assemble the per-kind ``extra`` bag for the shared store (full bag, or None).

    Passing ``None`` preserves a previously mirrored bag via COALESCE. A non-empty dict
    replaces the bag, so every field that must survive (commit/rollback payloads, owner
    constraint) is included together whenever any of them is present.
    """
    extra: Dict[str, Any] = {}
    if rec.commit_response is not None:
        extra["commit_response"] = rec.commit_response.model_dump(mode="json")
    if rec.rollback_response is not None:
        extra["rollback_response"] = rec.rollback_response.model_dump(mode="json")
    if rec.state == "pending-approval" or rec.status.state == "pending-approval":
        extra["owner_resource_constraint"] = _OWNER_RESOURCE_CONSTRAINT
    return extra or None


def _raise_preview_owner_constraint() -> None:
    """Raise the documented 501 for preview commit/rollback (never a bare 404)."""
    raise HTTPException(status_code=501, detail=_PREVIEW_OWNER_CONSTRAINT_DETAIL)


async def _mirror_job(job_id: str) -> None:
    """Best-effort mirror of a job's current poll payload into the shared store.

    Round-robin deployments poll across instances, but the in-memory ``_jobs`` dict only
    exists on the instance that received the POST; without this, pollers on the other
    instances 404. The driving instance mirrors every state change so any instance can serve
    ``GET/list`` from Postgres. Strictly best-effort — a mirror failure never affects the run;
    the in-memory record stays authoritative for the driver.
    """
    async with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is None:
            return
        tenant_slug = rec.tenant_slug
        state = rec.state
        status_json = rec.status.model_dump(mode="json")
        extra = _build_shared_extra(rec)
    # The DB call is made inline (not via ``asyncio.to_thread``): ``_drive_job`` runs on the
    # request's loop, and a thread-pool await here would orphan the background task under a
    # harness that tears the loop down between requests, stalling the job before it finalizes.
    # The write is a single indexed upsert, so the brief loop pause is acceptable.
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
        logger.warning("Failed to mirror import job %s to shared store", job_id, exc_info=True)


async def _fetch_shared_job(tenant_slug: str, job_id: str) -> Optional[Dict[str, Any]]:
    """Read a job's shared-store row, or None if it's absent or the store is unreachable.

    Used only on the non-owner read path (round-robin): a store outage degrades to a 404 for
    instances that don't hold the job locally, never to a 500.
    """
    from .database import db

    try:
        return await asyncio.to_thread(db.get_async_job, job_id, tenant_slug, _SHARED_JOB_KIND)
    except Exception:  # noqa: BLE001 - shared store is best-effort
        logger.warning("Failed to read import job %s from shared store", job_id, exc_info=True)
        return None


async def _sync_cancel_flag(job_id: str) -> None:
    """Honor a cross-instance cancel: pull the shared cancel flag into the in-memory record.

    A ``DELETE …/imports/{job_id}`` may land on an instance that does not drive the job; it
    sets ``cancel_requested`` in the shared store. The driving instance calls this at stage
    boundaries so the flag it already checks (``rec.cancel_requested``) reflects that request.
    """
    try:
        from .database import db

        # Inline DB read (not ``to_thread``) — this runs inside the background ``_drive_job``
        # pipeline; see the note in ``_mirror_job`` on why a thread-pool await must be avoided.
        requested = db.async_job_cancel_requested(job_id)
    except Exception:  # noqa: BLE001 - cancel propagation is best-effort
        return
    if requested:
        async with _jobs_lock:
            rec = _jobs.get(job_id)
            if rec is not None:
                rec.cancel_requested = True


def _build_worker_payload(
    *,
    rest_job_id: str,
    tenant_slug: str,
    tenant_id: str,
    user_id: str,
    body: SpecImportStartJsonRequest,
) -> Dict[str, Any]:
    meta = body.metadata
    return {
        "rest_job_id": rest_job_id,
        "tenant_slug": tenant_slug,
        "tenant_id": tenant_id,
        "user_id": user_id,
        "metadata": json.loads(meta.model_dump_json()),
        "document_base64": body.document_base64,
        "filename": body.filename,
        "content_type": body.content_type,
    }


def _default_result_status(
    job_id: str,
    message: str,
    code: str = "WORKER_ERROR",
    correlation_id: Optional[str] = None,
) -> SpecImportJobStatus:
    return SpecImportJobStatus(
        job_id=job_id,
        state="failed",
        percent=0,
        events=[
            {
                "id": "rest-1",
                "ts": 0,
                "level": "error",
                "code": code,
                "message": message,
                "context": None,
            }
        ],
        # IXH-1.3: every terminal failure carries a stable taxonomy code +
        # remediation, keyed off the engine's legacy event code. The request
        # correlation id (IXH-6.6) rides along when known; job id otherwise.
        error=build_job_error(code, message, correlation_id=correlation_id or job_id),
    )


def _maybe_build_commit_response(
    job_id: str, status: SpecImportJobStatus
) -> Optional[SpecImportCommitResponse]:
    if status.state != "completed":
        return None
    r = status.result
    if r is None:
        return None
    if not r.project_id or not r.project_slug or not r.version_id or not r.version_record_id:
        return None
    return SpecImportCommitResponse(
        job_id=job_id,
        state="completed",
        project_id=r.project_id,
        project_slug=r.project_slug,
        version_id=r.version_id,
        version_record_id=r.version_record_id,
    )


async def _apply_streaming_spec_import_status(job_id: str, status_raw: Dict[str, Any]) -> None:
    """Merge a worker-emitted partial status snapshot into the in-memory job record."""
    try:
        status = SpecImportJobStatus.model_validate(status_raw)
    except Exception as e:  # noqa: BLE001
        logger.debug("Ignoring invalid partial import status job=%s: %s", job_id, e)
        return
    if status.job_id != job_id:
        logger.debug("Partial import status job_id mismatch (expected %s)", job_id)
        return
    await _sync_cancel_flag(job_id)
    async with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is None or rec.cancel_requested:
            return
        _set_status(rec, status)
        fresh_events = _take_new_import_events(rec, status)
    # Log outside the lock (logging handlers can block); surfaces benchmark phases live.
    _log_import_events(fresh_events, job_id)
    await _mirror_job(job_id)


async def _run_subprocess_worker(payload: Dict[str, Any]) -> Dict[str, Any]:
    env = {**os.environ}
    db_url = os.environ.get("DATABASE_URL") or settings.effective_database_url
    env["DATABASE_URL"] = db_url

    argv, worker_cwd = resolve_spec_import_worker_invocation()
    logger.info("spec import worker spawn argv=%s cwd=%s", argv, worker_cwd)
    job_id = str(payload.get("rest_job_id", ""))
    data = json.dumps(payload).encode("utf-8")
    stderr_chunks: List[bytes] = []

    stream_limit = _resolve_worker_subprocess_stream_limit()
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(worker_cwd),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            limit=stream_limit,
        )
    except OSError as exc:
        errno = getattr(exc, "errno", None)
        if isinstance(exc, FileNotFoundError) or errno == 2:
            raise FileNotFoundError(_format_worker_spawn_errno2_message(argv, worker_cwd, exc)) from exc
        raise

    async with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is not None:
            rec.proc = proc

    last: Dict[str, Any] = {}
    parse_error: Optional[str] = None

    async def drain_stderr() -> None:
        assert proc.stderr is not None
        while True:
            chunk = await proc.stderr.read(65536)
            if not chunk:
                break
            stderr_chunks.append(chunk)

    stderr_task = asyncio.create_task(drain_stderr())

    try:
        assert proc.stdin is not None
        proc.stdin.write(data)
        await proc.stdin.drain()
        proc.stdin.close()

        assert proc.stdout is not None
        while True:
            line_b = await proc.stdout.readline()
            if not line_b:
                break
            line = line_b.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                parsed_line: Dict[str, Any] = json.loads(line)
            except json.JSONDecodeError:
                parse_error = line[:200]
                break

            if parsed_line.get("partial"):
                status_raw = parsed_line.get("status")
                if isinstance(status_raw, dict):
                    await _apply_streaming_spec_import_status(job_id, status_raw)
                continue

            last = parsed_line
    finally:
        if proc.returncode is None:
            await proc.wait()
        await stderr_task
        async with _jobs_lock:
            r2 = _jobs.get(job_id)
            if r2 is not None:
                r2.proc = None

    stderr_text = b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()
    if stderr_text:
        logger.warning("spec import worker stderr job=%s: %s", job_id, stderr_text[:4000])

    if parse_error is not None:
        return {
            "ok": False,
            "error": f"Worker stdout is not JSON (exit {proc.returncode}): {parse_error}",
        }

    if not last:
        return {"ok": False, "error": "Worker produced no stdout"}

    if proc.returncode != 0 and not last.get("ok"):
        return last

    if proc.returncode != 0:
        return {"ok": False, "error": last.get("error") or f"Worker exited {proc.returncode}"}

    return last


async def _invoke_worker(payload: Dict[str, Any]) -> Dict[str, Any]:
    if _worker_runner is not None:
        return await _worker_runner(payload)
    return await _run_subprocess_worker(payload)


def _resolve_inprocess_adapter(payload: Dict[str, Any]) -> Optional[ImportSource]:
    """Return the in-process :class:`ImportSource` for this job, or ``None`` for the worker.

    Resolves the request's ``metadata.source_kind`` against the import-source registry
    (MFI-1.1). A source kind that resolves to a registered adapter *other than* a
    worker-backed one (:data:`_WORKER_BACKED_ADAPTER_KEYS`) runs through the generalized
    in-process pipeline; OpenAPI/Swagger and any unrecognized source kind return ``None``
    so the job continues on the ``tsx`` worker exactly as before.
    """
    metadata = payload.get("metadata") or {}
    source_kind = metadata.get("source_kind")
    if not isinstance(source_kind, str) or not source_kind:
        return None
    resolved_kind = resolve_import_source_key(source_kind)
    try:
        adapter = get_import_source(resolved_kind)
    except Exception:  # noqa: BLE001 - a registry/import failure must not break the job
        logger.warning(
            "Import-source registry lookup failed for source_kind=%r (resolved=%r)",
            source_kind,
            resolved_kind,
            exc_info=True,
        )
        return None
    if adapter is None or adapter.key in _WORKER_BACKED_ADAPTER_KEYS:
        return None
    return adapter


def _requires_inprocess_adapter(source_kind: str) -> bool:
    """True when ``source_kind`` names a registered adapter that must not use the tsx worker."""
    resolved = resolve_import_source_key(source_kind)
    return resolved in available_import_sources() and resolved not in _WORKER_BACKED_ADAPTER_KEYS


async def _run_inprocess_adapter_job(
    job_id: str, adapter: ImportSource, payload: Dict[str, Any]
) -> None:
    """Drive a job through the in-process adapter pipeline and publish its snapshots.

    Each intermediate snapshot updates the polled job record (and logs fresh events);
    a cancel request between phases stops the run. The terminal status is recorded the
    same way the worker path records its final status, so the poll/commit/rollback
    contract is identical regardless of which path ran the import.
    """

    async def _publish(status: SpecImportJobStatus) -> None:
        async with _jobs_lock:
            rec = _jobs.get(job_id)
            if rec is None or rec.cancel_requested:
                return
            _set_status(rec, status)
            fresh = _take_new_import_events(rec, status)
        _log_import_events(fresh, job_id)
        await _mirror_job(job_id)

    def _is_canceled() -> bool:
        rec = _jobs.get(job_id)
        return rec is not None and rec.cancel_requested

    try:
        final = await run_adapter_import_job(
            adapter, payload, on_snapshot=_publish, is_canceled=_is_canceled
        )
    except Exception as e:  # noqa: BLE001 - convert any unexpected adapter fault to a failed job
        logger.exception("in-process import adapter crashed job=%s", job_id)
        async with _jobs_lock:
            rec = _jobs.get(job_id)
            if rec is None:
                return
            _set_status(
                rec,
                _default_result_status(
                    job_id, str(e), code="ADAPTER_EXCEPTION",
                    correlation_id=rec.correlation_id,
                ),
            )
        return

    async with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is None:
            return
        if rec.cancel_requested and final.state != "canceled":
            _set_status(
                rec, SpecImportJobStatus(job_id=job_id, state="canceled", percent=0)
            )
            return
        _set_status(rec, final)
        rec.commit_response = _maybe_build_commit_response(job_id, final)
        fresh = _take_new_import_events(rec, final)
    _log_import_events(fresh, job_id)


async def _drive_job(job_id: str, payload: Dict[str, Any]) -> None:
    """Drive a job to a terminal state, then record its IXH-6.6 job metrics.

    The wrapper (not the pipeline) owns the whole-job wall clock and the terminal
    metrics because it is the one seam every path exits through — worker faults,
    in-process failures, engine faults, and cancels alike.
    """
    rec = _jobs.get(job_id)
    if rec is not None:
        # Deterministic log correlation: the create_task context snapshot already
        # carries the request contextvars, but an explicit bind survives refactors.
        bind_contextvars(request_id=rec.correlation_id, import_job_id=job_id)
        rec.started_monotonic = time.monotonic()
    try:
        await _drive_job_inner(job_id, payload)
    finally:
        _record_terminal_import_metrics(job_id, payload)


def _record_terminal_import_metrics(job_id: str, payload: Dict[str, Any]) -> None:
    """Record the terminal job total (and failure counter) for one import (best-effort)."""
    try:
        rec = _jobs.get(job_id)
        if rec is None:
            return
        status = rec.status
        state = status.state
        if state in ("completed", "pending-approval"):
            outcome = "completed"
        elif state == "canceled":
            outcome = "canceled"
        else:
            outcome = "failed"
        raw_kind = str(((payload.get("metadata") or {}).get("source_kind")) or "")
        adapter = resolve_import_source_key(raw_kind) or raw_kind
        duration_ms: Optional[float] = None
        if rec.started_monotonic:
            duration_ms = (time.monotonic() - rec.started_monotonic) * 1000.0

        from .import_export_metrics import import_export_metrics

        import_export_metrics.record_job(
            kind="import",
            adapter_or_target=adapter,
            format_key=adapter,
            outcome=outcome,
            duration_ms=duration_ms,
            bytes_in=rec.bytes_in,
        )
        if outcome == "failed" and status.error is not None:
            import_export_metrics.record_failure(
                kind="import",
                code=status.error.code,
                adapter_or_target=adapter,
                format_key=adapter,
            )
    except Exception:  # noqa: BLE001 - metrics must never affect the job
        logger.debug("Failed to record terminal import metrics", exc_info=True)


async def _drive_job_inner(job_id: str, payload: Dict[str, Any]) -> None:
    async with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is None:
            return
        if rec.cancel_requested:
            _set_status(
                rec, SpecImportJobStatus(job_id=job_id, state="canceled", percent=0)
            )
            canceled = True
        else:
            _set_status(
                rec, SpecImportJobStatus(job_id=job_id, state="running", percent=0)
            )
            canceled = False
    await _mirror_job(job_id)
    if canceled:
        return

    # MFI-1.2: a source kind that resolves to a non-worker import-source adapter runs the
    # generalized in-process pipeline; OpenAPI/Swagger (and unknown kinds) stay on the worker.
    adapter = _resolve_inprocess_adapter(payload)
    if adapter is not None:
        await _run_inprocess_adapter_job(job_id, adapter, payload)
        return

    raw_kind = (payload.get("metadata") or {}).get("source_kind")
    if isinstance(raw_kind, str) and raw_kind.strip() and _requires_inprocess_adapter(raw_kind):
        message = (
            f"Import source {raw_kind!r} could not run in this runtime. "
            "Restart the REST service after installing dev toolchains "
            "(apiome-rest/scripts/install_dev_toolchain.sh)."
        )
        logger.error("in-process adapter required but unavailable job=%s source_kind=%r", job_id, raw_kind)
        async with _jobs_lock:
            rec = _jobs.get(job_id)
            if rec is None:
                return
            _set_status(
                rec,
                _default_result_status(
                    job_id, message, code="ADAPTER_UNAVAILABLE",
                    correlation_id=rec.correlation_id,
                ),
            )
        await _mirror_job(job_id)
        return

    try:
        raw = await _invoke_worker(payload)
    except Exception as e:  # noqa: BLE001
        logger.exception("spec import worker crashed job=%s", job_id)
        async with _jobs_lock:
            rec = _jobs.get(job_id)
            if rec is None:
                return
            _set_status(
                rec,
                _default_result_status(
                    job_id, str(e), code="WORKER_EXCEPTION",
                    correlation_id=rec.correlation_id,
                ),
            )
        await _mirror_job(job_id)
        return

    async with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is None:
            return
        canceled = rec.cancel_requested
        if canceled:
            _set_status(
                rec, SpecImportJobStatus(job_id=job_id, state="canceled", percent=0)
            )
    if canceled:
        await _mirror_job(job_id)
        return

    if not raw.get("ok"):
        msg = str(raw.get("error") or "Import worker failed")
        async with _jobs_lock:
            rec = _jobs.get(job_id)
            if rec is None:
                return
            _set_status(
                rec,
                _default_result_status(
                    job_id, msg, code="WORKER_FAILED", correlation_id=rec.correlation_id
                ),
            )
        await _mirror_job(job_id)
        return

    status_raw = raw.get("status")
    if not isinstance(status_raw, dict):
        async with _jobs_lock:
            rec = _jobs.get(job_id)
            if rec is None:
                return
            _set_status(
                rec,
                _default_result_status(
                    job_id,
                    "Worker returned ok but no status object",
                    code="BAD_WORKER_PAYLOAD",
                    correlation_id=rec.correlation_id,
                ),
            )
        await _mirror_job(job_id)
        return

    try:
        status = SpecImportJobStatus.model_validate(status_raw)
    except Exception as e:  # noqa: BLE001
        logger.warning("Invalid worker status for job=%s: %s", job_id, e)
        async with _jobs_lock:
            rec = _jobs.get(job_id)
            if rec is None:
                return
            _set_status(
                rec,
                _default_result_status(
                    job_id,
                    f"Invalid job status from worker: {e}",
                    code="INVALID_STATUS",
                    correlation_id=rec.correlation_id,
                ),
            )
        await _mirror_job(job_id)
        return

    async with _jobs_lock:
        rec = _jobs.get(job_id)
        if rec is None:
            return
        _set_status(rec, status)
        rec.commit_response = _maybe_build_commit_response(job_id, status)
        tenant_slug = rec.tenant_slug
        # Final snapshot carries any events not seen in streamed partials (notably the
        # end-of-run BENCHMARK summary); log them so the timing breakdown lands in the logs.
        fresh_events = _take_new_import_events(rec, status)
    _log_import_events(fresh_events, job_id)
    await _mirror_job(job_id)

    # Capture the quality/lint score onto the newly imported revision so the projects list can show
    # it (#3609 follow-up). Done outside the lock, off the event loop (DB-bound), and best-effort.
    result = status.result
    version_record_id = getattr(result, "version_record_id", None) if result else None
    if status.state == "completed" and version_record_id:
        tenant_id = str(payload.get("tenant_id") or "")
        if tenant_id:
            await asyncio.to_thread(
                _capture_version_quality_score, tenant_slug, tenant_id, version_record_id
            )


def _current_correlation_id(job_id: str) -> str:
    """The request id the observability middleware bound, else the job id.

    Read from the structlog contextvars (IXH-6.6) so no route signature changes:
    ``schedule_*`` always runs inside the submitting request's context. The job-id
    fallback keeps non-HTTP callers (tests, tools) correlated by *something*.
    """
    try:
        from structlog.contextvars import get_contextvars

        value = get_contextvars().get("request_id")
        if isinstance(value, str) and value:
            return value
    except Exception:  # noqa: BLE001 - correlation must never fail scheduling
        pass
    return job_id


async def schedule_spec_import(
    tenant_slug: str,
    tenant_id: str,
    user_id: str,
    body: SpecImportStartJsonRequest,
) -> SpecImportJobAccepted:
    job_id = str(uuid.uuid4())
    correlation_id = _current_correlation_id(job_id)
    payload = _build_worker_payload(
        rest_job_id=job_id,
        tenant_slug=tenant_slug,
        tenant_id=tenant_id,
        user_id=user_id,
        body=body,
    )
    payload["correlation_id"] = correlation_id
    initial = SpecImportJobStatus(
        job_id=job_id, state="queued", percent=0, correlation_id=correlation_id
    )
    async with _jobs_lock:
        _jobs[job_id] = _JobRecord(
            tenant_slug=tenant_slug,
            job_id=job_id,
            state="queued",
            status=initial,
            correlation_id=correlation_id,
            # Base64 arithmetic sizes the source without re-decoding it (IXH-6.6).
            bytes_in=(len(body.document_base64) * 3) // 4 if body.document_base64 else None,
        )
    # Mirror the initial 'queued' row before returning 202 so the very first poll — which
    # round-robin may route to any instance — already finds the job in the shared store.
    await _mirror_job(job_id)
    asyncio.create_task(_drive_job(job_id, payload))
    return SpecImportJobAccepted(
        job_id=job_id,
        status_path=f"/v1/tenants/{tenant_slug}/imports/{job_id}",
    )


async def schedule_spec_import_multipart(
    tenant_slug: str,
    tenant_id: str,
    user_id: str,
    metadata: SpecImportStartMetadata,
    file_bytes: bytes,
    filename: Optional[str],
    content_type: Optional[str],
) -> SpecImportJobAccepted:
    """Schedule a multipart import, streaming bytes to a tempfile (IXH-6.5).

    Avoids base64-doubling the upload in the worker payload. The owning instance
    reads ``document_path`` during the job and deletes the tempfile when the job
    reaches a terminal state.
    """
    from .intake_resource_guard import resolve_guard_profile
    from .intake_streaming import write_bytes_to_tempfile

    profile = resolve_guard_profile(tenant_id=tenant_id)
    suffix = Path(filename or "").suffix or ".upload"
    path, _size = write_bytes_to_tempfile(
        file_bytes,
        limits=profile.limits,
        suffix=suffix,
        source_label=filename,
    )
    return await schedule_spec_import_from_path(
        tenant_slug,
        tenant_id,
        user_id,
        metadata,
        document_path=path,
        filename=filename,
        content_type=content_type,
    )


async def schedule_spec_import_from_path(
    tenant_slug: str,
    tenant_id: str,
    user_id: str,
    metadata: SpecImportStartMetadata,
    *,
    document_path: str,
    filename: Optional[str],
    content_type: Optional[str],
) -> SpecImportJobAccepted:
    """Schedule an import whose document already lives on a bounded tempfile."""
    job_id = str(uuid.uuid4())
    correlation_id = _current_correlation_id(job_id)
    payload: Dict[str, Any] = {
        "rest_job_id": job_id,
        "tenant_slug": tenant_slug,
        "tenant_id": tenant_id,
        "user_id": user_id,
        "metadata": json.loads(metadata.model_dump_json()),
        "document_path": document_path,
        "filename": filename,
        "content_type": content_type,
        "correlation_id": correlation_id,
    }
    try:
        bytes_in: Optional[int] = os.path.getsize(document_path)
    except OSError:
        bytes_in = None
    initial = SpecImportJobStatus(
        job_id=job_id, state="queued", percent=0, correlation_id=correlation_id
    )
    async with _jobs_lock:
        _jobs[job_id] = _JobRecord(
            tenant_slug=tenant_slug,
            job_id=job_id,
            state="queued",
            status=initial,
            correlation_id=correlation_id,
            bytes_in=bytes_in,
        )
    await _mirror_job(job_id)
    asyncio.create_task(_drive_job(job_id, payload))
    return SpecImportJobAccepted(
        job_id=job_id,
        status_path=f"/v1/tenants/{tenant_slug}/imports/{job_id}",
    )


async def get_spec_import_status(tenant_slug: str, job_id: str) -> SpecImportJobStatus:
    # Fast path: this instance drives the job, so its in-memory record is authoritative and
    # freshest. Otherwise (round-robin: another instance drives it) consult the shared store so
    # the poll still resolves instead of 404-ing.
    rec = _jobs.get(job_id)
    if rec is not None and rec.tenant_slug == tenant_slug:
        return rec.status
    row = await _fetch_shared_job(tenant_slug, job_id)
    if row is not None:
        return SpecImportJobStatus.model_validate(row["status"])
    raise HTTPException(status_code=404, detail="Import job not found")


async def list_spec_import_jobs(
    tenant_slug: str,
    *,
    limit: int = 50,
    offset: int = 0,
    state: Optional[str] = None,
    created_after: Optional[datetime] = None,
    created_before: Optional[datetime] = None,
) -> SpecImportJobListResponse:
    from .database import db

    page_limit = max(1, min(int(limit), 200))
    page_offset = max(0, int(offset))

    def _from_status(st: SpecImportJobStatus) -> SpecImportJobListItem:
        return SpecImportJobListItem(
            job_id=st.job_id,
            state=st.state,
            percent=st.percent,
            status_path=f"/v1/tenants/{tenant_slug}/imports/{st.job_id}",
            progress=st.progress,
            result=st.result,
        )

    def _state_matches(job_state: str) -> bool:
        return state is None or not str(state).strip() or job_state == str(state).strip()

    # Prefer the shared store so the list spans every instance's jobs for the tenant; fall back
    # to this process's in-memory jobs if the store is unreachable.
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
        logger.warning("Falling back to in-memory import job list for %s", tenant_slug, exc_info=True)
        async with _jobs_lock:
            local = [
                r.status
                for r in _jobs.values()
                if r.tenant_slug == tenant_slug and _state_matches(r.status.state)
            ]
        local.sort(
            key=lambda st: (
                int(getattr(st, "created_at_ms", None) or getattr(st, "updated_at_ms", None) or 0),
                st.job_id,
            ),
            reverse=True,
        )
        total = len(local)
        slice_rows = local[page_offset : page_offset + page_limit]
        return SpecImportJobListResponse(
            jobs=[_from_status(st) for st in slice_rows],
            total=total,
            limit=page_limit,
            offset=page_offset,
        )
    items = [
        _from_status(SpecImportJobStatus.model_validate(row["status"]))
        for row in page["jobs"]
    ]
    return SpecImportJobListResponse(
        jobs=items,
        total=int(page["total"]),
        limit=int(page["limit"]),
        offset=int(page["offset"]),
    )


async def cancel_spec_import_job(tenant_slug: str, job_id: str) -> None:
    from .database import db

    # Set the shared cancel flag so the driving instance (which may be a different process)
    # honors it at its next stage boundary. Whether it matched a row tells us if the job exists.
    try:
        matched = await asyncio.to_thread(
            db.request_async_job_cancel, job_id, tenant_slug, _SHARED_JOB_KIND
        )
    except Exception:  # noqa: BLE001 - shared store is best-effort
        logger.warning("Failed to set shared cancel flag for import job %s", job_id, exc_info=True)
        matched = False
    # If this instance owns the live job, honor the cancel immediately (kill the worker proc).
    async with _jobs_lock:
        rec = _jobs.get(job_id)
        owned = rec is not None and rec.tenant_slug == tenant_slug
        proc = None
        if owned:
            if rec.state in ("completed", "failed", "canceled", "rolled-back"):
                return
            rec.cancel_requested = True
            proc = rec.proc
    if not matched and not owned:
        raise HTTPException(status_code=404, detail="Import job not found")
    if proc is not None and proc.returncode is None:
        proc.kill()


async def commit_spec_import_job(tenant_slug: str, job_id: str) -> SpecImportCommitResponse:
    """Return a prior commit payload (idempotent) from the owner or the shared store.

    Incremental imports finalize without a separate commit; when a ``commit_response`` was
    mirrored at completion, any instance can replay it. Preview (``pending-approval``) still
    needs an owner-held transaction — that constraint is named in the 501 detail.
    """
    rec = _jobs.get(job_id)
    if rec is not None and rec.tenant_slug == tenant_slug:
        if rec.commit_response is not None:
            return rec.commit_response
        state = rec.status.state
        if state == "pending-approval":
            _raise_preview_owner_constraint()
        raise HTTPException(
            status_code=409,
            detail=f"No commit available for import job in state {state}",
        )

    row = await _fetch_shared_job(tenant_slug, job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Import job not found")
    extra = row.get("extra") or {}
    commit_raw = extra.get("commit_response")
    if commit_raw:
        return SpecImportCommitResponse.model_validate(commit_raw)
    state = row["state"]
    if state == "pending-approval" or extra.get("owner_resource_constraint"):
        _raise_preview_owner_constraint()
    raise HTTPException(
        status_code=409,
        detail=f"No commit available for import job in state {state}",
    )


async def rollback_spec_import_job(tenant_slug: str, job_id: str) -> SpecImportRollbackResponse:
    """Return a prior rollback payload (idempotent) from the owner or the shared store.

    Owner fast path uses the in-memory record. Non-owning instances read
    ``extra.rollback_response`` / ``rolled-back`` state from the shared store so round-robin
    never 404s a job that exists. Preview rollback that would need a held-open transaction
    returns a constraint-named 501 instead of a bare 404.
    """
    rec = _jobs.get(job_id)
    if rec is not None and rec.tenant_slug == tenant_slug:
        if rec.rollback_response is not None:
            return rec.rollback_response
        if rec.status.state == "rolled-back":
            response = SpecImportRollbackResponse(job_id=job_id, state="rolled-back")
            async with _jobs_lock:
                owned = _jobs.get(job_id)
                if owned is not None and owned.tenant_slug == tenant_slug:
                    owned.rollback_response = response
            await _mirror_job(job_id)
            return response
        if rec.status.state == "pending-approval":
            _raise_preview_owner_constraint()
        raise HTTPException(
            status_code=409,
            detail=f"Cannot rollback import job in state {rec.status.state}",
        )

    row = await _fetch_shared_job(tenant_slug, job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Import job not found")
    extra = row.get("extra") or {}
    rollback_raw = extra.get("rollback_response")
    if rollback_raw:
        return SpecImportRollbackResponse.model_validate(rollback_raw)
    state = row["state"]
    if state == "rolled-back":
        return SpecImportRollbackResponse(job_id=job_id, state="rolled-back")
    if state == "pending-approval" or extra.get("owner_resource_constraint"):
        _raise_preview_owner_constraint()
    raise HTTPException(
        status_code=409,
        detail=f"Cannot rollback import job in state {state}",
    )

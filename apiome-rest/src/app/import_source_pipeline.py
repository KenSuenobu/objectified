"""In-process import-source job pipeline — MFI-1.2 (#3734).

The spec-import job engine (:mod:`app.spec_import_engine`) was OpenAPI-shaped: every
job ran the ``apiome-ui`` ``tsx`` worker, which only knows how to import an
OpenAPI/Swagger document. MFI-1.1 (#3733) introduced the :class:`ImportSource` SPI so
a *format* is added by registering an adapter; this module is the generalized engine
step that **drives any such adapter through the existing job lifecycle** —
parse → normalize → version → lint — emitting the same
:class:`~app.models.SpecImportJobStatus` contract the worker already produces.

The four phases map onto the SPI:

* **parse** — :meth:`ImportSource.parse` turns the raw document text into the
  format's native AST;
* **normalize** — :meth:`ImportSource.normalize` maps that AST onto the canonical
  model (:class:`~app.canonical_model.CanonicalApi`);
* **version** — :meth:`ImportSource.fingerprint` computes the stable content
  fingerprint that *identifies* this revision (the unit ``skip_duplicate_versions``
  and incremental imports key off);
* **lint** — :meth:`ImportSource.lint` scores the normalized model.

The OpenAPI/Swagger path keeps running on the ``tsx`` worker (it persists a full
catalog project/version and has its own benchmark instrumentation). This path handles
every *other* format and now **persists** its result via the canonical→catalog hook
(:func:`persist_adapter_import`): a non-dry-run import writes its routed artifact and
keeps the **original source verbatim** in the revision's ``format_metadata`` so it can
be converted to OpenAPI later (MFI-EPIC-22) — nothing is converted at import time. A
``dry_run`` still previews without writing. The completed job's ``summary`` carries the
fingerprint, paradigm/format, entity counts, lint score, the Project-vs-Catalog
**routing decision** (MFI-23.7, :mod:`app.import_routing`), and a ``persisted`` flag;
its ``result`` carries the produced project/version ids.

Between normalize and version the pipeline records a routing decision — OpenAPI/Swagger
imports route to a publishable **Project**, everything else to a non-publishable
**catalog item** — onto the summary (and a ``ROUTING_DECIDED`` event) so the UI can
explain where an import landed and why; the persistence hook then creates that artifact
with ``db.create_project(publishable=routing.publishable)``.

The driver is intentionally transport-agnostic: it takes a resolved adapter and the
worker payload dict, calls an optional ``on_snapshot`` coroutine after every phase so
the engine can publish poll-visible progress, and checks an optional ``is_canceled``
predicate between phases. This mirrors the MCP discovery-job driver: a small async
state machine over a registry-resolved adapter.

The adapter's parse/normalize/fingerprint/lint calls run inline (not on a worker
thread): these adapters handle bounded new-format documents, and the one heavy path —
OpenAPI/Swagger — stays on the subprocess worker. Keeping the work inline means a job
runs to a terminal state within a single event-loop turn, the same way the worker's
final-status callback resolves, which the job engine and its tests rely on. A future
format with genuinely CPU-bound parsing can move its own step to a thread/subprocess.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from .archive_intake import ArchiveIntakeError, is_archive_payload, unpack_archive
from .canonical_model import CanonicalApi
from .fileset import IntakeFileset
from .import_routing import ImportRoutingDecision, ImportTarget, decide_import_routing
from .import_source import (
    DetectionInput,
    ImportSource,
    ImportSourceError,
    LintReport,
    detect_import_source,
)
from .intake_error_taxonomy import descriptor_for, resolve_intake_error_code
from .intake_resource_guard import IntakeLimitError, guard_payload_bytes
from .intake_secret_scrub import (
    ScrubFinding,
    ScrubOutcome,
    scrub_document_text,
    scrub_message,
)
from .models import (
    SpecImportEvent,
    SpecImportJobError,
    SpecImportJobResult,
    SpecImportJobStatus,
)
from .secure_xml import SecureXmlError
from .style_guide_engine import (
    FALLBACK_GUIDE_SOURCE,
    apply_style_guide_to_lint_report,
    resolve_style_guide,
)

logger = logging.getLogger(__name__)

__all__ = [
    "ADAPTER_PHASE_EVENT_CODES",
    "ImportRunArtifacts",
    "build_job_error",
    "capture_canonical_quality_score",
    "run_adapter_import_job",
]


# Event codes the in-process adapter pipeline emits for each phase. Surfaced at INFO
# by the engine's event logger (mirrors the worker's PHASE_TIMING/BENCHMARK codes) so
# an adapter import's progress is readable in the REST logs as it runs.
ADAPTER_PHASE_EVENT_CODES = frozenset(
    {
        "ADAPTER_INIT",
        "PARSE_OK",
        "NORMALIZE_OK",
        "ROUTING_DECIDED",
        "VERSION_FINGERPRINT",
        "INCREMENTAL_MODE",
        "DRY_RUN",
        "LINT_COMPLETED",
        "QUALITY_CAPTURED",
        "SECRETS_REDACTED",
        "IMPORT_COMPLETED",
    }
)

# Percent milestones for each phase, so a poller sees monotonic progress even though
# an in-process adapter run is fast. Values are coarse on purpose — the contract only
# promises a 0–100 percent, not a per-phase breakdown.
_PCT_INIT = 5
_PCT_PARSED = 25
_PCT_NORMALIZED = 55
_PCT_VERSIONED = 75
_PCT_LINTED = 90
_PCT_DONE = 100


@dataclass
class ImportRunArtifacts:
    """Mutable collector for the in-flight objects one pipeline run produces (IXH-2.1).

    The terminal :class:`SpecImportJobStatus` carries only a *rolled-up* summary — lint
    score, grade, counts — because that is all a polling client needs. The pre-flight API
    (IXH-2.1) needs the objects behind those roll-ups (the full lint report with its
    findings, the canonical model, the resolved style guide) and must get them from the
    **same** run as the committing import, not from a second code path.

    Passing an instance to :func:`run_adapter_import_job` therefore has it record each
    artifact as the phase that produces it completes. Every field stays ``None`` when the
    run failed before that phase. Purely an out-parameter: the pipeline never *reads* it,
    so collecting artifacts cannot change an import's outcome.

    Attributes:
        adapter_key: Registry key of the adapter that ran.
        model: The normalized canonical model (after the normalize phase).
        fingerprint: The revision fingerprint (after the version phase).
        lint: The rolled-up lint report, already re-scored under the resolved style
            guide — byte-identical to the report the committing import persists.
        routing: The Project-vs-Catalog-vs-Types routing decision.
        style_guide: The :class:`~app.style_guide_engine.CompiledStyleGuide` that governed
            the lint (the in-code fallback guide when the tenant has none). Typed loosely
            to keep the style-guide module off this module's import path.
        scrub_report: The IXH-1.4 secret-scrub report for the intake.
    """

    adapter_key: Optional[str] = None
    model: Optional[CanonicalApi] = None
    fingerprint: Optional[str] = None
    lint: Optional[LintReport] = None
    routing: Optional[ImportRoutingDecision] = None
    style_guide: Optional[Any] = None
    scrub_report: Optional[Dict[str, Any]] = None


def _scrub_event_context(context: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Scrub credential-shaped spans from an event context's string values.

    Contexts carry adapter-supplied detail (member paths, reasons, fingerprints).
    Only string values are rewritten; other types cannot embed a token.

    Args:
        context: The event context, or ``None``.

    Returns:
        The scrubbed context, or ``None`` when ``context`` was ``None``.
    """
    if not context:
        return context
    return {
        key: (scrub_message(value) if isinstance(value, str) else value)
        for key, value in context.items()
    }


class _AdapterRunState:
    """Accumulates events/percent for one adapter import and builds status snapshots.

    A tiny mutable helper so each phase can append an event and emit a
    :class:`SpecImportJobStatus` carrying the *full* accumulated event log (the same
    shape the worker's streamed snapshots use), without threading a growing list
    through every call.
    """

    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        self._events: List[SpecImportEvent] = []
        self._seq = 0

    def event(
        self,
        code: str,
        message: str,
        *,
        level: str = "info",
        context: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Append one structured event to the run's log.

        The message is scrubbed of credential-shaped spans (IXH-1.4) before it is
        retained: parser errors quote the offending source line, so a secret on a
        malformed line would otherwise reach every status poll and the server log.
        """
        self._seq += 1
        self._events.append(
            SpecImportEvent(
                id=f"adapter-{self._seq}",
                ts=int(time.time() * 1000),
                level=level,  # type: ignore[arg-type]
                code=code,
                message=scrub_message(message) or "",
                context=_scrub_event_context(context),
            )
        )

    def snapshot(
        self,
        *,
        state: str,
        percent: int,
        summary: Optional[Dict[str, Any]] = None,
        result: Optional[SpecImportJobResult] = None,
        error: Optional[SpecImportJobError] = None,
    ) -> SpecImportJobStatus:
        """Build a status snapshot carrying the accumulated event log."""
        return SpecImportJobStatus(
            job_id=self.job_id,
            state=state,  # type: ignore[arg-type]
            percent=percent,
            events=list(self._events),
            summary=summary,
            result=result,
            error=error,
        )


def build_job_error(code: Optional[str], message: str) -> SpecImportJobError:
    """Build the terminal :class:`SpecImportJobError` for a failed job.

    ``code`` may be a taxonomy code, a legacy event/engine code, or ``None``;
    anything unrecognized falls back to ``INTERNAL_ADAPTER_FAULT`` so a failed job
    always carries a valid taxonomy code with non-empty remediation (IXH-1.3).
    """
    resolved = resolve_intake_error_code(code) or "INTERNAL_ADAPTER_FAULT"
    descriptor = descriptor_for(resolved)
    assert descriptor is not None  # every resolved code is registered
    return SpecImportJobError(
        code=descriptor.code,
        category=descriptor.category.value,
        message=message,
        remediation=descriptor.remediation,
        retriable=descriptor.retriable,
    )


#: Characters that betray a text that was decoded from a non-UTF-8 upload:
#: U+FFFD replacement characters (invalid byte sequences under the permissive
#: decode in :func:`_decode_document`) and NULs (UTF-16 payloads decoded as UTF-8).
_ENCODING_FAULT_MARKERS = ("\ufffd", "\x00")

#: Minimum confidence another adapter must report before a parse failure is
#: attributed to a wrong-format upload rather than a malformed document.
_FORMAT_MISMATCH_MIN_CONFIDENCE = 0.5


def _classify_parse_failure(
    exc: ImportSourceError,
    adapter: ImportSource,
    text: Optional[str],
    source_label: Optional[str],
) -> str:
    """Pick the taxonomy code for a parse-phase failure (IXH-1.3).

    Precedence:
        1. An explicit ``exc.code`` from the adapter (it knows best).
        2. Empty/whitespace-only input → ``INPUT_EMPTY``.
        3. Encoding-fault markers (replacement chars, NULs, a leading BOM) →
           ``INPUT_ENCODING_INVALID``.
        4. The adapter's own ``detect()`` does not claim the text but a
           *different* adapter confidently does → ``FORMAT_MISMATCH`` (the
           document is plausibly that other format, routed to the wrong
           importer). A broken document nobody claims is just malformed —
           detection failing on it is not evidence of a different format.
        5. Otherwise ``INPUT_MALFORMED``.
    """
    explicit = resolve_intake_error_code(getattr(exc, "code", None))
    if explicit is not None:
        return explicit
    if text is None:
        # Archive/fileset intake: no single text to inspect further.
        return "INPUT_MALFORMED"
    if not text.strip():
        return "INPUT_EMPTY"
    if text.startswith("\ufeff") or any(marker in text for marker in _ENCODING_FAULT_MARKERS):
        return "INPUT_ENCODING_INVALID"
    payload = DetectionInput(
        text=text, filename=source_label if isinstance(source_label, str) else None
    )
    try:
        claimed = adapter.detect(payload).matched
    except Exception:  # noqa: BLE001 - a buggy sniffer must not change the outcome
        claimed = True
    if not claimed:
        best = detect_import_source(payload)
        if (
            best is not None
            and best[0].key != adapter.key
            and best[1].confidence >= _FORMAT_MISMATCH_MIN_CONFIDENCE
        ):
            return "FORMAT_MISMATCH"
    return "INPUT_MALFORMED"


def _decode_document_bytes(payload: Dict[str, Any]) -> bytes:
    """Decode the base64 worker payload into raw bytes.

    Raises:
        ImportSourceError: If ``document_base64`` is missing or not valid base64.
    """
    b64 = payload.get("document_base64")
    if not isinstance(b64, str) or not b64:
        raise ImportSourceError(
            "Import payload is missing document_base64 content", code="INPUT_EMPTY"
        )
    try:
        return base64.standard_b64decode(b64)
    except (binascii.Error, ValueError) as exc:
        raise ImportSourceError(
            f"document_base64 is not valid base64: {exc}", code="INPUT_ENCODING_INVALID"
        ) from exc


def _decode_document(payload: Dict[str, Any]) -> str:
    """Decode the base64 worker payload into source text.

    Raises:
        ImportSourceError: If ``document_base64`` is missing or not valid base64.
    """
    raw_bytes = _decode_document_bytes(payload)
    # Decode permissively: a per-format adapter's parse() is responsible for rejecting
    # genuinely malformed text; we should not fail the whole job on a stray byte.
    return raw_bytes.decode("utf-8", errors="replace")


@dataclass(frozen=True)
class _ResolvedIntake:
    """Either a single text document or an unpacked archive fileset."""

    raw_bytes: bytes
    text: Optional[str]
    fileset: Optional[IntakeFileset]
    archive_root: Optional[str]


def _resolve_intake(payload: Dict[str, Any], options: Dict[str, Any]) -> _ResolvedIntake:
    """Classify the payload as a single file or an archive fileset."""
    raw_bytes = _decode_document_bytes(payload)
    source_label = payload.get("filename")
    archive_root = options.get("archive_root") if isinstance(options, dict) else None
    if isinstance(archive_root, str):
        archive_root = archive_root.strip() or None
    else:
        archive_root = None

    if not is_archive_payload(raw_bytes, source_label if isinstance(source_label, str) else None):
        # IXH-1.4: cap the single-document payload on its *bytes*, before decoding
        # to text (which would double the footprint) and before any adapter sees
        # it — text-only formats never reach the JSON/YAML guard in parse_document.
        # Archives keep their own, larger budget enforced inside unpack_archive.
        guard_payload_bytes(
            raw_bytes,
            source_label=source_label if isinstance(source_label, str) else None,
        )
        return _ResolvedIntake(
            raw_bytes=raw_bytes,
            text=raw_bytes.decode("utf-8", errors="replace"),
            fileset=None,
            archive_root=None,
        )

    try:
        unpacked = unpack_archive(
            raw_bytes,
            source_label=source_label if isinstance(source_label, str) else None,
            root_path=archive_root,
        )
    except ArchiveIntakeError as exc:
        raise ImportSourceError(str(exc), code="INPUT_ARCHIVE_INVALID") from exc

    fileset = IntakeFileset.from_members(unpacked.members, root=unpacked.root_path)
    return _ResolvedIntake(
        raw_bytes=raw_bytes,
        text=None,
        fileset=fileset,
        archive_root=unpacked.root_path,
    )


def scrub_intake_source(intake: _ResolvedIntake) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Build the persisted source fields with credentials removed (IXH-1.4).

    Intake stores the upload verbatim so it can be converted later (MFI-23.9), which
    means a document carrying a live token would persist that token. Every source
    is therefore scrubbed first (:mod:`app.intake_secret_scrub`):

    * **single document** — secret *values* are replaced in place, so the stored
      source stays parseable and structurally identical (values only);
    * **archive** — the stored blob is the original bytes, which cannot be rewritten
      safely, so when any member carries a secret the verbatim blob is **withheld**
      rather than persisted. The member list and root still persist, so the catalog
      item is complete; only the re-downloadable source is dropped.

    Args:
        intake: The resolved intake (single text document or unpacked fileset).

    Returns:
        ``(source_fields, scrub_report)`` — the ``format_metadata`` source fields to
        persist, and the report (types and line numbers, never values) recorded on
        the job summary.
    """
    if intake.fileset is not None:
        findings: List[ScrubFinding] = []
        for member_path in sorted(intake.fileset.members):
            outcome = scrub_document_text(intake.fileset.members[member_path])
            findings.extend(outcome.findings)
        combined = ScrubOutcome(text="", findings=findings)
        fields: Dict[str, Any] = {
            "intakeKind": "archive",
            "filesetRoot": intake.fileset.root,
            "filesetMembers": sorted(intake.fileset.members.keys()),
        }
        if combined.scrubbed:
            fields["sourceContent"] = None
            fields["sourceWithheld"] = "secrets-detected"
        else:
            fields["sourceContent"] = base64.standard_b64encode(intake.raw_bytes).decode("ascii")
            fields["sourceEncoding"] = "base64"
        report = combined.report()
        report["source_withheld"] = combined.scrubbed
        return fields, report

    assert intake.text is not None
    outcome = scrub_document_text(intake.text)
    report = outcome.report()
    report["source_withheld"] = False
    return {"sourceContent": outcome.text, "intakeKind": "file"}, report


def _source_content_for_persist(intake: _ResolvedIntake) -> Dict[str, Any]:
    """Build format_metadata source fields, credentials scrubbed.

    Thin wrapper over :func:`scrub_intake_source` for callers that do not need the
    scrub report.
    """
    fields, _report = scrub_intake_source(intake)
    return fields


def capture_canonical_quality_score(
    version_record_id: str, tenant_id: str, report: LintReport
) -> None:
    """Best-effort: persist an import's rolled-up lint score onto the revision (MFI-4.2).

    The canonical-model analogue of
    :func:`app.spec_import_engine._capture_version_quality_score` (specs) and
    :func:`app.mcp_discovery_engine._capture_mcp_version_score` (MCP). Given the already-computed
    :class:`~app.import_source.LintReport` for a freshly committed revision — the same roll-up
    surfaced in the import summary — this writes its weighted 0–100 ``score``, A–F ``grade``, and
    stable ``report_fingerprint`` onto the revision's ``quality_*`` columns (V124), the
    artifact-version row the canonical model is tied to (one ``api_artifacts`` row per
    ``versions`` row, MFI-2.2), so no new table/migration is needed. Persisting the report the
    adapter already produced (rather than re-linting) keeps the stored score identical to the
    surfaced one.

    Strictly **best-effort**: the revision is already committed, so any failure here just leaves
    the score for an on-demand re-lint (MFI-4.4) to fill and never affects the import outcome. An
    unscored report (no ``score``/``grade``) is skipped — there is nothing to persist. The DB
    import is lazy to keep that layer off the hot import path.

    Args:
        version_record_id: The just-committed ``versions`` row to score.
        tenant_id: Owning tenant; scopes the write so a caller cannot score another tenant's row.
        report: The rolled-up lint report for the revision (from the adapter's ``lint``).
    """
    if report.score is None or report.grade is None:
        return
    try:
        from .database import db

        db.set_version_quality_score(
            version_record_id,
            tenant_id,
            report.score,
            report.grade,
            report.report_fingerprint,
            quality_report=report.to_persisted_dict(),
        )
        # CLX-2.4: Buf / GraphQL ESLint → CLX-1.1 evidence (best-effort; never fails import).
        try:
            from .format_adapter_evidence import capture_format_adapters_for_revision_sync

            capture_format_adapters_for_revision_sync(
                version_record_id=version_record_id,
                tenant_id=tenant_id,
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "Failed to capture format-adapter evidence for revision %s",
                version_record_id,
                exc_info=True,
            )
    except Exception:  # noqa: BLE001 - capture is strictly best-effort
        logger.warning(
            "Failed to capture canonical quality score for revision %s",
            version_record_id,
            exc_info=True,
        )


def persist_adapter_import(
    payload: Dict[str, Any],
    model: CanonicalApi,
    intake: _ResolvedIntake,
    routing: ImportRoutingDecision,
) -> Optional[SpecImportJobResult]:
    """Persist a non-dry-run adapter import as its routed artifact (canonical→catalog hook, MFI-23.7).

    This is the persistence hook the pipeline docstring calls out as "pending": it creates the
    routed artifact — a **non-publishable catalog item** for every non-OpenAPI format
    (``routing.publishable is False``) — and stores the *original source verbatim* on the created
    revision's ``format_metadata`` (under ``sourceContent``) alongside its ``source_format`` and
    ``protocol``.

    Crucially, **nothing is converted here.** The raw bytes the user uploaded sit in the catalog
    untouched until they explicitly run the convert-to-OpenAPI flow (MFI-EPIC-22), which re-parses
    exactly these stored bytes via :mod:`app.catalog_conversion`. So a gRPC / Protobuf / Thrift
    import lands in the catalog in its native form and is converted only when the user is ready.

    Blocking DB work (the psycopg driver is synchronous) — call via ``asyncio.to_thread``.

    Args:
        payload: The worker payload (``tenant_id`` / ``user_id`` / ``metadata`` / ``filename``).
        model: The normalized canonical model (its ``format`` / ``paradigm`` label the revision).
        intake: The resolved upload (single file or archive fileset), stored verbatim.
        routing: The Project-vs-Catalog decision; ``routing.publishable`` sets the created row.

    Returns:
        The produced identifiers, or ``None`` when there is no tenant to write under.
    """
    from .database import db

    tenant_id = str(payload.get("tenant_id") or "")
    if not tenant_id:
        return None
    creator_id = str(payload.get("user_id") or "") or None
    metadata = payload.get("metadata") or {}
    project_meta = metadata.get("project") or {}
    version_meta = metadata.get("version") or {}
    options = metadata.get("options") or {}
    existing_project_id = metadata.get("existing_project_id")
    source_label = payload.get("filename")

    version_id = str(version_meta.get("version_id") or "1.0.0").strip() or "1.0.0"
    version_description = version_meta.get("description")

    if existing_project_id:
        existing = db.get_project_by_id(str(existing_project_id), tenant_id)
        project_id = str(existing_project_id)
        project_slug = (existing or {}).get("slug")
    else:
        name = str(project_meta.get("name") or source_label or "Imported source").strip()
        slug = str(project_meta.get("slug") or "").strip()
        description = project_meta.get("description")
        project_id, project_slug = _resolve_import_project(
            db,
            tenant_id=tenant_id,
            creator_id=creator_id,
            name=name,
            slug=slug,
            description=description,
            routing=routing,
        )

    version_record_id, version_id = _resolve_import_version(
        db,
        tenant_id=tenant_id,
        project_id=project_id,
        creator_id=creator_id,
        version_id=version_id,
        version_description=version_description,
        routing=routing,
    )

    # Store the original source verbatim so the convert flow can re-parse it later. The input kind
    # (file/url/paste) is recorded for the catalog's source-material badge when the client sends it
    # (MFI-26.2); for a URL intake the label is also recorded as the source URI so the detail panel
    # can link/redirect back to it.
    input_kind = options.get("input_kind") if isinstance(options, dict) else None
    format_metadata: Dict[str, Any] = {
        "sourceLabel": source_label,
        "inputKind": input_kind or "file",
    }
    format_metadata.update(_source_content_for_persist(intake))
    if input_kind == "url" and source_label:
        format_metadata["sourceUri"] = source_label
    db.set_version_source_format(
        version_record_id,
        tenant_id,
        source_format=model.format,
        protocol=model.paradigm.value,
        format_metadata=format_metadata,
    )

    # REPO-3.3 (#2772): AsyncAPI imports also land Channels/Operations/Messages in the
    # MFI-2.2 tables and promote message payloads/headers into designer Classes.
    if model.format in {"asyncapi-2", "asyncapi-3"} and creator_id:
        from .asyncapi_class_promotion import promote_asyncapi_message_classes

        promote_asyncapi_message_classes(db, version_record_id, model)
        db.persist_canonical_api(
            tenant_id=tenant_id,
            creator_id=creator_id,
            version_id=version_record_id,
            model=model,
        )

    return SpecImportJobResult(
        project_id=project_id,
        project_slug=project_slug,
        version_id=version_id,
        version_record_id=version_record_id,
    )


def _normalize_import_project_slug(slug: str, name: str) -> str:
    """Derive a lowercase project slug from an explicit slug or a display name."""
    base = (slug or "").strip().lower()
    if base:
        return base
    cleaned = "".join(ch if ch.isalnum() else "-" for ch in name.strip().lower())
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or "imported-source"


def _resolve_import_project(
    db: Any,
    *,
    tenant_id: str,
    creator_id: Optional[str],
    name: str,
    slug: str,
    description: Optional[str],
    routing: ImportRoutingDecision,
) -> tuple[str, Optional[str]]:
    """Create or reuse the project row an adapter import persists under.

    Catalog imports (``publishable=False``) reuse an existing live catalog item with the same slug
    so a retry after a partial failure can add another revision instead of violating the unique
    ``(tenant_id, slug)`` constraint. Publishable imports always allocate a fresh unique slug.
    """
    slug_base = _normalize_import_project_slug(slug, name)
    if not routing.publishable:
        existing = db.get_project_by_slug(slug_base, tenant_id)
        if existing and not existing.get("publishable"):
            return str(existing["id"]), existing.get("slug")

    unique_slug = db.allocate_project_slug(tenant_id, slug_base)
    project = db.create_project(
        tenant_id,
        creator_id,
        name,
        unique_slug,
        description,
        None,
        routing.publishable,
    )
    return str(project["id"]), project.get("slug")


def _resolve_import_version(
    db: Any,
    *,
    tenant_id: str,
    project_id: str,
    creator_id: Optional[str],
    version_id: str,
    version_description: Optional[str],
    routing: ImportRoutingDecision,
) -> tuple[str, str]:
    """Create or reuse the version row an adapter import persists under.

    Catalog imports reuse an existing live revision with the same ``version_id`` so a retry after
    a partial failure can refresh source metadata instead of violating the unique
    ``(project_id, version_id)`` constraint. Publishable imports allocate a fresh unique label when
    the requested one is taken.
    """
    if not routing.publishable:
        existing = db.get_version_by_version_id(project_id, version_id, tenant_id)
        if existing:
            return str(existing["id"]), version_id

    unique_version_id = db.allocate_version_id(project_id, version_id)
    version = db.create_version(project_id, creator_id, unique_version_id, version_description)
    return str(version["id"]), unique_version_id


def _name_from_schema_id(schema_id: Any) -> Optional[str]:
    """Derive a type name from a JSON Schema ``$id`` URI, or ``None`` when absent.

    Mirrors :func:`app.jsonschema_import_source._name_from_id` (kept local so the pipeline does
    not import an adapter's private helper): strips a trailing ``.json`` / ``.schema.json`` and
    any URL fragment so ``https://acme.test/user.schema.json`` yields ``user``.
    """
    if not isinstance(schema_id, str) or not schema_id.strip():
        return None
    tail = schema_id.split("#", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    for suffix in (".schema.json", ".json"):
        if tail.endswith(suffix):
            tail = tail[: -len(suffix)]
            break
    return tail or None


def _extract_schema_definitions(document: Dict[str, Any]) -> Dict[str, Any]:
    """Resolve a JSON Schema document into the ``name -> schema`` map to import as types.

    Reads the document's ``$defs`` (2020-12) and ``definitions`` (older drafts) containers —
    the same extraction the primitives ``/import`` endpoint performs
    (:func:`app.primitives_routes._resolve_import_definitions`) so an "as current" import lands
    the same types. When the document declares no such container it is itself a single
    (bare) type schema, named from ``title`` / ``$id`` (falling back to ``Schema``), so a
    single-type JSON Schema still imports rather than failing with "no definitions".

    Args:
        document: The parsed JSON Schema document (a mapping).

    Returns:
        A ``name -> schema fragment`` map ready for the type-registry commit helper.
    """
    definitions: Dict[str, Any] = {}
    defs = document.get("$defs")
    if isinstance(defs, dict):
        definitions.update(defs)
    older = document.get("definitions")
    if isinstance(older, dict):
        definitions.update(older)

    if not definitions:
        title = document.get("title")
        root_name = (
            title
            if isinstance(title, str) and title.strip()
            else _name_from_schema_id(document.get("$id")) or "Schema"
        )
        definitions[str(root_name)] = document

    return definitions


def persist_types_as_current(
    payload: Dict[str, Any],
    model: CanonicalApi,
    intake: _ResolvedIntake,
    routing: ImportRoutingDecision,
) -> Optional[Dict[str, Any]]:
    """Persist a JSON Schema import **as current** into the type registry (MFI-26.8).

    The Types/Projects branch of the §0.3 routing policy: instead of a catalog item, the
    schema's ``$defs`` / ``definitions`` (or the bare root schema) are committed as current
    types via the shared registry importer
    (:func:`app.primitives_routes._commit_imported_definitions`) — the very path the dashboard
    type-import review uses — so the same document lands identical types whether it arrives here
    or through ``POST /{tenant_slug}/import``. Conflicts default to *keep* (the pipeline offers
    no interactive resolution), identical types are deduped, and recognized formats are mapped
    to core types, matching the importer defaults.

    Blocking DB work (the psycopg driver is synchronous) — call via ``asyncio.to_thread``.

    Args:
        payload: The worker payload (``tenant_slug`` / ``tenant_id`` / ``user_id`` / ``metadata``).
        model: The normalized canonical model; its verbatim ``raw`` source is the schema imported.
        intake: The resolved upload; the root member text is parsed when ``model.raw`` is absent.
        routing: The routing decision (``target`` is :attr:`ImportTarget.TYPES`).

    Returns:
        The registry import outcome (``imported`` / ``overwritten`` / … lists), or ``None`` when
        there is no tenant to write under or the source is not a schema mapping.
    """
    tenant_id = str(payload.get("tenant_id") or "")
    if not tenant_id:
        return None

    # Prefer the model's retained raw source (populated with include_raw=True); fall back to
    # re-parsing the decoded text so persistence still works if raw was not carried.
    document: Any = None
    if isinstance(model.raw, dict):
        document = model.raw.get("source")
    if not isinstance(document, dict):
        fallback_text = intake.text
        if fallback_text is None and intake.fileset is not None:
            fallback_text = intake.fileset.root_content()
        try:
            document = json.loads(fallback_text or "")
        except (ValueError, TypeError):
            document = None
    if not isinstance(document, dict):
        logger.warning("types-as-current import had no schema mapping to persist")
        return None

    definitions = _extract_schema_definitions(document)

    metadata = payload.get("metadata") or {}
    options = metadata.get("options") or {}
    target_namespace = options.get("target_namespace") if isinstance(options, dict) else None
    creator_id = str(payload.get("user_id") or "") or None
    tenant_slug = str(payload.get("tenant_slug") or "")

    # Imported lazily to avoid a module-load cycle (primitives_routes pulls in the FastAPI app);
    # the commit helper takes plain arguments and needs no request/auth object.
    from .primitives_routes import _commit_imported_definitions

    return _commit_imported_definitions(
        definitions,
        tenant_id=tenant_id,
        tenant_slug=tenant_slug,
        target_namespace=target_namespace,
        created_by=creator_id,
    )


def _build_summary(
    *,
    adapter: ImportSource,
    model: CanonicalApi,
    fingerprint: str,
    lint: LintReport,
    routing: ImportRoutingDecision,
    options: Dict[str, Any],
    persisted: bool = False,
    types_outcome: Optional[Dict[str, Any]] = None,
    scrub_report: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Assemble the completed-job summary for an adapter import.

    Carries the version fingerprint, what was produced (paradigm/format + entity
    counts), the rolled-up lint outcome (score / grade / fingerprint / severity tally),
    the **routing decision** (MFI-23.7) so the UI can explain where the import landed and why,
    the dry-run/incremental flags the request asked for, and whether the import was
    **persisted** — a non-dry-run import stores its routed artifact (a catalog item for
    non-OpenAPI formats, keeping the original source verbatim). When the JSON Schema
    "as current" branch (MFI-26.8) ran, a ``types_import`` block reports the per-outcome
    registry counts (imported / overwritten / renamed / identical / skipped / errors).
    When intake redacted credentials (IXH-1.4), a ``secret_scrub`` block reports what
    was redacted and where — types and line numbers only, never the values.
    """
    summary: Dict[str, Any] = {
        "source": adapter.key,
        "paradigm": model.paradigm.value,
        "format": model.format,
        "fingerprint": fingerprint,
        "counts": {
            "services": len(model.services),
            "operations": sum(len(s.operations) for s in model.services),
            "types": len(model.types),
            "channels": len(model.channels),
        },
        "lint": {
            "score": lint.score,
            "grade": lint.grade,
            "report_fingerprint": lint.report_fingerprint,
            "findings": len(lint.findings),
            "severity_counts": dict(lint.severity_counts),
        },
        "routing": routing.as_dict(),
        "dry_run": bool(options.get("dry_run")),
        "incremental_mode": bool(options.get("incremental_mode")),
        "persisted": persisted,
    }
    if types_outcome is not None:
        summary["types_import"] = {
            key: len(types_outcome.get(key) or [])
            for key in (
                "imported",
                "overwritten",
                "renamed",
                "identical",
                "skipped",
                "errors",
            )
        }
    if scrub_report is not None:
        summary["secret_scrub"] = scrub_report
    return summary


async def run_adapter_import_job(
    adapter: ImportSource,
    payload: Dict[str, Any],
    *,
    on_snapshot: Optional[Callable[[SpecImportJobStatus], Awaitable[None]]] = None,
    is_canceled: Optional[Callable[[], bool]] = None,
    artifacts: Optional[ImportRunArtifacts] = None,
) -> SpecImportJobStatus:
    """Drive one import-source adapter through the job lifecycle, in-process.

    Runs parse → normalize → version(fingerprint) → lint and returns the terminal
    :class:`SpecImportJobStatus`. After each phase the optional ``on_snapshot``
    coroutine is awaited with the current snapshot (so the engine can publish
    poll-visible progress), and the optional ``is_canceled`` predicate is checked (so
    a delete request between phases stops the run).

    The adapter's parse/normalize/fingerprint/lint calls run inline (see the module
    docstring). A :class:`ImportSourceError` from parse or normalize is a clean,
    user-facing failure (bad document / unsupported format), so it is turned into a
    ``failed`` status rather than propagated.

    Args:
        adapter: The resolved :class:`ImportSource` for the request's source kind.
        payload: The worker payload dict (``document_base64`` + ``metadata`` etc.).
        on_snapshot: Optional coroutine called with each intermediate snapshot.
        is_canceled: Optional predicate; when it returns ``True`` between phases the
            run stops and a ``canceled`` status is returned.
        artifacts: Optional :class:`ImportRunArtifacts` out-parameter; when given, each
            phase records the object it produced (model, fingerprint, lint report,
            routing, style guide) so a caller such as the pre-flight API (IXH-2.1) sees
            the full detail behind the summary without re-running the pipeline.

    Returns:
        The terminal :class:`SpecImportJobStatus` (``completed``/``failed``/``canceled``).
    """
    job_id = str(payload.get("rest_job_id") or "")
    metadata = payload.get("metadata") or {}
    options = metadata.get("options") or {}
    source_label = payload.get("filename")
    state = _AdapterRunState(job_id)
    if artifacts is not None:
        artifacts.adapter_key = adapter.key

    async def publish(status: SpecImportJobStatus) -> None:
        if on_snapshot is not None:
            await on_snapshot(status)

    def canceled() -> bool:
        return is_canceled is not None and is_canceled()

    # --- init -----------------------------------------------------------------
    state.event("ADAPTER_INIT", f"Importing via the {adapter.label!r} source ({adapter.key})")
    if options.get("incremental_mode"):
        state.event(
            "INCREMENTAL_MODE",
            "Incremental mode requested; the in-process adapter path holds no transaction.",
        )
    await publish(state.snapshot(state="running", percent=_PCT_INIT))
    if canceled():
        return state.snapshot(state="canceled", percent=_PCT_INIT)

    # --- parse ----------------------------------------------------------------
    intake: Optional[_ResolvedIntake] = None
    try:
        intake = _resolve_intake(payload, options if isinstance(options, dict) else {})
        if intake.fileset is not None:
            native_ast = adapter.parse_fileset(intake.fileset, source_label=source_label)
        else:
            assert intake.text is not None
            native_ast = adapter.parse(intake.text, source_label=source_label)
    except (ImportSourceError, IntakeLimitError, SecureXmlError) as exc:
        # A resource-limit or unsafe-construct rejection (IXH-1.4) already knows
        # its taxonomy code and must not be re-classified as a malformed document.
        error_code = (
            resolve_intake_error_code(getattr(exc, "code", None))
            if isinstance(exc, (IntakeLimitError, SecureXmlError))
            else None
        ) or _classify_parse_failure(
            exc, adapter, intake.text if intake is not None else None, source_label
        )
        state.event("PARSE_ERROR", str(exc), level="error", context={"error_code": error_code})
        return state.snapshot(
            state="failed",
            percent=_PCT_INIT,
            error=build_job_error(error_code, str(exc)),
        )
    state.event("PARSE_OK", "Parsed source into the format's native representation.")
    await publish(state.snapshot(state="running", percent=_PCT_PARSED))
    if canceled():
        return state.snapshot(state="canceled", percent=_PCT_PARSED)

    # --- normalize ------------------------------------------------------------
    try:
        model = adapter.normalize(native_ast, include_raw=True)
    except (ImportSourceError, IntakeLimitError, SecureXmlError) as exc:
        error_code = resolve_intake_error_code(getattr(exc, "code", None)) or (
            "INPUT_SEMANTIC_INVALID"
        )
        state.event(
            "NORMALIZE_ERROR", str(exc), level="error", context={"error_code": error_code}
        )
        return state.snapshot(
            state="failed",
            percent=_PCT_PARSED,
            error=build_job_error(error_code, str(exc)),
        )
    if artifacts is not None:
        artifacts.model = model
    state.event(
        "NORMALIZE_OK",
        f"Normalized into the canonical model ({model.paradigm.value}/{model.format}).",
    )
    await publish(state.snapshot(state="running", percent=_PCT_NORMALIZED))
    if canceled():
        return state.snapshot(state="canceled", percent=_PCT_NORMALIZED)

    # --- route (Project vs Catalog vs Types) — MFI-23.7 / MFI-26.8 ------------
    # Decide whether this import becomes a publishable Project (OpenAPI/Swagger), a
    # non-publishable catalog item (most non-OpenAPI formats), or — when a JSON Schema import
    # carries the user's explicit ``import_target`` opt-in (MFI-26.7 prompt) — a **current**
    # type/schema in the registry (MFI-26.8). The decision + its reason are recorded on the
    # summary so the UI can explain the routing; the persistence step below reads it to create
    # the right artifact. ``import_target`` is honored only for JSON Schema (see
    # ``decide_import_routing``), so OpenAPI/Arazzo routing cannot regress.
    requested_target = options.get("import_target") if isinstance(options, dict) else None
    routing = decide_import_routing(adapter, model, requested_target=requested_target)
    if artifacts is not None:
        artifacts.routing = routing
    state.event(
        "ROUTING_DECIDED",
        f"Routing → {routing.target.value}: {routing.reason}",
        context=routing.as_dict(),
    )

    # --- version (fingerprint) ------------------------------------------------
    fingerprint = adapter.fingerprint(model)
    if artifacts is not None:
        artifacts.fingerprint = fingerprint
    state.event(
        "VERSION_FINGERPRINT",
        f"Computed revision fingerprint {fingerprint}.",
        context={"fingerprint": fingerprint},
    )
    await publish(state.snapshot(state="running", percent=_PCT_VERSIONED))
    if canceled():
        return state.snapshot(state="canceled", percent=_PCT_VERSIONED)

    # --- lint -----------------------------------------------------------------
    lint = adapter.lint(model)
    # GOV-1.4: re-score the adapter's report under the tenant's resolved style guide
    # (tenant → default; a canonical import has no owning project yet, so the project tier
    # never applies). Resolution is a single indexed read and runs inline like the
    # adapter's own phases — the pipeline task must not really suspend here, since the
    # engine schedules it fire-and-forget and only awaits it opportunistically. Strictly
    # best-effort: any fault leaves the adapter's default-scored report untouched.
    guide_tenant_id = str(payload.get("tenant_id") or "")
    if guide_tenant_id:
        try:
            guide = resolve_style_guide(guide_tenant_id)
            if artifacts is not None:
                artifacts.style_guide = guide
            # Only a *resolved* guide re-scores. Under the in-code fallback the adapter's
            # own roll-up is already the default-guide score, and MFI-4.2 promises the
            # adapter-produced report is persisted verbatim. An unscored report has
            # nothing to re-score either (``apply`` returns it untouched).
            if lint.score is not None and guide.source != FALLBACK_GUIDE_SOURCE:
                lint = apply_style_guide_to_lint_report(lint, guide)
        except Exception:  # noqa: BLE001 - guide application must never fail the import
            logger.warning(
                "Style-guide application failed for import job %s; keeping default score",
                job_id,
                exc_info=True,
            )
    if artifacts is not None:
        artifacts.lint = lint
    state.event(
        "LINT_COMPLETED",
        f"Lint produced {len(lint.findings)} finding(s)"
        + (f", score {lint.score}" if lint.score is not None else "")
        + ".",
    )
    await publish(state.snapshot(state="running", percent=_PCT_LINTED))

    # --- persist -------------------------------------------------------------
    # A non-dry-run import stores its routed artifact. Two persistence paths:
    #   * ``TYPES`` (MFI-26.8) — a JSON Schema the user opted to import *as current* commits its
    #     types into the registry (no catalog item, no project), via ``persist_types_as_current``.
    #   * everything else (catalog/project hook, MFI-23.7) — a non-publishable **catalog item**
    #     for every non-OpenAPI format, keeping the *original source verbatim* in the revision's
    #     format_metadata so the user can convert it to OpenAPI later (MFI-EPIC-22); nothing is
    #     converted at import time.
    # The DB driver is blocking, so the write runs off-thread. A persistence failure fails the job
    # (unlike the best-effort quality capture) since without it the import produced nothing.
    result: Optional[SpecImportJobResult] = None
    types_outcome: Optional[Dict[str, Any]] = None
    tenant_id = str(payload.get("tenant_id") or "")
    imports_as_types = routing.target is ImportTarget.TYPES
    if not options.get("dry_run") and not adapter.preview_only:
        try:
            if imports_as_types:
                types_outcome = await asyncio.to_thread(
                    persist_types_as_current, payload, model, intake, routing
                )
            else:
                result = await asyncio.to_thread(
                    persist_adapter_import, payload, model, intake, routing
                )
        except Exception as exc:  # noqa: BLE001 - surface a persistence fault as a failed job
            logger.exception("adapter import persistence failed job=%s", job_id)
            state.event(
                "PERSIST_ERROR",
                f"Failed to store the import: {exc}",
                level="error",
                context={"error_code": "INTERNAL_PERSIST_FAULT"},
            )
            return state.snapshot(
                state="failed",
                percent=_PCT_LINTED,
                error=build_job_error(
                    "INTERNAL_PERSIST_FAULT", f"Failed to store the import: {exc}"
                ),
            )

    if types_outcome is not None:
        imported = types_outcome.get("imported") or []
        overwritten = types_outcome.get("overwritten") or []
        renamed = types_outcome.get("renamed") or []
        state.event(
            "PERSISTED",
            f"Imported JSON Schema as current type/schema: "
            f"{len(imported)} created, {len(overwritten)} overwritten, {len(renamed)} renamed "
            "(no catalog item created).",
            context={
                "target": routing.target.value,
                "imported": len(imported),
                "overwritten": len(overwritten),
                "renamed": len(renamed),
                "errors": len(types_outcome.get("errors") or []),
            },
        )
    elif result is not None:
        state.event(
            "PERSISTED",
            f"Stored {routing.target.value} item {result.project_id} "
            f"(revision {result.version_record_id}); the original source was kept verbatim "
            "for later conversion.",
            context={
                "project_id": result.project_id,
                "version_record_id": result.version_record_id,
                "publishable": routing.publishable,
            },
        )
        # Capture the rolled-up quality score onto the freshly created revision (MFI-4.2).
        if result.version_record_id and tenant_id:
            await asyncio.to_thread(
                capture_canonical_quality_score, result.version_record_id, tenant_id, lint
            )
            state.event(
                "QUALITY_CAPTURED",
                f"Captured quality score onto revision {result.version_record_id}.",
            )

    # --- finalize -------------------------------------------------------------
    # Report what intake redacted (IXH-1.4). The scrub itself happens inside the
    # persistence hook — this recomputes the report so a dry run surfaces the same
    # findings without writing, and so the summary records them either way.
    _fields, scrub_report = scrub_intake_source(intake)
    if artifacts is not None:
        artifacts.scrub_report = scrub_report
    if scrub_report.get("scrubbed"):
        state.event(
            "SECRETS_REDACTED",
            f"Redacted {scrub_report['redactions']} credential value(s) from the stored "
            f"source ({', '.join(scrub_report['secret_types'])})"
            + ("; the verbatim archive was withheld." if scrub_report.get("source_withheld") else "."),
            level="warn",
            context={"secret_types": scrub_report["secret_types"]},
        )
    summary = _build_summary(
        adapter=adapter,
        model=model,
        fingerprint=fingerprint,
        lint=lint,
        routing=routing,
        options=options,
        persisted=result is not None or types_outcome is not None,
        types_outcome=types_outcome,
        scrub_report=scrub_report,
    )
    if options.get("dry_run"):
        state.event("DRY_RUN", "Dry run: the normalized model was not persisted.")
        state.event("IMPORT_COMPLETED", "Import-source pipeline completed (dry run; no catalog write).")
    elif imports_as_types:
        state.event(
            "IMPORT_COMPLETED",
            "Import-source pipeline completed; the JSON Schema was imported as a current type/schema.",
        )
    else:
        state.event(
            "IMPORT_COMPLETED",
            "Import-source pipeline completed; the source was stored in the catalog unconverted.",
        )
    return state.snapshot(state="completed", percent=_PCT_DONE, summary=summary, result=result)

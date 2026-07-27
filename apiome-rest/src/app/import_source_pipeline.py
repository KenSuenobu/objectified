"""In-process import-source job pipeline — MFI-1.2 (#3734).

The spec-import job engine (:mod:`app.spec_import_engine`) was OpenAPI-shaped: every
job ran the ``apiome-ui`` ``tsx`` worker, which only knows how to import an
OpenAPI/Swagger document. MFI-1.1 (#3733) introduced the :class:`ImportSource` SPI so
a *format* is added by registering an adapter; this module is the generalized engine
step that **drives any such adapter through the existing job lifecycle** —
parse → normalize → version → lint — emitting the same
:class:`~app.models.SpecImportJobStatus` contract the worker already produces.

The phases map onto the SPI:

* **parse** — :meth:`ImportSource.parse` turns the raw document text into the
  format's native AST;
* **analyze** — :meth:`ImportSource.analyze` describes that AST as a bounded native
  payload analysis (CPDO-1.2) *before* normalization reduces it. This is the last
  moment the whole native structure exists: an X12 interchange normalizes from one
  functional group's first transaction set, so anything else it carried survives
  only because it was analysed here. The record is written after persistence, since
  it is scoped to the revision persistence creates, and a failure at either point is
  reported without failing the import;
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
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from .archive_intake import ArchiveIntakeError, is_archive_payload, unpack_archive
from .canonical_model import CanonicalApi
from .config import settings
from .fileset import IntakeFileset
from .import_ingestion import IngestionError, parse_document
from .import_routing import ImportRoutingDecision, ImportTarget, decide_import_routing
from .import_source import (
    DetectionInput,
    ImportSource,
    ImportSourceError,
    LintReport,
    detect_import_source,
)
from .intake_error_taxonomy import descriptor_for, resolve_intake_error_code
from .intake_resource_guard import (
    IntakeLimitError,
    guard_expansion_ratio,
    guard_payload_bytes,
    resolve_guard_profile,
    stage_memory_tracker,
    stage_wall_clock,
)
from .intake_streaming import cleanup_intake_tempfile
from .intake_scrub_policy import (
    DEFAULT_POLICY as DEFAULT_SCRUB_POLICY,
    ScrubResolution,
    load_tenant_scrub_policy,
    resolve_scrub_mode,
)
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
from .payload_analysis import (
    REASON_ANALYZER_FAILED,
    STATUS_FAILED,
    PayloadAnalysisDocument,
    unavailable_document,
)
from .payload_analyzer import analyze_import
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
    "analysed_source",
    "analysis_summary_block",
    "build_job_error",
    "capture_canonical_quality_score",
    "run_adapter_import_job",
    "run_import_analysis",
    "store_import_analysis",
]


# Event codes the in-process adapter pipeline emits for each phase. Surfaced at INFO
# by the engine's event logger (mirrors the worker's PHASE_TIMING/BENCHMARK codes) so
# an adapter import's progress is readable in the REST logs as it runs.
ADAPTER_PHASE_EVENT_CODES = frozenset(
    {
        "ADAPTER_INIT",
        "PARSE_OK",
        "PAYLOAD_ANALYZED",
        "PAYLOAD_ANALYSIS_STORED",
        "PAYLOAD_ANALYSIS_STORE_FAILED",
        "NORMALIZE_OK",
        "ROUTING_DECIDED",
        "VERSION_FINGERPRINT",
        "INCREMENTAL_MODE",
        "DRY_RUN",
        "LINT_COMPLETED",
        "QUALITY_CAPTURED",
        "SECRETS_REDACTED",
        "REMOTE_REFS_RESOLVED",
        "REMOTE_REFS_UNRESOLVED",
        "REMOTE_REFS_BLOCKED",
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
        remote_refs: The MFI-29.4 remote ``$ref`` resolution outcome, when the adapter's
            format can carry external references and the intake had any. Typed loosely to
            keep the resolver module off this module's import path.
        analysis: The CPDO-1.2 native payload analysis produced after parse. Carries observed
            values as the analyzer saw them — the redaction policy is applied by the store on
            the way in, so a caller reading this out-parameter is reading pre-policy material
            and must not surface it.
    """

    adapter_key: Optional[str] = None
    model: Optional[CanonicalApi] = None
    fingerprint: Optional[str] = None
    lint: Optional[LintReport] = None
    routing: Optional[ImportRoutingDecision] = None
    style_guide: Optional[Any] = None
    scrub_report: Optional[Dict[str, Any]] = None
    remote_refs: Optional[Any] = None
    analysis: Optional[PayloadAnalysisDocument] = None


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


def build_job_error(
    code: Optional[str],
    message: str,
    *,
    correlation_id: Optional[str] = None,
) -> SpecImportJobError:
    """Build the terminal :class:`SpecImportJobError` for a failed job.

    ``code`` may be a taxonomy code, a legacy event/engine code, or ``None``;
    anything unrecognized falls back to ``INTERNAL_ADAPTER_FAULT`` so a failed job
    always carries a valid taxonomy code with non-empty remediation (IXH-1.3).

    Internal-category codes never echo a bare stringified exception: the user-facing
    ``message`` is a generic sentence that includes ``correlation_id`` (typically the
    job id) when provided (IXH-6.4).
    """
    from .intake_error_taxonomy import JobErrorCategory

    resolved = resolve_intake_error_code(code) or "INTERNAL_ADAPTER_FAULT"
    descriptor = descriptor_for(resolved)
    assert descriptor is not None  # every resolved code is registered
    if descriptor.category is JobErrorCategory.INTERNAL:
        if correlation_id:
            safe_message = (
                f"An internal error occurred while processing this request "
                f"(correlation id: {correlation_id})."
            )
        else:
            safe_message = (
                "An internal error occurred while processing this request. "
                "Retry once, and if it persists report the job id to support."
            )
    else:
        safe_message = message
    return SpecImportJobError(
        code=descriptor.code,
        category=descriptor.category.value,
        message=safe_message,
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
    """Decode the worker payload into raw bytes.

    Prefers a streamed tempfile path (``document_path``, IXH-6.5) so large
    multipart uploads are not base64-doubled in memory. Falls back to
    ``document_base64`` for JSON intake and legacy workers.

    Raises:
        ImportSourceError: If neither path nor base64 is usable.
    """
    path = payload.get("document_path")
    if isinstance(path, str) and path.strip():
        try:
            return Path(path).read_bytes()
        except OSError as exc:
            raise ImportSourceError(
                f"document_path could not be read: {exc}", code="INPUT_EMPTY"
            ) from exc

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
    tenant_id = payload.get("tenant_id")
    profile = resolve_guard_profile(
        tenant_id=str(tenant_id) if isinstance(tenant_id, str) else None
    )
    limits = profile.limits
    archive_root = options.get("archive_root") if isinstance(options, dict) else None
    if isinstance(archive_root, str):
        archive_root = archive_root.strip() or None
    else:
        archive_root = None

    if not is_archive_payload(raw_bytes, source_label if isinstance(source_label, str) else None):
        # IXH-1.4 / IXH-6.5: cap the single-document payload on its *bytes*, before
        # decoding to text (which would double the footprint) and before any adapter
        # sees it — text-only formats never reach the JSON/YAML guard in parse_document.
        # Archives keep their own, larger budget enforced inside unpack_archive.
        guard_payload_bytes(
            raw_bytes,
            source_label=source_label if isinstance(source_label, str) else None,
            limits=limits,
        )
        text = raw_bytes.decode("utf-8", errors="replace")
        decoded_len = len(text.encode("utf-8", errors="replace"))
        guard_expansion_ratio(
            raw_bytes=len(raw_bytes),
            expanded_bytes=decoded_len,
            source_label=source_label if isinstance(source_label, str) else None,
            limits=limits,
        )
        return _ResolvedIntake(
            raw_bytes=raw_bytes,
            text=text,
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
        raise ImportSourceError(
            str(exc), code=getattr(exc, "code", None) or "INPUT_ARCHIVE_INVALID"
        ) from exc

    fileset = IntakeFileset.from_members(unpacked.members, root=unpacked.root_path)
    return _ResolvedIntake(
        raw_bytes=raw_bytes,
        text=None,
        fileset=fileset,
        archive_root=unpacked.root_path,
    )


@dataclass(frozen=True)
class _RemoteRefResolution:
    """What the MFI-29.4 resolver produced for one intake.

    Attributes:
        text: The rewritten single-document text to parse, or ``None`` when the document was
            not changed (nothing inlined) and the original text should be parsed.
        fileset: The rewritten fileset to parse, or ``None`` when no member changed.
        outcome: The resolver's :class:`~app.remote_ref_resolver.RemoteRefOutcome`.
    """

    text: Optional[str]
    fileset: Optional[IntakeFileset]
    outcome: Any


def _parse_intake_documents(intake: _ResolvedIntake) -> Dict[str, Any]:
    """Parse the intake into ``label → document`` for reference scanning.

    A single document is labelled ``""``; a fileset's members are labelled by member path.
    Members that are not JSON/YAML (a ``.proto`` in a mixed archive, a README) are skipped —
    they cannot carry a ``$ref`` — and so is a document that does not parse at all, since the
    adapter's own ``parse`` is what must report that error.
    """
    documents: Dict[str, Any] = {}
    if intake.fileset is not None:
        for path, text in intake.fileset.members.items():
            try:
                documents[path] = parse_document(text, source_label=path)
            except (IngestionError, IntakeLimitError):
                continue
        return documents
    if intake.text is None:  # pragma: no cover - one of text/fileset is always set
        return documents
    try:
        documents[""] = parse_document(intake.text)
    except (IngestionError, IntakeLimitError):
        return {}
    return documents


def resolve_intake_remote_refs(
    adapter: ImportSource,
    intake: _ResolvedIntake,
    options: Dict[str, Any],
) -> Optional[_RemoteRefResolution]:
    """Run the shared remote ``$ref`` resolver over an intake before parse (MFI-29.4).

    Only formats that can reference other documents by URL are scanned
    (:attr:`ImportSource.supports_remote_refs`). Whether references are actually *fetched*
    is the import's explicit opt-in (``options['resolve_remote_refs']``), further gated by
    the ``remote_ref_resolution_allowed`` deployment kill switch; with fetching off the
    documents are only scanned, so the run reports what the model is missing without
    touching the network.

    Resolution rewrites what the **adapter parses** — inlined before normalization and
    therefore before the fingerprint — while the intake itself is left untouched, so the
    verbatim source the catalog persists is still exactly what the user submitted.

    Args:
        adapter: The resolved adapter for this import.
        intake: The classified intake (single document or fileset).
        options: The request's importer options.

    Returns:
        The :class:`_RemoteRefResolution` for the run, or ``None`` when the format cannot
        carry external references, the intake did not parse, or it contains none — in which
        case the import behaves exactly as it did before this feature existed.
    """
    if not adapter.supports_remote_refs:
        return None

    from .remote_ref_resolver import resolve_remote_refs

    documents = _parse_intake_documents(intake)
    if not documents:
        return None

    enabled = bool(options.get("resolve_remote_refs")) and bool(
        settings.remote_ref_resolution_allowed
    )
    outcome = resolve_remote_refs(documents, enabled=enabled)
    if not outcome.resolved and not outcome.unresolved:
        return None

    text: Optional[str] = None
    fileset: Optional[IntakeFileset] = None
    if outcome.changed_documents:
        if intake.fileset is not None:
            members = dict(intake.fileset.members)
            for label in outcome.changed_documents:
                members[label] = json.dumps(
                    outcome.documents[label], separators=(",", ":")
                )
            fileset = IntakeFileset.from_members(members, root=intake.fileset.root)
        else:
            # Key order is preserved (never sorted): a JSON Schema's ``properties`` order
            # carries into the canonical model's field order, so re-serializing sorted would
            # give a resolved import a different fingerprint than the same document inlined
            # by hand.
            text = json.dumps(outcome.documents[""], separators=(",", ":"))
    return _RemoteRefResolution(text=text, fileset=fileset, outcome=outcome)


def _emit_remote_ref_events(state: "_AdapterRunState", outcome: Any) -> None:
    """Record what remote ``$ref`` resolution did, as poll-visible job events (MFI-29.4).

    Emits at most three events: what was inlined (only when resolution ran), what was left
    unresolved, and — separately, because it is a security-relevant signal rather than a
    completeness one — what the SSRF guard refused.

    Args:
        state: The run's event accumulator.
        outcome: The resolver's ``RemoteRefOutcome``.
    """
    if outcome.enabled and outcome.resolved:
        state.event(
            "REMOTE_REFS_RESOLVED",
            f"Inlined {len(outcome.resolved)} external $ref(s) "
            f"({outcome.cache_hits} from cache, {outcome.fetched_bytes} bytes fetched).",
            context={
                "resolved": len(outcome.resolved),
                "cache_hits": outcome.cache_hits,
                "fetched_bytes": outcome.fetched_bytes,
            },
        )
    unresolved = [ref for ref in outcome.unresolved if not ref.blocked]
    if unresolved:
        reasons = sorted({ref.reason for ref in unresolved})
        state.event(
            "REMOTE_REFS_UNRESOLVED",
            f"{len(unresolved)} external $ref(s) were not resolved ({', '.join(reasons)}); "
            "the definitions they name are missing from the imported model.",
            level="warn",
            context={"unresolved": len(unresolved), "reasons": reasons},
        )
    blocked = list(outcome.blocked)
    if blocked:
        state.event(
            "REMOTE_REFS_BLOCKED",
            f"The SSRF guard refused {len(blocked)} external $ref URL(s); nothing was fetched "
            "from them.",
            level="warn",
            context={"blocked": len(blocked), "urls": sorted({ref.url for ref in blocked})[:10]},
        )


def scrub_intake_source(
    intake: _ResolvedIntake,
    resolution: Optional[ScrubResolution] = None,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Build the persisted source fields with credentials removed (IXH-1.4, MFI-29.6).

    Intake stores the upload verbatim so it can be converted later (MFI-23.9), which
    means a document carrying a live token would persist that token. Every source
    is therefore scanned first (:mod:`app.intake_secret_scrub`), and what happens to
    what it finds is the tenant's ``enforce`` / ``warn_only`` decision
    (:mod:`app.intake_scrub_policy`).

    Under **enforce** (the default):

    * **single document** — secret *values* are replaced in place, so the stored
      source stays parseable and structurally identical (values only);
    * **archive** — the stored blob is the original bytes, which cannot be rewritten
      safely, so when any member carries a secret the verbatim blob is **withheld**
      rather than persisted. The member list and root still persist, so the catalog
      item is complete; only the re-downloadable source is dropped.

    Under **warn_only** the detection is identical and the report is identical, but the
    content is persisted exactly as uploaded — no redaction, and no withheld archive.
    That is the whole point of the mode: it shows a tenant what enforcement would do
    before it does it. The report says so (``mode``/``applied``), so a reader can never
    mistake a warn-only summary for a redacted source.

    Args:
        intake: The resolved intake (single text document or unpacked fileset).
        resolution: The resolved tenant scrub mode. Defaults to enforce with entropy
            detection on, so a caller that has no tenant context still scrubs.

    Returns:
        ``(source_fields, scrub_report)`` — the ``format_metadata`` source fields to
        persist, and the report (types and line numbers, never values) recorded on
        the job summary.
    """
    effective = resolution or resolve_scrub_mode(DEFAULT_SCRUB_POLICY)
    entropy = effective.entropy_detection

    if intake.fileset is not None:
        findings: List[ScrubFinding] = []
        # A line number alone is ambiguous across an archive, so the report also names the
        # members that carried something — enough for an operator to find and rotate the
        # credential, still without quoting it.
        affected_members: List[str] = []
        for member_path in sorted(intake.fileset.members):
            outcome = scrub_document_text(
                intake.fileset.members[member_path], entropy_detection=entropy
            )
            if outcome.scrubbed:
                affected_members.append(member_path)
            findings.extend(outcome.findings)
        combined = ScrubOutcome(text="", findings=findings)
        # An archive's blob is only withheld when the policy is actually enforcing;
        # warn-only keeps the upload whole so the tenant can still re-download it.
        withhold = combined.scrubbed and effective.enforced
        fields: Dict[str, Any] = {
            "intakeKind": "archive",
            "filesetRoot": intake.fileset.root,
            "filesetMembers": sorted(intake.fileset.members.keys()),
        }
        if withhold:
            fields["sourceContent"] = None
            fields["sourceWithheld"] = "secrets-detected"
        else:
            fields["sourceContent"] = base64.standard_b64encode(intake.raw_bytes).decode("ascii")
            fields["sourceEncoding"] = "base64"
        report = combined.report()
        report["source_withheld"] = withhold
        report["members"] = affected_members
        report.update(effective.as_report_fields())
        return fields, report

    assert intake.text is not None
    outcome = scrub_document_text(intake.text, entropy_detection=entropy)
    report = outcome.report()
    report["source_withheld"] = False
    report.update(effective.as_report_fields())
    stored_text = outcome.text if effective.enforced else intake.text
    return {"sourceContent": stored_text, "intakeKind": "file"}, report


def _source_content_for_persist(
    intake: _ResolvedIntake, resolution: Optional[ScrubResolution] = None
) -> Dict[str, Any]:
    """Build format_metadata source fields, credentials scrubbed.

    Thin wrapper over :func:`scrub_intake_source` for callers that do not need the
    scrub report.
    """
    fields, _report = scrub_intake_source(intake, resolution)
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


def analysed_source(
    intake: _ResolvedIntake,
    remote_refs: Optional[_RemoteRefResolution],
) -> Optional[Any]:
    """Return the exact material the adapter parsed, for the analysis to name (CPDO-1.2).

    The analysis record's ``source_hash`` has to identify *what was analysed*, which is what was
    parsed — so for a single document that is the remote-``$ref``-resolved text when resolution
    rewrote it, and the intake text otherwise; for an archive it is the uploaded bytes, since the
    fileset as a whole is what the adapter read.

    Note this is the intake **as submitted**, which is not always byte-identical to the copy the
    catalog stores: under an enforcing secret-scrub policy (IXH-1.4 / MFI-29.6) the stored source has
    its credential values replaced. The hash names the bytes the analyzer actually read, because that
    is the only claim it can honestly make.

    Args:
        intake: The resolved intake.
        remote_refs: The remote-``$ref`` resolution outcome, when one ran.

    Returns:
        The analysed text or bytes, or ``None`` when the intake carried neither (which yields a
        declared ``no_source_captured`` record rather than an invented one).
    """
    if intake.fileset is not None:
        return intake.raw_bytes
    return (remote_refs.text if remote_refs is not None else None) or intake.text


def run_import_analysis(
    adapter: ImportSource,
    native_ast: Any,
    intake: _ResolvedIntake,
    remote_refs: Optional[_RemoteRefResolution],
    *,
    profile: Any = None,
    source_label: Optional[str] = None,
) -> PayloadAnalysisDocument:
    """Analyse the freshly parsed AST, under the intake stage budget, without failing the import.

    Runs between parse and normalize, while the native AST is still in hand — the point of the whole
    exercise being that an X12 envelope or a copybook level survives the import instead of being
    re-derived by whatever parser is installed at read time.

    Two things can go wrong, and neither is allowed to fail an import that otherwise succeeded:
    the analyzer can raise (:func:`app.payload_analyzer.analyze_import` catches that and returns a
    declared ``failed`` record), or it can overrun the per-stage wall clock on a pathological source.
    The second is caught here and degraded the same way, because an analysis is *evidence about* an
    import rather than part of it. Both outcomes are explicit: a record naming the analyzer and the
    reason, surfaced as a job event and in the summary.

    Args:
        adapter: The adapter that parsed the source.
        native_ast: The AST it produced.
        intake: The resolved intake.
        remote_refs: The remote-``$ref`` resolution outcome, when one ran.
        profile: The tenant's resolved intake guard profile.
        source_label: Filename/URL label, used in guard messages.

    Returns:
        The analysis document; never ``None``.
    """
    try:
        with stage_wall_clock("analyze", limits=profile, source_label=source_label):
            return analyze_import(
                adapter, native_ast, source=analysed_source(intake, remote_refs)
            )
    except Exception as exc:  # noqa: BLE001 - an analysis must never fail an import
        logger.warning(
            "payload analysis aborted for adapter %r: %s",
            adapter.key,
            type(exc).__name__,
            exc_info=True,
        )
        return unavailable_document(
            REASON_ANALYZER_FAILED,
            source_format=adapter.key,
            message=(
                f"The {adapter.analyzer_key!r} payload analyzer did not complete "
                f"({type(exc).__name__})."
            ),
            analyzer=adapter.analyzer_info(),
            capabilities=adapter.analysis_capabilities(),
            failed=True,
        )


def store_import_analysis(
    payload: Dict[str, Any],
    result: SpecImportJobResult,
    document: PayloadAnalysisDocument,
) -> Optional[str]:
    """Record an import's analysis against the revision it describes (CPDO-1.2).

    Called after persistence, because the analysis is scoped to a *revision* and the revision is
    what persistence creates. The write goes through
    :func:`app.payload_analysis_store.store_analysis`, so the value-visibility policy is applied and
    the contract validated on the way in — observed values reach the store only as far as policy
    allows, and never at all under the default.

    It is idempotent by content: a re-import that produced an identical analysis for the same
    revision (a catalog re-import reuses its revision when the version label is unchanged) returns
    the existing row rather than appending a redundant sequence.

    Blocking DB work (the psycopg driver is synchronous) — call via ``asyncio.to_thread``.

    Args:
        payload: The worker payload (``tenant_id`` / ``user_id``).
        result: The persistence result naming the created project and revision.
        document: The analysis to record.

    Returns:
        The stored record's id, or ``None`` when there was no tenant/revision to store against.
    """
    from .payload_analysis_store import store_analysis

    tenant_id = str(payload.get("tenant_id") or "")
    version_record_id = result.version_record_id
    project_id = result.project_id
    if not tenant_id or not version_record_id or not project_id:
        return None

    record = store_analysis(
        tenant_id=tenant_id,
        project_id=str(project_id),
        version_id=str(version_record_id),
        document=document,
        created_by=str(payload.get("user_id") or "") or None,
    )
    return record.analysis_id if record is not None else None


def analysis_summary_block(
    document: PayloadAnalysisDocument, *, stored: bool
) -> Dict[str, Any]:
    """Project an analysis onto the block the completed job's summary carries.

    Counts and status only — never a node, never a value — so the summary of an import stays safe to
    show to anyone who may see the import at all. ``unsupported`` is included because it is the
    difference between "this source had no functional groups" and "this analyzer does not model
    them", and a summary that omitted it would leave a reader guessing.

    Args:
        document: The analysis produced for the import.
        stored: Whether it was written against a revision (a dry run has none).

    Returns:
        The ``analysis`` block for the job summary.
    """
    return {
        "status": document.status,
        "status_reason": document.status_reason,
        "analyzer": document.analyzer.key,
        "analyzer_version": document.analyzer.version,
        "node_count": document.metrics.node_count,
        "max_depth": document.metrics.max_depth,
        "truncated": document.metrics.truncated,
        "dropped_nodes": document.metrics.dropped_node_count,
        "warnings": len(document.warnings),
        "unsupported": list(document.capabilities.unsupported),
        "stored": stored,
    }


def persist_adapter_import(
    payload: Dict[str, Any],
    model: CanonicalApi,
    intake: _ResolvedIntake,
    routing: ImportRoutingDecision,
    scrub_resolution: Optional[ScrubResolution] = None,
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
        scrub_resolution: The tenant's resolved secret-scrub mode (MFI-29.6). ``None`` means
            enforce, so a caller with no tenant policy context still redacts.

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
    format_metadata.update(_source_content_for_persist(intake, scrub_resolution))
    if input_kind == "url" and source_label:
        format_metadata["sourceUri"] = source_label
    # MFI-29.3: a git-sourced fileset arrives as the same packed archive an upload
    # would, so the intake fields above describe it correctly — provenance only adds
    # where those bytes came from, and re-labels the intake kind 'git'.
    git_source = options.get("git_source") if isinstance(options, dict) else None
    if isinstance(git_source, dict) and git_source.get("repo_url"):
        from .git_intake import git_provenance_metadata

        format_metadata.update(git_provenance_metadata(git_source))
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
    remote_ref_report: Optional[Dict[str, Any]] = None,
    analysis_report: Optional[Dict[str, Any]] = None,
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
    When intake found credentials (IXH-1.4), a ``secret_scrub`` block reports what was
    found and where — types and line numbers only, never the values — together with the
    tenant scrub mode that governed it (MFI-29.6): ``mode``/``applied`` say whether the
    stored source was actually redacted or merely reported on, and ``policy_tier`` names the
    resolution tier that decided it. When the source
    carried external ``$ref``\\s (MFI-29.4), a ``remote_refs`` block reports what was inlined
    and what was not, with the reason for each. An ``analysis`` block (CPDO-1.2) reports the native
    payload analysis: its status, the analyzer that produced it, how much of the source it covered,
    and whether it was stored against the revision.
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
    if remote_ref_report is not None:
        summary["remote_refs"] = remote_ref_report
    if analysis_report is not None:
        summary["analysis"] = analysis_report
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

    # Resolve the tenant's secret-scrub mode once, up front (MFI-29.6): the persistence hook
    # and the finalize report must agree on it, and a mode that changed mid-run would make the
    # summary describe something other than what was stored. The lookup is a synchronous, quick
    # DB read that degrades to enforce — this coroutine must not gain a real suspension point
    # (the engine schedules it fire-and-forget; see the module docstring).
    scrub_resolution = resolve_scrub_mode(
        load_tenant_scrub_policy(str(payload.get("tenant_id") or "") or None),
        format_key=adapter.key,
    )

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
    remote_refs: Optional[_RemoteRefResolution] = None
    tenant_id = payload.get("tenant_id")
    profile = resolve_guard_profile(
        tenant_id=str(tenant_id) if isinstance(tenant_id, str) else None
    )
    stage_label = source_label if isinstance(source_label, str) else None
    try:
        with stage_wall_clock("parse", limits=profile, source_label=stage_label):
            with stage_memory_tracker(limits=profile, source_label=stage_label):
                intake = _resolve_intake(payload, options if isinstance(options, dict) else {})
        # Remote `$ref` resolution (MFI-29.4) runs between intake and parse, under its own
        # stage budget: it is the only intake step that touches the network, so it must not
        # eat into the parse stage's wall clock (its own deadline is the tighter bound).
        with stage_wall_clock("remote-refs", limits=profile, source_label=stage_label):
            remote_refs = resolve_intake_remote_refs(
                adapter, intake, options if isinstance(options, dict) else {}
            )
        with stage_wall_clock("parse", limits=profile, source_label=stage_label):
            with stage_memory_tracker(limits=profile, source_label=stage_label):
                if intake.fileset is not None:
                    native_ast = adapter.parse_fileset(
                        (remote_refs.fileset if remote_refs else None) or intake.fileset,
                        source_label=source_label,
                    )
                else:
                    assert intake.text is not None
                    native_ast = adapter.parse(
                        (remote_refs.text if remote_refs else None) or intake.text,
                        source_label=source_label,
                    )
    except (ImportSourceError, IntakeLimitError, SecureXmlError) as exc:
        # A resource-limit or unsafe-construct rejection (IXH-1.4 / IXH-6.5) already knows
        # its taxonomy code and must not be re-classified as a malformed document.
        error_code = (
            resolve_intake_error_code(getattr(exc, "code", None))
            if isinstance(exc, (IntakeLimitError, SecureXmlError))
            else None
        ) or _classify_parse_failure(
            exc, adapter, intake.text if intake is not None else None, source_label
        )
        state.event("PARSE_ERROR", str(exc), level="error", context={"error_code": error_code})
        cleanup_intake_tempfile(payload.get("document_path"))
        return state.snapshot(
            state="failed",
            percent=_PCT_INIT,
            error=build_job_error(error_code, str(exc), correlation_id=job_id),
        )
    if remote_refs is not None:
        _emit_remote_ref_events(state, remote_refs.outcome)
        if artifacts is not None:
            artifacts.remote_refs = remote_refs.outcome
    state.event("PARSE_OK", "Parsed source into the format's native representation.")

    # --- analyze (CPDO-1.2) ----------------------------------------------------
    # After parse, before persistence, while the native AST is still in hand. Normalization is
    # about to reduce it to the canonical model — for X12 that means one functional group's first
    # transaction set — so this is the last moment the whole native structure exists. The record is
    # stored after persistence (below), because it is scoped to the revision persistence creates.
    analysis = run_import_analysis(
        adapter,
        native_ast,
        intake,
        remote_refs,
        profile=profile,
        source_label=stage_label,
    )
    if artifacts is not None:
        artifacts.analysis = analysis
    state.event(
        "PAYLOAD_ANALYZED",
        f"Native payload analysis is {analysis.status}"
        + (f" ({analysis.status_reason})" if analysis.status_reason else "")
        + f"; {analysis.metrics.node_count} node(s) from the {analysis.analyzer.key!r} analyzer.",
        level="warn" if analysis.status == STATUS_FAILED else "info",
        context={
            "status": analysis.status,
            "status_reason": analysis.status_reason,
            "analyzer": analysis.analyzer.key,
            "analyzer_version": analysis.analyzer.version,
            "node_count": analysis.metrics.node_count,
            "truncated": analysis.metrics.truncated,
        },
    )

    await publish(state.snapshot(state="running", percent=_PCT_PARSED))
    if canceled():
        cleanup_intake_tempfile(payload.get("document_path"))
        return state.snapshot(state="canceled", percent=_PCT_PARSED)

    # --- normalize ------------------------------------------------------------
    try:
        with stage_wall_clock(
            "normalize",
            limits=profile,
            source_label=source_label if isinstance(source_label, str) else None,
        ):
            with stage_memory_tracker(
                limits=profile,
                source_label=source_label if isinstance(source_label, str) else None,
            ):
                model = adapter.normalize(native_ast, include_raw=True)
    except (ImportSourceError, IntakeLimitError, SecureXmlError) as exc:
        error_code = resolve_intake_error_code(getattr(exc, "code", None)) or (
            "INPUT_SEMANTIC_INVALID"
        )
        state.event(
            "NORMALIZE_ERROR", str(exc), level="error", context={"error_code": error_code}
        )
        cleanup_intake_tempfile(payload.get("document_path"))
        return state.snapshot(
            state="failed",
            percent=_PCT_PARSED,
            error=build_job_error(error_code, str(exc), correlation_id=job_id),
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
    # MFI-29.4: fold in what remote `$ref` resolution could not resolve. These findings are
    # merged *before* the style guide is applied, so a tenant governs them (severity override,
    # disable) exactly like any other registered rule.
    if remote_refs is not None:
        lint = lint.with_extra_findings(remote_refs.outcome.findings())
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
    analysis_stored = False
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
                    persist_adapter_import, payload, model, intake, routing, scrub_resolution
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
                    "INTERNAL_PERSIST_FAULT",
                    f"Failed to store the import: {exc}",
                    correlation_id=job_id,
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

        # Record the native analysis against the revision it describes (CPDO-1.2). Best-effort by
        # design: the revision is already committed and the source is already in the catalog, so a
        # store fault costs an analysis, not an import. It is reported rather than swallowed — an
        # analysis that silently failed to persist would read back as "this revision was never
        # analysed", which is a different and untrue fact.
        try:
            analysis_id = await asyncio.to_thread(
                store_import_analysis, payload, result, analysis
            )
            analysis_stored = analysis_id is not None
            if analysis_stored:
                state.event(
                    "PAYLOAD_ANALYSIS_STORED",
                    f"Stored the native payload analysis for revision {result.version_record_id}.",
                    context={
                        "analysis_id": analysis_id,
                        "status": analysis.status,
                        "analyzer": analysis.analyzer.key,
                    },
                )
        except Exception as exc:  # noqa: BLE001 - never fail a committed import over its analysis
            logger.warning(
                "failed to store payload analysis for revision %s job=%s",
                result.version_record_id,
                job_id,
                exc_info=True,
            )
            state.event(
                "PAYLOAD_ANALYSIS_STORE_FAILED",
                f"The native payload analysis could not be stored: {exc}",
                level="warn",
                context={"version_record_id": result.version_record_id},
            )

    # --- finalize -------------------------------------------------------------
    # Report what intake found (IXH-1.4, MFI-29.6). The scrub itself happens inside the
    # persistence hook — this recomputes the report so a dry run surfaces the same
    # findings without writing, and so the summary records them either way. The same
    # resolution drove both, so the report always describes what was actually stored.
    _fields, scrub_report = scrub_intake_source(intake, scrub_resolution)
    if artifacts is not None:
        artifacts.scrub_report = scrub_report
    if scrub_report.get("scrubbed"):
        types = ", ".join(scrub_report["secret_types"])
        if scrub_resolution.enforced:
            state.event(
                "SECRETS_REDACTED",
                f"Redacted {scrub_report['redactions']} credential value(s) from the stored "
                f"source ({types})"
                + (
                    "; the verbatim archive was withheld."
                    if scrub_report.get("source_withheld")
                    else "."
                ),
                level="warn",
                context={
                    "secret_types": scrub_report["secret_types"],
                    "mode": scrub_resolution.mode,
                },
            )
        else:
            state.event(
                "SECRETS_DETECTED",
                f"Found {scrub_report['redactions']} credential value(s) in the source "
                f"({types}); the tenant's scrub policy is warn-only, so the content was "
                "stored unmodified.",
                level="warn",
                context={
                    "secret_types": scrub_report["secret_types"],
                    "mode": scrub_resolution.mode,
                },
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
        remote_ref_report=remote_refs.outcome.report() if remote_refs is not None else None,
        analysis_report=analysis_summary_block(analysis, stored=analysis_stored),
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
    cleanup_intake_tempfile(payload.get("document_path"))
    return state.snapshot(state="completed", percent=_PCT_DONE, summary=summary, result=result)

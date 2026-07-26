"""Pre-flight lint and rank for import candidates — IXH-2.1 (#5096).

``run_adapter_import_job`` (:mod:`app.import_source_pipeline`) already runs
detect → parse → normalize → fingerprint → lint *before* it persists anything, but the
verdict only reaches a caller after the catalog item exists. This module turns that same
run into an **answer you can get first**: given a candidate document, it reports whether
the document is importable, what it would become, and how good it is — without writing a
catalog item, project, version, type row, or async-job artifact.

Design
------
There is exactly **one** import code path. Pre-flight resolves the adapter (explicit
``source_kind`` or auto-detection), builds the very same worker payload the import job
builds, forces ``dry_run`` so the pipeline's persistence branch is skipped, and drives
:func:`~app.import_source_pipeline.run_adapter_import_job` with an
:class:`~app.import_source_pipeline.ImportRunArtifacts` collector. The lint report in the
returned report is therefore the object the committing import would persist — not a
re-computation that could drift from it. Resource guards (IXH-1.4/6.5) and the intake
error taxonomy (IXH-1.3/6.4) come along for free, because they live inside that pipeline.

Ranking
-------
The pipeline's lint report lists findings in rule order. Pre-flight ranks them the way a
reviewer would read them: **severity first** (an error before a warning before an info),
then by how much the finding's *rule* actually cost the score — the capped per-rule
penalty from :mod:`app.schema_lint`'s one scoring formula — so the rule doing the most
damage leads. Ties break on rule id then path, so the ranking is deterministic for a given
report.

Caching
-------
The wizard pre-flights a document and then commits the identical bytes, and CI re-runs the
same artifact on every push, so identical work is common. Reports are cached per
**tenant** (never across tenants: the governing style guide is tenant state) keyed by the
document's content hash plus the adapter/target the request asked for. A cached entry
records the fingerprint of the style guide that produced it and is discarded when the
tenant's guide has since changed, so an edited guide can never serve a stale grade. The
cache is per-process and bounded (:data:`PREFLIGHT_CACHE_MAX_ENTRIES`) — it is an
optimization, never a source of truth.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
from collections import OrderedDict
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Dict, List, Mapping, Optional, Tuple, Union

from .archive_intake import ArchiveIntakeError, detect_archive_format, is_archive_payload
from .format_detection import FormatDetection, detect_format
from .import_source import (
    DetectionInput,
    ImportSource,
    LintReport,
    get_import_source,
    load_builtin_import_sources,
    resolve_import_source_key,
)
from .import_export_quality_policy import (
    SCOPE_IMPORT,
    evaluate_quality,
    find_active_waiver,
    load_tenant_policy,
    verdict_response_model,
)
from .import_source_pipeline import ImportRunArtifacts, build_job_error, run_adapter_import_job
from .intake_error_taxonomy import resolve_intake_error_code
from .intake_resource_guard import IntakeLimitError, guard_payload_bytes, resolve_guard_profile
from .intake_secret_scrub import scrub_message
from .lint_rule_registry import LINT_RULE_DOCS_PAGE, builtin_rule_descriptors
from .models import (
    ImportPreflightCache,
    ImportPreflightCounts,
    ImportPreflightDetection,
    ImportPreflightFinding,
    ImportPreflightLint,
    ImportPreflightPolicy,
    ImportPreflightReport,
    ImportPreflightRequest,
    ImportPreflightStyleGuide,
)
from .scanner_rule_transparency import get_blocking_meta
from .schema_lint import PER_RULE_PENALTY_CAP, SEVERITY_PENALTY
from .style_guide_engine import resolve_style_guide

logger = logging.getLogger(__name__)

__all__ = [
    "PREFLIGHT_CACHE_MAX_ENTRIES",
    "clear_preflight_cache",
    "preflight_cache_size",
    "rank_lint_findings",
    "run_import_preflight",
]

#: Upper bound on cached reports held per process. Keys are (tenant, content hash,
#: adapter, target) tuples, so this comfortably covers a wizard session or a CI batch
#: while keeping the footprint bounded.
PREFLIGHT_CACHE_MAX_ENTRIES = 256

@dataclass(frozen=True)
class _CacheEntry:
    """One cached pre-flight report plus what it depends on.

    Attributes:
        report: The report to serve (its ``cache.hit`` is rewritten per response).
        style_guide_fingerprint: Fingerprint of the guide that scored the report, or
            ``None`` when the run never reached lint (nothing guide-dependent to stale).
    """

    report: ImportPreflightReport
    style_guide_fingerprint: Optional[str]


#: Per-process LRU of pre-flight reports. Bounded by :data:`PREFLIGHT_CACHE_MAX_ENTRIES`.
#: Not locked: the worst outcome of an interleaved miss is duplicated work, and a stale
#: entry cannot be served because every hit re-validates the style-guide fingerprint.
_cache: "OrderedDict[str, _CacheEntry]" = OrderedDict()


def clear_preflight_cache() -> None:
    """Drop every cached report (used by tests and by process-level reloads)."""
    _cache.clear()


def preflight_cache_size() -> int:
    """Return how many reports are currently cached in this process."""
    return len(_cache)


def _cache_key(tenant_id: str, content_hash: str, request: ImportPreflightRequest) -> str:
    """Build the tenant-scoped cache key for a request.

    Everything that can change the verdict for the same bytes is in the key: the tenant
    (whose style guide governs the lint), the requested adapter (a document that two
    adapters both claim scores differently under each), the requested import target
    (it changes the routing decision), and the archive root (it changes which member is
    the document at all).
    """
    return "|".join(
        (
            tenant_id,
            content_hash,
            (request.source_kind or "").strip().lower() or "auto",
            request.import_target or "",
            (request.archive_root or "").strip(),
        )
    )


def _cache_store(key: str, entry: _CacheEntry) -> None:
    """Insert an entry, evicting the least recently used report when full."""
    _cache[key] = entry
    _cache.move_to_end(key)
    while len(_cache) > PREFLIGHT_CACHE_MAX_ENTRIES:
        _cache.popitem(last=False)


def _cache_lookup(key: str, tenant_id: str) -> Optional[ImportPreflightReport]:
    """Return a still-valid cached report for ``key``, or ``None``.

    A cached lint verdict is only valid while the style guide that produced it is still
    the tenant's guide, so a scored entry re-resolves the guide (a single indexed read,
    already served from the compiled-guide cache) and compares fingerprints. A mismatch
    drops the entry rather than serving a grade the tenant has since changed.
    """
    entry = _cache.get(key)
    if entry is None:
        return None
    if entry.style_guide_fingerprint is not None:
        guide = resolve_style_guide(tenant_id)
        if guide.fingerprint != entry.style_guide_fingerprint:
            _cache.pop(key, None)
            return None
    _cache.move_to_end(key)
    return entry.report


@dataclass(frozen=True)
class _RuleGuidance:
    """Static, per-rule guidance attached to a ranked finding."""

    remediation: Optional[str]
    docs_url: Optional[str]


def _rule_guidance(rule_id: str) -> _RuleGuidance:
    """Resolve remediation + docs pointer for a rule id.

    Blocking (``error``) rules carry explicit remediation copy in the CLX-4.3 transparency
    catalogue; every other registered rule falls back to its registry *rationale*, which
    states what the rule wants and is the closest thing to guidance the catalogue has.
    Rules outside the registry (external-tool findings merged in by an adapter) get
    ``None`` for both — a guide cannot document a rule it cannot list.
    """
    blocking = get_blocking_meta(rule_id)
    descriptor = _rule_descriptors().get(rule_id)
    remediation = blocking.remediation if blocking is not None else None
    if remediation is None and descriptor is not None:
        remediation = descriptor.rationale
    docs_url = (
        f"{LINT_RULE_DOCS_PAGE}#{descriptor.docs_anchor}" if descriptor is not None else None
    )
    return _RuleGuidance(remediation=remediation, docs_url=docs_url)


@lru_cache(maxsize=1)
def _rule_descriptors() -> Mapping[str, Any]:
    """rule id -> registry descriptor for every built-in rule.

    Cached: :func:`~app.lint_rule_registry.builtin_rule_descriptors` re-assembles the
    catalogue from every registered rule pack on each call, and ranking asks for guidance
    once per finding. The registry is fixed at import time, so one build per process is
    both correct and enough. Treat the returned mapping as read-only.
    """
    return {d.rule_id: d for d in builtin_rule_descriptors()}


def rank_lint_findings(report: LintReport) -> List[ImportPreflightFinding]:
    """Rank a lint report's findings by severity, then by their rule's score damage.

    The ordering key is ``(-severity penalty, -capped rule penalty, rule id, path, id)``:
    severity dominates, the rule that cost the score the most comes next, and the trailing
    keys make the order total (and therefore reproducible) for any report.

    Args:
        report: The lint report produced by the import pipeline.

    Returns:
        Every finding as an :class:`~app.models.ImportPreflightFinding`, ranked, with
        1-based ``rank`` and the per-rule guidance the UI links to.
    """
    penalty_by_rule: Dict[str, float] = {}
    for finding in report.findings:
        weight = SEVERITY_PENALTY.get(finding.severity, 0.0)
        penalty_by_rule[finding.rule] = penalty_by_rule.get(finding.rule, 0.0) + weight
    capped = {rule: min(total, PER_RULE_PENALTY_CAP) for rule, total in penalty_by_rule.items()}

    ordered = sorted(
        report.findings,
        key=lambda f: (
            -SEVERITY_PENALTY.get(f.severity, 0.0),
            -capped.get(f.rule, 0.0),
            f.rule,
            f.path or "",
            f.id or "",
        ),
    )
    ranked: List[ImportPreflightFinding] = []
    for position, finding in enumerate(ordered, start=1):
        guidance = _rule_guidance(finding.rule)
        ranked.append(
            ImportPreflightFinding(
                rank=position,
                id=finding.id,
                rule=finding.rule,
                severity=finding.severity,
                category=finding.category,
                message=finding.message,
                path=finding.path or "",
                weight=SEVERITY_PENALTY.get(finding.severity, 0.0),
                rule_penalty=capped.get(finding.rule, 0.0),
                remediation=guidance.remediation,
                docs_url=guidance.docs_url,
            )
        )
    return ranked


#: The "nothing was recognized" detection verdict, used when detection cannot run.
_NO_DETECTION = FormatDetection(detected=None, candidates=[], ambiguous=False, ambiguous_candidates=[])


def _guard_intake_size(raw: bytes, request: ImportPreflightRequest, *, tenant_id: str) -> None:
    """Apply the IXH-1.4 / IXH-6.5 byte ceiling before anything decodes the payload.

    Pre-flight sniffs the document *before* handing it to the pipeline, and sniffing
    decodes the bytes to text — so the ceiling the pipeline applies inside
    ``_resolve_intake`` has to be applied here too, or an oversized upload would be
    doubled in memory and fanned out across every sniffer before the pipeline ever
    rejects it. Archives are exempt for the same reason they are in the pipeline: they
    carry their own, larger budget, enforced while unpacking.

    Args:
        raw: The decoded upload bytes.
        request: The pre-flight request (its filename labels the error).
        tenant_id: Selects the tenant's GuardProfile tier.

    Raises:
        IntakeLimitError: When the payload exceeds the import size limit.
    """
    if not is_archive_payload(raw, request.filename):
        profile = resolve_guard_profile(tenant_id=tenant_id)
        guard_payload_bytes(raw, source_label=request.filename, limits=profile)


def _detect(raw: bytes, request: ImportPreflightRequest) -> Tuple[FormatDetection, Optional[str], List[str]]:
    """Auto-detect the candidate's format, unpacking an archive when necessary.

    Never raises: detection is advisory here (the pipeline is what actually decides an
    import's fate), so an archive that cannot be unpacked — or a sniffer that misbehaves
    despite the registry's own guard — yields "nothing recognized" and lets the pipeline
    report the real failure with its taxonomy code.

    Args:
        raw: The decoded document bytes.
        request: The pre-flight request (filename/content-type/URL hints, archive root).

    Returns:
        ``(detection, archive_root, archive_members)`` — the archive fields are ``None``
        / empty for a single-document payload, and also when an archive could not be
        unpacked.
    """
    try:
        if is_archive_payload(raw, request.filename):
            try:
                unpacked = detect_archive_format(
                    raw, filename=request.filename, root_path=request.archive_root
                )
            except ArchiveIntakeError:
                return _NO_DETECTION, None, []
            return unpacked.detection, unpacked.root_path, sorted(unpacked.members)

        text = raw.decode("utf-8", errors="replace")
        detection = detect_format(
            DetectionInput(
                text=text,
                filename=request.filename,
                content_type=request.content_type,
                url=request.url,
            )
        )
    except Exception:  # noqa: BLE001 - detection must never decide a pre-flight's fate
        logger.warning("import pre-flight detection failed; continuing undetected", exc_info=True)
        return _NO_DETECTION, None, []
    return detection, None, []


def _build_detection_model(
    detection: FormatDetection,
    *,
    requested_key: Optional[str],
    used_key: Optional[str],
    archive_root: Optional[str],
    archive_members: List[str],
) -> ImportPreflightDetection:
    """Assemble the report's detection block from a detection verdict."""
    best = detection.detected
    detected_key = best.source_key if best is not None and best.importable else None
    return ImportPreflightDetection(
        adapter_key=used_key,
        requested_adapter_key=requested_key,
        detected_adapter_key=detected_key,
        detected_format=best.format if best is not None else None,
        confidence=best.confidence if best is not None else 0.0,
        reason=best.reason if best is not None else None,
        matched=detection.matched,
        importable=bool(best is not None and best.importable),
        ambiguous=detection.ambiguous,
        agrees_with_request=(
            True if requested_key is None or detected_key is None else detected_key == requested_key
        ),
        archive_root=archive_root,
        archive_members=archive_members,
    )


def _requested_detection(request: ImportPreflightRequest) -> ImportPreflightDetection:
    """The detection block for a failure that happened before detection could run.

    Nothing was sniffed, so the only thing it can report is which importer the caller
    asked for (resolved through the registry's alias map).
    """
    return ImportPreflightDetection(
        requested_adapter_key=(
            resolve_import_source_key(request.source_kind) if request.source_kind else None
        ),
    )


def _failed_report(
    *,
    detection: ImportPreflightDetection,
    code: str,
    message: str,
    cache: ImportPreflightCache,
    tenant_id: str = "",
) -> ImportPreflightReport:
    """Build an ``ok=false`` report carrying a taxonomy error and nothing else.

    The message is scrubbed of credential-shaped spans (IXH-1.4) before it leaves: a
    parser error quotes the offending source line, so a secret on a malformed line would
    otherwise travel back in the response and into every log that records it.

    The policy block still reports the tenant's policy (evaluated against no score), because a
    client renders it either way — but an unimportable candidate is never *blocked on quality*:
    the taxonomy error is the real answer, and a floor cannot be missed by a document that
    never produced a grade.
    """
    return ImportPreflightReport(
        ok=False,
        detection=detection,
        policy=_policy_verdict(None, tenant_id=tenant_id),
        error=build_job_error(code, scrub_message(message) or ""),
        cache=cache,
    )


def _policy_verdict(
    lint: Optional[Union[LintReport, ImportPreflightLint]],
    *,
    tenant_id: str = "",
    format_key: Optional[str] = None,
    content_hash: Optional[str] = None,
) -> ImportPreflightPolicy:
    """Evaluate the tenant's import quality policy for a lint report (IXH-2.3).

    Resolution, thresholds, and the waiver lookup all live in
    :mod:`app.import_export_quality_policy` so the pre-flight report, the server-side commit
    gate, and the export half cannot disagree about what a policy means. A tenant with no
    policy runs the advisory default, which passes everything — the shipped behaviour before
    2.3 and therefore an upgrade nobody notices.

    Args:
        lint: The candidate's lint report, or ``None`` when the run never reached lint (an
            unscored candidate cannot fall short of a floor, so the verdict is the policy's
            no-floor answer).
        tenant_id: The tenant whose policy governs.
        format_key: The adapter key the candidate resolved to, for per-format overrides.
        content_hash: SHA-256 of the candidate bytes — the waiver match key, so a report shown
            after a waiver was recorded reports ``warn`` with the waiver rather than ``block``.

    Returns:
        The :class:`~app.models.ImportPreflightPolicy` verdict for the candidate.
    """
    policy = load_tenant_policy(tenant_id)
    waiver = (
        find_active_waiver(
            tenant_id=tenant_id,
            scope=SCOPE_IMPORT,
            subject_key=content_hash,
            format_key=format_key,
        )
        if content_hash and not policy.is_default
        else None
    )
    verdict = evaluate_quality(
        policy=policy,
        scope=SCOPE_IMPORT,
        format_key=format_key,
        score=lint.score if lint is not None else None,
        grade=lint.grade if lint is not None else None,
        severity_counts=dict(lint.severity_counts) if lint is not None else {},
        waiver=waiver,
    )
    # The verdict → response adaptation lives with the policy engine (IXH-2.4), so the import
    # pre-flight, the export pre-flight, and the delivery gate cannot drift apart on it.
    return verdict_response_model(verdict)


def _style_guide_model(guide: Any) -> Optional[ImportPreflightStyleGuide]:
    """Adapt a compiled style guide into its response shape, or ``None`` when unresolved."""
    if guide is None:
        return None
    return ImportPreflightStyleGuide(
        guide_id=guide.guide_id,
        name=guide.name,
        source=guide.source,
        fingerprint=guide.fingerprint,
    )


def _preflight_payload(
    request: ImportPreflightRequest,
    *,
    adapter_key: str,
    tenant_id: str,
    tenant_slug: str,
    user_id: Optional[str],
    content_hash: str,
    archive_root: Optional[str],
) -> Dict[str, Any]:
    """Build the worker payload the pipeline runs, with ``dry_run`` forced on.

    Identical in shape to :func:`app.spec_import_engine._build_worker_payload` so the
    pipeline cannot tell a pre-flight from a real import — except for ``dry_run``, which
    makes its persistence branch unreachable, and the placeholder project/version identity,
    which nothing reads on a dry run.
    """
    options: Dict[str, Any] = {"dry_run": True}
    if request.import_target is not None:
        options["import_target"] = request.import_target
    if request.input_kind is not None:
        options["input_kind"] = request.input_kind
    if archive_root:
        options["archive_root"] = archive_root
    return {
        "rest_job_id": f"preflight-{content_hash[:16]}",
        "tenant_slug": tenant_slug,
        "tenant_id": tenant_id,
        "user_id": user_id,
        "metadata": {
            "source_kind": adapter_key,
            "project": {"name": "Pre-flight", "slug": "preflight"},
            "version": {"version_id": "0.0.0"},
            "options": options,
        },
        "document_base64": request.document_base64,
        "filename": request.filename,
        "content_type": request.content_type,
    }


def _resolve_adapter(
    requested_key: Optional[str], detection: FormatDetection
) -> Tuple[Optional[ImportSource], Optional[str], Optional[Tuple[str, str]]]:
    """Pick the adapter to pre-flight with.

    Args:
        requested_key: The caller's ``source_kind``, or ``None`` to auto-detect.
        detection: The auto-detection verdict for the document.

    Returns:
        ``(adapter, resolved_requested_key, failure)`` where ``failure`` is a
        ``(taxonomy code, message)`` pair when no adapter can run — an unknown/unavailable
        requested format, or nothing recognizable to fall back on.
    """
    load_builtin_import_sources()
    resolved_request = (
        resolve_import_source_key(requested_key.strip()) if requested_key and requested_key.strip() else None
    )

    key = resolved_request
    if key is None:
        best = detection.detected
        key = best.source_key if best is not None and best.importable else None
        if key is None:
            return (
                None,
                None,
                (
                    "FORMAT_UNRECOGNIZED",
                    "No registered importer recognized this document; "
                    "select the format explicitly to pre-flight it.",
                ),
            )

    adapter = get_import_source(key)
    if adapter is None:
        return (
            None,
            resolved_request,
            (
                "FORMAT_UNRECOGNIZED",
                f"No importer is registered for source kind {key!r}.",
            ),
        )

    descriptor = type(adapter).descriptor()
    if not descriptor.available:
        return (
            None,
            resolved_request,
            (
                "ADAPTER_UNAVAILABLE",
                descriptor.unavailable_reason
                or f"The {adapter.label} importer is not available in this runtime.",
            ),
        )
    return adapter, resolved_request, None


async def run_import_preflight(
    request: ImportPreflightRequest,
    *,
    tenant_id: str,
    tenant_slug: str,
    user_id: Optional[str] = None,
    artifacts: Optional[ImportRunArtifacts] = None,
) -> ImportPreflightReport:
    """Score a candidate document without importing it (IXH-2.1).

    Runs detect → parse → normalize → fingerprint → lint through the *same* pipeline a
    committing import uses, with ``dry_run`` forced on so no catalog item, project,
    version, type row, or async-job artifact can be written. Every failure — bad base64,
    an unrecognized format, a malformed document, a resource-limit rejection — is reported
    as ``ok=false`` plus a stable intake-taxonomy code, never as an exception or a 5xx.

    Args:
        request: The candidate document and its intake hints.
        tenant_id: The tenant the pre-flight runs for; scopes the cache and selects the
            style guide the lint is scored under.
        tenant_slug: The tenant's slug, recorded on the pipeline payload.
        user_id: The requesting user, recorded on the pipeline payload. Nothing is
            written on a dry run, so it is only provenance.
        artifacts: Optional out-parameter. When supplied, the pipeline records its
            in-flight objects (canonical model, routing, lint, style guide) on it and the
            **report cache is bypassed** — a cached report carries no artifacts, and a
            caller that asks for them (the IXH-3.1 preview manifest) needs the objects
            from a real run. The report itself is still stored, so a later plain
            pre-flight of the same bytes hits the cache as before.

    Returns:
        The :class:`~app.models.ImportPreflightReport` verdict for the candidate.
    """
    try:
        raw = base64.standard_b64decode(request.document_base64)
    except (binascii.Error, ValueError) as exc:
        return _failed_report(
            detection=_requested_detection(request),
            code="INPUT_ENCODING_INVALID",
            message=f"document_base64 is not valid base64: {exc}",
            cache=ImportPreflightCache(hit=False, key="", content_hash=""),
            tenant_id=tenant_id,
        )

    content_hash = hashlib.sha256(raw).hexdigest()
    key = _cache_key(tenant_id, content_hash, request)
    # An artifacts collector needs the objects behind the report, which only a real run
    # produces — a cached report cannot populate it, so the serve path is skipped.
    cached = _cache_lookup(key, tenant_id) if artifacts is None else None
    if cached is not None:
        # The lint verdict is reusable; the *policy* verdict is not. Policy is tenant state that
        # can change between two pre-flights of the same bytes — and recording a waiver is
        # exactly such a change — so the cached report's policy block is re-evaluated against
        # the live policy rather than replayed.
        return cached.model_copy(
            update={
                "cache": ImportPreflightCache(hit=True, key=key, content_hash=content_hash),
                "policy": _policy_verdict(
                    cached.lint,
                    tenant_id=tenant_id,
                    format_key=cached.detection.adapter_key,
                    content_hash=content_hash,
                ),
            }
        )
    cache = ImportPreflightCache(hit=False, key=key, content_hash=content_hash)

    try:
        _guard_intake_size(raw, request, tenant_id=tenant_id)
    except IntakeLimitError as exc:
        report = _failed_report(
            detection=_requested_detection(request),
            code=resolve_intake_error_code(exc.code) or "INPUT_TOO_LARGE",
            message=str(exc),
            cache=cache,
            tenant_id=tenant_id,
        )
        _cache_store(key, _CacheEntry(report=report, style_guide_fingerprint=None))
        return report

    detection, archive_root, archive_members = _detect(raw, request)
    adapter, resolved_request, failure = _resolve_adapter(request.source_kind, detection)
    detection_model = _build_detection_model(
        detection,
        requested_key=resolved_request,
        used_key=adapter.key if adapter is not None else None,
        archive_root=archive_root,
        archive_members=archive_members,
    )
    if adapter is None:
        assert failure is not None  # _resolve_adapter returns one or the other
        report = _failed_report(
            detection=detection_model,
            code=failure[0],
            message=failure[1],
            cache=cache,
            tenant_id=tenant_id,
        )
        _cache_store(key, _CacheEntry(report=report, style_guide_fingerprint=None))
        return report

    if artifacts is None:
        artifacts = ImportRunArtifacts()
    payload = _preflight_payload(
        request,
        adapter_key=adapter.key,
        tenant_id=tenant_id,
        tenant_slug=tenant_slug,
        user_id=user_id,
        content_hash=content_hash,
        archive_root=request.archive_root or archive_root,
    )
    try:
        status = await run_adapter_import_job(adapter, payload, artifacts=artifacts)
    except Exception as exc:  # noqa: BLE001 - a pre-flight must never surface as a 5xx
        # Deliberately not cached: an adapter crash is our bug, and the taxonomy marks it
        # retriable — a retry must get a real attempt, not a replay of the crash.
        logger.exception("import pre-flight failed for tenant %s adapter %s", tenant_id, adapter.key)
        return _failed_report(
            detection=detection_model,
            code="INTERNAL_ADAPTER_FAULT",
            message=f"The importer failed while evaluating the document: {exc}",
            cache=cache,
            tenant_id=tenant_id,
        )

    report = _report_from_run(
        status=status,
        artifacts=artifacts,
        detection=detection_model,
        cache=cache,
        tenant_id=tenant_id,
        content_hash=content_hash,
    )
    guide = artifacts.style_guide
    _cache_store(
        key,
        _CacheEntry(
            report=report,
            style_guide_fingerprint=(
                guide.fingerprint if guide is not None and artifacts.lint is not None else None
            ),
        ),
    )
    return report


def _report_from_run(
    *,
    status: Any,
    artifacts: ImportRunArtifacts,
    detection: ImportPreflightDetection,
    cache: ImportPreflightCache,
    tenant_id: str = "",
    content_hash: Optional[str] = None,
) -> ImportPreflightReport:
    """Assemble the report from a finished pipeline run and its collected artifacts.

    Args:
        status: The terminal :class:`~app.models.SpecImportJobStatus` from the pipeline.
        artifacts: The objects the run produced (model / fingerprint / lint / guide).
        detection: The detection block already built for the request.
        cache: Cache provenance for this response.
        tenant_id: The tenant whose quality policy scores the verdict.
        content_hash: SHA-256 of the candidate bytes, for the waiver lookup.

    Returns:
        The assembled report; ``ok`` is true only for a ``completed`` run.
    """
    model = artifacts.model
    lint = artifacts.lint
    counts = ImportPreflightCounts()
    if model is not None:
        counts = ImportPreflightCounts(
            services=len(model.services),
            operations=sum(len(service.operations) for service in model.services),
            types=len(model.types),
            channels=len(model.channels),
        )

    lint_model: Optional[ImportPreflightLint] = None
    if lint is not None:
        lint_model = ImportPreflightLint(
            score=lint.score,
            grade=lint.grade,
            report_fingerprint=lint.report_fingerprint,
            severity_counts=dict(lint.severity_counts),
            rule_hits=dict(lint.rule_hits),
            categories=list(lint.categories),
            findings=rank_lint_findings(lint),
        )

    ok = status.state == "completed"
    error = status.error
    if error is not None:
        # The pipeline scrubs its *event* messages but hands the raw exception text to the
        # terminal error; a pre-flight returns that text to the caller, so it is scrubbed
        # here for the same reason the events are (IXH-1.4).
        error = error.model_copy(update={"message": scrub_message(error.message) or ""})
    if not ok and error is None:
        # A pipeline that ends anywhere but ``completed`` without an error payload can
        # only be a cancellation, which pre-flight never requests — report it as an
        # internal fault rather than an ``ok=false`` with no explanation.
        error = build_job_error(
            "INTERNAL_ADAPTER_FAULT",
            f"The importer ended in state {status.state!r} without reporting a reason.",
        )

    return ImportPreflightReport(
        ok=ok,
        detection=detection,
        routing=artifacts.routing.as_dict() if artifacts.routing is not None else None,
        paradigm=model.paradigm.value if model is not None else None,
        format=model.format if model is not None else None,
        counts=counts,
        fingerprint=artifacts.fingerprint,
        lint=lint_model,
        style_guide=_style_guide_model(artifacts.style_guide),
        policy=_policy_verdict(
            lint,
            tenant_id=tenant_id,
            format_key=detection.adapter_key,
            content_hash=content_hash,
        ),
        secret_scrub=artifacts.scrub_report,
        error=error,
        cache=cache,
    )

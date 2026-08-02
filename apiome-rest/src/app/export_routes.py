"""Fidelity report REST surfacing — ``/export/targets`` + ``/export/preview`` — MFX-2.5 (#3842).

Two granularities the export UX needs *before* a download is committed:

* **``GET /v1/export/{tenant_slug}/targets?artifact=&version=``** — for the given source
  revision, every registered target's descriptor + capability profile + options (the emitter
  registry's public view, MFX-1.2) **plus** a cheap per-target fidelity badge: a
  :class:`~app.export_fidelity.ExportFidelityTier` (``lossless`` / ``lossy`` / ``types-only``)
  and a ``preserved_percent`` estimate, computed from the prediction engine with no emit. This
  drives the export dialog's target-card badges (MFX-6.1) and the version-view pre-summary
  (MFX-6.5) in one round-trip.

* **``POST /v1/export/{tenant_slug}/preview``** — for one chosen ``target``, the full
  :class:`~app.export_fidelity.ExportFidelity` envelope: the per-construct
  :class:`~app.lossiness.LossinessReport`, the user-facing advisory (MFX-2.4), and the tier
  summary — again **without emitting an artifact**. It backs the dialog's detailed fidelity
  panel and is the same envelope an export job embeds in its result (MFX-3.1/3.2).

* **``POST /v1/export/{tenant_slug}/document``** — for one chosen ``target``, the emitted
  document itself, produced through the Emitter SPI (:func:`app.export_service.emit_canonical`)
  and serialized as JSON (default) or YAML (``Accept: application/yaml``). This is the emit
  counterpart to ``/preview``: ``/preview`` predicts the loss, ``/document`` returns the bytes.
  It gives non-OpenAPI targets (AsyncAPI, MFX-11.5) a byte source the legacy OpenAPI browse
  reconstruction (``GET /v1/schema/…``) cannot supply, and the ``apiome export <target>`` CLI
  pairs it with ``/preview`` to write the artifact and surface its honest fidelity.

* **``POST /v1/export/{tenant_slug}/dispatch``** — the "run it, attach the fidelity report" step
  (MFX-3.2) in one round-trip: emit the chosen ``target`` **and** return its full fidelity
  envelope together. Where ``/preview`` predicts the loss and ``/document`` returns only the
  bytes, ``/dispatch`` returns both — the synchronous, one-shot twin of submitting an export
  job (``POST …/jobs``) and polling it, without the poll. Intended for small artifacts and the
  ``apiome export`` CLI; large or toolchain-backed exports still use the async job. ``dry_run``
  stops after the report (no artifact), the same shape ``/preview`` returns.

All endpoints are tenant-scoped (JWT or API key, via :func:`app.auth.validate_authentication`)
and load the source model version-scoped through :func:`app.export_source.load_export_source`.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

import yaml
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from . import __version__ as APIOME_VERSION
from .auth import validate_authentication
from .capability_registry import REGISTRY_VERSION, CapabilityRegistrySnapshot, registry_snapshot
from .emitter import (
    CapabilityProfile,
    EmitterDescriptor,
    describe_emit_targets,
    get_emitter,
)
from .export_delivery_gate import (
    DeliveryGateReport,
    build_delivery_attestation,
    delivery_tool_versions,
    evaluate_delivery,
    lint_delivery_source,
)
from .export_dispatch import dispatch_from_source
from .export_fidelity import (
    ExportFidelity,
    ExportFidelityTier,
    TargetFidelity,
    build_export_fidelity,
    build_target_fidelity,
)
from .export_job_engine import serialize_file_content
from .export_preflight import (
    ExportPreflightReport,
    ExportPreflightRequest,
    run_export_preflight,
)
from .export_preview_manifest import (
    ExportPreviewManifestRequest,
    ExportPreviewManifestResponse,
    run_export_preview_manifest,
)
from .export_projection import (
    DEFAULT_EVIDENCE_PAGE_SIZE,
    MAX_EVIDENCE_PAGE_SIZE,
    UI_AGGREGATION_THRESHOLD_ROWS,
    NativeEvidence,
    ProjectionEvidencePage,
    ProjectionManifestSummary,
    _normalize_options_for_hash,
    build_projection_manifest,
    paginate_evidence,
    summarize_manifest,
)
from .export_service import (
    ExportError,
    ExportPersistenceContext,
    emit_canonical,
    resolve_emit_format,
    resolve_emitter,
)
from .export_source import ExportSourceError, load_export_source
from .export_validation import validate_emitted_artifact
from .export_validation_gate import EmittedValidationReport, build_validation_report
from .lossiness import LossinessSeverity
from .projection_manifest_cache import build_manifest_cache_key, manifest_cache
from .projection_telemetry import ALLOWED_METRIC_KINDS, ALLOWED_REASON_CATEGORIES, projection_telemetry
from .quality_rank_telemetry import observe_delivery
from .transcoding_guards import TranscodeGuard, TranscodeGuardError, classify_transcode

router = APIRouter(prefix="/v1/export", tags=["export"])

#: The tenant-scoped export surface. ``/v1/export/{tenant_slug}/…`` is the historical shape of
#: the fidelity endpoints above; the pre-flight (IXH-2.4) is the export twin of
#: ``POST /v1/tenants/{tenant_slug}/import/preflight`` (IXH-2.1) and is mounted alongside it, so
#: the two pre-flights read as one pair of endpoints rather than two unrelated surfaces.
tenant_router = APIRouter(prefix="/v1/tenants", tags=["export"])


# ===========================================================================
# Response / request models
# ===========================================================================


class ExportTargetFidelity(BaseModel):
    """One registered target's descriptor + options + its per-source fidelity badge (MFX-2.5).

    The union of the emitter registry's public view (descriptor, capability profile, options
    schema + defaults — MFX-1.1/1.4) and the cheap fidelity summary for the requested source
    (:class:`~app.export_fidelity.TargetFidelity` — tier + preserved-%), so a single
    ``/export/targets`` call gives the export dialog everything a target card needs.
    """

    model_config = ConfigDict(extra="forbid")

    descriptor: EmitterDescriptor
    capability_profile: CapabilityProfile
    options_schema: Dict[str, Any] = Field(
        description="JSON Schema for this target's per-emit options (MFX-1.4).",
    )
    default_options: Dict[str, Any] = Field(
        description="Validated default option values for this target (MFX-1.4).",
    )
    fidelity: TargetFidelity = Field(
        description="Cheap tier + preserved-% badge for exporting the requested source here.",
    )


class ExportTargetsResponse(BaseModel):
    """The per-target fidelity list for one source revision (MFX-2.5)."""

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id the fidelity was computed for.")
    version: Optional[str] = Field(
        default=None, description="The version selector as requested (label, UUID, or null)."
    )
    version_record_id: str = Field(description="The resolved revision (``versions.id``).")
    version_label: Optional[str] = Field(
        default=None, description="The resolved revision's version label (e.g. ``1.0.0``)."
    )
    targets: List[ExportTargetFidelity] = Field(
        default_factory=list,
        description="Every registered target with its per-source fidelity, sorted by target key.",
    )


class ExportPreviewRequest(BaseModel):
    """A dry-run fidelity preview request: source revision + chosen target (MFX-2.5)."""

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
        description="Per-target emit options (MFX-1.4); null or empty applies the target "
        "defaults. Folded (normalized) into the projection snapshot hash (EFP-2.1), so a "
        "preview, a verify, and a dispatch of the same source, target, and options reference "
        "the same snapshot.",
    )
    min_severity: LossinessSeverity = Field(
        default=LossinessSeverity.INFO,
        description="Lowest loss severity that raises the advisory (MFX-2.4); does not affect "
        "the report or counts.",
    )


class ExportPreviewResponse(BaseModel):
    """The dry-run fidelity preview: the full envelope + the resolved source coordinates (MFX-2.5)."""

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id the preview was computed for.")
    version: Optional[str] = Field(
        default=None, description="The version selector as requested (label, UUID, or null)."
    )
    version_record_id: str = Field(description="The resolved revision (``versions.id``).")
    version_label: Optional[str] = Field(
        default=None, description="The resolved revision's version label (e.g. ``1.0.0``)."
    )
    fidelity: ExportFidelity = Field(
        description="The full fidelity envelope (target + tier + report + advisory), no artifact.",
    )
    guard: TranscodeGuard = Field(
        description="The pre-flight transcoding guard (MFX-3.3): the conversion band "
        "(clean / lossy / near-empty / severe), whether it needs an explicit confirmation, and "
        "why. Lets the UI/CLI warn (near-empty) or prompt for confirmation (severe) before "
        "dispatching the export.",
    )


class ExportProjectionEvidenceRequest(BaseModel):
    """A bounded projection-evidence page request for one configured export (EFP-2.1).

    Identifies the same ``(source revision, target, options)`` triple a preview / verify /
    dispatch describes, plus the cursor/limit window into the manifest's evidence rows.
    Matching inputs resolve to the same snapshot (``manifest_hash``) every surface shares.
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
        description="Per-target emit options (MFX-1.4); null or empty applies the target "
        "defaults. Folded (normalized) into the snapshot hash — different options are a "
        "different snapshot.",
    )
    cursor: Optional[str] = Field(
        default=None,
        description="Opaque cursor from a previous page, or null to start at the beginning. "
        "A malformed cursor is rejected with 422.",
    )
    limit: int = Field(
        default=DEFAULT_EVIDENCE_PAGE_SIZE,
        ge=1,
        description=f"Maximum evidence rows per page; clamped to {MAX_EVIDENCE_PAGE_SIZE}.",
    )
    redact_source: bool = Field(
        default=True,
        description="Ignored (EFP-3.2). Source-native evidence is always redacted; kept for "
        "request-body compatibility with earlier callers. Response ``redacted`` is always true.",
    )


class ExportProjectionEvidenceResponse(BaseModel):
    """One bounded, cursor-paginated page of projection evidence (EFP-2.1).

    The authenticated evidence surface behind the preview/verify summaries: the resolved
    source coordinates, the snapshot provenance (:class:`~app.export_projection.ManifestTarget`
    carries the emitter/registry versions and destination documentation), the bounded
    :class:`~app.export_projection.ProjectionManifestSummary`, and one
    :class:`~app.export_projection.ProjectionEvidencePage` of outcome edges + their nodes.
    Deterministic: the same ``(revision, target, options)`` yields the same snapshot hash a
    preview / verify / dispatch / job result references, and paging the same snapshot twice
    yields identical pages.
    """

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id the evidence describes.")
    version: Optional[str] = Field(
        default=None, description="The version selector as requested (label, UUID, or null)."
    )
    version_record_id: str = Field(description="The resolved revision (``versions.id``).")
    version_label: Optional[str] = Field(
        default=None, description="The resolved revision's version label (e.g. ``1.0.0``)."
    )
    summary: ProjectionManifestSummary = Field(
        description="The bounded snapshot summary — hash, target/version provenance "
        "(emitter/registry versions), and status/reason counts.",
    )
    page: ProjectionEvidencePage = Field(
        description="This page of outcome edges + the nodes they reference, with the opaque "
        "cursor for the next page (null on the last page).",
    )
    redacted: bool = Field(
        description="Always true (EFP-3.2): source-native evidence values are redacted.",
    )


class ExportDocumentRequest(BaseModel):
    """An emit request: source revision + chosen target + per-emit options (MFX-11.5)."""

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id to export.")
    version: Optional[str] = Field(
        default=None,
        description="Revision UUID, version label (``1.0.0``), or null for the latest revision.",
    )
    target: str = Field(
        description="Target emitter key (``asyncapi``) or format key (``asyncapi-3``).",
    )
    options: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Per-target emit options (MFX-1.4); null or empty applies the target defaults.",
    )


class ExportDispatchRequest(BaseModel):
    """A dispatch request: source revision + chosen target + options + dry-run flag (MFX-3.2)."""

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
        "guard would otherwise block with 409. Ignored for non-severe conversions and dry-runs.",
    )
    min_severity: LossinessSeverity = Field(
        default=LossinessSeverity.INFO,
        description="Lowest loss severity that raises the advisory (MFX-2.4); does not affect "
        "the report or counts.",
    )


class ExportDispatchFile(BaseModel):
    """One emitted file returned inline by the dispatch surface (MFX-3.2).

    Unlike the async job's metadata-only manifest (the bytes are served later by MFX-4.x),
    a synchronous dispatch returns the ``content`` inline — there is no job to poll and no
    separate download step.
    """

    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="Relative path within the output bundle.")
    content: Any = Field(description="The emitted file's content (structured document or text).")
    media_type: Optional[str] = Field(
        default=None, description="Per-file media type when it differs from the bundle default."
    )
    subject: Optional[str] = Field(
        default=None,
        description="Schema Registry subject when the target assigns one (e.g. Avro).",
    )


class ExportDispatchResponse(BaseModel):
    """The dispatch result: resolved coordinates + fidelity envelope + emitted artifact (MFX-3.2)."""

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id the dispatch exported.")
    version: Optional[str] = Field(
        default=None, description="The version selector as requested (label, UUID, or null)."
    )
    version_record_id: str = Field(description="The resolved revision (``versions.id``).")
    version_label: Optional[str] = Field(
        default=None, description="The resolved revision's version label (e.g. ``1.0.0``)."
    )
    target: str = Field(description="The resolved target format key (e.g. ``openapi-3.1``).")
    dry_run: bool = Field(description="True when the dispatch stopped after the fidelity report.")
    fidelity: ExportFidelity = Field(
        description="The full fidelity envelope (target + tier + report + advisory).",
    )
    guard: TranscodeGuard = Field(
        description="The pre-flight transcoding guard (MFX-3.3): the conversion band and why. "
        "A severe conversion only reaches a real (non-dry-run) dispatch when ``confirm`` was set.",
    )
    files: List[ExportDispatchFile] = Field(
        default_factory=list,
        description="The emitted files (inline); empty for a dry-run.",
    )
    media_type: Optional[str] = Field(
        default=None,
        description="The bundle's primary media type; null for a dry-run.",
    )
    delivery: Optional[DeliveryGateReport] = Field(
        default=None,
        description="The delivery gate decision for this dispatch (IXH-2.5) with its named "
        "reasons and the signed attestation for the returned artifact. Null for a dry-run "
        "(nothing is delivered).",
    )


class ExportVerifyVerdict(str, Enum):
    """The overall go/no-go verdict for a one-call verify (MFX-42.1/42.5).

    The single band the Verify workbench's banner and Generate gate read, derived from the
    validation gate (MFX-5.3) and the fidelity tier (MFX-2.5) per the MFX-3.3 severity classes:

    * ``clean`` — a lossless conversion whose emitted artifact validated (or had nothing to
      validate); the green path.
    * ``lossy`` — a valid artifact, but the conversion is not lossless; the user may proceed only
      after acknowledging the loss.
    * ``invalid`` — a validator ran and rejected the emitted artifact; the export is blocked and no
      acknowledgement can override it.
    """

    CLEAN = "clean"
    LOSSY = "lossy"
    INVALID = "invalid"


class EmittedArtifactLint(BaseModel):
    """The emitted-artifact lint report slot for one verify (MFX-5.2 → MFX-42.3).

    The lint pass over the emitted artifact is **MFX-5.2**, which is not yet implemented; until it
    lands, :func:`verify_export` returns ``lint: null`` and the Verify workbench renders the lint
    lens's "no lint pack ran" empty state. This model documents the shape MFX-5.2 will populate so
    the response contract is stable for the UI (`EmittedArtifactLintReport`).
    """

    model_config = ConfigDict(extra="forbid")

    applicable: bool = Field(
        description="Whether a lint pack is registered for this target's format.",
    )
    pack: Optional[str] = Field(
        default=None, description="The lint pack that ran (e.g. ``spectral:oas``), when applicable."
    )
    score: Optional[int] = Field(
        default=None, description="The 0–100 quality score, when the pack computes one."
    )
    grade: Optional[str] = Field(
        default=None, description="The A–F letter grade, when the pack computes one."
    )
    findings: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="The itemized lint findings (severity, rule, message, location).",
    )


class ExportVerifyRequest(BaseModel):
    """A one-call verify request: source revision + chosen target + options (MFX-42.5)."""

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
    include_content: bool = Field(
        default=True,
        description="When true, return the emitted artifact inline (under the size cap) so the "
        "Monaco viewer (MFX-43.x) can render the preview from this same call; the bytes are "
        "still discarded server-side.",
    )
    min_severity: LossinessSeverity = Field(
        default=LossinessSeverity.INFO,
        description="Lowest loss severity that raises the advisory (MFX-2.4); does not affect "
        "the report or counts.",
    )


class ExportVerifyResponse(BaseModel):
    """The one-call verify result: fidelity + validation + lint + verdict (MFX-42.5).

    Everything the Studio's Verify workbench (MFX-42.1) needs in one round-trip, computed by
    emitting the artifact to a **temporary buffer** — no artifact and no job row are persisted.
    The emit is read-only (no field-identity persistence), so a verify never mutates tenant state.
    """

    model_config = ConfigDict(extra="forbid")

    artifact: str = Field(description="The artifact (project) id the verify was computed for.")
    version: Optional[str] = Field(
        default=None, description="The version selector as requested (label, UUID, or null)."
    )
    version_record_id: str = Field(description="The resolved revision (``versions.id``).")
    version_label: Optional[str] = Field(
        default=None, description="The resolved revision's version label (e.g. ``1.0.0``)."
    )
    target: str = Field(description="The resolved target format key (e.g. ``openapi-3.1``).")
    fidelity: ExportFidelity = Field(
        description="The full fidelity envelope (target + tier + per-construct report + advisory).",
    )
    guard: TranscodeGuard = Field(
        description="The pre-flight transcoding guard (MFX-3.3): the conversion band and why.",
    )
    validation: EmittedValidationReport = Field(
        description="The emitted-output validation gate + structured report (MFX-5.1/5.3).",
    )
    lint: Optional[EmittedArtifactLint] = Field(
        default=None,
        description="The emitted-artifact lint report (MFX-5.2); null until MFX-5.2 lands, which "
        "the Verify workbench renders as the lint lens's empty state.",
    )
    verdict: ExportVerifyVerdict = Field(
        description="The overall go/no-go band the Generate gate reads (clean / lossy / invalid).",
    )
    files: List[ExportDispatchFile] = Field(
        default_factory=list,
        description="The emitted artifact inline (under the size cap); empty when the caller "
        "opted out (``include_content: false``) or the artifact exceeded the cap (`truncated`).",
    )
    truncated: bool = Field(
        default=False,
        description="True when the emitted artifact exceeded the inline size cap and was omitted "
        "from ``files``; the Monaco viewer should fetch it via the job/document surface instead.",
    )


# ===========================================================================
# Shared route helpers
# ===========================================================================


def build_target_fidelity_entries(api: Any) -> List[ExportTargetFidelity]:
    """Enumerate every registered export target with its per-source fidelity badge.

    The shared body of every ``…/targets`` route (authenticated and public browse alike):
    walk the emitter registry's public view and pair each target's descriptor/profile/options
    with the cheap :func:`~app.export_fidelity.build_target_fidelity` badge for ``api``.

    Args:
        api: The source :class:`~app.canonical_model.CanonicalApi` fidelity is measured against.

    Returns:
        One :class:`ExportTargetFidelity` per registered target, in registry (key) order.
    """
    entries: List[ExportTargetFidelity] = []
    for target in describe_emit_targets():
        emitter_cls = get_emitter(target.descriptor.format)
        if emitter_cls is None:  # pragma: no cover - registry/describe are always in sync
            continue
        entries.append(
            ExportTargetFidelity(
                descriptor=target.descriptor,
                capability_profile=target.capability_profile,
                options_schema=target.options_schema,
                default_options=target.default_options,
                fidelity=build_target_fidelity(api, emitter_cls),
            )
        )
    return entries


# ===========================================================================
# Routes
# ===========================================================================


@router.get(
    "/{tenant_slug}/targets",
    response_model=ExportTargetsResponse,
    summary="List export targets with per-source fidelity",
    description=(
        "For the given source artifact/version, enumerate every registered export target "
        "(descriptor + capability profile + options) with a cheap per-target fidelity badge "
        "(tier + preserved-%), computed from the prediction engine without emitting an "
        "artifact. Drives the export dialog's card badges (MFX-6.1) and the version pre-summary "
        "(MFX-6.5)."
    ),
)
async def list_export_targets(
    tenant_slug: str,
    artifact: str = Query(..., description="The artifact (project) id to export."),
    version: Optional[str] = Query(
        None,
        description="Revision UUID, version label (``1.0.0``), or omitted for the latest revision.",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportTargetsResponse:
    """Return every export target with its per-source fidelity badge.

    Args:
        tenant_slug: The tenant slug (scopes the artifact lookup).
        artifact: The artifact (project) id whose source model fidelity is measured against.
        version: The revision to measure (UUID or label); the latest revision when omitted.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The per-target fidelity list for the resolved source revision.

    Raises:
        HTTPException: 404 when the artifact/version is unknown; 422 when the revision has no
            reconstructable source; 400 when the source format cannot be adapted.
    """
    tenant_id = auth_data["tenant_id"]
    try:
        source = load_export_source(tenant_id, artifact, version)
    except ExportSourceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    entries = build_target_fidelity_entries(source.api)

    return ExportTargetsResponse(
        artifact=source.artifact_id,
        version=version,
        version_record_id=source.version_record_id,
        version_label=source.version_label,
        targets=entries,
    )


@router.get(
    "/{tenant_slug}/capability-registry",
    response_model=CapabilityRegistrySnapshot,
    summary="Get the destination capability & documentation registry",
    description=(
        "Return the versioned destination capability registry (EFP-1.2): one reviewed "
        "capability entry per registered export destination (label, availability state, and "
        "host-allowlisted destination-format documentation with a safe fallback) plus the "
        "reviewed explanation for every projection reason code. This is static reference "
        "data — the same for every source — that lets the export UI render honest loss "
        "reasons and authoritative documentation links from reviewed data instead of "
        "hard-coding URLs in components."
    ),
)
async def get_capability_registry(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> CapabilityRegistrySnapshot:
    """Return the versioned destination capability & documentation registry snapshot.

    The snapshot is deterministic and source-independent — it describes the destinations
    themselves, not any particular export — so the UI can fetch it once and cache it by
    :attr:`~app.capability_registry.CapabilityRegistrySnapshot.version`. Every documentation
    link it carries has already passed the registry's host allowlist, and every reason code
    is a member of the canonical taxonomy.

    Args:
        tenant_slug: The tenant slug (scopes access; the snapshot content is tenant-independent).
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The full :class:`~app.capability_registry.CapabilityRegistrySnapshot`.
    """
    return registry_snapshot()


@router.post(
    "/{tenant_slug}/preview",
    response_model=ExportPreviewResponse,
    summary="Preview export fidelity for one target",
    description=(
        "Compute the full fidelity report for exporting the given source artifact/version to "
        "one target — the per-construct LossinessReport, the user-facing advisory (MFX-2.4), and "
        "the tier summary — **without producing the artifact**. Backs the export dialog's "
        "detailed fidelity panel; the same envelope is embedded in an export job result."
    ),
)
async def preview_export_fidelity(
    tenant_slug: str,
    request: ExportPreviewRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportPreviewResponse:
    """Return the full fidelity envelope for one (source, target) export, emitting nothing.

    Args:
        tenant_slug: The tenant slug (scopes the artifact lookup).
        request: The source coordinates + chosen target + advisory threshold.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The dry-run preview: the full :class:`~app.export_fidelity.ExportFidelity` envelope plus
        the resolved source coordinates.

    Raises:
        HTTPException: 404 when the artifact/version is unknown; 422 when the revision has no
            reconstructable source; 400 when the target or source format is unsupported.
    """
    tenant_id = auth_data["tenant_id"]
    try:
        source = load_export_source(tenant_id, request.artifact, request.version)
    except ExportSourceError as exc:
        projection_telemetry.record("preview_failure", reason_category="source_load")
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    try:
        emitter_cls = type(resolve_emitter(request.target))
    except ExportError as exc:
        projection_telemetry.record("preview_failure", reason_category="unsupported_target")
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    fidelity = build_export_fidelity(
        source.api,
        emitter_cls,
        min_severity=request.min_severity,
        options=request.options,
    )
    # Classify the conversion off the envelope's report so the preview and the eventual
    # dispatch/job agree, and the UI knows up front whether it must confirm (MFX-3.3).
    guard = classify_transcode(source.api, emitter_cls, report=fidelity.report)
    return ExportPreviewResponse(
        artifact=source.artifact_id,
        version=request.version,
        version_record_id=source.version_record_id,
        version_label=source.version_label,
        fidelity=fidelity,
        guard=guard,
    )


@router.post(
    "/{tenant_slug}/preview-manifest",
    response_model=ExportPreviewManifestResponse,
    summary="Structural manifest of the emitted artifact: entities, fidelity, locations",
    description=(
        "Describe the emitted artifact **structurally** (IXH-4.1): every canonical entity "
        "(services → operations, channels, types → fields) with its stable canonical key, its "
        "per-entity fidelity status and reason from the shared CPDO-1.3 taxonomy, and — for "
        "entities the artifact carries — its location in the bundle (file, 1-based line in the "
        "download-serialized text, and a JSON Pointer where derivable). Entities the source has "
        "but the artifact does not carry are listed with their drop reason, never hidden. The "
        "emit runs read-only in a temporary buffer (no artifact, no job row, no field-identity "
        "persistence — the verify route's discipline) and a severe conversion is described, not "
        "blocked. Deterministic: identical (revision, target, options) yield an identical "
        "``manifest_hash``; entities are cursor-paginated (codec shared with the import preview "
        "manifest) and the full manifest is cached per (tenant, revision, target, options) so "
        "paging re-emits nothing. Backs the Export Studio's structural artifact explorer with "
        "two-way entity ↔ code selection."
    ),
)
async def preview_export_manifest(
    tenant_slug: str,
    request: ExportPreviewManifestRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportPreviewManifestResponse:
    """Return one page of the structural export preview manifest for a (source, target) pair.

    Args:
        tenant_slug: The tenant slug (scopes the artifact lookup).
        request: Source coordinates + chosen target + emit options + entity page window.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The :class:`~app.export_preview_manifest.ExportPreviewManifestResponse` with the
        requested entity page.

    Raises:
        HTTPException: 404 when the artifact/version is unknown; 422 when the revision has no
            reconstructable source, the emit options are invalid, or the emitter produced no
            document; 400 when the target or the request's cursor is malformed/unsupported.
    """
    tenant_id = auth_data["tenant_id"]
    try:
        source = load_export_source(tenant_id, request.artifact, request.version)
    except ExportSourceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    try:
        return run_export_preview_manifest(source, request, tenant_id=str(tenant_id))
    except ExportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except ValueError as exc:  # malformed page cursor
        raise HTTPException(status_code=400, detail=str(exc)) from exc


#: Placeholder written over redacted source-native evidence values (EFP-2.1 / EFP-3.2).
#: A present placeholder tells a viewer "a value was captured but withheld", which is
#: honestly different from ``null`` ("nothing was captured"). Matches the projection
#: corpus's golden redaction convention.
SOURCE_EVIDENCE_REDACTED = "[redacted]"


def _redact_evidence_page(page: ProjectionEvidencePage) -> ProjectionEvidencePage:
    """Return a copy of ``page`` with source-native evidence always redacted (EFP-3.2).

    Replaces every present ``native_id`` / ``native_name`` / ``source_location`` value on
    native nodes with :data:`SOURCE_EVIDENCE_REDACTED`, then scrubs those captured strings
    out of edge ``detail`` / ``explanation`` / ``target_mapping`` text. Construct keys,
    statuses, reasons, and target locations stay. Edges, cursors, and totals are unchanged
    so pagination identity is preserved under always-on redaction.

    Args:
        page: The evidence page to redact.

    Returns:
        The redacted copy (the input is not mutated).
    """
    sensitive: list[str] = []
    for node in page.nodes:
        if node.native is None:
            continue
        for value in (node.native.native_id, node.native.native_name, node.native.source_location):
            if value:
                sensitive.append(value)

    nodes = []
    for node in page.nodes:
        if node.native is not None and (
            node.native.native_id is not None
            or node.native.native_name is not None
            or node.native.source_location is not None
        ):
            native = NativeEvidence(
                native_id=SOURCE_EVIDENCE_REDACTED if node.native.native_id is not None else None,
                native_name=(
                    SOURCE_EVIDENCE_REDACTED if node.native.native_name is not None else None
                ),
                source_location=(
                    SOURCE_EVIDENCE_REDACTED if node.native.source_location is not None else None
                ),
            )
            nodes.append(node.model_copy(update={"native": native}))
        else:
            nodes.append(node)

    edges = []
    for edge in page.edges:
        updates: Dict[str, Any] = {}
        for field_name in ("detail", "explanation", "target_mapping"):
            text = getattr(edge, field_name)
            if not text:
                continue
            scrubbed = text
            for value in sensitive:
                if value and value in scrubbed:
                    scrubbed = scrubbed.replace(value, SOURCE_EVIDENCE_REDACTED)
            if scrubbed != text:
                updates[field_name] = scrubbed
        edges.append(edge.model_copy(update=updates) if updates else edge)

    return page.model_copy(update={"nodes": nodes, "edges": edges})


def _doc_link_counts(page: ProjectionEvidencePage) -> tuple[int, int]:
    """Count edges whose documentation URL is available vs unavailable (privacy-safe)."""
    available = 0
    missing = 0
    for edge in page.edges:
        doc = edge.documentation
        if doc is None:
            continue
        if doc.url and not doc.documentation_unavailable:
            available += 1
        else:
            missing += 1
    return available, missing


class ExportProjectionMetricRequest(BaseModel):
    """Whitelist-only client/server projection metric event (EFP-3.2).

    Rejects unknown fields. Only :data:`~app.projection_telemetry.ALLOWED_METRIC_KINDS`
    are accepted; reason categories are optional and themselves whitelisted.
    """

    model_config = ConfigDict(extra="forbid")

    kind: Literal[
        "preview_failure",
        "stale_acknowledgement",
        "evidence_page",
        "aggregation_used",
        "documentation_link_available",
        "documentation_link_missing",
    ] = Field(description="Privacy-safe metric kind (whitelist).")
    page_total: Optional[int] = Field(
        default=None,
        ge=0,
        description="Optional integer page/evidence total (no labels).",
    )
    reason_category: Optional[str] = Field(
        default=None,
        description="Optional controlled failure category (whitelist only).",
    )


class ExportProjectionMetricResponse(BaseModel):
    """Acknowledgement that a privacy-safe metric was recorded."""

    model_config = ConfigDict(extra="forbid")

    recorded: bool = True
    kind: str


@router.post(
    "/{tenant_slug}/projection-metrics",
    response_model=ExportProjectionMetricResponse,
    summary="Record a privacy-safe projection metric",
    description=(
        "Increment an in-process counter and emit a structured ``export.projection`` log "
        "line for UI/ops telemetry (EFP-3.2). Payload is a strict whitelist of kinds and "
        "optional integer/reason-category fields — never construct labels or source content."
    ),
)
async def record_projection_metric(
    tenant_slug: str,
    request: ExportProjectionMetricRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportProjectionMetricResponse:
    """Record one privacy-safe projection metric event.

    Args:
        tenant_slug: Tenant slug (scopes the call; unused in the counter key by design).
        request: Whitelisted metric payload.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        ``{"recorded": true, "kind": ...}``.

    Raises:
        HTTPException: 422 when the reason category is not on the allowlist.
    """
    _ = tenant_slug, auth_data  # auth required; tenant is not folded into metrics keys
    if request.kind not in ALLOWED_METRIC_KINDS:
        raise HTTPException(status_code=422, detail="unsupported metric kind")
    if (
        request.reason_category is not None
        and request.reason_category not in ALLOWED_REASON_CATEGORIES
    ):
        raise HTTPException(status_code=422, detail="unsupported reason_category")
    projection_telemetry.record(
        request.kind,
        reason_category=request.reason_category,
        page_total=request.page_total,
    )
    return ExportProjectionMetricResponse(kind=request.kind)


@router.post(
    "/{tenant_slug}/projection-evidence",
    response_model=ExportProjectionEvidenceResponse,
    summary="Page through projection evidence for one configured export",
    description=(
        "Return one bounded, cursor-paginated page of source→target projection evidence "
        "(EFP-2.1 / EFP-3.2) for the given source revision, target, and options — the "
        "traceable rows behind the projection summary that preview, verify, dispatch, and "
        "job results embed. The same inputs resolve to the same snapshot hash on every "
        "surface. Tenant-scoped. Source-native evidence is **always** redacted (EFP-3.2); "
        "`redact_source` is accepted for compatibility and ignored. How to interpret the "
        "statuses, reason categories, and destination-documentation links is documented in "
        "`docs/guide/export-fidelity.md` (EFP-3.3)."
    ),
)
async def get_projection_evidence(
    tenant_slug: str,
    request: ExportProjectionEvidenceRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportProjectionEvidenceResponse:
    """Return one bounded page of projection evidence for a configured export.

    Builds (or reuses a cached) deterministic projection manifesto for the requested
    ``(revision, target, options)`` and pages its outcome edges with the manifest's
    canonical cursor pagination — bounded by the hard page-size cap regardless of the
    requested limit. Source-native fields are always redacted before return.

    Args:
        tenant_slug: The tenant slug (scopes the artifact lookup).
        request: The source coordinates + target + options + page window.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The evidence page with its snapshot summary and provenance.

    Raises:
        HTTPException: 404 when the artifact/version is unknown; 422 when the revision has
            no reconstructable source or the cursor is malformed; 400 when the target or
            source format is unsupported.
    """
    _ = tenant_slug
    tenant_id = auth_data["tenant_id"]
    started = time.perf_counter()
    try:
        source = load_export_source(tenant_id, request.artifact, request.version)
    except ExportSourceError as exc:
        projection_telemetry.record("preview_failure", reason_category="source_load")
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    try:
        emitter_cls = type(resolve_emitter(request.target))
    except ExportError as exc:
        projection_telemetry.record("preview_failure", reason_category="unsupported_target")
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    normalized_options = _normalize_options_for_hash(emitter_cls, request.options)
    cache_key = build_manifest_cache_key(
        tenant_id=tenant_id,
        artifact_id=source.artifact_id,
        version_record_id=source.version_record_id,
        target=request.target,
        options=normalized_options,
        emitter_version=emitter_cls.version,
        registry_version=REGISTRY_VERSION,
        apiome_version=APIOME_VERSION,
    )
    manifest = manifest_cache.get(cache_key)
    if manifest is None:
        manifest = build_projection_manifest(source.api, emitter_cls, options=request.options)
        manifest_cache.put(cache_key, manifest)

    try:
        page = paginate_evidence(manifest, cursor=request.cursor, limit=request.limit)
    except ValueError as exc:
        projection_telemetry.record("preview_failure", reason_category="malformed_cursor")
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    page = _redact_evidence_page(page)
    summary = summarize_manifest(manifest)
    latency_ms = (time.perf_counter() - started) * 1000.0
    available, missing = _doc_link_counts(page)
    projection_telemetry.record(
        "evidence_page",
        page_total=page.total,
        latency_ms=latency_ms,
        status_counts=summary.status_counts,
        reason_counts=summary.reason_counts,
        large_manifest=page.total > UI_AGGREGATION_THRESHOLD_ROWS,
    )
    if available:
        projection_telemetry.record("documentation_link_available", n=available)
    if missing:
        projection_telemetry.record("documentation_link_missing", n=missing)

    return ExportProjectionEvidenceResponse(
        artifact=source.artifact_id,
        version=request.version,
        version_record_id=source.version_record_id,
        version_label=source.version_label,
        summary=summary,
        page=page,
        redacted=True,
    )


# Accept-header tokens that select YAML serialization of the emitted document.
_YAML_ACCEPT_TOKENS = ("application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml")


def _wants_yaml(accept: Optional[str]) -> bool:
    """True when the ``Accept`` header requests a YAML serialization of the document."""
    header = (accept or "").lower()
    return any(token in header for token in _YAML_ACCEPT_TOKENS)


def _document_filename(base_path: str, *, yaml_serialization: bool) -> str:
    """Derive the download filename from the emitted file's path, honouring the serialization.

    ``base_path`` is the emitter's primary file path (e.g. ``asyncapi.json``); when the caller
    asked for YAML we swap the extension so a saved artifact keeps an honest suffix.
    """
    name = (base_path or "document").rsplit("/", 1)[-1]
    if yaml_serialization:
        stem = name.rsplit(".", 1)[0] if "." in name else name
        return f"{stem}.yaml"
    return name


# ===========================================================================
# Delivery gate for the synchronous export routes (IXH-2.5)
# ===========================================================================

#: Largest base64 attestation a synchronous document download carries as a response header.
#: Beyond it the header is omitted (and said so) rather than risking a proxy's header limit —
#: the same delivery attested through the async job path is always retrievable in full.
_ATTESTATION_HEADER_CAP = 6 * 1024


def _delivery_gate_for_source(
    source: Any,
    *,
    tenant_id: str,
    tenant_slug: str,
    target_format: str,
    target_key: Optional[str],
    preserved_percent: Optional[int],
    validation: Optional[EmittedValidationReport] = None,
) -> DeliveryGateReport:
    """Run the IXH-2.5 delivery gate for one synchronous export, raising 409 when it blocks.

    A policy enforced only on the async job path is not enforced: the CLI and any script reach
    ``…/document`` and ``…/dispatch`` directly, so both are gated here with the same engine the
    job uses. The **source lint** is the pre-flight's linter (so the grade this gate judges is the
    grade the pre-flight showed), and the fidelity floor is measured against the projected
    preserved percentage the caller already computed.

    The **emitted-artifact validation** dimension is only folded in when the caller ran it: the
    synchronous document route deliberately does not re-parse its own output (that is what
    ``POST …/verify`` and the async job are for), so its decision spans the lint, fidelity, and
    policy dimensions and reports ``validationVerdict: null``.

    Args:
        source: The loaded :class:`~app.export_source.ExportSource`.
        tenant_id: The authenticated tenant.
        tenant_slug: The tenant slug, for the override path's waiver endpoint.
        target_format: The resolved target format key.
        target_key: The target's registry key for policy override resolution.
        preserved_percent: The conversion's projected preserved-construct percentage.
        validation: The emitted-artifact validation report, when the caller computed one.

    Returns:
        The non-blocking :class:`~app.export_delivery_gate.DeliveryGateReport`.

    Raises:
        HTTPException: 409 when the gate blocks the delivery — the body carries the decision, its
            named reasons, and the override path, and **no artifact bytes are returned**.
    """
    lint = lint_delivery_source(
        source.api, tenant_id=tenant_id, project_id=source.artifact_id
    )
    decision = evaluate_delivery(
        tenant_id=tenant_id,
        tenant_slug=tenant_slug,
        target_format=target_format,
        target_key=target_key or target_format,
        version_record_id=source.version_record_id,
        validation=validation,
        lint=lint,
        preserved_percent=preserved_percent,
    )
    # Append the delivery grade to the quality-rank series (IXH-2.7). Recorded *before* the
    # block is raised, so a refused delivery is in the series too — a tenant whose exports are
    # increasingly blocked is exactly the drift the series exists to show.
    observe_delivery(
        decision,
        tenant_id=tenant_id,
        lint=lint,
        adapter_key=target_key or target_format,
        project_id=source.artifact_id,
        version_record_id=source.version_record_id,
    )
    if decision.blocks_delivery:
        raise HTTPException(
            status_code=409,
            detail={
                "message": decision.message,
                "delivery": decision.model_dump(mode="json", exclude_none=True),
            },
        )
    return decision


def _attest_sync_delivery(
    decision: DeliveryGateReport,
    source: Any,
    *,
    tenant_id: str,
    tenant_slug: str,
    target_format: str,
    filename: str,
    body: bytes,
    media_type: Optional[str],
    validation: Optional[EmittedValidationReport] = None,
) -> DeliveryGateReport:
    """Attach the delivery attestation for a synchronous export's exact returned bytes.

    Args:
        decision: The allowed decision from :func:`_delivery_gate_for_source`.
        source: The loaded export source (for the delivery identity).
        tenant_id: The authenticated tenant.
        tenant_slug: The tenant slug.
        target_format: The resolved target format key.
        filename: The artifact's download filename.
        body: The exact bytes handed back, which the attestation subject digests.
        media_type: The artifact's media type.
        validation: The emitted-artifact validation report, for the validator identity.

    Returns:
        The decision with its :class:`~app.export_delivery_gate.DeliveryAttestation` attached.
    """
    return build_delivery_attestation(
        decision,
        tenant_id=tenant_id,
        delivery={
            "tenantSlug": tenant_slug,
            "artifactId": source.artifact_id,
            "versionRecordId": source.version_record_id,
            "versionLabel": source.version_label,
            "target": target_format,
            "channel": "synchronous",
        },
        artifact={
            "filename": filename,
            "contentSha256": hashlib.sha256(body).hexdigest(),
            "sizeBytes": len(body),
            "mediaType": media_type,
        },
        tools=delivery_tool_versions(
            target_format=target_format,
            apiome_version=APIOME_VERSION,
            validation=validation,
        ),
    )


def _disposition_filename(response: Response) -> str:
    """The download filename a rendered document response advertises.

    Read back off the response rather than re-derived, so the attestation names the artifact by
    exactly the filename the client receives.

    Args:
        response: The rendered document response.

    Returns:
        The ``Content-Disposition`` filename, or ``export-artifact`` when it carries none.
    """
    disposition = response.headers.get("Content-Disposition") or ""
    marker = 'filename="'
    start = disposition.find(marker)
    if start < 0:
        return "export-artifact"
    start += len(marker)
    end = disposition.find('"', start)
    return disposition[start:end] if end > start else "export-artifact"


def _attestation_headers(decision: DeliveryGateReport) -> Dict[str, str]:
    """Response headers carrying a synchronous delivery's decision and attestation.

    A raw-bytes download has no body to put the attestation in, so it rides as a base64 header —
    the same DSSE envelope, just transport-encoded. An envelope that would exceed
    :data:`_ATTESTATION_HEADER_CAP` is omitted with ``X-Apiome-Delivery-Attestation-Omitted:
    size`` rather than emitting a header a proxy may truncate or reject.

    Args:
        decision: The allowed delivery decision, ideally already attested.

    Returns:
        The headers to merge into the download response.
    """
    headers: Dict[str, str] = {"X-Apiome-Delivery-Decision": decision.decision.value}
    if decision.attestation is None:
        return headers
    encoded = base64.b64encode(
        json.dumps(decision.attestation.envelope, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).decode("ascii")
    if len(encoded) > _ATTESTATION_HEADER_CAP:
        headers["X-Apiome-Delivery-Attestation-Omitted"] = "size"
        return headers
    headers["X-Apiome-Delivery-Attestation"] = encoded
    return headers


def render_emitted_document(
    api: Any,
    target: str,
    options: Optional[Dict[str, Any]],
    accept: Optional[str],
    *,
    persistence: Optional[ExportPersistenceContext] = None,
) -> Response:
    """Emit ``api`` to ``target`` and wrap the primary file as an HTTP download response.

    The shared tail of every ``…/document`` route (authenticated and public browse alike):
    run the Emitter SPI, pick the primary emitted file, serialize it as JSON (default) or YAML
    (when ``accept`` asks for it), and attach a ``Content-Disposition`` filename derived from
    the emitter's output path.

    Args:
        api: The source :class:`~app.canonical_model.CanonicalApi` to emit.
        target: Target emitter key (``asyncapi``) or format key (``asyncapi-3``).
        options: Per-target emit options; ``None``/empty applies the target defaults.
        accept: The request's ``Accept`` header, for JSON/YAML content negotiation.
        persistence: Optional field-identity persistence context; ``None`` keeps the emit
            fully read-only (the public path must never write).

    Returns:
        The emitted document as a download :class:`~fastapi.Response`.

    Raises:
        HTTPException: 400 when the target or options are unsupported; 422 when the emitter
            produced no document.
    """
    try:
        result = emit_canonical(api, target, opts=options, persistence=persistence)
    except ExportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    if not result.files:  # pragma: no cover - registered emitters always produce a file
        raise HTTPException(
            status_code=422,
            detail=f"Target {target!r} produced no document for this source.",
        )

    primary = result.files[0]
    content = primary.content
    yaml_serialization = _wants_yaml(accept)
    filename = _document_filename(primary.path, yaml_serialization=yaml_serialization)
    disposition = {"Content-Disposition": f'attachment; filename="{filename}"'}

    # Structured (dict) documents serialize to the requested wire format; a plain-text bundle
    # (rare, non-JSON/YAML targets) is returned verbatim under its own media type.
    if isinstance(content, dict):
        if yaml_serialization:
            body = yaml.dump(content, sort_keys=False, default_flow_style=False)
            return Response(
                content=body, media_type="application/x-yaml", headers=disposition
            )
        body = json.dumps(content, indent=2, ensure_ascii=False)
        return Response(
            content=body,
            media_type=primary.media_type or result.media_type or "application/json",
            headers=disposition,
        )

    return Response(
        content=str(content),
        media_type=primary.media_type or result.media_type or "text/plain",
        headers=disposition,
    )


@router.post(
    "/{tenant_slug}/document",
    summary="Emit the export document for one target",
    description=(
        "Emit the source artifact/version to one ``target`` through the Emitter SPI and return "
        "the document itself — JSON by default, YAML when ``Accept: application/yaml`` is sent. "
        "This is the emit counterpart to ``/preview`` (which predicts the loss without emitting); "
        "the ``apiome export <target>`` CLI pairs the two to write the artifact and surface its "
        "fidelity. Gives non-OpenAPI targets (AsyncAPI) a byte source the OpenAPI-only browse "
        "reconstruction cannot supply."
    ),
    response_class=Response,
)
async def emit_export_document(
    tenant_slug: str,
    request: ExportDocumentRequest,
    accept: Optional[str] = Header(None),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Response:
    """Emit and return the export document for one (source, target) pair.

    Args:
        tenant_slug: The tenant slug (scopes the artifact lookup).
        request: The source coordinates + chosen target + optional per-emit options.
        accept: Accept header for JSON/YAML content negotiation.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The emitted document, serialized as JSON (default) or YAML, with a ``Content-Disposition``
        filename derived from the emitter's primary output path.

    Raises:
        HTTPException: 404 when the artifact/version is unknown; 422 when the revision has no
            reconstructable source or the emitter produced no document; 400 when the target,
            source format, or options are unsupported; 409 when the tenant's export quality
            policy blocks the delivery (IXH-2.5) — the body carries the reasons and the override
            path, and no document bytes are returned.
    """
    tenant_id = auth_data["tenant_id"]
    try:
        source = load_export_source(tenant_id, request.artifact, request.version)
    except ExportSourceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    # The delivery gate runs *before* the emit, so a blocked delivery never even produces bytes
    # to withhold. The projected fidelity comes from the same cheap summary builder the export
    # pre-flight ranks targets with, so the floor is measured identically on both surfaces.
    try:
        target_format = resolve_emit_format(request.target)
        emitter_cls = get_emitter(target_format)
    except ExportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    fidelity = build_target_fidelity(source.api, emitter_cls)
    decision = _delivery_gate_for_source(
        source,
        tenant_id=str(tenant_id),
        tenant_slug=tenant_slug,
        target_format=target_format,
        target_key=emitter_cls.key or target_format,
        preserved_percent=fidelity.preserved_percent,
    )

    response = render_emitted_document(
        source.api,
        request.target,
        request.options,
        accept,
        persistence=ExportPersistenceContext(
            tenant_id=tenant_id,
            artifact_id=source.artifact_id,
        ),
    )
    decision = _attest_sync_delivery(
        decision,
        source,
        tenant_id=str(tenant_id),
        tenant_slug=tenant_slug,
        target_format=target_format,
        filename=_disposition_filename(response),
        body=bytes(response.body or b""),
        media_type=response.media_type,
    )
    response.headers.update(_attestation_headers(decision))
    return response


@router.post(
    "/{tenant_slug}/dispatch",
    response_model=ExportDispatchResponse,
    summary="Dispatch an export: emit one target and attach its fidelity report",
    description=(
        "The one-shot transcode (MFX-3.2): load the source artifact/version, resolve the target "
        "emitter, run it, and return the emitted document **together with** its full fidelity "
        "envelope (report + advisory + summary). The synchronous twin of submitting an export job "
        "and polling it — for small artifacts and the ``apiome export`` CLI; large or "
        "toolchain-backed exports should use ``POST …/jobs``. ``dry_run: true`` stops after the "
        "fidelity report (no artifact), the same shape ``POST …/preview`` returns."
    ),
)
async def dispatch_export_document(
    tenant_slug: str,
    request: ExportDispatchRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportDispatchResponse:
    """Emit one (source, target) pair and return the artifact alongside its fidelity report.

    Args:
        tenant_slug: The tenant slug (scopes the artifact lookup).
        request: Source coordinates + chosen target + optional per-emit options + dry-run flag.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The dispatch result: resolved coordinates, the full fidelity envelope, and — for a real
        (non-dry-run) export — the emitted files inline.

    Raises:
        HTTPException: 404 when the artifact/version is unknown; 422 when the revision has no
            reconstructable source or the emitter produced no document; 400 when the target or
            source format is unsupported; 422 when the emit options are invalid for the target;
            409 when the conversion is severe (MFX-3.3) and ``confirm`` was not set, or when the
            tenant's export quality policy blocks the delivery (IXH-2.5).
    """
    tenant_id = str(auth_data["tenant_id"])
    try:
        source = load_export_source(tenant_id, request.artifact, request.version)
    except ExportSourceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    # Gate the delivery *before* the emit (IXH-2.5). Emitting first would both waste the work and
    # write proto3 field-identity rows for an artifact that is never delivered; a dry-run delivers
    # nothing, so it is not gated (the same rule the async job's dry-run gate applies).
    decision: Optional[DeliveryGateReport] = None
    if not request.dry_run:
        try:
            target_format = resolve_emit_format(request.target)
            emitter_cls = get_emitter(target_format)
        except ExportError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        projected = build_target_fidelity(source.api, emitter_cls)
        decision = _delivery_gate_for_source(
            source,
            tenant_id=tenant_id,
            tenant_slug=tenant_slug,
            target_format=target_format,
            target_key=emitter_cls.key or target_format,
            preserved_percent=projected.preserved_percent,
        )

    try:
        dispatch = dispatch_from_source(
            source,
            request.target,
            options=request.options,
            min_severity=request.min_severity,
            dry_run=request.dry_run,
            confirm=request.confirm,
            persistence=ExportPersistenceContext(
                tenant_id=tenant_id, artifact_id=source.artifact_id
            ),
        )
    except ExportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except TranscodeGuardError as exc:
        # A severe conversion the caller did not confirm: 409 with the guard so the client can
        # render the confirmation prompt and retry with ``confirm: true`` (MFX-3.3).
        raise HTTPException(
            status_code=exc.status_code,
            detail={"message": exc.guard.message, "guard": exc.guard.model_dump(mode="json")},
        ) from exc

    files: List[ExportDispatchFile] = []
    media_type: Optional[str] = None
    if dispatch.emit is not None:
        media_type = dispatch.emit.media_type
        files = [
            ExportDispatchFile(
                path=f.path,
                content=f.content,
                media_type=f.media_type,
                subject=f.subject,
            )
            for f in dispatch.emit.files
        ]
        if decision is not None:
            # The attestation's subject is the artifact this response actually carries, so it is
            # digested over the canonical serialization of the inline files — the bytes a client
            # would write to disk, in a stable order.
            inline = json.dumps(
                [{"path": f.path, "content": serialize_file_content(f.content)}
                 for f in dispatch.emit.files],
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            decision = _attest_sync_delivery(
                decision,
                source,
                tenant_id=tenant_id,
                tenant_slug=tenant_slug,
                target_format=dispatch.target,
                filename=dispatch.emit.files[0].path,
                body=inline,
                media_type=media_type,
            )

    return ExportDispatchResponse(
        artifact=dispatch.artifact,
        version=request.version,
        version_record_id=dispatch.version_record_id,
        version_label=dispatch.version_label,
        target=dispatch.target,
        dry_run=dispatch.dry_run,
        fidelity=dispatch.fidelity,
        guard=dispatch.guard,
        files=files,
        media_type=media_type,
        delivery=decision,
    )


# The inline-content budget for a verify response: emitted artifacts up to this serialized size
# ride back inline (so the Monaco viewer, MFX-43.x, renders from the same call); larger ones set
# ``truncated`` and are omitted, to be fetched via the job/document surface instead.
_VERIFY_INLINE_CONTENT_CAP = 256 * 1024


def _verify_verdict(
    validation: EmittedValidationReport, tier: ExportFidelityTier
) -> ExportVerifyVerdict:
    """Derive the overall verify verdict from the validation gate and the fidelity tier.

    Mirrors the client's ``deriveVerifyVerdict`` (MFX-42.1) so the server-authored verdict and the
    UI's fallback derivation always agree: an ``invalid`` validation blocks unconditionally; a
    non-lossless (loss-bearing) tier is ``lossy``; everything else is ``clean``. A ``skipped``
    validation (toolchain unavailable) warns but never demotes a clean band.

    Args:
        validation: The MFX-5.3 validation gate for the emitted artifact.
        tier: The conversion's fidelity tier (MFX-2.5).

    Returns:
        The go/no-go band the Generate gate reads.
    """
    if validation.blocks_delivery:
        return ExportVerifyVerdict.INVALID
    if tier is not ExportFidelityTier.LOSSLESS:
        return ExportVerifyVerdict.LOSSY
    return ExportVerifyVerdict.CLEAN


def _inline_verify_files(
    emit: Optional[Any], *, include_content: bool
) -> tuple[List[ExportDispatchFile], bool]:
    """Build the inline emitted-file list for a verify response, honouring the size cap.

    Returns the emitted files inline when the caller opted in and the serialized bundle fits under
    :data:`_VERIFY_INLINE_CONTENT_CAP`; otherwise returns an empty list and ``truncated=True`` so
    the client fetches the artifact separately (MFX-43.x). The bytes are measured, never persisted.

    Args:
        emit: The emitter's output bundle (an :class:`~app.emitter.EmitResult`), or ``None``.
        include_content: Whether the caller asked for the artifact inline.

    Returns:
        A ``(files, truncated)`` pair: the inline files (possibly empty) and whether the artifact
        was omitted for exceeding the cap.
    """
    if emit is None or not include_content:
        return [], False
    total = 0
    for f in emit.files:
        content = f.content
        total += len(content if isinstance(content, str) else json.dumps(content, ensure_ascii=False))
    if total > _VERIFY_INLINE_CONTENT_CAP:
        return [], True
    files = [
        ExportDispatchFile(path=f.path, content=f.content, media_type=f.media_type, subject=f.subject)
        for f in emit.files
    ]
    return files, False


@router.post(
    "/{tenant_slug}/verify",
    response_model=ExportVerifyResponse,
    summary="One-call pre-generation verify: fidelity + validation + lint + verdict",
    description=(
        "The Verify workbench's dry run (MFX-42.5, backing MFX-42.1): emit the source "
        "artifact/version to one ``target`` in a **temporary buffer**, then run fidelity "
        "(MFX-2.5) + emitted-output validation (MFX-5.1/5.3) + emitted-artifact lint (MFX-5.2) "
        "over it, and return all three lenses plus an overall go/no-go **verdict** — **without "
        "persisting an artifact or a job row**. The emit is read-only (no field-identity "
        "persistence), so a verify never mutates tenant state. The emitted artifact rides back "
        "inline under a size cap (``include_content``) for the Monaco viewer (MFX-43.x). A severe "
        "conversion (MFX-3.3) is **verified, not blocked** — its verdict reports the loss so the "
        "user can decide. Rate-limited by the global per-tenant middleware (it does real emit "
        "work). Lint (MFX-5.2) is not yet implemented, so ``lint`` is currently ``null``. "
        "Typical p50 for the five MVP emitters (OpenAPI, AsyncAPI, GraphQL, gRPC/Protobuf, Avro) "
        "is dominated by the single emit + re-parse and runs in the tens of milliseconds for "
        "pure-Python validators; protobuf/AsyncAPI add their toolchain's startup when installed."
    ),
)
async def verify_export(
    tenant_slug: str,
    request: ExportVerifyRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportVerifyResponse:
    """Emit one (source, target) pair to a temporary buffer and return all three verify lenses.

    Args:
        tenant_slug: The tenant slug (scopes the artifact lookup).
        request: Source coordinates + chosen target + per-emit options + inline-content flag.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The one-call verify result: the fidelity envelope, the emitted-output validation gate, the
        (currently null) lint report, the overall verdict, and — under the cap — the artifact
        inline. No artifact or job row is persisted.

    Raises:
        HTTPException: 404 when the artifact/version is unknown; 422 when the revision has no
            reconstructable source or the emitter produced no document; 400 when the target or
            source format is unsupported; 422 when the emit options are invalid for the target.
    """
    tenant_id = auth_data["tenant_id"]
    try:
        source = load_export_source(tenant_id, request.artifact, request.version)
    except ExportSourceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    try:
        # confirm=True: a severe conversion is *verified* here (its verdict reports the loss), not
        # blocked — blocking is the job/dispatch path's job, not the pre-generation preview's.
        # persistence=None keeps the emit read-only: a verify never persists field identities.
        dispatch = dispatch_from_source(
            source,
            request.target,
            options=request.options,
            min_severity=request.min_severity,
            dry_run=False,
            confirm=True,
            persistence=None,
        )
    except ExportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    # A real (non-dry-run) dispatch that returned without raising always carries an artifact.
    if dispatch.emit is None:  # pragma: no cover - defensive; a real dispatch always emits
        raise HTTPException(
            status_code=422,
            detail=f"Target {request.target!r} produced no document for this source.",
        )

    validation = await validate_emitted_artifact(dispatch.target, dispatch.emit, api=source.api)
    validation_report = build_validation_report(validation)
    verdict = _verify_verdict(validation_report, dispatch.fidelity.summary.tier)
    files, truncated = _inline_verify_files(
        dispatch.emit, include_content=request.include_content
    )

    return ExportVerifyResponse(
        artifact=dispatch.artifact,
        version=request.version,
        version_record_id=dispatch.version_record_id,
        version_label=dispatch.version_label,
        target=dispatch.target,
        fidelity=dispatch.fidelity,
        guard=dispatch.guard,
        validation=validation_report,
        lint=None,
        verdict=verdict,
        files=files,
        truncated=truncated,
    )


@tenant_router.post(
    "/{tenant_slug}/export/preflight",
    response_model=ExportPreflightReport,
    summary="Pre-flight an export: source lint + target-readiness ranking (no job, no artifact)",
    description=(
        "Rank every export target for one source revision **before** a job exists (IXH-2.4). "
        "Lints the *source* under the tenant's resolved style guide — the check the export path "
        "otherwise only makes against the emitted artifact, and only after the job — then, per "
        "target, returns the projected fidelity envelope (tier, preserved %, DROP/APPROX/SYNTH "
        "counts from the same prediction engine a job embeds in its result), the capability "
        "verdict (which construct classes this source uses vs. which the target declares it can "
        "carry), the tenant export quality-policy verdict (IXH-2.3) with any honoured waiver, and "
        "a composite readiness score with a one-line rationale.\n\n"
        "Targets are returned best-readiness first: ready → caution → blocked → unavailable, then "
        "by descending score and target key. A target the policy **blocks** is ranked and returned "
        "with its reason, never hidden. Nothing is emitted and nothing is persisted — no export "
        "job, no artifact, no field-identity rows. The ranking is deterministic for a fixed source "
        "revision, style guide, and policy; ``ranking_fingerprint`` lets a caller assert that "
        "without diffing the body. This is the pre-job counterpart to ``POST …/export/verify``."
    ),
)
async def preflight_export(
    tenant_slug: str,
    request: ExportPreflightRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportPreflightReport:
    """Rank every export target for one source revision, emitting and persisting nothing.

    Authenticated like the rest of the export surface (no additional action permission): the
    pre-flight reads the source the caller can already export and writes nothing.

    Args:
        tenant_slug: The tenant slug (scopes the artifact lookup).
        request: The source coordinates plus the optional target filter.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The :class:`~app.export_preflight.ExportPreflightReport` for the resolved revision.

    Raises:
        HTTPException: 404 when the artifact/version is unknown; 422 when the revision has no
            reconstructable source.
    """
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    try:
        source = load_export_source(tenant_id, request.artifact, request.version)
    except ExportSourceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    return run_export_preflight(source, request, tenant_id=tenant_id)

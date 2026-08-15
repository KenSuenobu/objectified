"""Convert-to-project/version job + provenance — MFI-22.5 (#4006), passthrough MFI-22.7 (#4008).

The emitter (:mod:`app.openapi_emitter`, MFI-22.1), paradigm projections
(:mod:`app.projection`, MFI-22.2) and fidelity analyzer (:mod:`app.fidelity`,
MFI-22.3) turn a catalog item's canonical model into an OpenAPI 3.1 document *and*
tell the user how faithful that conversion is. This module is the step after the
user says **"convert"**: it makes the conversion *real*.

OpenAPI/Swagger and TypeSpec sources skip the lossy projection (MFI-22.7): the
preview/commit path classifies the source and either adopts the captured document
(or a structural Swagger 2.0→3.1 upgrade) or compiles TypeSpec via ``tsp``, returning
a high-fidelity report. Every other format still:

1. **emits** the OpenAPI 3.1 document from the source :class:`~app.canonical_model.CanonicalApi`
   (optionally closing cheap gaps with user-supplied ``defaults`` — an info title/version or
   servers the source lacked);
2. **analyzes** its fidelity (:func:`app.fidelity.analyze_fidelity`) so the report the user saw in
   the preview is the report persisted with the result, and builds the **projection manifest**
   (:mod:`app.conversion_projection`, CPDO-1.3) from the same triple — the traceable
   source-construct → OpenAPI-pointer graph behind that report;
3. **mints or re-versions a publishable OpenAPI Project** from the emitted document by *reusing the
   spec-import submit→commit engine* (:mod:`app.spec_import_engine`) — a first conversion creates a
   new Project + ``v1``; a **re-convert of a changed source** appends a *new version* to the Project
   the source was previously converted into (looked up via the provenance ledger) instead of
   duplicating the Project;
4. runs the existing **OpenAPI lint/score** (MFI-EPIC-4) on the converted result; and
5. **persists provenance** — the source artifact id + source revision + source format/protocol +
   the fidelity report + the converter tool versions + the projection manifest hash/summary
   (V214) — into ``apiome.conversion_provenance`` (V139), so the converted spec links back to its
   origin, a later re-import diffs cleanly, and a stored conversion can be compared snapshot-for-
   snapshot with the one before it.

The orchestration (:func:`run_conversion`) is written against small **ports**
(:class:`SpecCommitter`, :class:`LintScorer`, :class:`ProvenanceStore`) so the
decision logic — emit, analyze, first-convert-vs-re-convert, persist — is pure and
unit-testable with fakes, while the production wiring (the spec-import worker, the
lint engine, the database) lives in swappable default adapters
(:func:`default_ports`). The REST endpoint + CLI that call this job are MFI-22.6.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version
from typing import Any, Dict, List, Optional, Protocol

from pydantic import BaseModel, ConfigDict, Field

from .canonical_model import CanonicalApi, Server
from .conversion_projection import (
    ConversionManifest,
    ConversionManifestSummary,
    build_conversion_manifest,
    summarize_conversion_manifest,
)
from .emitter import EmitResult
from .export_service import ExportError, emit_canonical, resolve_emit_format
from .fidelity import FidelityReport, analyze_fidelity
from .payload_analysis import PayloadAnalysisDocument, source_digest

logger = logging.getLogger(__name__)

__all__ = [
    "ConversionError",
    "ConversionDefaults",
    "ConversionSource",
    "ConversionCommit",
    "ConversionPreview",
    "LintScore",
    "ConversionResult",
    "SpecCommitter",
    "LintScorer",
    "ProvenanceStore",
    "converter_tool_versions",
    "preview_conversion",
    "run_conversion",
    "default_ports",
    "SpecImportCommitter",
    "DbLintScorer",
    "DbConversionProvenanceStore",
]

#: Only emit target supported today; the verb is written target-generic for future emitters (22.6).
DEFAULT_TARGET_FORMAT = "openapi-3.1"

#: Semantic version label a first conversion assigns to the minted Project's ``v1``.
INITIAL_VERSION_LABEL = "1.0.0"

#: ``source_kind`` handed to the spec-import engine for the emitted OpenAPI document. Matches the
#: worker-backed OpenAPI importer (:data:`app.spec_import_engine._WORKER_BACKED_ADAPTER_KEYS`) so the
#: emitted doc is decomposed into a full publishable Project + version exactly like an OpenAPI upload.
CONVERT_IMPORT_SOURCE_KIND = "openapi"

#: Default conversion mode for the lossy canonical→OpenAPI path (MFI-22.1–22.5).
LOSSY_CONVERSION_MODE = "lossy"


class ConversionError(Exception):
    """A conversion could not be completed (bad source, commit failure, …).

    Carries an optional ``status_code`` so the MFI-22.6 REST endpoint can map a failure onto an HTTP
    status without re-classifying it.
    """

    def __init__(self, message: str, *, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


# ===========================================================================
# Value objects
# ===========================================================================


class ConversionDefaults(BaseModel):
    """User-supplied values that close cheap gaps *before* committing a conversion.

    All optional: each is applied to the emitted document only where the source model left the
    corresponding construct empty, so a default never overwrites a value the source actually
    declared. Mirrors the inline defaults the preview screen (MFI-22.4) collects.
    """

    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = Field(default=None, description="Fallback API title when the source has none.")
    version: Optional[str] = Field(
        default=None, description="Fallback API version when the source declares none."
    )
    servers: List[str] = Field(
        default_factory=list,
        description="Fallback server URLs when the source declares no servers.",
    )


class ConversionSource(BaseModel):
    """The loaded source artifact a conversion job operates on.

    Bundles the canonical model to emit with the provenance coordinates the converted Project must
    link back to. Building this from a catalog item (reconstructing the canonical model from the
    stored/captured source) is the caller's concern — the job takes it ready-made so its logic stays
    pure and independent of how the source was loaded.
    """

    model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)

    api: CanonicalApi = Field(description="The source canonical model to convert.")
    source_project_id: str = Field(description="Catalog item id (a project id, MFI-23.1) being converted.")
    source_version_id: Optional[str] = Field(
        default=None, description="The source revision (``versions.id``) that was converted."
    )
    source_format: Optional[str] = Field(
        default=None, description="Source format key (e.g. ``grpc``); defaults to the model's format."
    )
    source_protocol: Optional[str] = Field(
        default=None, description="Source protocol; defaults to the model's protocol."
    )
    source_version_label: Optional[str] = Field(
        default=None, description="Source-declared API version; defaults to the model's version."
    )
    source_tool_versions: Dict[str, Any] = Field(
        default_factory=dict, description="Tool provenance the import recorded for the source revision."
    )
    source_text: Optional[str] = Field(
        default=None,
        description="Captured raw source text (needed for TypeSpec native emit and OpenAPI "
        "passthrough when ``api.raw`` is absent) — MFI-22.7.",
    )
    analysis: Optional[PayloadAnalysisDocument] = Field(
        default=None,
        description="The source revision's payload analysis (CPDO-1.1/1.2), when one exists. "
        "Feeds the projection manifest's source-side evidence; ``None`` yields a manifest that "
        "declares the analysis unavailable rather than one that quietly omits the question.",
    )


class ConversionCommit(BaseModel):
    """What a :class:`SpecCommitter` produced: the minted / re-versioned Project + revision."""

    model_config = ConfigDict(extra="forbid")

    project_id: str
    project_slug: str
    version_id: str = Field(description="Semantic version label of the created revision (e.g. ``1.0.0``).")
    version_record_id: str = Field(description="Row id (``versions.id``) of the created revision.")
    created_project: bool = Field(description="True when a new Project was minted (first convert).")


class LintScore(BaseModel):
    """An OpenAPI lint/score (MFI-EPIC-4) captured on a converted revision."""

    model_config = ConfigDict(extra="forbid")

    score: int
    grade: str
    report_fingerprint: Optional[str] = None


class ConversionPreview(BaseModel):
    """The side-effect-free outcome of a conversion: the fidelity report + the would-be document.

    Produced by :func:`preview_conversion` — the emit + analyze steps of :func:`run_conversion`
    *without* committing anything. It powers the MFI-22.6 endpoint's ``dryRun=true`` response (which
    backs the MFI-22.4 preview screen): the user sees exactly what a commit would produce and how
    faithful it is, with no Project/version created.
    """

    model_config = ConfigDict(extra="forbid")

    fidelity: FidelityReport
    document: Dict[str, Any] = Field(description="The OpenAPI 3.1 document the conversion would emit.")
    target_format: str = Field(description="Emit target the preview was produced for.")
    conversion_mode: str = Field(
        default=LOSSY_CONVERSION_MODE,
        description="How the document was produced: ``passthrough``, ``typespec_native``, or "
        "``lossy`` (MFI-22.7).",
    )
    manifest: ConversionManifest = Field(
        description="The deterministic conversion projection manifest (CPDO-1.3) — which source "
        "construct became which OpenAPI pointer, and why anything did not.",
    )


class ConversionResult(BaseModel):
    """The full outcome of a conversion job, returned to the caller (and the 22.6 endpoint)."""

    model_config = ConfigDict(extra="forbid")

    project_id: str
    project_slug: str
    version_id: str
    version_record_id: str
    created_project: bool = Field(description="True when a new Project was minted; False on re-convert.")
    reconverted: bool = Field(description="True when this superseded a prior conversion of the source.")
    fidelity: FidelityReport
    lint: Optional[LintScore] = Field(
        default=None, description="Captured lint/score; None if the best-effort capture failed."
    )
    provenance_id: str = Field(description="Id of the persisted ``conversion_provenance`` row.")
    document: Dict[str, Any] = Field(description="The emitted OpenAPI 3.1 document that was committed.")
    conversion_mode: str = Field(
        default=LOSSY_CONVERSION_MODE,
        description="How the document was produced: ``passthrough``, ``typespec_native``, or "
        "``lossy`` (MFI-22.7).",
    )
    projection: ConversionManifestSummary = Field(
        description="The bounded projection-manifest summary persisted with the provenance row "
        "(CPDO-1.3): the snapshot hash, the tool versions that produced it, and the tallies.",
    )


# ===========================================================================
# Ports (dependency-inversion seams)
# ===========================================================================


class SpecCommitter(Protocol):
    """Turns an emitted OpenAPI document into a committed Project + revision.

    The production adapter (:class:`SpecImportCommitter`) reuses the spec-import submit→commit engine;
    tests supply a fake. When ``target_project_id`` is set the commit must add a *new version* to that
    existing Project (a re-convert) rather than mint a new one.
    """

    async def commit(
        self,
        *,
        tenant_slug: str,
        tenant_id: str,
        user_id: Optional[str],
        document: Dict[str, Any],
        source: ConversionSource,
        target_project_id: Optional[str],
        version_label: str,
    ) -> ConversionCommit: ...


class LintScorer(Protocol):
    """Computes and persists the OpenAPI lint/score for a freshly committed revision."""

    async def score(
        self, *, tenant_slug: str, tenant_id: str, version_record_id: str
    ) -> Optional[LintScore]: ...


class ProvenanceStore(Protocol):
    """Reads/writes the ``apiome.conversion_provenance`` ledger."""

    def latest_for_source(self, tenant_id: str, source_project_id: str) -> Optional[Dict[str, Any]]:
        """Most recent conversion of ``source_project_id``, or ``None`` if never converted."""
        ...

    def record(
        self,
        *,
        tenant_id: str,
        created_by: Optional[str],
        source: ConversionSource,
        commit: ConversionCommit,
        fidelity: FidelityReport,
        lint: Optional[LintScore],
        converter_tool_versions: Dict[str, Any],
        reconverted: bool,
        projection: ConversionManifestSummary,
        manifest: ConversionManifest,
        source_hash: Optional[str],
    ) -> Dict[str, Any]:
        """Append one provenance row; return it (must include ``id``).

        ``manifest`` is the full projection graph the conversion was approved under, for the
        content-addressed evidence snapshot (CPDO-3.3); ``source_hash`` is the ``sha256:``-prefixed
        digest of the exact source text converted, or ``None`` when no source text was captured.
        """
        ...


# ===========================================================================
# Pure helpers
# ===========================================================================


def converter_tool_versions(*, conversion_mode: str = LOSSY_CONVERSION_MODE) -> Dict[str, str]:
    """Return the conversion tool versions stamped onto each provenance row.

    Records *what produced this conversion* so it is reproducible and a later re-convert can be
    compared against the tooling that made the prior one: the ``apiome-rest`` package version and
    the emitter/analyzer contract identifiers (MFI-22.1/22.3). For OpenAPI-native passthrough and
    TypeSpec native emit (MFI-22.7), the ``emitter`` key names the path taken instead of the
    lossy OpenAPI 3.1 emitter.

    Args:
        conversion_mode: The :class:`~app.conversion_passthrough.ConversionMode` value that
            produced the document (``passthrough`` / ``typespec_native`` / ``lossy``).
    """
    try:
        rest_version = _pkg_version("apiome-rest")
    except PackageNotFoundError:  # pragma: no cover - packaging edge, not worth a DB-free test
        rest_version = "unknown"
    if conversion_mode == "passthrough":
        emitter = "passthrough"
    elif conversion_mode == "typespec_native":
        emitter = "typespec-native"
    else:
        emitter = DEFAULT_TARGET_FORMAT
    return {
        "apiome-rest": rest_version,
        "emitter": emitter,
        "fidelity-analyzer": "MFI-22.3" if conversion_mode == LOSSY_CONVERSION_MODE else "MFI-22.7",
        "conversion-mode": conversion_mode,
    }


def _apply_defaults(api: CanonicalApi, defaults: Optional[ConversionDefaults]) -> CanonicalApi:
    """Return ``api`` with user ``defaults`` filled in *only where the source left a gap*.

    A default never overwrites a value the source declared: a title/version is applied solely when
    the model has none, and servers are added solely when the model declares none. Returns the model
    unchanged (a copy) when there is nothing to fill, so the emitter still sees a distinct object.
    """
    if defaults is None:
        return api
    patch: Dict[str, Any] = {}
    if defaults.title and not (api.title and api.title.strip()):
        patch["title"] = defaults.title
    if defaults.version and not (api.version and api.version.strip()):
        patch["version"] = defaults.version
    if defaults.servers and not api.servers:
        patch["servers"] = [Server(url=url) for url in defaults.servers if url and url.strip()]
    if not patch:
        return api
    return api.model_copy(update=patch)


def _next_version_label(prior: Optional[Dict[str, Any]]) -> str:
    """Semantic version label for the revision this conversion will create.

    A first conversion assigns :data:`INITIAL_VERSION_LABEL`. A re-convert bumps the patch component
    of the prior conversion's target label (``1.0.0`` → ``1.0.1``); when the prior label is not a
    dotted numeric triple it falls back to appending a ``.1`` suffix, so the label is always distinct
    from the one already on the Project (the import engine rejects a duplicate version line).
    """
    if not prior:
        return INITIAL_VERSION_LABEL
    label = (prior.get("target_version_label") or "").strip()
    if not label:
        return INITIAL_VERSION_LABEL
    parts = label.split(".")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        major, minor, patch = (int(p) for p in parts)
        return f"{major}.{minor}.{patch + 1}"
    return f"{label}.1"


# ===========================================================================
# Orchestrator
# ===========================================================================


def preview_conversion(
    source: ConversionSource,
    defaults: Optional[ConversionDefaults] = None,
    target_format: str = DEFAULT_TARGET_FORMAT,
) -> ConversionPreview:
    """Emit + analyze a conversion **without committing it** (the dry-run path).

    Runs the pure, deterministic first half of :func:`run_conversion`. OpenAPI/Swagger sources
    and TypeSpec take the near-lossless paths (MFI-22.7 — passthrough / ``tsp`` native emit);
    every other format fills cheap gaps from ``defaults``, emits via the OpenAPI 3.1 emitter
    (MFI-22.1), and analyzes fidelity (MFI-22.3). Either way the projection manifest (CPDO-1.3)
    is built from the same ``(model, document, report)`` triple, so the traceable graph and the
    aggregate report a user sees always describe one conversion. No Project/version is created
    and nothing is persisted, so this is safe to call for a preview (MFI-22.4) or a CLI
    ``--dry-run`` (MFI-22.6).

    Args:
        source: The loaded canonical model + source provenance coordinates.
        defaults: Optional user-supplied fallbacks (title/version/servers) for cheap gaps
            (lossy path only).
        target_format: Emit target; only :data:`DEFAULT_TARGET_FORMAT` is supported today.

    Returns:
        A :class:`ConversionPreview` with the fidelity report, the would-be OpenAPI document,
        the projection manifest, and the :attr:`~ConversionPreview.conversion_mode` that
        produced them.

    Raises:
        ConversionError: If ``target_format`` is unsupported, or a native/passthrough path fails.
    """
    from .conversion_passthrough import (
        ConversionMode,
        classify_conversion,
        resolve_passthrough_preview,
    )

    mode = classify_conversion(
        source_format=source.source_format, api_format=source.api.format
    )
    if mode is not ConversionMode.LOSSY:
        try:
            resolved_format = resolve_emit_format(target_format)
        except ExportError as exc:
            raise ConversionError(str(exc), status_code=exc.status_code) from exc
        document, report = resolve_passthrough_preview(
            mode=mode, api=source.api, source_text=source.source_text
        )
        # The passthrough/native paths adopt or compile a document rather than walking the
        # canonical model, so there is no per-pointer provenance trail; the manifest is built
        # without one, where a resolvable pointer is faithful by construction.
        return ConversionPreview(
            fidelity=report,
            document=document,
            target_format=resolved_format,
            conversion_mode=mode.value,
            manifest=_build_manifest(
                api=source.api,
                document=document,
                report=report,
                emit_result=None,
                source=source,
                defaults=defaults,
                target_format=resolved_format,
                conversion_mode=mode.value,
            ),
        )

    api = _apply_defaults(source.api, defaults)
    try:
        resolved_format = resolve_emit_format(target_format)
        emit_result = emit_canonical(api, target_format)
    except ExportError as exc:
        raise ConversionError(str(exc), status_code=exc.status_code) from exc
    report = analyze_fidelity(api, emit_result)
    return ConversionPreview(
        fidelity=report,
        document=emit_result.document,
        target_format=resolved_format,
        conversion_mode=LOSSY_CONVERSION_MODE,
        manifest=_build_manifest(
            api=api,
            document=emit_result.document,
            report=report,
            emit_result=emit_result,
            source=source,
            defaults=defaults,
            target_format=resolved_format,
            conversion_mode=LOSSY_CONVERSION_MODE,
        ),
    )


def _build_manifest(
    *,
    api: CanonicalApi,
    document: Dict[str, Any],
    report: FidelityReport,
    emit_result: Optional[EmitResult],
    source: ConversionSource,
    defaults: Optional[ConversionDefaults],
    target_format: str,
    conversion_mode: str,
) -> ConversionManifest:
    """Build the CPDO-1.3 projection manifest for one preview, from the coordinates in ``source``.

    A thin adapter so both conversion paths (lossy and passthrough/native) assemble the manifest
    from one place and therefore stamp the same provenance — the converter tool versions for the
    mode that ran, the source revision coordinates, and the revision's payload analysis when the
    caller loaded one.
    """
    return build_conversion_manifest(
        api=api,
        document=document,
        report=report,
        emit_result=emit_result,
        target_format=target_format,
        conversion_mode=conversion_mode,
        tool_versions=converter_tool_versions(conversion_mode=conversion_mode),
        defaults=defaults.model_dump(mode="json") if defaults is not None else None,
        analysis=source.analysis,
        project_id=source.source_project_id,
        version_record_id=source.source_version_id,
        source_format=source.source_format,
        source_protocol=source.source_protocol,
        source_version_label=source.source_version_label,
    )


async def run_conversion(
    *,
    tenant_slug: str,
    tenant_id: str,
    user_id: Optional[str],
    source: ConversionSource,
    committer: SpecCommitter,
    scorer: LintScorer,
    store: ProvenanceStore,
    defaults: Optional[ConversionDefaults] = None,
    target_format: str = DEFAULT_TARGET_FORMAT,
) -> ConversionResult:
    """Run one convert-to-project/version job and return its :class:`ConversionResult`.

    Emits the OpenAPI document from ``source`` (honouring ``defaults``), analyzes its fidelity, then —
    minting a new Project on a first conversion or appending a new version to the previously-converted
    Project on a re-convert (decided by the provenance ledger) — commits it, captures the OpenAPI
    lint/score, and persists a provenance row linking the result back to its origin.

    Args:
        tenant_slug: Tenant slug (needed to reconstruct the OpenAPI doc for lint capture).
        tenant_id: Owning tenant id.
        user_id: Authenticated user id (creator of the converted Project); ``None`` for service calls.
        source: The loaded canonical model + source provenance coordinates.
        committer: Port that turns the emitted document into a committed Project + revision.
        scorer: Port that computes/persists the converted revision's lint score.
        store: Port over the ``conversion_provenance`` ledger.
        defaults: Optional user-supplied fallbacks (title/version/servers) for cheap gaps.
        target_format: Emit target; only :data:`DEFAULT_TARGET_FORMAT` is supported today.

    Returns:
        A :class:`ConversionResult` with the created Project/revision ids, the fidelity report, the
        captured lint score, and the persisted provenance row id.

    Raises:
        ConversionError: If ``target_format`` is unsupported or the commit yields no Project/revision.
    """
    # 1. Emit + 2. analyze fidelity — pure, deterministic, no I/O (shared with the dry-run path).
    #    OpenAPI/Swagger/TypeSpec take the MFI-22.7 near-lossless path inside preview_conversion.
    preview = preview_conversion(source, defaults, target_format)
    report = preview.fidelity
    conversion_mode = preview.conversion_mode
    projection = summarize_conversion_manifest(preview.manifest)

    # 3. First-convert vs re-convert: a prior conversion of this source names the Project a re-convert
    #    must add a new version to, so we never duplicate a Project on re-convert.
    prior = store.latest_for_source(tenant_id, source.source_project_id)
    target_project_id = prior.get("target_project_id") if prior else None
    reconverted = target_project_id is not None
    version_label = _next_version_label(prior)

    commit = await committer.commit(
        tenant_slug=tenant_slug,
        tenant_id=tenant_id,
        user_id=user_id,
        document=preview.document,
        source=source,
        target_project_id=target_project_id,
        version_label=version_label,
    )
    if not commit.project_id or not commit.version_record_id:
        raise ConversionError("Conversion commit did not produce a project/version.", status_code=502)

    # 4. Capture the OpenAPI lint/score on the converted result (best-effort — never fails the job).
    lint = await scorer.score(
        tenant_slug=tenant_slug, tenant_id=tenant_id, version_record_id=commit.version_record_id
    )

    # 5. Persist provenance so the converted spec links back to its origin, alongside the
    #    content-addressed evidence snapshot and the digest of the exact source converted (CPDO-3.3).
    prov = store.record(
        tenant_id=tenant_id,
        created_by=user_id,
        source=source,
        commit=commit,
        fidelity=report,
        lint=lint,
        converter_tool_versions=converter_tool_versions(conversion_mode=conversion_mode),
        reconverted=reconverted,
        projection=projection,
        manifest=preview.manifest,
        source_hash=source_digest(source.source_text) if source.source_text else None,
    )

    # 6. Auto-link source catalog item ↔ converted publishable Project (MFI-6.4, #4410).
    from .database import db as _db

    try:
        _db.link_identity_projects(
            tenant_id=tenant_id,
            project_id_a=source.source_project_id,
            project_id_b=commit.project_id,
            created_by=user_id,
            link_source="conversion",
        )
    except ValueError:
        pass  # source project missing — provenance row still valid

    return ConversionResult(
        project_id=commit.project_id,
        project_slug=commit.project_slug,
        version_id=commit.version_id,
        version_record_id=commit.version_record_id,
        created_project=commit.created_project,
        reconverted=reconverted,
        fidelity=report,
        lint=lint,
        provenance_id=str(prov["id"]),
        document=preview.document,
        conversion_mode=conversion_mode,
        projection=projection,
    )


# ===========================================================================
# Production adapters (the swappable default wiring)
# ===========================================================================

#: Terminal spec-import job states (mirrors the engine's state machine).
_TERMINAL_IMPORT_STATES = frozenset({"completed", "failed", "canceled", "rolled-back"})


class SpecImportCommitter:
    """:class:`SpecCommitter` that reuses the spec-import submit→commit engine.

    Bytes-in: the emitted OpenAPI document is base64-encoded and handed to
    :func:`app.spec_import_engine.schedule_spec_import` as an ``openapi`` import, which decomposes it
    into a full publishable Project + version exactly like an OpenAPI upload. The job is then polled to
    a terminal state. On a re-convert ``target_project_id`` is passed as the import's
    ``existing_project_id`` so a new version is appended to the existing Project instead of a duplicate
    being created.
    """

    def __init__(self, *, poll_interval: float = 0.25, timeout: float = 600.0) -> None:
        self._poll_interval = poll_interval
        self._timeout = timeout

    async def commit(
        self,
        *,
        tenant_slug: str,
        tenant_id: str,
        user_id: Optional[str],
        document: Dict[str, Any],
        source: ConversionSource,
        target_project_id: Optional[str],
        version_label: str,
    ) -> ConversionCommit:
        # Imported here (not at module load) so the pure orchestrator + its tests never pull in the
        # import-engine/DB stack.
        from .models import (
            SpecImportOptions,
            SpecImportProjectTarget,
            SpecImportStartJsonRequest,
            SpecImportStartMetadata,
            SpecImportVersionTarget,
        )
        from .spec_import_engine import get_spec_import_status, schedule_spec_import

        name, slug = _converted_project_identity(source)
        metadata = SpecImportStartMetadata(
            source_kind=CONVERT_IMPORT_SOURCE_KIND,
            project=SpecImportProjectTarget(
                name=name,
                slug=slug,
                description=f"Converted from {source.source_format or source.api.format} "
                f"catalog item {source.source_project_id}.",
            ),
            version=SpecImportVersionTarget(
                version_id=version_label,
                description="Catalog → OpenAPI conversion (MFI-22.5).",
            ),
            existing_project_id=target_project_id,
            options=SpecImportOptions(skip_duplicate_versions=False),
        )
        document_b64 = base64.standard_b64encode(
            json.dumps(document, separators=(",", ":")).encode("utf-8")
        ).decode("ascii")
        body = SpecImportStartJsonRequest(
            metadata=metadata,
            document_base64=document_b64,
            filename=f"{slug}.openapi.json",
            content_type="application/json",
        )

        accepted = await schedule_spec_import(tenant_slug, tenant_id, user_id or "", body)
        job_id = accepted.job_id

        waited = 0.0
        status = await get_spec_import_status(tenant_slug, job_id)
        while status.state not in _TERMINAL_IMPORT_STATES:
            if waited >= self._timeout:
                raise ConversionError(
                    f"Conversion import job {job_id} did not finish within {self._timeout:.0f}s.",
                    status_code=504,
                )
            await asyncio.sleep(self._poll_interval)
            waited += self._poll_interval
            status = await get_spec_import_status(tenant_slug, job_id)

        if status.state != "completed":
            detail = _first_error_message(status) or f"import job ended {status.state}"
            raise ConversionError(f"Conversion import failed: {detail}", status_code=502)

        result = status.result
        if result is None or not result.project_id or not result.version_record_id:
            raise ConversionError(
                "Conversion import completed without a project/version result.", status_code=502
            )
        return ConversionCommit(
            project_id=str(result.project_id),
            project_slug=str(result.project_slug or slug),
            version_id=str(result.version_id or version_label),
            version_record_id=str(result.version_record_id),
            created_project=target_project_id is None,
        )


class DbLintScorer:
    """:class:`LintScorer` that reuses the MFI-EPIC-4 OpenAPI lint over the converted revision.

    Reconstructs the OpenAPI document for the committed revision, lints it, and persists the resulting
    score/grade onto the revision (parity with the import path's quality-score capture). Strictly
    best-effort: the revision is already committed, so any failure here just leaves the score for an
    on-demand lint to fill and never fails the conversion.
    """

    async def score(
        self, *, tenant_slug: str, tenant_id: str, version_record_id: str
    ) -> Optional[LintScore]:
        return await asyncio.to_thread(
            self._score_sync, tenant_slug, tenant_id, version_record_id
        )

    @staticmethod
    def _score_sync(tenant_slug: str, tenant_id: str, version_record_id: str) -> Optional[LintScore]:
        try:
            from .compatibility_engine import openapi_for_revision
            from .database import db
            from .style_guide_engine import guided_lint_openapi_spec
            from .version_quality_capture import persistable_lint_report

            version = db.get_version_by_id(version_record_id, tenant_id)
            if not version:
                return None
            spec = openapi_for_revision(version, tenant_slug, tenant_id)
            # GOV-1.4: score under the revision's resolved style guide (project → tenant →
            # default), matching the import path's guided capture.
            result, guide = guided_lint_openapi_spec(
                spec, tenant_id, project_id=str(version.get("project_id") or "") or None
            )
            # #5259: store the content fingerprint + guide context alongside the report so
            # the converted (editable) revision is only re-linted once its content changes.
            db.set_version_quality_score(
                version_record_id,
                tenant_id,
                result.score,
                result.grade,
                result.report_fingerprint,
                quality_report=persistable_lint_report(result, spec, guide=guide),
            )
            return LintScore(
                score=result.score, grade=result.grade, report_fingerprint=result.report_fingerprint
            )
        except Exception:  # noqa: BLE001 - lint capture is strictly best-effort
            logger.warning(
                "Failed to capture lint score for converted revision %s",
                version_record_id,
                exc_info=True,
            )
            return None


class DbConversionProvenanceStore:
    """:class:`ProvenanceStore` backed by the ``apiome.conversion_provenance`` DAO (V139)."""

    def latest_for_source(self, tenant_id: str, source_project_id: str) -> Optional[Dict[str, Any]]:
        from .database import db

        return db.get_latest_conversion_for_source(tenant_id, source_project_id)

    def record(
        self,
        *,
        tenant_id: str,
        created_by: Optional[str],
        source: ConversionSource,
        commit: ConversionCommit,
        fidelity: FidelityReport,
        lint: Optional[LintScore],
        converter_tool_versions: Dict[str, Any],
        reconverted: bool,
        projection: ConversionManifestSummary,
        manifest: ConversionManifest,
        source_hash: Optional[str],
    ) -> Dict[str, Any]:
        from .database import db

        # Snapshot first, ledger second: a provenance row must never name a hash whose storage was
        # never even attempted. The write is best-effort — the Project/version already exists by
        # step 5, and a missing snapshot is a truthful degrade state the evidence reads report.
        # The stored manifest nulls the two hash-excluded source ids: under content-addressed
        # dedupe they would otherwise record whichever catalog item happened to write first.
        try:
            stored = manifest.model_copy(
                update={
                    "source": manifest.source.model_copy(
                        update={"project_id": None, "version_record_id": None}
                    )
                }
            )
            db.upsert_conversion_evidence_snapshot(
                tenant_id=tenant_id,
                manifest_hash=manifest.manifest_hash,
                schema_version=manifest.schema_version,
                conversion_mode=manifest.conversion_mode,
                source_format=manifest.source.source_format,
                target_format=manifest.target_format,
                tool_versions=manifest.tool_versions,
                defaults=manifest.defaults,
                manifest=stored.model_dump(mode="json"),
                node_count=len(manifest.nodes),
                edge_count=len(manifest.edges),
                truncated=manifest.truncated,
                created_by=created_by,
            )
        except Exception:  # noqa: BLE001 - snapshot capture is strictly best-effort
            logger.warning(
                "Failed to store conversion evidence snapshot %s",
                manifest.manifest_hash,
                exc_info=True,
            )

        return db.create_conversion_provenance(
            tenant_id=tenant_id,
            created_by=created_by,
            source_project_id=source.source_project_id,
            source_version_id=source.source_version_id,
            source_format=source.source_format or source.api.format,
            source_protocol=source.source_protocol or source.api.protocol,
            source_version_label=source.source_version_label or source.api.version,
            source_tool_versions=source.source_tool_versions,
            target_project_id=commit.project_id,
            target_version_id=commit.version_record_id,
            target_version_label=commit.version_id,
            fidelity_report=fidelity.model_dump(mode="json"),
            fidelity_score=fidelity.score,
            fidelity_grade=fidelity.grade,
            fidelity_tier=fidelity.tier.value,
            lint_score=lint.score if lint else None,
            lint_grade=lint.grade if lint else None,
            converter_tool_versions=converter_tool_versions,
            reconverted=reconverted,
            projection_manifest_hash=projection.manifest_hash,
            projection_manifest=projection.model_dump(mode="json"),
            source_hash=source_hash,
        )


def default_ports() -> Dict[str, Any]:
    """Return the production port wiring for :func:`run_conversion` (spread as keyword args).

    The MFI-22.6 endpoint calls ``run_conversion(..., **default_ports())``; tests pass fakes instead.
    """
    return {
        "committer": SpecImportCommitter(),
        "scorer": DbLintScorer(),
        "store": DbConversionProvenanceStore(),
    }


# ===========================================================================
# Small production helpers
# ===========================================================================


def _converted_project_identity(source: ConversionSource) -> tuple[str, str]:
    """Derive a stable ``(name, slug)`` for the converted Project from the source identity.

    Deterministic in the source artifact id so a re-convert (which also passes the prior Project via
    ``existing_project_id``) resolves consistently. The name prefers the model's title/identity name.
    """
    ident = source.api.identity
    base_name = (source.api.title or getattr(ident, "name", None) or "Converted API").strip()
    name = f"{base_name} (OpenAPI)"
    slug = _slugify(f"{base_name}-openapi-{source.source_project_id}")
    return name, slug


def _slugify(value: str) -> str:
    """Lowercase, hyphenate and trim ``value`` into a URL-safe project slug."""
    out: List[str] = []
    prev_hyphen = False
    for ch in value.lower():
        if ch.isalnum():
            out.append(ch)
            prev_hyphen = False
        elif not prev_hyphen:
            out.append("-")
            prev_hyphen = True
    slug = "".join(out).strip("-")
    return slug or "converted-api"


def _first_error_message(status: Any) -> Optional[str]:
    """Return the first error-level event message from a spec-import status, if any."""
    for event in getattr(status, "events", None) or []:
        if getattr(event, "level", None) == "error":
            return getattr(event, "message", None)
    return None

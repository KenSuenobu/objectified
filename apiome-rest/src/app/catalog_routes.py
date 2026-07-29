"""
Catalog API Routes (MFI-23.2)

Read endpoints for the *Catalog* — the ``publishable = false`` slice of projects, i.e. the
OpenAPI-worthy non-OpenAPI imports that are deliberately *not* publishable Projects (MFI-23.1).

The list + detail responses deliberately mirror the Projects contract (``projects_routes.py``):
the same envelope (id/name/slug/description/timestamps/creator/qualityScore/qualityGrade) plus the
catalog-only format/source fields (``sourceFormat``, ``protocol``, ``formatMetadata``,
``toolVersions``) and the ``publishable = false`` invariant. Matching the Projects shape is the
whole point — it lets the Catalog screen (MFI-23.3) be cloned from the Projects dashboard.

Catalog items are created by the import routing (MFI-23.7), not through this API, so only read
endpoints exist here. All endpoints are tenant-scoped and require authentication via JWT token or
API key.
"""

import logging
import time
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from .analysis_telemetry import (
    ALLOWED_UI_SURFACES,
    LARGE_GRAPH_EDGE_THRESHOLD,
    analysis_telemetry,
)
from .api_identity_service import build_related_artifact_refs
from .auth import get_authenticated_user_id, validate_authentication
from .catalog_conversion import build_conversion_source
from .catalog_detail import (
    derive_catalog_source,
    derive_catalog_summary,
    resolve_source_payload,
)
from .catalog_parsed_model import derive_catalog_parsed_model
from .conversion_evidence import (
    current_source_digest,
    evidence_response,
    parse_evidence_scope,
    provenance_entry,
)
from .conversion_job import (
    ConversionDefaults,
    ConversionError,
    default_ports,
    preview_conversion,
    run_conversion,
)
from .conversion_projection import (
    ConversionEdgeScope,
    paginate_conversion_evidence,
    summarize_conversion_manifest,
)
from .database import db
from .lint_routes import build_lint_report
from .models import (
    CatalogConversionHistoryResponse,
    CatalogConversionRef,
    CatalogItemDetailSchema,
    CatalogItemSchema,
    CatalogNormalizedSummary,
    CatalogProjectionRequest,
    CatalogProjectionResponse,
    CatalogSourceDescriptor,
    ConversionEvidenceResponse,
    ConvertCatalogItemRequest,
    ConvertCommitResponse,
    ConvertDryRunResponse,
    LintReportResponse,
)
from .payload_analysis import (
    MAX_TREE_DEPTH,
    MAX_TREE_NODES,
    PayloadAnalysisRecord,
    ValueVisibility,
    bound_document,
)
from .payload_analysis_store import analysis_summary_for_item, load_analysis_for_item
from .permissions import Action, Resource, _resolve_actor_id, enforce_permission

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/catalog", tags=["catalog"])


def _audit_catalog_access(
    auth_data: Dict[str, Any],
    *,
    action: str,
    target: str,
    detail: Optional[Dict[str, Any]] = None,
) -> None:
    """Write a best-effort access-audit entry for a sensitive catalog read (CPDO-4.2).

    The raw source and the analysis tree are the two catalog reads that expose payload-derived
    material, so each successful serve leaves a row in the append-only ``apiome.access_audit``
    ledger (V120) — who read what, when, through which auth method. ``detail`` may carry counts,
    statuses, and modes only; never payload content. Best-effort by the same rule as the
    permission-denied audit: a failed audit insert must never turn a successful read into an error.

    Args:
        auth_data: The authenticated caller's context.
        action: Ledger action name (``catalog.analysis.view`` / ``catalog.source.view``).
        target: What was read (``catalog:{item_id}:analysis`` / ``…:source``).
        detail: Optional content-free metadata about the read.
    """
    try:
        db.write_access_audit(
            tenant_id=auth_data.get("tenant_id"),
            actor_id=_resolve_actor_id(db, auth_data),
            actor_label=auth_data.get("user_email") or auth_data.get("user_name"),
            action=action,
            target=target,
            source="api_key" if auth_data.get("auth_method") == "api_key" else "web",
            detail=detail or {},
        )
    except Exception:  # pragma: no cover - audit is strictly best-effort
        logger.debug("catalog access audit write failed", exc_info=True)


def _build_conversion_ref(item: Dict[str, Any]) -> Optional[CatalogConversionRef]:
    """Project the ``conv_*`` columns of a catalog row onto a :class:`CatalogConversionRef` (MFI-23.11).

    The catalog list/detail queries left-join the newest ``apiome.conversion_provenance`` row for the item
    (MFI-22.5) plus its target Project's name/slug. A row that was never converted has a ``NULL``
    ``conv_target_project_id`` — return ``None`` so the item shows no converted state; otherwise return
    the back-link (target Project id/name/slug + whether it was since deleted, the produced revision, the
    re-convert flag, and the fidelity grade/tier) the card/detail renders as "Converted → {project}".
    """
    target_project_id = item.get("conv_target_project_id")
    if not target_project_id:
        return None
    return CatalogConversionRef(
        project_id=target_project_id,
        project_name=item.get("conv_target_project_name"),
        project_slug=item.get("conv_target_project_slug"),
        project_deleted=item.get("conv_target_project_deleted_at") is not None,
        version_id=item.get("conv_target_version_label"),
        version_record_id=item.get("conv_target_version_id"),
        reconverted=bool(item.get("conv_reconverted")),
        converted_at=item.get("conv_converted_at"),
        fidelity_grade=item.get("conv_fidelity_grade"),
        fidelity_tier=item.get("conv_fidelity_tier"),
        provenance_id=str(item["conv_provenance_id"]) if item.get("conv_provenance_id") else None,
        manifest_hash=item.get("conv_manifest_hash") or None,
    )


def _build_related_artifacts(
    tenant_id: str, project_id: str
) -> list:
    rows = db.get_related_artifact_rows(tenant_id, project_id)
    return build_related_artifact_refs(rows)


@router.get("/{tenant_slug}")
async def list_catalog_items(
    tenant_slug: str,
    include_deleted: bool = Query(
        False,
        description="When true, include soft-deleted catalog items (active items listed first).",
    ),
    identity_group_id: Optional[str] = Query(
        None,
        alias="identityGroupId",
        description="When set, return only catalog items in this cross-format identity group (MFI-6.4).",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> List[CatalogItemSchema]:
    """
    List all catalog items for a tenant.

    Returns the same envelope as ``GET /v1/projects/{tenant_slug}`` (so the Catalog screen can be
    cloned from the Projects dashboard) restricted to the non-publishable slice, with each item
    also carrying the latest revision's format/protocol/source provenance.

    Supports authentication via:
    - JWT token in Authorization header (Bearer token)
    - API key in X-API-Key header

    Args:
        tenant_slug: The tenant slug.
        include_deleted: Include rows with deleted_at set (for trash / restore flows).
        auth_data: Authentication data (injected by dependency).

    Returns:
        List of catalog items for the tenant (active first when include_deleted is set).
    """
    items = db.get_catalog_items_for_tenant(
        auth_data['tenant_id'],
        include_deleted=include_deleted,
        identity_group_id=identity_group_id,
    )

    tenant_id = auth_data["tenant_id"]
    return [
        CatalogItemSchema(
            **item,
            conversion=_build_conversion_ref(item),
        )
        for item in items
    ]


@router.get("/{tenant_slug}/{item_id}")
async def get_catalog_item(
    tenant_slug: str,
    item_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> CatalogItemDetailSchema:
    """
    Get a specific catalog item by ID, with the MFI-23.9 detail enrichments.

    Returns the MFI-23.2 list envelope plus a normalized-content ``summary`` (services/operations/
    types/channels counts), a ``source`` material descriptor (both derived from the latest revision's
    ``format_metadata``) and, from MFI-25.2, a ``parsed`` list of paradigm-tagged entity groups derived
    from the item's canonical model (``[]`` when no model can be reconstructed from the captured
    source). A publishable Project is intentionally *not* returned here: only the non-publishable
    slice is a catalog item, so requesting a Project's id (or an unknown id) yields 404.

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug.
        item_id: The catalog item ID.
        auth_data: Authentication data (injected by dependency).

    Returns:
        The catalog item details, including its normalized summary and source descriptor.
    """
    item = db.get_catalog_item_by_id(item_id, auth_data['tenant_id'])

    if not item:
        raise HTTPException(
            status_code=404,
            detail=f"Catalog item not found: {item_id}"
        )

    summary = derive_catalog_summary(item.get("format_metadata"))
    source = derive_catalog_source(item.get("format_metadata"), item.get("metadata"))
    parsed = derive_catalog_parsed_model(item)
    tenant_id = auth_data["tenant_id"]

    return CatalogItemDetailSchema(
        **item,
        conversion=_build_conversion_ref(item),
        related_artifacts=_build_related_artifacts(tenant_id, item_id),
        summary=CatalogNormalizedSummary(**summary),
        source=CatalogSourceDescriptor(**source),
        parsed=parsed,
        analysis=analysis_summary_for_item(tenant_id, item),
    )


@router.get(
    "/{tenant_slug}/{item_id}/analysis",
    response_model=PayloadAnalysisRecord,
)
async def get_catalog_item_analysis(
    tenant_slug: str,
    item_id: str,
    value_visibility: Optional[str] = Query(
        None,
        alias="valueVisibility",
        description=(
            "Optional read-time restriction on observed payload values: none | structural | full. "
            "It can only narrow what the stored record carries, never widen it."
        ),
    ),
    max_nodes: Optional[int] = Query(
        None,
        alias="maxNodes",
        ge=1,
        le=MAX_TREE_NODES,
        description=(
            "Optional read-time node budget for a lazy first fetch of an oversized tree. "
            "Keeps the same breadth-first prefix write-time bounding keeps; truncation is "
            "reported on the record's metrics, never silent (CPDO-4.2)."
        ),
    ),
    max_depth: Optional[int] = Query(
        None,
        alias="maxDepth",
        ge=1,
        le=MAX_TREE_DEPTH,
        description="Optional read-time depth budget, applied with maxNodes (CPDO-4.2).",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> PayloadAnalysisRecord:
    """Return the full native payload analysis of a catalog item's latest revision (CPDO-1.1).

    The detail read (``GET …/{item_id}``) embeds only the analysis *summary* — status and counts,
    no payload material — so it stays cheap regardless of how large the analysed source was. This
    endpoint serves the record itself: the native tree in the analyzer's own vocabulary (X12
    interchange → functional group → transaction set → segment → element; copybook level → PIC →
    OCCURS → 88-condition), its source locations, analyzer warnings, and the redaction metadata
    stating what was withheld.

    **Authorization.** The summary is readable by anyone who can read the catalog item; the tree is
    gated on ``imports:view``, the permission that governs imported source material, because a
    native tree is a structural description of the payload itself. ``valueVisibility`` may further
    restrict what is returned — it can never widen it, since values the store never held cannot be
    re-materialised.

    **Absence is declared.** A revision imported before this contract existed, or one whose source
    was never captured, returns a record with ``status: "unavailable"``, an empty tree, and a reason
    code saying which. It never returns a fabricated tree.

    Like the other catalog reads this is restricted to the non-publishable slice — a Project's id, or
    an unknown id, yields 404 — and authenticated via JWT token or API key.

    Args:
        tenant_slug: The tenant slug.
        item_id: The catalog item ID (a project id).
        value_visibility: Optional read-time value-visibility restriction.
        max_nodes: Optional read-time node budget for a lazy fetch of an oversized tree.
        max_depth: Optional read-time depth budget, applied with ``max_nodes``.
        auth_data: Authentication data (injected by dependency).

    Returns:
        The :class:`~app.payload_analysis.PayloadAnalysisRecord` for the item's latest revision.
    """
    tenant_id = auth_data["tenant_id"]

    item = db.get_catalog_item_by_id(item_id, tenant_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"Catalog item not found: {item_id}")

    enforce_permission(
        db, auth_data, Resource.IMPORTS, Action.VIEW, target=f"catalog:{item_id}:analysis"
    )

    if value_visibility is not None and value_visibility not in ValueVisibility.ALL:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unsupported valueVisibility {value_visibility!r}; "
                f"expected one of {', '.join(ValueVisibility.ALL)}."
            ),
        )

    started = time.monotonic()
    record = load_analysis_for_item(tenant_id, item, value_visibility=value_visibility)

    # Read-time bounding (CPDO-4.2): a client may ask for only the top of a large stored tree.
    # Like value visibility this can only narrow the record, and truncation stays declared.
    if max_nodes is not None or max_depth is not None:
        record = record.model_copy(
            update={
                "analysis": bound_document(
                    record.analysis,
                    max_nodes=max_nodes if max_nodes is not None else MAX_TREE_NODES,
                    max_depth=max_depth if max_depth is not None else MAX_TREE_DEPTH,
                )
            }
        )

    # The tree is payload-derived material, so a successful serve is audited (counts and
    # statuses only — the audit row carries nothing from the tree itself).
    _audit_catalog_access(
        auth_data,
        action="catalog.analysis.view",
        target=f"catalog:{item_id}:analysis",
        detail={
            "status": record.analysis.status,
            "nodeCount": record.analysis.metrics.node_count,
            "valueVisibility": record.analysis.redaction.value_visibility,
        },
    )
    analysis_telemetry.record(
        "analysis_read",
        status=record.analysis.status,
        node_count=record.analysis.metrics.node_count,
        latency_ms=(time.monotonic() - started) * 1000.0,
    )
    return record


@router.get(
    "/{tenant_slug}/{item_id}/lint",
    response_model=LintReportResponse,
)
async def lint_catalog_item(
    tenant_slug: str,
    item_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintReportResponse:
    """
    Score a catalog item's latest revision and return itemized lint findings (MFI-23.10).

    The catalog analog of ``GET /v1/versions/{tenant_slug}/{project_id}/{version_record_id}/lint``:
    it lets the Catalog card/detail lint orbs open the *same* server-computed lint report the
    Projects screens use, populated from the item's own revision rather than browser-local history.

    A catalog item's id *is* a project id (the Catalog is the non-publishable slice of projects,
    MFI-23.1), so the latest revision is resolved here and fed to the shared
    :func:`app.lint_routes.build_lint_report`. Like the other catalog reads this is restricted to
    the non-publishable slice — a Project's id, or an unknown id, yields 404 — and authenticated via
    JWT token or API key.

    Args:
        tenant_slug: The tenant slug (used to reconstruct the OpenAPI document).
        item_id: The catalog item ID (a project id).
        auth_data: Authentication data (injected by dependency).

    Returns:
        The server-computed quality score, A-F grade and itemized findings for the latest revision.
    """
    tenant_id = auth_data["tenant_id"]

    item = db.get_catalog_item_by_id(item_id, tenant_id)
    if not item:
        raise HTTPException(
            status_code=404,
            detail=f"Catalog item not found: {item_id}",
        )

    revision_id = db.get_latest_revision_id_for_project(item_id, tenant_id)
    if not revision_id:
        raise HTTPException(
            status_code=404,
            detail=f"No revision to lint for catalog item: {item_id}",
        )

    version = db.get_version_by_id(revision_id, tenant_id)
    if not version:
        raise HTTPException(
            status_code=404,
            detail=f"Revision not found: {revision_id}",
        )

    return await build_lint_report(version, item_id, tenant_slug, tenant_id, catalog_item=item)


def _conversion_defaults(request: Any) -> Optional[ConversionDefaults]:
    """Map a request's optional user defaults onto the job's :class:`ConversionDefaults`.

    Shared by the convert verb and the projection read, which must agree exactly: the defaults are
    folded into the projection snapshot hash, so a projection previewed with different defaults from
    the ones the conversion will run with would describe a different conversion.
    """
    defaults = getattr(request, "defaults", None)
    if defaults is None:
        return None
    return ConversionDefaults(
        title=defaults.title,
        version=defaults.version,
        servers=list(defaults.servers),
    )


def _load_conversion_source(tenant_id: str, item: Dict[str, Any]):
    """Rebuild the conversion source for a catalog item, with its payload analysis attached.

    The analysis read is best-effort by design: a store fault must not make a catalog item
    unconvertible, and the manifest already has a truthful way to say an analysis was not available
    (:class:`~app.conversion_projection.ConversionAnalysisRef`). Returns the source plus the revision
    id it was built from, which the projection response echoes.
    """
    item_id = str(item["id"])
    source_version_id = db.get_latest_revision_id_for_project(item_id, tenant_id)
    try:
        analysis = load_analysis_for_item(
            tenant_id, item, version_record_id=source_version_id
        ).analysis
    except Exception:  # noqa: BLE001 - a missing analysis must never block a conversion
        logger.warning("Payload analysis unreadable for catalog item %s", item_id, exc_info=True)
        analysis = None
    source = build_conversion_source(
        item, source_version_id=source_version_id, analysis=analysis
    )
    return source, source_version_id


@router.post(
    "/{tenant_slug}/{item_id}/convert",
    response_model=None,
)
async def convert_catalog_item(
    tenant_slug: str,
    item_id: str,
    request: ConvertCatalogItemRequest = ConvertCatalogItemRequest(),
    dry_run: Optional[bool] = Query(
        None,
        alias="dryRun",
        description="Authoritative side-effect switch; overrides the body's dryRun when present.",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
):
    """Convert a catalog item to OpenAPI — a dry-run preview or a committed Project (MFI-22.6).

    The single convert verb behind the UI preview (MFI-22.4), CLI (``apiome convert``), and API:

    * ``dryRun=true`` (the default) reconstructs the item's canonical model from its captured source,
      emits the OpenAPI 3.1 document (MFI-22.1) and analyzes its fidelity (MFI-22.3), and returns the
      **fidelity report + the would-be document with no side effects** — nothing is created.
    * ``dryRun=false`` runs the convert-to-project/version commit job (MFI-22.5): it mints a new
      Project + ``v1`` (or appends a new version to the previously-converted Project on a re-convert),
      captures its lint score, persists provenance, and returns the created ids + the report.

    The ``dryRun`` **query param is authoritative** for the side-effect decision (falling back to the
    body's ``dryRun``), so a malformed/omitted body defaults to a safe dry-run and never silently
    commits. ``target`` is ``openapi`` today; other targets yield 400 (the verb is target-generic for
    future emitters). Optional ``defaults`` (info title/version, servers) fill cheap gaps only where
    the source is empty.

    A catalog item's id is a project id; this is restricted to the non-publishable slice, so a
    Project's id — or an unknown id — yields 404. An item with no captured source material to
    reconstruct from yields 422. Authenticated via JWT token or API key.

    Args:
        tenant_slug: The tenant slug (used to reconstruct/commit the OpenAPI document).
        item_id: The catalog item ID (a project id).
        request: The conversion target + dryRun + optional defaults.
        dry_run: Authoritative dryRun query override (``None`` falls back to the body).
        auth_data: Authentication data (injected by dependency).

    Returns:
        A :class:`ConvertDryRunResponse` for a dry-run, or a :class:`ConvertCommitResponse` for a commit.
    """
    tenant_id = auth_data["tenant_id"]

    if request.target.strip().lower() != "openapi":
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported conversion target {request.target!r}; only 'openapi' is available today.",
        )

    item = db.get_catalog_item_by_id(item_id, tenant_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"Catalog item not found: {item_id}")

    effective_dry_run = dry_run if dry_run is not None else request.dry_run
    defaults = _conversion_defaults(request)

    try:
        source, _source_version_id = _load_conversion_source(tenant_id, item)

        if effective_dry_run:
            preview = preview_conversion(source, defaults)
            return ConvertDryRunResponse(
                report=preview.fidelity.model_dump(mode="json"),
                openapi=preview.document,
                source_format=source.source_format,
                target="openapi",
                conversion_mode=preview.conversion_mode,
                projection=summarize_conversion_manifest(preview.manifest).model_dump(mode="json"),
            )

        result = await run_conversion(
            tenant_slug=tenant_slug,
            tenant_id=tenant_id,
            user_id=get_authenticated_user_id(auth_data),
            source=source,
            defaults=defaults,
            **default_ports(),
        )
    except ConversionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    return ConvertCommitResponse(
        project_id=result.project_id,
        project_slug=result.project_slug,
        version_id=result.version_id,
        version_record_id=result.version_record_id,
        created_project=result.created_project,
        reconverted=result.reconverted,
        provenance_id=result.provenance_id,
        report=result.fidelity.model_dump(mode="json"),
        conversion_mode=result.conversion_mode,
        projection=result.projection.model_dump(mode="json"),
    )


@router.post(
    "/{tenant_slug}/{item_id}/projection",
    response_model=CatalogProjectionResponse,
    summary="Page through a catalog item's conversion projection manifest",
)
async def get_catalog_projection(
    tenant_slug: str,
    item_id: str,
    request: CatalogProjectionRequest = CatalogProjectionRequest(),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> CatalogProjectionResponse:
    """Return one bounded page of the item's source → OpenAPI projection manifest (CPDO-1.3).

    The graph API behind the fidelity report: where the report says *how much* a conversion would
    lose, this says **which source construct became which OpenAPI pointer, and why anything did
    not**. Rebuilds the deterministic manifest for the item's latest revision — the same manifest a
    dry-run and a commit reference by hash, so a page fetched here describes the conversion the user
    is about to run — and pages its edges.

    Strictly read-only despite the POST verb, which carries the ``defaults`` body: gap-filling
    defaults are folded into the snapshot hash, so a projection previewed with different defaults
    from the ones the conversion will use would describe a different conversion. Nothing is created
    and nothing is persisted.

    **What it exposes, and why it is gated.** The page carries source-native *coordinates* — a
    construct's native name/id, the line or offset a parser recorded, and payload-analysis node ids
    — so a reader can open the source viewer where the evidence is. It carries no payload *values*
    at all. That is the same class of data as the analysis read (CPDO-1.1), so it is gated on the
    same ``imports:view`` permission, checked **after** the item lookup so a cross-tenant id 404s
    rather than confirming its existence with a 403.

    Like every other catalog read this is restricted to the non-publishable slice (a Project's id, or
    an unknown id, yields 404) and authenticated via JWT token or API key.

    Args:
        tenant_slug: The tenant slug.
        item_id: The catalog item ID (a project id).
        request: Target + defaults + page window (``scope`` / ``cursor`` / ``limit``).
        auth_data: Authentication data (injected by dependency).

    Returns:
        The :class:`~app.models.CatalogProjectionResponse` — the snapshot summary and one page.

    Raises:
        HTTPException: 400 for an unsupported target or scope, 404 for an unknown item, 422 when the
            item has no reconstructable source or the cursor is malformed.
    """
    _ = tenant_slug
    tenant_id = auth_data["tenant_id"]

    if request.target.strip().lower() != "openapi":
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported conversion target {request.target!r}; only 'openapi' is available today.",
        )

    scope: Optional[ConversionEdgeScope] = None
    if request.scope is not None:
        try:
            scope = ConversionEdgeScope(request.scope.strip().lower())
        except ValueError as exc:
            allowed = ", ".join(member.value for member in ConversionEdgeScope)
            raise HTTPException(
                status_code=400,
                detail=f"Unknown projection scope {request.scope!r}; expected one of: {allowed}.",
            ) from exc

    item = db.get_catalog_item_by_id(item_id, tenant_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"Catalog item not found: {item_id}")

    enforce_permission(
        db, auth_data, Resource.IMPORTS, Action.VIEW, target=f"catalog:{item_id}:projection"
    )

    started = time.monotonic()
    try:
        source, source_version_id = _load_conversion_source(tenant_id, item)
        preview = preview_conversion(source, _conversion_defaults(request))
    except ConversionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    try:
        page = paginate_conversion_evidence(
            preview.manifest, cursor=request.cursor, limit=request.limit, scope=scope
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    summary = summarize_conversion_manifest(preview.manifest)
    # Conversion status distribution + graph size + latency, counts only (CPDO-4.2).
    analysis_telemetry.record(
        "projection_page",
        page_total=page.total,
        latency_ms=(time.monotonic() - started) * 1000.0,
        status_counts=summary.status_counts,
        large_tree=page.total > LARGE_GRAPH_EDGE_THRESHOLD,
    )

    return CatalogProjectionResponse(
        item_id=item_id,
        version_record_id=source_version_id,
        target="openapi",
        summary=summary.model_dump(mode="json"),
        page=page.model_dump(mode="json"),
    )


@router.get(
    "/{tenant_slug}/{item_id}/conversions",
    response_model=CatalogConversionHistoryResponse,
    summary="List a catalog item's conversion provenance history",
)
async def get_catalog_conversion_history(
    tenant_slug: str,
    item_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> CatalogConversionHistoryResponse:
    """Return a catalog item's full conversion history, newest first (CPDO-3.3).

    One entry per convert/re-convert from the append-only ``conversion_provenance`` ledger: the
    target Project + revision it produced, the fidelity outcome, the converter tool versions, the
    content-addressed evidence snapshot id (and whether that snapshot is actually stored and
    replayable), and the digest of the exact source text converted. ``currentSourceHash`` digests
    the item's *currently captured* source so a client can mark rows whose ``sourceHash`` differs
    as historic — "the source has changed since this conversion was approved".

    Exposes the same class of metadata the unguarded catalog list/detail already carry on their
    ``conversion`` back-link, so like them it requires authentication + tenant scoping only; the
    per-conversion *evidence graph* read is the gated one. Restricted to the non-publishable slice
    (a Project's id, or an unknown id, yields 404).

    Args:
        tenant_slug: The tenant slug.
        item_id: The catalog item ID (a project id).
        auth_data: Authentication data (injected by dependency).

    Returns:
        The :class:`~app.models.CatalogConversionHistoryResponse`, newest first.
    """
    _ = tenant_slug
    tenant_id = auth_data["tenant_id"]

    item = db.get_catalog_item_by_id(item_id, tenant_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"Catalog item not found: {item_id}")

    rows = db.get_conversions_for_source(tenant_id, item_id)
    return CatalogConversionHistoryResponse(
        item_id=item_id,
        current_source_hash=current_source_digest(item),
        conversions=[provenance_entry(row) for row in rows],
    )


@router.get(
    "/{tenant_slug}/{item_id}/conversions/{provenance_id}/evidence",
    response_model=ConversionEvidenceResponse,
    summary="Page through the stored evidence snapshot of one historical conversion",
)
async def get_catalog_conversion_evidence(
    tenant_slug: str,
    item_id: str,
    provenance_id: str,
    scope: Optional[str] = Query(
        None,
        description="Restrict the page to one edge scope: checklist / construct / loss / analysis.",
    ),
    cursor: Optional[str] = Query(
        None, description="Opaque cursor from a previous page; omit to start at the beginning."
    ),
    limit: int = Query(
        50, ge=1, le=500, description="Maximum edges per page; clamped server-side."
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ConversionEvidenceResponse:
    """Return one page of the exact evidence graph a historical conversion was approved with.

    Served from the content-addressed snapshot store (CPDO-3.3, V215) — **never rebuilt** — so the
    graph is the one the user reviewed at commit time, regardless of how the source or the
    converter changed since. A GET, unlike the projection's POST: the stored snapshot already fixed
    its defaults, so there is no body to agree on. A snapshot that cannot be served degrades to an
    explicit HTTP 200 state (``predates_snapshots`` / ``snapshot_missing`` / ``unreadable``), never
    an error — pre-CPDO-3.3 conversions are a normal part of any history.

    Carries the same class of source-native coordinates as the projection read, so it is gated on
    the same ``imports:view`` permission, checked **after** the item lookup so a cross-tenant id
    404s rather than confirming its existence with a 403. A provenance row that does not belong to
    this item also 404s, so one item's evidence cannot be probed through another's URL.

    Args:
        tenant_slug: The tenant slug.
        item_id: The catalog item ID (a project id).
        provenance_id: The ``conversion_provenance`` row whose snapshot to page.
        scope: Restrict the page to one edge scope; omit to page every scope.
        cursor: Opaque page cursor.
        limit: Maximum edges per page.
        auth_data: Authentication data (injected by dependency).

    Returns:
        The :class:`~app.models.ConversionEvidenceResponse` — snapshot state, summary, and one page.

    Raises:
        HTTPException: 400 for an unknown scope, 404 for an unknown item/provenance row, 422 for a
            malformed cursor.
    """
    _ = tenant_slug
    tenant_id = auth_data["tenant_id"]

    parsed_scope = parse_evidence_scope(scope)

    item = db.get_catalog_item_by_id(item_id, tenant_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"Catalog item not found: {item_id}")

    enforce_permission(
        db, auth_data, Resource.IMPORTS, Action.VIEW, target=f"catalog:{item_id}:evidence"
    )

    row = db.get_conversion_provenance_by_id(tenant_id, provenance_id)
    if not row or str(row.get("source_project_id")) != str(item_id):
        raise HTTPException(status_code=404, detail=f"Conversion not found: {provenance_id}")

    snapshot_row = None
    if row.get("projection_manifest_hash"):
        snapshot_row = db.get_conversion_evidence_snapshot(
            tenant_id, row["projection_manifest_hash"]
        )

    started = time.monotonic()
    try:
        response = evidence_response(
            row=row,
            snapshot_row=snapshot_row,
            cursor=cursor,
            limit=limit,
            scope=parsed_scope,
            item_id=item_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    page_total = response.page.get("total") if isinstance(response.page, dict) else None
    analysis_telemetry.record(
        "evidence_page",
        page_total=page_total,
        latency_ms=(time.monotonic() - started) * 1000.0,
        large_tree=page_total > LARGE_GRAPH_EDGE_THRESHOLD if page_total is not None else None,
    )
    return response


@router.get("/{tenant_slug}/{item_id}/source")
async def get_catalog_item_source(
    tenant_slug: str,
    item_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
):
    """
    Serve a catalog item's original source material (MFI-23.9): viewable / downloadable.

    Resolves what the import captured onto the item's ``format_metadata``:

    * **inline content** — streamed back as a downloadable attachment (typed by source format);
    * **a source URL** (when no content was captured) — answered with a redirect to that URL;
    * **neither** — ``404``, since the raw source has not (yet) been captured for this item.

    **Authorization and audit (CPDO-4.2).** The raw source is the most sensitive read on the
    catalog surface — it is the payload itself, not a description of it — so it is gated on the
    same ``imports:view`` permission as the analysis tree and the projection graph, checked after
    the item lookup so a cross-tenant id 404s rather than confirming its existence with a 403.
    Every successful serve writes an ``access_audit`` row (``catalog.source.view``) recording who
    read it and how it was answered; the row carries no source content.

    Like the other catalog reads this is restricted to the non-publishable slice (a Project's id, or
    an unknown id, yields 404) and authenticated via JWT token or API key.

    Args:
        tenant_slug: The tenant slug.
        item_id: The catalog item ID.
        auth_data: Authentication data (injected by dependency).

    Returns:
        A StreamingResponse of the captured source, or a RedirectResponse to the source URL.
    """
    item = db.get_catalog_item_by_id(item_id, auth_data['tenant_id'])

    if not item:
        raise HTTPException(
            status_code=404,
            detail=f"Catalog item not found: {item_id}"
        )

    enforce_permission(
        db, auth_data, Resource.IMPORTS, Action.VIEW, target=f"catalog:{item_id}:source"
    )

    payload = resolve_source_payload(item)

    if payload is None:
        raise HTTPException(
            status_code=404,
            detail=f"No source material captured for catalog item: {item_id}",
        )

    access_mode = "redirect" if payload["mode"] == "redirect" else "inline"
    _audit_catalog_access(
        auth_data,
        action="catalog.source.view",
        target=f"catalog:{item_id}:source",
        detail={"mode": access_mode},
    )
    analysis_telemetry.record("source_access", access_mode=access_mode)

    if payload["mode"] == "redirect":
        # 307 preserves the method and lets the browser fetch the original source directly.
        return RedirectResponse(url=payload["url"], status_code=307)

    return StreamingResponse(
        iter([payload["content"]]),
        media_type=payload["media_type"],
        headers={
            "Content-Disposition": f'attachment; filename="{payload["filename"]}"',
        },
    )


class CatalogAnalysisMetricRequest(BaseModel):
    """A privacy-safe UI latency report for a catalog analysis surface (CPDO-4.2).

    A strict whitelist: one kind, a controlled surface name, and numbers. Unknown fields are
    rejected (``extra="forbid"``) so a client cannot smuggle payload material into telemetry.
    """

    model_config = ConfigDict(extra="forbid")

    kind: Literal["ui_latency"] = Field(description="Privacy-safe metric kind (whitelist).")
    surface: str = Field(
        description="Which UI surface is reporting (controlled vocabulary, e.g. format_tab)."
    )
    latency_ms: Optional[float] = Field(
        default=None, ge=0, description="Wall-clock latency the surface measured."
    )
    page_total: Optional[int] = Field(
        default=None, ge=0, description="Optional integer row/edge total (no labels)."
    )


class CatalogAnalysisMetricResponse(BaseModel):
    """Acknowledgement that a privacy-safe metric was recorded."""

    model_config = ConfigDict(extra="forbid")

    recorded: bool = True
    kind: str


@router.post(
    "/{tenant_slug}/analysis-metrics",
    response_model=CatalogAnalysisMetricResponse,
    summary="Record a privacy-safe catalog analysis metric",
    description=(
        "Increment an in-process counter and emit a structured ``catalog.analysis`` log line "
        "for UI/ops telemetry (CPDO-4.2). Payload is a strict whitelist of kinds, controlled "
        "surface names, and integer/duration fields — never node names, values, or source content."
    ),
)
async def record_catalog_analysis_metric(
    tenant_slug: str,
    request: CatalogAnalysisMetricRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> CatalogAnalysisMetricResponse:
    """Record one privacy-safe UI latency metric for the catalog analysis surface.

    Args:
        tenant_slug: Tenant slug (scopes the call; unused in the counter key by design).
        request: Whitelisted metric payload.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        ``{"recorded": true, "kind": ...}``.

    Raises:
        HTTPException: 422 when the surface is not on the allowlist.
    """
    _ = tenant_slug, auth_data  # auth required; tenant is not folded into metrics keys
    if request.surface not in ALLOWED_UI_SURFACES:
        raise HTTPException(status_code=422, detail="unsupported surface")
    analysis_telemetry.record(
        request.kind,
        surface=request.surface,
        latency_ms=request.latency_ms,
        page_total=request.page_total,
    )
    return CatalogAnalysisMetricResponse(kind=request.kind)

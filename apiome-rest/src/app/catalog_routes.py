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

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse, StreamingResponse

from .api_identity_service import build_related_artifact_refs
from .auth import get_authenticated_user_id, validate_authentication
from .catalog_conversion import build_conversion_source
from .catalog_detail import (
    derive_catalog_source,
    derive_catalog_summary,
    resolve_source_payload,
)
from .catalog_parsed_model import derive_catalog_parsed_model
from .conversion_job import (
    ConversionDefaults,
    ConversionError,
    default_ports,
    preview_conversion,
    run_conversion,
)
from .database import db
from .lint_routes import build_lint_report
from .models import (
    CatalogConversionRef,
    CatalogItemDetailSchema,
    CatalogItemSchema,
    CatalogNormalizedSummary,
    CatalogSourceDescriptor,
    ConvertCatalogItemRequest,
    ConvertCommitResponse,
    ConvertDryRunResponse,
    LintReportResponse,
)

router = APIRouter(prefix="/v1/catalog", tags=["catalog"])


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
    )


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


def _conversion_defaults(request: ConvertCatalogItemRequest) -> Optional[ConversionDefaults]:
    """Map the request's optional user defaults onto the job's :class:`ConversionDefaults`."""
    if request.defaults is None:
        return None
    return ConversionDefaults(
        title=request.defaults.title,
        version=request.defaults.version,
        servers=list(request.defaults.servers),
    )


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
        source_version_id = db.get_latest_revision_id_for_project(item_id, tenant_id)
        source = build_conversion_source(item, source_version_id=source_version_id)

        if effective_dry_run:
            preview = preview_conversion(source, defaults)
            return ConvertDryRunResponse(
                report=preview.fidelity.model_dump(mode="json"),
                openapi=preview.document,
                source_format=source.source_format,
                target="openapi",
                conversion_mode=preview.conversion_mode,
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
    )


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

    payload = resolve_source_payload(item)

    if payload is None:
        raise HTTPException(
            status_code=404,
            detail=f"No source material captured for catalog item: {item_id}",
        )

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

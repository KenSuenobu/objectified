"""REST surface for static MCP manifests — FMT-1.7 (#5418).

Three endpoints, mapped to the acceptance criteria the import-source registry cannot carry
on its own:

* ``POST /v1/mcp/{tenant}/endpoints/manifest-import`` — catalog a server from a manifest.
  Resolves the endpoint the manifest is about, **attaching to the one a probe already
  created** when it names the same server, and records the declared surface as its own
  source of facts rather than as a version snapshot.
* ``GET  /v1/mcp/{tenant}/endpoints/{id}/surface-provenance`` — the declared-vs-observed
  attribution the detail view renders: for every fact on the surface, which source carries
  it, and where the two disagree, both values.
* ``GET  /v1/mcp/{tenant}/endpoints/{id}/manifests`` — the declarations attached to an
  endpoint, live and (optionally) superseded.

Why the import lands here rather than only through ``/v1/import``
-----------------------------------------------------------------
The generic import pipeline turns a manifest into a *catalog item* — the multi-format,
paradigm-agnostic record every adapter produces, and the right home for the tools, schemas
and prompts as an API description. What it cannot do is reason about **MCP endpoint
identity**: whether the server this manifest describes is one the catalog already knows,
and what it means when the manifest and the last probe disagree. That question only exists
in the MCP domain, so it is answered here, against the MCP catalog's own tables. Both paths
parse the same document with the same adapter, so the two records agree by construction.

Nothing in this module reaches the network. A manifest's ``transport`` block is read as an
*address* — used to recognise an endpoint and, when one must be created, to fill its
``endpoint_url`` — and is never connected to. Cataloguing a server from a manifest must not
be a way to make Apiome fetch something.
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg2 import errors as pg_errors
from pydantic import BaseModel, Field

from .auth import get_authenticated_user_id, validate_authentication
from .database import db
from .mcp_discovery_engine import reconstruct_surface
from .mcp_manifest_attach import (
    ADDED_VIA_IMPORT,
    ManifestTargetError,
    plan_manifest_attach,
    resolve_manifest_target,
)
from .mcp_manifest_parser import McpManifestParseError, parse_mcp_manifest
from .mcp_manifest_store import declared_manifest, surface_from_manifest_row
from .mcp_surface_provenance import build_surface_provenance
from .models import MCP_ENDPOINT_TRANSPORTS, McpEndpointOut, mcp_endpoint_out_from_row

router = APIRouter(prefix="/v1/mcp", tags=["mcp-manifest"])

#: Intake failures that are the caller's document being wrong, not the service failing.
_CLIENT_ERROR_STATUS = 422


class McpManifestImportRequest(BaseModel):
    """A static MCP server manifest to catalog."""

    manifest: str = Field(
        description=(
            "The manifest document as text (JSON). The same bytes the `mcp` import "
            "adapter accepts."
        ),
    )
    endpoint_url: Optional[str] = Field(
        default=None,
        description=(
            "Where this server is reached, overriding the manifest's `transport` block. "
            "Required when the manifest declares no transport."
        ),
    )
    transport: Optional[str] = Field(
        default=None,
        description=(
            "Transport override: `streamable_http`, `sse`, or `stdio`. Defaults to the "
            "manifest's declared transport."
        ),
    )
    source_label: Optional[str] = Field(
        default=None,
        description="Where the manifest came from (filename / URL). Recorded, never fetched.",
    )


class McpDeclaredManifestOut(BaseModel):
    """One declared capability surface attached to an endpoint."""

    id: str = Field(description="The declaration's id.")
    endpoint_id: str = Field(description="The endpoint it describes.")
    source_label: Optional[str] = Field(
        default=None, description="Where the declaration came from."
    )
    surface_fingerprint: str = Field(
        description="The declared surface's fingerprint — the same hash a probe's surface produces."
    )
    protocol_version: Optional[str] = Field(default=None, description="Declared MCP protocol version.")
    server_name: Optional[str] = Field(default=None, description="Declared server name.")
    server_title: Optional[str] = Field(default=None, description="Declared server title.")
    server_version: Optional[str] = Field(default=None, description="Declared server version.")
    tool_count: int = Field(description="Declared tool count.")
    resource_count: int = Field(description="Declared resource count.")
    resource_template_count: int = Field(description="Declared resource-template count.")
    prompt_count: int = Field(description="Declared prompt count.")
    retired_at: Optional[str] = Field(
        default=None, description="When this declaration was superseded, if it was."
    )
    created_at: Optional[str] = Field(default=None, description="When it was attached.")
    updated_at: Optional[str] = Field(default=None, description="When it was last refreshed.")

    @classmethod
    def from_row(cls, row: Dict[str, Any]) -> "McpDeclaredManifestOut":
        """Adapt an ``mcp_endpoint_manifests`` row into its response shape."""
        return cls(
            id=str(row["id"]),
            endpoint_id=str(row["endpoint_id"]),
            source_label=row.get("source_label"),
            surface_fingerprint=str(row.get("surface_fingerprint") or ""),
            protocol_version=row.get("protocol_version"),
            server_name=row.get("server_name"),
            server_title=row.get("server_title"),
            server_version=row.get("server_version"),
            tool_count=int(row.get("tool_count") or 0),
            resource_count=int(row.get("resource_count") or 0),
            resource_template_count=int(row.get("resource_template_count") or 0),
            prompt_count=int(row.get("prompt_count") or 0),
            retired_at=_isoformat(row.get("retired_at")),
            created_at=_isoformat(row.get("created_at")),
            updated_at=_isoformat(row.get("updated_at")),
        )


class McpManifestImportResponse(BaseModel):
    """The outcome of cataloguing a server from a manifest."""

    success: bool = Field(default=True, description="Always true for a 2xx response.")
    endpoint: McpEndpointOut = Field(description="The endpoint the manifest now describes.")
    manifest: McpDeclaredManifestOut = Field(description="The declaration that was attached.")
    endpoint_created: bool = Field(
        description="True when no catalogued endpoint matched and one was registered."
    )
    match: str = Field(
        description=(
            "How the endpoint was recognised: `address` (same normalized endpoint URL), "
            "`surface` (same declared surface fingerprint), or `none` (created)."
        )
    )
    surface_conflict: bool = Field(
        description=(
            "True when the endpoint has been probed and its observed surface fingerprint "
            "differs from the declared one. Not an error — see the surface-provenance report."
        )
    )
    observed_fingerprint: Optional[str] = Field(
        default=None, description="The endpoint's current observed surface fingerprint, if any."
    )
    superseded_manifests: int = Field(
        default=0, description="How many earlier declarations this import retired."
    )
    reason: str = Field(description="One sentence explaining where the manifest landed and why.")


class McpDeclaredManifestListResponse(BaseModel):
    """Every declaration attached to one endpoint."""

    success: bool = Field(default=True, description="Always true for a 2xx response.")
    manifests: List[McpDeclaredManifestOut] = Field(
        default_factory=list, description="Declarations, newest first."
    )


class McpSurfaceFactOut(BaseModel):
    """One attributable fact about an endpoint's surface."""

    scope: str = Field(description="`surface`, or the capability kind the fact belongs to.")
    key: str = Field(description="Stable identifier within the scope.")
    label: str = Field(description="What a reader sees for this fact.")
    kind_label: str = Field(description="Human label for the fact's scope.")
    origin: str = Field(description="`declared`, `observed`, or `both`.")
    origin_label: str = Field(description="Human label for the origin.")
    agreement: str = Field(description="`uncontested`, `agrees`, or `conflicts`.")
    declared: Optional[Any] = Field(default=None, description="The declared value, when any.")
    observed: Optional[Any] = Field(default=None, description="The observed value, when any.")


class McpSurfaceProvenanceResponse(BaseModel):
    """The declared-vs-observed attribution for one endpoint's surface."""

    success: bool = Field(default=True, description="Always true for a 2xx response.")
    endpoint_id: str = Field(description="The endpoint the report describes.")
    surface_match: str = Field(
        description=(
            "`none`, `declared_only`, `observed_only`, `identical` (the two fingerprints "
            "agree), or `divergent`."
        )
    )
    declared_fingerprint: Optional[str] = Field(
        default=None, description="The declared surface's fingerprint, when one is attached."
    )
    observed_fingerprint: Optional[str] = Field(
        default=None, description="The observed surface's fingerprint, when discovery has run."
    )
    fingerprints_match: bool = Field(
        description="True only when both surfaces exist and fingerprint identically."
    )
    origin_counts: Dict[str, int] = Field(
        default_factory=dict, description="Fact count per origin."
    )
    conflict_count: int = Field(description="How many facts the two sources disagree on.")
    facts: List[McpSurfaceFactOut] = Field(
        default_factory=list, description="Every attributable fact, identity first then items."
    )


def _isoformat(value: Any) -> Optional[str]:
    """Render a timestamp column as ISO-8601 text, or ``None``."""
    if value is None:
        return None
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else str(value)


def _require_tenant_endpoint(auth_data: Dict[str, Any], endpoint_id: uuid.UUID) -> Dict[str, Any]:
    """Load an endpoint scoped to the caller's token tenant, or raise ``404``.

    The URL ``tenant_slug`` is informational; the validated token's ``tenant_id`` is what
    scopes the lookup, so a cross-tenant id reads as "not found" rather than "forbidden".

    Args:
        auth_data: The validated authentication context.
        endpoint_id: The endpoint being addressed.

    Returns:
        The ``mcp_endpoints`` row.

    Raises:
        HTTPException: 404 when the endpoint is not this tenant's.
    """
    tenant_id = str(auth_data["tenant_id"])
    endpoint = db.get_mcp_endpoint(tenant_id, str(endpoint_id))
    if not endpoint:
        raise HTTPException(status_code=404, detail="MCP endpoint not found")
    return endpoint


def _observed_surface(endpoint: Dict[str, Any]):
    """Rebuild an endpoint's observed surface from its current snapshot.

    Args:
        endpoint: The ``mcp_endpoints`` row.

    Returns:
        The :class:`~app.mcp_client.normalize.DiscoverySurface` for the current version, or
        ``None`` when the endpoint has never been discovered — an absence, never an empty
        surface that would read as "the server offers nothing".
    """
    version_id = endpoint.get("current_version_id")
    if not version_id:
        return None
    version = db.get_mcp_endpoint_version(str(endpoint["id"]), str(version_id))
    if not version:
        return None
    return reconstruct_surface(version, db.get_mcp_capability_items(str(version_id)))


@router.post(
    "/{tenant_slug}/endpoints/manifest-import",
    response_model=McpManifestImportResponse,
    summary="Catalog an MCP server from a static manifest",
    description=(
        "Import a static MCP server descriptor — tools, resources, resource templates and "
        "prompts with their JSON Schemas — without probing the server (FMT-1.7). The declared "
        "surface is normalized and fingerprinted by the same code a live discovery uses, so it "
        "is directly comparable with an observed one.\n\n"
        "**Never creates a duplicate.** When the manifest names a server the catalog already "
        "holds — by normalized endpoint URL, or by an identical declared surface fingerprint — "
        "the declaration attaches to that endpoint. Only an unrecognised server registers a new "
        "one, stamped `added_via: import`.\n\n"
        "A declaration is *not* a version snapshot: it never becomes `current_version_id` and "
        "never appears in the change feed. Where a manifest and a probe disagree, both values "
        "are kept and reported by the surface-provenance report."
    ),
)
async def import_mcp_manifest(
    tenant_slug: str,
    body: McpManifestImportRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> McpManifestImportResponse:
    """Attach a declared surface to a new or existing MCP endpoint.

    Args:
        tenant_slug: Informational; scoping comes from the validated token.
        body: The manifest plus optional address overrides.
        auth_data: The validated authentication context.

    Returns:
        The endpoint, the attached declaration, and why it landed there.

    Raises:
        HTTPException: 422 when the manifest cannot be parsed or names no address; 400 for
            an unknown transport; 409 on a slug race while registering a new endpoint.
    """
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])

    if body.transport is not None and body.transport not in MCP_ENDPOINT_TRANSPORTS:
        raise HTTPException(
            status_code=400,
            detail=f"transport must be one of {', '.join(MCP_ENDPOINT_TRANSPORTS)}",
        )

    try:
        document = parse_mcp_manifest(body.manifest, source_label=body.source_label)
    except McpManifestParseError as exc:
        raise HTTPException(
            status_code=_CLIENT_ERROR_STATUS,
            detail={"message": str(exc), "code": exc.code or "INPUT_MALFORMED"},
        ) from exc

    declaration = declared_manifest(document, source_label=body.source_label)

    try:
        target = resolve_manifest_target(
            document,
            declaration.fingerprint,
            endpoint_url=body.endpoint_url,
            transport=body.transport,
        )
    except ManifestTargetError as exc:
        raise HTTPException(
            status_code=_CLIENT_ERROR_STATUS,
            detail={"message": str(exc), "code": "INPUT_SEMANTIC_INVALID"},
        ) from exc

    endpoints = db.list_mcp_endpoints(tenant_id)
    plan = plan_manifest_attach(
        target,
        endpoints,
        observed_fingerprints=db.map_mcp_endpoint_surface_fingerprints(tenant_id),
    )

    actor = get_authenticated_user_id(auth_data)
    if plan.created:
        if not actor:
            raise HTTPException(
                status_code=403,
                detail="a resolvable user is required to register an MCP endpoint",
            )
        try:
            endpoint = db.insert_mcp_endpoint(
                tenant_id=tenant_id,
                creator_id=str(actor),
                name=target.name,
                base_slug=target.slug,
                endpoint_url=target.endpoint_url,
                transport=target.transport,
                description=document.instructions,
                added_via=ADDED_VIA_IMPORT,
            )
        except pg_errors.UniqueViolation as exc:
            raise HTTPException(
                status_code=409,
                detail="an MCP endpoint with this slug already exists for this tenant",
            ) from exc
    else:
        endpoint = db.get_mcp_endpoint(tenant_id, str(plan.endpoint_id))
        if not endpoint:
            raise HTTPException(status_code=404, detail="MCP endpoint not found")

    endpoint_id = str(endpoint["id"])
    stored = db.upsert_mcp_endpoint_manifest(
        tenant_id=tenant_id,
        endpoint_id=endpoint_id,
        manifest=declaration.as_row(),
        imported_by=str(actor) if actor else None,
    )
    if not stored:
        raise HTTPException(
            status_code=500, detail="the declared manifest could not be attached"
        )
    superseded = db.retire_other_mcp_endpoint_manifests(endpoint_id, str(stored["id"]))

    return McpManifestImportResponse(
        endpoint=mcp_endpoint_out_from_row(endpoint),
        manifest=McpDeclaredManifestOut.from_row(stored),
        endpoint_created=plan.created,
        match=plan.match,
        surface_conflict=plan.surface_conflict,
        observed_fingerprint=plan.observed_fingerprint,
        superseded_manifests=superseded,
        reason=plan.reason,
    )


@router.get(
    "/{tenant_slug}/endpoints/{endpoint_id}/manifests",
    response_model=McpDeclaredManifestListResponse,
    summary="List an endpoint's declared manifests",
    description=(
        "Every static manifest attached to this endpoint, newest first (FMT-1.7). Superseded "
        "declarations are excluded unless `include_retired` is set — they stay readable so an "
        "attribution made against one remains interpretable."
    ),
)
async def list_mcp_endpoint_manifests(
    tenant_slug: str,
    endpoint_id: uuid.UUID,
    include_retired: bool = Query(
        default=False, description="Include superseded declarations."
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> McpDeclaredManifestListResponse:
    """List the declarations attached to one endpoint.

    Args:
        tenant_slug: Informational; scoping comes from the validated token.
        endpoint_id: The endpoint to read.
        include_retired: Whether superseded declarations are included.
        auth_data: The validated authentication context.

    Returns:
        The declarations, newest first.
    """
    _ = tenant_slug
    endpoint = _require_tenant_endpoint(auth_data, endpoint_id)
    rows = db.list_mcp_endpoint_manifests(
        str(endpoint["id"]), include_retired=include_retired
    )
    return McpDeclaredManifestListResponse(
        manifests=[McpDeclaredManifestOut.from_row(row) for row in rows]
    )


@router.get(
    "/{tenant_slug}/endpoints/{endpoint_id}/surface-provenance",
    response_model=McpSurfaceProvenanceResponse,
    summary="Attribute an endpoint's surface facts to declared / observed sources",
    description=(
        "For every fact on this endpoint's surface — protocol version, server identity, "
        "declared capabilities, and each tool / resource / resource template / prompt — say "
        "whether it came from a **declared** manifest, an **observed** probe, or **both** "
        "(FMT-1.7).\n\n"
        "Where both carry a fact and their values differ, the fact reads `conflicts` and both "
        "values are returned; nothing here picks a winner. An endpoint with no manifest reads "
        "as `observed_only`, never as agreement."
    ),
)
async def get_mcp_surface_provenance(
    tenant_slug: str,
    endpoint_id: uuid.UUID,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> McpSurfaceProvenanceResponse:
    """Return the declared-vs-observed attribution for one endpoint's surface.

    Args:
        tenant_slug: Informational; scoping comes from the validated token.
        endpoint_id: The endpoint to attribute.
        auth_data: The validated authentication context.

    Returns:
        The attribution report.
    """
    _ = tenant_slug
    endpoint = _require_tenant_endpoint(auth_data, endpoint_id)
    declared = surface_from_manifest_row(
        db.get_current_mcp_endpoint_manifest(str(endpoint["id"]))
    )
    provenance = build_surface_provenance(
        declared=declared, observed=_observed_surface(endpoint)
    )
    payload = provenance.to_dict()
    return McpSurfaceProvenanceResponse(
        endpoint_id=str(endpoint["id"]),
        surface_match=payload["surface_match"],
        declared_fingerprint=payload["declared_fingerprint"],
        observed_fingerprint=payload["observed_fingerprint"],
        fingerprints_match=payload["fingerprints_match"],
        origin_counts=payload["origin_counts"],
        conflict_count=payload["conflict_count"],
        facts=[McpSurfaceFactOut(**fact) for fact in payload["facts"]],
    )

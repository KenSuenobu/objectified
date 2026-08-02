"""
Public browse directory endpoints (no authentication).

Mirrors the data surfaced by ``apiome-browse`` ``getPublicTenants`` and
``getDirectoryStats`` for CLI and API consumers.
"""

from __future__ import annotations

from datetime import datetime
from functools import cmp_to_key
from typing import Any, Dict, List, Literal

from fastapi import APIRouter, Header, HTTPException, Query

from .auth import resolve_optional_tenant_member_auth
from .browse_change_summary import browse_version_changes_summary
from .browse_facets import (
    normalize_format_filter,
    normalize_protocol_filter,
    sort_format_counts,
    sort_protocol_counts,
)
from .database import db
from .models import (
    BrowseDirectoryStats,
    BrowseFacetCount,
    BrowseFacets,
    BrowsePublicProjectRow,
    BrowsePublicProjectsResponse,
    BrowsePublicTenantRow,
    BrowsePublicTenantsResponse,
    BrowsePublicVersionRow,
    BrowsePublicVersionsResponse,
)
from .semver_version import parse_semver as _parse_semver

router = APIRouter(prefix="/v1/browse", tags=["browse"])


def _cmp_prerelease(a: tuple[str, ...], b: tuple[str, ...]) -> int:
    if not a and not b:
        return 0
    if not a:
        return 1
    if not b:
        return -1
    for ai, bi in zip(a, b):
        if ai == bi:
            continue
        ai_num = ai.isdigit()
        bi_num = bi.isdigit()
        if ai_num and bi_num:
            return 1 if int(ai) > int(bi) else -1
        if ai_num != bi_num:
            return -1 if ai_num else 1
        return 1 if ai > bi else -1
    if len(a) == len(b):
        return 0
    return 1 if len(a) > len(b) else -1


def _compare_version_slug_desc(a_slug: str, b_slug: str) -> int:
    a_parsed = _parse_semver(a_slug)
    b_parsed = _parse_semver(b_slug)
    if a_parsed and b_parsed:
        if a_parsed[:3] != b_parsed[:3]:
            return -1 if a_parsed[:3] > b_parsed[:3] else 1
        prerelease_cmp = _cmp_prerelease(a_parsed[3], b_parsed[3])
        if prerelease_cmp != 0:
            return -1 if prerelease_cmp > 0 else 1
        a_lower = a_slug.lower()
        b_lower = b_slug.lower()
        if a_lower == b_lower:
            return 0
        return -1 if a_lower > b_lower else 1
    if a_parsed and not b_parsed:
        return -1
    if b_parsed and not a_parsed:
        return 1
    a_lower = a_slug.lower()
    b_lower = b_slug.lower()
    if a_lower == b_lower:
        return 0
    return -1 if a_lower > b_lower else 1


def _sort_versions_semver_desc(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(
        rows,
        key=cmp_to_key(
            lambda a, b: _compare_version_slug_desc(
                str(a.get("version_id") or ""),
                str(b.get("version_id") or ""),
            )
        ),
    )


#: Shared documentation for the two facet query parameters, so every browse listing describes them
#: identically (MFI-6.1).
_PROTOCOL_QUERY_DESCRIPTION = (
    "Filter by canonical paradigm: rest, rpc, event, graph, data_schema, agent. "
    "Punctuation-insensitive (``data-schema`` works) and unknown values simply match nothing."
)
_FORMAT_QUERY_DESCRIPTION = (
    "Filter by specific source format key as captured at import (e.g. openapi-3.1, protobuf, "
    "graphql). Case-insensitive; unknown values simply match nothing."
)


def _facet_value(value: Any) -> str | None:
    """Normalize a single stored facet value for the response (lower-case, blanks become null).

    Args:
        value: A raw ``protocol`` / ``source_format`` column value, possibly None.

    Returns:
        The normalized value, or None when it is absent or blank — matching how the facet counts
        and filters treat an unrecorded value.
    """
    if value is None:
        return None
    text = str(value).strip().lower()
    return text or None


def _string_list(value: Any) -> List[str]:
    """Coerce a database array column into a list of non-empty strings.

    Args:
        value: The raw column value — a list from psycopg, or None for a row with no values.

    Returns:
        The values as strings, blanks dropped; an empty list for anything non-list.
    """
    if not isinstance(value, list):
        return []
    return [str(v) for v in value if v is not None and str(v).strip()]


def _build_facets(counts: Any) -> BrowseFacets:
    """Turn a database facet-count mapping into the ordered, labelled response model.

    Args:
        counts: ``{"protocols": {value: count}, "formats": {value: count}}`` as returned by the
            ``db.*_facets*`` accessors. A malformed or missing axis degrades to empty — a facet row
            is navigational sugar and must never break a listing.

    Returns:
        The facet chips: protocols in canonical paradigm order, formats by descending count.
    """
    protocols: dict = {}
    formats: dict = {}
    if isinstance(counts, dict):
        raw_protocols = counts.get("protocols")
        raw_formats = counts.get("formats")
        if isinstance(raw_protocols, dict):
            protocols = {str(k): int(v) for k, v in raw_protocols.items() if k}
        if isinstance(raw_formats, dict):
            formats = {str(k): int(v) for k, v in raw_formats.items() if k}
    return BrowseFacets(
        protocols=[
            BrowseFacetCount(value=value, label=label, count=count)
            for value, label, count in sort_protocol_counts(protocols)
        ],
        formats=[
            BrowseFacetCount(value=value, label=label, count=count)
            for value, label, count in sort_format_counts(formats)
        ],
    )


def _browse_project_domain_label(metadata: Any) -> str:
    """Human-facing domain/category cell (matches CLI ``domainDisplay`` semantics)."""
    if not metadata or not isinstance(metadata, dict):
        return "—"
    d_raw = metadata.get("domain")
    if isinstance(d_raw, str):
        d = d_raw.strip()
        if d:
            return d
    c_raw = metadata.get("domainCategory")
    if isinstance(c_raw, str):
        c = c_raw.strip()
        if c and c.lower() != "none":
            return c
    return "—"


@router.get("/tenants", response_model=BrowsePublicTenantsResponse)
async def list_public_browse_tenants(
    search: str | None = Query(
        None,
        description="Case-insensitive substring filter on tenant name and slug.",
    ),
    sort: Literal["latest", "name", "projects"] = Query(
        "name",
        description="Sort order: name (default), projects (desc), or latest activity (desc).",
    ),
    protocol: str | None = Query(None, description=_PROTOCOL_QUERY_DESCRIPTION),
    source_format: str | None = Query(None, alias="format", description=_FORMAT_QUERY_DESCRIPTION),
) -> BrowsePublicTenantsResponse:
    protocol_filter = normalize_protocol_filter(protocol)
    format_filter = normalize_format_filter(source_format)

    stats = db.get_public_browse_directory_stats()
    rows = db.list_public_browse_tenants(
        search=search,
        sort=sort,
        protocol=protocol_filter,
        source_format=format_filter,
    )
    tenants = [
        BrowsePublicTenantRow.model_validate(
            {**r, "protocols": _string_list(r.get("protocols")), "formats": _string_list(r.get("formats"))}
        )
        for r in rows
    ]
    facets = _build_facets(db.get_public_browse_tenant_facets(search=search))
    return BrowsePublicTenantsResponse(
        directory_stats=BrowseDirectoryStats.model_validate(stats),
        tenants=tenants,
        filtered_count=len(tenants),
        facets=facets,
    )


@router.get(
    "/tenants/{tenant_slug}/projects",
    response_model=BrowsePublicProjectsResponse,
    responses={
        401: {"description": "Credentials provided but could not be validated."},
        403: {"description": "Credentials provided but not authorized for this tenant."},
        404: {"description": "Tenant not found."},
    },
)
async def list_public_browse_projects(
    tenant_slug: str,
    search: str | None = Query(
        None,
        description="Case-insensitive substring filter on project slug and name.",
    ),
    domain: str | None = Query(
        None,
        description="Filter by project metadata domain or domainCategory (case-insensitive).",
    ),
    has_published: bool = Query(
        False,
        description="Only include projects with at least one published version (visibility rules apply).",
    ),
    protocol: str | None = Query(None, description=_PROTOCOL_QUERY_DESCRIPTION),
    source_format: str | None = Query(None, alias="format", description=_FORMAT_QUERY_DESCRIPTION),
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None, alias="X-API-Key"),
) -> BrowsePublicProjectsResponse:
    tenant = db.get_tenant_row_by_slug(tenant_slug)
    if tenant is None:
        raise HTTPException(status_code=404, detail=f"Tenant not found: {tenant_slug}")

    is_member = resolve_optional_tenant_member_auth(
        tenant_slug,
        authorization=authorization,
        x_api_key=x_api_key,
    )
    tenant_id = tenant["id"]
    protocol_filter = normalize_protocol_filter(protocol)
    format_filter = normalize_format_filter(source_format)

    if is_member:
        raw_rows = db.list_member_browse_projects_for_tenant(
            tenant_id,
            search=search,
            domain=domain,
            require_published=has_published,
            protocol=protocol_filter,
            source_format=format_filter,
        )
        facet_counts = db.get_member_browse_project_facets_for_tenant(
            tenant_id,
            search=search,
            domain=domain,
        )
    else:
        raw_rows = db.list_public_browse_projects_for_tenant(
            tenant_id,
            search=search,
            domain=domain,
            require_published=has_published,
            protocol=protocol_filter,
            source_format=format_filter,
        )
        facet_counts = db.get_public_browse_project_facets_for_tenant(
            tenant_id,
            search=search,
            domain=domain,
        )

    projects = [
        BrowsePublicProjectRow(
            slug=row["slug"],
            name=row["name"],
            domain=_browse_project_domain_label(row.get("metadata")),
            published_versions=int(row["published_versions"] or 0),
            latest_version=row.get("latest_version"),
            latest_published_at=row.get("latest_published_at"),
            protocols=_string_list(row.get("protocols")),
            formats=_string_list(row.get("formats")),
        )
        for row in raw_rows
    ]

    return BrowsePublicProjectsResponse(
        tenant_slug=str(tenant["slug"]),
        tenant_name=str(tenant["name"]),
        projects=projects,
        filtered_count=len(projects),
        facets=_build_facets(facet_counts),
    )


@router.get(
    "/tenants/{tenant_slug}/projects/{project_slug}/versions",
    response_model=BrowsePublicVersionsResponse,
    responses={
        401: {"description": "Credentials provided but could not be validated."},
        403: {"description": "Credentials provided but not authorized for this tenant."},
        404: {"description": "Tenant or project not found."},
    },
)
async def list_public_browse_versions(
    tenant_slug: str,
    project_slug: str,
    since: datetime | None = Query(
        None,
        description="Include only versions whose published_at is at or after this timestamp (ISO 8601).",
    ),
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None, alias="X-API-Key"),
) -> BrowsePublicVersionsResponse:
    tenant = db.get_tenant_row_by_slug(tenant_slug)
    if tenant is None:
        raise HTTPException(status_code=404, detail=f"Tenant not found: {tenant_slug}")

    is_member = resolve_optional_tenant_member_auth(
        tenant_slug,
        authorization=authorization,
        x_api_key=x_api_key,
    )
    tenant_id = tenant["id"]

    project = db.get_project_by_slug(project_slug, tenant_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_slug}")

    if not is_member:
        if not db.project_has_public_published_version(tenant_id, project_slug):
            raise HTTPException(status_code=404, detail=f"Project not found: {project_slug}")

    if is_member:
        raw_rows = db.list_member_browse_versions_for_project(tenant_id, project_slug, since=since)
    else:
        raw_rows = db.list_public_browse_versions_for_project(tenant_id, project_slug, since=since)

    rows_sorted = _sort_versions_semver_desc(raw_rows)

    versions_out: List[BrowsePublicVersionRow] = []
    for i, row in enumerate(rows_sorted):
        next_row = rows_sorted[i + 1] if i + 1 < len(rows_sorted) else None
        baseline_slug = str(next_row["version_id"]) if next_row else None

        tags_raw = row.get("tags") or []
        tags_list = [str(t) for t in tags_raw] if isinstance(tags_raw, list) else []

        desc = row.get("description")
        clog = row.get("change_log")
        summary = browse_version_changes_summary(
            change_model_json=row.get("change_model_json"),
            change_log=str(clog) if clog is not None else None,
            description=str(desc) if desc is not None else None,
            baseline_version_slug=baseline_slug,
        )

        versions_out.append(
            BrowsePublicVersionRow(
                id=str(row["id"]),
                version_id=str(row["version_id"]),
                published_at=row.get("published_at"),
                tags=tags_list,
                changes_summary=summary,
                description=str(desc) if desc is not None else None,
                change_log=str(clog) if clog is not None else None,
                protocol=_facet_value(row.get("protocol")),
                source_format=_facet_value(row.get("source_format")),
            )
        )

    return BrowsePublicVersionsResponse(
        tenant_slug=str(tenant["slug"]),
        tenant_name=str(tenant["name"]),
        project_slug=str(project["slug"]),
        project_name=str(project["name"]),
        versions=versions_out,
        filtered_count=len(versions_out),
    )

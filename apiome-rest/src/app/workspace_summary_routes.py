"""Domain summary & counts API — DUW-1.3 (private-suite#2570).

One read the unified workspace draws its whole tree from. The tree shows a badge on every folder
before anything is hydrated — ``customers/ 3·4``, ``billing/ 5·9``, ``shared/ 8`` — and each lens
badges the same folder with a different number: ``3 classes`` in the schemas lens, ``4 ops`` in the
paths lens, both in the combined lens. Deriving any of that in the browser would mean fetching the
whole catalog first, which is the read DUW-1.2 exists to eliminate, so the aggregation happens in
SQL and arrives in one round trip.

Three rules the surface rests on:

**Counts are exhaustive, member lists are bounded.** Every count covers the folder's entire
membership, because a badge that is only right for the first page is not a badge. The shallow rows
beside it are capped per folder by ``member_limit``, and a folder whose list was cut says so — the
client continues it with the DUW-1.2 scoped reads, which page. Nothing here is paginated: a version
has few folders, and a cursor over folders would make the tree's first render two requests.

**No bodies.** A class row carries id, name, kind and badge; an operation row carries its verb,
operationId, summary and deprecation flag. Schema bodies, properties, tags, parameters and
responses all stay with the reads that hydrate a selection. Shipping them here would rebuild the
full-catalog fetch under a new name.

**Tenancy is resolved through the version**, exactly as in :mod:`app.scoped_catalog_routes`: the
version is looked up inside the caller's tenant first, and every statement is then scoped by it.
Another tenant's version is a 404 — whether it exists is not something this API confirms.

The per-path schema rows the combined lens nests under an operation are DUW-1.4's schema↔path
index, not this endpoint.
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from . import workspace_summary_store as store
from .auth import validate_authentication
from .database import db
from .models import (
    WorkspaceDomainCounts,
    WorkspaceDomainSummary,
    WorkspaceSummary,
)

router = APIRouter(prefix="/v1/workspace", tags=["workspace"])

#: Description of the per-folder member cap, so a client learns both bounds from the schema rather
#: than by probing.
_MEMBER_LIMIT_DESCRIPTION = (
    f"Shallow member rows per folder, per kind. Default {store.DEFAULT_MEMBER_LIMIT}, clamped to "
    f"{store.MAX_MEMBER_LIMIT}; 0 returns counts alone, which is what a tree needs after an edit "
    "that changed a badge but not the folder on screen. Counts are unaffected — they always cover "
    "the whole folder."
)


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """The caller's tenant, or a 500 when the token carried none."""
    tid = auth_data.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=500, detail="Missing tenant context")
    return str(tid)


def _assert_version_in_tenant(version_id: str, tenant_id: str) -> Dict[str, Any]:
    """Resolve a version inside the caller's tenant, or 404.

    The only tenancy gate in this module: domains, classes and paths are all reached through their
    version, so scoping the version scopes the whole summary.

    Args:
        version_id: The version record UUID.
        tenant_id: The caller's tenant.

    Returns:
        The version row — which also carries the label the tree badges schema rows with.

    Raises:
        HTTPException: 404 when the version does not exist in this tenant.
    """
    version = db.get_version_by_id(version_id, tenant_id)
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    return version


def _counts(domain: Dict[str, Any]) -> WorkspaceDomainCounts:
    """The four badge numbers of one folder.

    Args:
        domain: A folder entry from :func:`app.workspace_summary_store.load_version_summary`.

    Returns:
        The counts model.
    """
    return WorkspaceDomainCounts(
        class_count=domain["class_count"],
        path_count=domain["path_count"],
        op_count=domain["op_count"],
        enum_count=domain["enum_count"],
    )


def _totals(domains: List[Dict[str, Any]]) -> WorkspaceDomainCounts:
    """The four badge numbers across every folder.

    Summed here rather than in SQL: the per-domain aggregates already cover the whole version
    exactly once each, so a fifth statement would only re-read what is already in hand.

    Args:
        domains: Every folder entry, including ``shared/``.

    Returns:
        The version-wide counts.
    """
    return WorkspaceDomainCounts(
        class_count=sum(d["class_count"] for d in domains),
        path_count=sum(d["path_count"] for d in domains),
        op_count=sum(d["op_count"] for d in domains),
        enum_count=sum(d["enum_count"] for d in domains),
    )


def _domain(domain: Dict[str, Any]) -> WorkspaceDomainSummary:
    """Project one store folder entry onto the API model.

    Args:
        domain: A folder entry from the store.

    Returns:
        The response element.
    """
    return WorkspaceDomainSummary(
        id=domain["id"],
        name=domain["name"],
        slug=domain["slug"],
        sort_order=domain["sort_order"],
        virtual=domain["virtual"],
        counts=_counts(domain),
        classes=domain["classes"],
        paths=domain["paths"],
        classes_truncated=domain["classes_truncated"],
        paths_truncated=domain["paths_truncated"],
    )


@router.get("/{tenant_slug}/version/{version_id}/summary", response_model=WorkspaceSummary)
async def get_workspace_summary(
    tenant_slug: str,
    version_id: str,
    member_limit: Optional[int] = Query(None, ge=0, description=_MEMBER_LIMIT_DESCRIPTION),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> WorkspaceSummary:
    """Every domain folder of a version, counted, with shallow member lists.

    Enough to render all three tree lens panels — combined, schemas and paths — with no further
    request: each folder arrives with its four counts, its class rows (kind-labelled, so the
    ``Schemas`` and ``Enums & unions`` groups need no second pass) and its path rows with their
    operations.
    """
    tenant_id = _tenant_id(auth_data)
    version = _assert_version_in_tenant(version_id, tenant_id)

    limit = store.clamp_member_limit(member_limit)
    badge = store.version_badge(version.get("version_id"))
    domains = store.load_version_summary(
        db, version_id=version_id, member_limit=limit, badge=badge
    )

    return WorkspaceSummary(
        version_id=version_id,
        version_badge=badge,
        member_limit=limit,
        domains=[_domain(domain) for domain in domains],
        totals=_totals(domains),
    )

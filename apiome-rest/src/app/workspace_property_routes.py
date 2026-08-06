"""Property-name search API — DUW-5.3 (private-suite#2590).

One read behind the ⌘K palette's `Properties` band: the properties of a version whose name matches
a query, each with how many classes carry it (``customer_id · used by 14 classes``) and which
classes those are.

Why it is a server-side endpoint rather than a filter in the browser: the workspace never fetches
properties. The DUW-1.3 summary carries class *rows* — id, name, kind, badge — and the DUW-1.2
scoped reads carry bodies only for what the reader opened. A browser answering "how many classes
use ``customer_id``" would first have to hydrate the whole catalog, which is the read this epic
exists to eliminate. The aggregate is one ``COUNT(DISTINCT class_id)``; see
:mod:`app.workspace_property_store`.

Three rules the surface rests on, shared with its DUW-1.x siblings:

**The count is exhaustive, the lists are bounded.** ``class_count`` covers every live class of the
version carrying the name, including ones this response does not list — a count that only covered
the returned owners would be a count of the answer. The name list and each name's owner list are
capped, and a response that capped either says so.

**A short query is answered, not argued with.** Anything under
:data:`~app.workspace_property_store.MIN_QUERY_LENGTH` characters answers with no hits and a 200:
the palette asks on every pause, and a keystroke that has not become a question yet is not an
error.

**Tenancy is resolved through the version**, as in DUW-1.2/1.3/1.4: the version is looked up inside
the caller's tenant first and every statement is then scoped by it. Another tenant's version is a
404 — whether it exists is not something this API confirms.

The two result *columns* beside this band — schemas and paths — are the domain summary (DUW-1.3)
and the consumption index (DUW-1.4); this endpoint answers the band alone.
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from . import workspace_property_store as store
from .auth import validate_authentication
from .database import db
from .models import WorkspacePropertySearch

router = APIRouter(prefix="/v1/workspace", tags=["workspace"])

_QUERY_DESCRIPTION = (
    "The property name to search for, matched case-insensitively anywhere in the name. Shorter "
    f"than {store.MIN_QUERY_LENGTH} characters answers with no hits rather than with most of the "
    "catalog; '%' and '_' match themselves rather than acting as wildcards."
)

_LIMIT_DESCRIPTION = (
    f"Property names to return. Default {store.DEFAULT_PROPERTY_LIMIT}, clamped to "
    f"{store.MAX_PROPERTY_LIMIT}; 0 returns no hits. 'total' always reports how many matched."
)

_OWNER_LIMIT_DESCRIPTION = (
    f"Owning classes listed per property. Default {store.DEFAULT_OWNER_LIMIT}, clamped to "
    f"{store.MAX_OWNER_LIMIT}; 0 returns counts alone, which costs one statement instead of two. "
    "'class_count' is unaffected — it always covers the whole version."
)


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """The caller's tenant, or a 500 when the token carried none."""
    tid = auth_data.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=500, detail="Missing tenant context")
    return str(tid)


def _assert_version_in_tenant(version_id: str, tenant_id: str) -> Dict[str, Any]:
    """Resolve a version inside the caller's tenant, or 404.

    The only tenancy gate in this module: classes and their properties are reached through their
    version, so scoping the version scopes the whole search.

    Args:
        version_id: The version record UUID.
        tenant_id: The caller's tenant.

    Returns:
        The version row.

    Raises:
        HTTPException: 404 when the version does not exist in this tenant.
    """
    version = db.get_version_by_id(version_id, tenant_id)
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    return version


@router.get(
    "/{tenant_slug}/version/{version_id}/properties",
    response_model=WorkspacePropertySearch,
    responses={404: {"description": "Version not found in this tenant."}},
)
async def search_workspace_properties(
    tenant_slug: str,
    version_id: str,
    q: Optional[str] = Query(None, description=_QUERY_DESCRIPTION),
    limit: Optional[int] = Query(None, ge=0, description=_LIMIT_DESCRIPTION),
    owner_limit: Optional[int] = Query(None, ge=0, description=_OWNER_LIMIT_DESCRIPTION),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> WorkspacePropertySearch:
    """Which properties of this version a query names, and how many classes carry each.

    Enough to draw the palette's `Properties` band with no further request: each hit carries the
    usage count the band prints and the classes behind it, so ⏎ opens the top owner and the
    secondary action lists the rest without asking again.
    """
    tenant_id = _tenant_id(auth_data)
    _assert_version_in_tenant(version_id, tenant_id)

    query = store.normalize_query(q)
    result = store.search_version_properties(
        db,
        version_id=version_id,
        query=query,
        limit=store.clamp_property_limit(limit),
        owner_limit=store.clamp_owner_limit(owner_limit),
    )

    return WorkspacePropertySearch(version_id=version_id, query=query, **result)

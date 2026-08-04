"""Selection-scoped catalog API — DUW-1.2 (private-suite#2569).

Two reads the unified workspace hydrates its canvas from: a version's classes, and a version's
paths, each selected either **by id list** or **by domain folder**. They exist because the only
class read before them was ``GET /v1/classes/{tenant}/version/{id}/with-properties-tags``, which
returns the entire catalog — the direct cause of the browser choke this epic is fixing.

The rules the whole surface rests on:

**A selection is mandatory.** Exactly one of ``class_ids``/``path_ids`` or ``domain_id`` must be
given. Omitting both would mean "the whole version", which is the thing this endpoint exists not to
do, so it is a 400 rather than a convenience default. Giving both is also a 400: a client that
means "these three, but only if they are in billing/" is describing a filter nobody has asked for,
and guessing which selector wins would make the response silently wrong.

**The cap is enforced two different ways, for one reason.** A page size over
:data:`~app.scoped_catalog_store.MAX_PAGE_SIZE` is *clamped*, because a domain listing hands back a
cursor and the client has a working continuation. An id list over
:data:`~app.scoped_catalog_store.MAX_SELECTED_IDS` is *rejected*, because there is no cursor for an
arbitrary id set and quietly answering a different question than the one asked is worse than
saying no. Both limits are echoed in the response.

**Tenancy is resolved through the version.** Every route resolves ``version_id`` against the
caller's tenant first, and every query is then scoped by that version — so an id from another
tenant's catalog matches nothing. Another tenant's version is a 404, not a 403; whether it exists
is not something this API confirms.

Per-domain counts for the tree badges are DUW-1.3, and the schema↔path consumption index that
turns these two reads into combined-lens edges is DUW-1.4. Neither is here.
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from . import domains_store
from . import scoped_catalog_store as store
from .auth import validate_authentication
from .database import db
from .export_projection import decode_page_cursor, encode_page_cursor
from .models import ScopedCatalogPage

router = APIRouter(prefix="/v1/workspace", tags=["workspace"])

#: Description shared by both id-selector parameters, so the two endpoints document one contract.
_IDS_DESCRIPTION = (
    "Explicit selection. Repeat the parameter or comma-separate the values; duplicates collapse. "
    f"At most {store.MAX_SELECTED_IDS} ids per request — a larger selection is a 400, not a "
    "truncated response. Mutually exclusive with domain_id."
)

#: Description shared by both domain selectors.
_DOMAIN_DESCRIPTION = (
    "Domain folder to list, or the literal 'shared' for items with no domain. Paginated. "
    "Mutually exclusive with the id selector."
)

#: Description of the page-size parameter.
_LIMIT_DESCRIPTION = (
    f"Page size for a domain listing, default {store.DEFAULT_PAGE_SIZE}, clamped to "
    f"{store.MAX_PAGE_SIZE}. Ignored for an id selection, which is bounded by the id cap instead."
)


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """The caller's tenant, or a 500 when the token carried none."""
    tid = auth_data.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=500, detail="Missing tenant context")
    return str(tid)


def _assert_version_in_tenant(version_id: str, tenant_id: str) -> Dict[str, Any]:
    """Resolve a version inside the caller's tenant, or 404.

    The only tenancy gate in this module: classes, paths and domains are all reached through their
    version, so scoping the version scopes everything selected under it.

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


def _blank_to_none(value: Optional[str]) -> Optional[str]:
    """Treat an empty or whitespace-only query value as absent.

    ``?domain_id=`` is a client that meant to send a folder and sent nothing. Reading it as "no
    selector" makes it fail the mandatory-selection check with a message that says so, instead of
    reaching SQL as a filter that matches nothing.
    """
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def _resolve_selection(
    *,
    ids: Optional[List[str]],
    domain_id: Optional[str],
    id_parameter: str,
    whole_version_route: str,
) -> Dict[str, Any]:
    """Validate the two mutually exclusive selectors and normalize whichever was used.

    Args:
        ids: Raw id parameter values, or None.
        domain_id: Raw domain selector, or None.
        id_parameter: The id parameter's name, for error messages naming the actual parameter.
        whole_version_route: The existing unbounded read for this member kind, named in the
            no-selection error so a caller who genuinely wants everything is not left guessing.

    Returns:
        For an id selection ``{"scope": "ids", "ids": [...], "malformed": [...]}``; for a domain
        listing ``{"scope": "domain", "domain": <str|None>}`` where None is the ``shared/`` bucket.

    Raises:
        HTTPException: 400 when neither or both selectors are present, or when the id list exceeds
            the server cap.
    """
    domain = _blank_to_none(domain_id)
    selected_ids, malformed = store.normalize_ids(ids)
    has_ids = bool(selected_ids or malformed)

    if has_ids and domain is not None:
        raise HTTPException(
            status_code=400,
            detail=f"Use either {id_parameter} or domain_id, not both.",
        )
    if not has_ids and domain is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"A selection is required: pass {id_parameter} for specific items, or domain_id "
                "(or 'shared') to list a folder. This endpoint does not return a whole version — "
                f"that is {whole_version_route}."
            ),
        )

    if has_ids:
        requested = len(selected_ids) + len(malformed)
        if requested > store.MAX_SELECTED_IDS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"At most {store.MAX_SELECTED_IDS} ids per request; {requested} were given. "
                    "Split the selection across requests."
                ),
            )
        return {"scope": "ids", "ids": selected_ids, "malformed": malformed}

    if domain == store.SHARED_DOMAIN_ID:
        return {"scope": "domain", "domain": None}
    return {"scope": "domain", "domain": domain}


def _assert_domain_in_version(domain_id: Optional[str], version_id: str) -> None:
    """Check that a named domain is a live folder of this version.

    The ``shared/`` bucket (``domain_id`` None) is always valid — it is the absence of a domain and
    exists in every version. A real domain is verified so that a stale or foreign id answers 404
    with a reason, rather than an empty page a client would read as "that folder is empty".

    Args:
        domain_id: The resolved domain, or None for ``shared/``.
        version_id: The version the listing is scoped to.

    Raises:
        HTTPException: 404 when the domain is missing, deleted, or belongs to another version.
    """
    if domain_id is None:
        return

    domain = domains_store.get_domain(db, domain_id=domain_id)
    if not domain or str(domain["version_id"]) != str(version_id):
        raise HTTPException(status_code=404, detail="Domain not found in this version")


def _decode_offset(cursor: Optional[str]) -> int:
    """Turn an opaque page cursor into a start offset.

    Uses the cursor codec :mod:`app.export_projection` defines and every other paginated surface
    here already speaks, so a client needs one cursor format for the whole API.

    Args:
        cursor: The token from a previous response's ``next_cursor``, or None for the first page.

    Returns:
        The offset to start at.

    Raises:
        HTTPException: 400 when the token is not one this API issued.
    """
    if not cursor:
        return 0
    try:
        return decode_page_cursor(cursor)
    except ValueError:
        raise HTTPException(status_code=400, detail="Malformed cursor") from None


def _page(
    result: store.ScopedPage,
    *,
    scope: str,
    domain_id: Optional[str],
    limit: int,
) -> ScopedCatalogPage:
    """Project a store page onto the API envelope.

    Args:
        result: What the store returned.
        scope: Which selector produced it — ``"ids"`` or ``"domain"``.
        domain_id: The folder listed, or None (either ``shared/`` or an id selection).
        limit: The most items this response could have carried.

    Returns:
        The response body.
    """
    return ScopedCatalogPage(
        items=result.items,
        total=result.total,
        limit=limit,
        scope=scope,
        domain_id=domain_id,
        missing_ids=result.missing_ids,
        next_cursor=(
            encode_page_cursor(result.next_offset) if result.next_offset is not None else None
        ),
    )


@router.get("/{tenant_slug}/version/{version_id}/classes", response_model=ScopedCatalogPage)
async def get_scoped_classes(
    tenant_slug: str,
    version_id: str,
    class_ids: Optional[List[str]] = Query(None, description=_IDS_DESCRIPTION),
    domain_id: Optional[str] = Query(None, description=_DOMAIN_DESCRIPTION),
    limit: Optional[int] = Query(None, ge=1, description=_LIMIT_DESCRIPTION),
    cursor: Optional[str] = Query(None, description="Opaque token from a previous next_cursor."),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ScopedCatalogPage:
    """Classes with their properties and tags, scoped to a selection or a domain folder.

    Requesting three ids returns those three classes and nothing else, whatever the version
    contains. Requesting a domain returns one page of that folder plus ``total``, so the workspace
    can decide whether hydrating the rest fits its node budget before asking for it.
    """
    tenant_id = _tenant_id(auth_data)
    _assert_version_in_tenant(version_id, tenant_id)

    selection = _resolve_selection(
        ids=class_ids,
        domain_id=domain_id,
        id_parameter="class_ids",
        whole_version_route=(
            "GET /v1/classes/{tenant_slug}/version/{version_id}/with-properties-tags"
        ),
    )

    if selection["scope"] == "ids":
        result = store.load_classes_by_ids(
            db,
            version_id=version_id,
            class_ids=selection["ids"],
            malformed_ids=selection["malformed"],
        )
        return _page(result, scope="ids", domain_id=None, limit=store.MAX_SELECTED_IDS)

    _assert_domain_in_version(selection["domain"], version_id)
    page_size = store.clamp_page_size(limit)
    result = store.load_classes_by_domain(
        db,
        version_id=version_id,
        domain_id=selection["domain"],
        limit=page_size,
        offset=_decode_offset(cursor),
    )
    return _page(result, scope="domain", domain_id=selection["domain"], limit=page_size)


@router.get("/{tenant_slug}/version/{version_id}/paths", response_model=ScopedCatalogPage)
async def get_scoped_paths(
    tenant_slug: str,
    version_id: str,
    path_ids: Optional[List[str]] = Query(None, description=_IDS_DESCRIPTION),
    domain_id: Optional[str] = Query(None, description=_DOMAIN_DESCRIPTION),
    limit: Optional[int] = Query(None, ge=1, description=_LIMIT_DESCRIPTION),
    cursor: Optional[str] = Query(None, description="Opaque token from a previous next_cursor."),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ScopedCatalogPage:
    """Paths with their operations, scoped to a selection or a domain folder.

    The bulk form of ``GET /v1/paths/{tenant}/{version}/{path}/full``'s first query: each path
    carries its operations, each operation its ``operation_id``, ``summary`` and ``deprecated``
    flag. Parameters, request bodies and responses stay with the per-path endpoint — those are
    inspector-sized data for one selected operation.
    """
    tenant_id = _tenant_id(auth_data)
    _assert_version_in_tenant(version_id, tenant_id)

    selection = _resolve_selection(
        ids=path_ids,
        domain_id=domain_id,
        id_parameter="path_ids",
        whole_version_route="GET /v1/paths/{tenant_slug}/{version_id}",
    )

    if selection["scope"] == "ids":
        result = store.load_paths_by_ids(
            db,
            version_id=version_id,
            path_ids=selection["ids"],
            malformed_ids=selection["malformed"],
        )
        return _page(result, scope="ids", domain_id=None, limit=store.MAX_SELECTED_IDS)

    _assert_domain_in_version(selection["domain"], version_id)
    page_size = store.clamp_page_size(limit)
    result = store.load_paths_by_domain(
        db,
        version_id=version_id,
        domain_id=selection["domain"],
        limit=page_size,
        offset=_decode_offset(cursor),
    )
    return _page(result, scope="domain", domain_id=selection["domain"], limit=page_size)

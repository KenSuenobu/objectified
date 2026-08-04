"""Domain folder API — DUW-1.1 (private-suite#2568).

CRUD over ``apiome.domains`` plus the two assignment endpoints that move a class or a path between
folders. Every route is version-scoped and every version is resolved through
``db.get_version_by_id(version_id, tenant_id)`` before anything else happens, so a domain in
another tenant's catalog is a 404 rather than a 403 — the existence of another tenant's version is
not something this API confirms.

Two behaviours are worth stating because they are load-bearing for the workspace tree:

**``shared/`` is always in the list and is never a row.** :func:`list_domains` appends a synthetic
entry with ``id: null`` and ``virtual: true`` after the real domains. It has no create, rename or
delete route because there is nothing to delete: it is the set of members with ``domain_id IS
NULL``. A client moves items into it by assigning ``domain_id: null`` (or the string ``"shared"``).

**Deleting a domain moves its contents; it never removes them.** The soft delete in
:func:`delete_domain` fires V242's release trigger, which nulls the ``domain_id`` of every member
in the same statement. The 200 body reports how many items moved, so a UI can say "3 classes and 4
paths moved to shared/" instead of asking the user to trust that nothing was lost.

Counts beyond that — the per-domain badges the tree renders — are DUW-1.3's endpoint, not this one.
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException

from . import domains_store as store
from .auth import validate_authentication
from .database import db
from .models import (
    DomainAssignmentRequest,
    DomainCreateRequest,
    DomainMemberSchema,
    DomainSchema,
    DomainUpdateRequest,
)
from .permissions import Action, Resource, enforce_permission

router = APIRouter(prefix="/v1/domains", tags=["domains"])


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """The caller's tenant, or a 500 when the token carried none."""
    tid = auth_data.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=500, detail="Missing tenant context")
    return str(tid)


def _assert_version_in_tenant(version_id: str, tenant_id: str) -> Dict[str, Any]:
    """Resolve a version inside the caller's tenant, or 404.

    This is the only tenancy gate in this module: domains, classes and paths are all reached
    through their version, so scoping the version scopes everything under it.

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


def _assert_domain_in_tenant(domain_id: str, tenant_id: str) -> Dict[str, Any]:
    """Load a live domain whose version belongs to the caller's tenant, or 404.

    Args:
        domain_id: The domain.
        tenant_id: The caller's tenant.

    Returns:
        The domain row.

    Raises:
        HTTPException: 404 when the domain is missing, deleted, or in another tenant.
    """
    domain = store.get_domain(db, domain_id=domain_id)
    if not domain:
        raise HTTPException(status_code=404, detail="Domain not found")
    _assert_version_in_tenant(str(domain["version_id"]), tenant_id)
    return domain


def _serialize(row: Dict[str, Any]) -> DomainSchema:
    """Project a domain row (or a synthetic shared bucket) onto the API shape."""
    return DomainSchema(
        id=str(row["id"]) if row.get("id") else None,
        version_id=str(row["version_id"]),
        name=row["name"],
        slug=row["slug"],
        sort_order=int(row.get("sort_order") or 0),
        virtual=bool(row.get("virtual", False)),
        created_at=str(row["created_at"]) if row.get("created_at") else None,
        updated_at=str(row["updated_at"]) if row.get("updated_at") else None,
    )


def _validate_slug(supplied: str) -> str:
    """Normalize and check a caller-supplied slug.

    Args:
        supplied: The slug as sent.

    Returns:
        The trimmed, lowercased slug.

    Raises:
        HTTPException: 400 when it is malformed or reserved.
    """
    slug = supplied.strip().lower()
    if not store.is_valid_slug(slug):
        raise HTTPException(
            status_code=400,
            detail=(
                "Slug must be lowercase letters, digits and single hyphens, and cannot be "
                "'shared' — that name is reserved for items with no domain."
            ),
        )
    return slug


def _derive_slug(name: str) -> str:
    """Derive a slug from a display name, for a create that supplied none.

    Args:
        name: The domain's display name.

    Returns:
        A slug the database's CHECK will accept.

    Raises:
        HTTPException: 400 when nothing usable can be derived — an all-punctuation name, or one
            that reduces to the reserved ``shared``.
    """
    derived = store.slugify(name)
    if derived is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Could not derive a slug from this name. Supply a slug of lowercase letters, "
                "digits and single hyphens."
            ),
        )
    return derived


def _assert_target_domain(domain_id: Optional[str], version_id: str, tenant_id: str) -> Optional[str]:
    """Validate a move's destination and return the value to store.

    ``None`` and ``"shared"`` both resolve to NULL — the derived bucket, always a legal
    destination. A real domain is checked to be live and in the *member's own* version here, so the
    caller gets a 404 naming the problem rather than the database's guard reaching them as a 500.

    Args:
        domain_id: Destination domain UUID, ``"shared"``, or None.
        version_id: The version the member being moved belongs to.
        tenant_id: The caller's tenant.

    Returns:
        The ``domain_id`` to store — None for ``shared/``.

    Raises:
        HTTPException: 404 when the destination is missing or in a different version.
    """
    resolved = store.resolve_domain_id(domain_id)
    if resolved is None:
        return None

    domain = _assert_domain_in_tenant(resolved, tenant_id)
    if str(domain["version_id"]) != str(version_id):
        raise HTTPException(
            status_code=404,
            detail="That domain belongs to a different version.",
        )
    return resolved


# ─── Domain CRUD ─────────────────────────────────────────────────────────────


@router.get("/{tenant_slug}/version/{version_id}", response_model=List[DomainSchema])
async def list_domains(
    tenant_slug: str,
    version_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> List[DomainSchema]:
    """List a version's domain folders in tree order, with ``shared/`` last.

    The synthetic ``shared/`` entry is always present, including for a version that has no domains
    at all — where it is the whole tree.
    """
    tenant_id = _tenant_id(auth_data)
    _assert_version_in_tenant(version_id, tenant_id)

    rows = store.list_domains(db, version_id=version_id)
    # Strictly past the highest explicit order, not merely `len(rows)`: sort orders are
    # caller-supplied and need not be dense, so a client re-sorting this list by `sort_order` would
    # otherwise pull `shared/` in among the real domains.
    last = max((int(row.get("sort_order") or 0) for row in rows), default=-1)
    shared = store.shared_bucket(version_id, last + 1)
    return [_serialize(row) for row in rows] + [_serialize(shared)]


@router.post("/{tenant_slug}/version/{version_id}", response_model=DomainSchema, status_code=201)
async def create_domain(
    tenant_slug: str,
    version_id: str,
    body: DomainCreateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> DomainSchema:
    """Create a domain folder in a version."""
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    tenant_id = _tenant_id(auth_data)
    _assert_version_in_tenant(version_id, tenant_id)

    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Domain name is required")

    slug = _validate_slug(body.slug) if body.slug is not None else _derive_slug(name)
    sort_order = (
        body.sort_order
        if body.sort_order is not None
        else store.next_sort_order(db, version_id=version_id)
    )

    try:
        row = store.create_domain(
            db, version_id=version_id, name=name, slug=slug, sort_order=sort_order
        )
    except store.DomainConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return _serialize(row)


@router.patch("/{tenant_slug}/{domain_id}", response_model=DomainSchema)
async def update_domain(
    tenant_slug: str,
    domain_id: str,
    body: DomainUpdateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> DomainSchema:
    """Rename or reorder a domain folder."""
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    tenant_id = _tenant_id(auth_data)
    _assert_domain_in_tenant(domain_id, tenant_id)

    name: Optional[str] = None
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Domain name cannot be empty")

    # A slug is only ever derived at creation. Renaming a domain must not silently move the URL its
    # slug forms, so changing one takes an explicit slug.
    slug = _validate_slug(body.slug) if body.slug is not None else None

    try:
        row = store.update_domain(
            db, domain_id=domain_id, name=name, slug=slug, sort_order=body.sort_order
        )
    except store.DomainConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None

    if row is None:
        raise HTTPException(status_code=404, detail="Domain not found")
    return _serialize(row)


@router.delete("/{tenant_slug}/{domain_id}")
async def delete_domain(
    tenant_slug: str,
    domain_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, Any]:
    """Delete a domain folder, moving its classes and paths to ``shared/``.

    Returns the number of members released, so the caller can report what moved rather than
    asserting that nothing was lost.
    """
    # EDIT rather than DELETE: this removes a folder, never its contents, and reorganizing a
    # version's tree is editing work. Gating it on "may delete a version" would stop an editor from
    # undoing a folder they had just been allowed to create.
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    tenant_id = _tenant_id(auth_data)
    domain = _assert_domain_in_tenant(domain_id, tenant_id)

    # Counted before the delete: afterwards these members are in shared/ and indistinguishable from
    # everything else that was already there.
    members = store.count_members(
        db, domain_id=domain_id, version_id=str(domain["version_id"])
    )

    if store.delete_domain(db, domain_id=domain_id) is None:
        raise HTTPException(status_code=404, detail="Domain not found")

    return {
        "success": True,
        "reassigned_to": store.SHARED_DOMAIN_ID,
        "classes_reassigned": members["class_count"],
        "paths_reassigned": members["path_count"],
    }


# ─── Membership ──────────────────────────────────────────────────────────────


@router.put("/{tenant_slug}/classes/{class_id}", response_model=DomainMemberSchema)
async def assign_class_domain(
    tenant_slug: str,
    class_id: str,
    body: DomainAssignmentRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> DomainMemberSchema:
    """Move a class into a domain, or into ``shared/`` with ``domain_id: null``."""
    enforce_permission(db, auth_data, Resource.CLASSES, Action.EDIT)
    tenant_id = _tenant_id(auth_data)

    member = store.get_class(db, class_id=class_id)
    if not member:
        raise HTTPException(status_code=404, detail="Class not found")
    _assert_version_in_tenant(str(member["version_id"]), tenant_id)

    target = _assert_target_domain(body.domain_id, str(member["version_id"]), tenant_id)

    try:
        row = store.assign_class(db, class_id=class_id, domain_id=target)
    except store.DomainScopeError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None

    if row is None:
        raise HTTPException(status_code=404, detail="Class not found")
    return DomainMemberSchema(
        id=str(row["id"]),
        version_id=str(row["version_id"]),
        name=row["name"],
        domain_id=str(row["domain_id"]) if row.get("domain_id") else None,
        kind="class",
    )


@router.put("/{tenant_slug}/paths/{path_id}", response_model=DomainMemberSchema)
async def assign_path_domain(
    tenant_slug: str,
    path_id: str,
    body: DomainAssignmentRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> DomainMemberSchema:
    """Move a path into a domain, or into ``shared/`` with ``domain_id: null``."""
    enforce_permission(db, auth_data, Resource.PATHS, Action.EDIT)
    tenant_id = _tenant_id(auth_data)

    member = store.get_path(db, path_id=path_id)
    if not member:
        raise HTTPException(status_code=404, detail="Path not found")
    _assert_version_in_tenant(str(member["version_id"]), tenant_id)

    target = _assert_target_domain(body.domain_id, str(member["version_id"]), tenant_id)

    try:
        row = store.assign_path(db, path_id=path_id, domain_id=target)
    except store.DomainScopeError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None

    if row is None:
        raise HTTPException(status_code=404, detail="Path not found")
    return DomainMemberSchema(
        id=str(row["id"]),
        version_id=str(row["version_id"]),
        name=row["pathname"],
        domain_id=str(row["domain_id"]) if row.get("domain_id") else None,
        kind="path",
    )

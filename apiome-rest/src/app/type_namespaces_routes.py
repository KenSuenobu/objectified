"""
Type-registry Namespace API Routes (#3451)

CRUD for type-registry namespaces over the existing ``apiome-db`` connection
(``apiome.type_namespaces``, whose ``namespace``/``base_uri`` columns mirror those on
``apiome.primitives``). All endpoints are tenant-scoped and authenticated via JWT or API key.

Scope rules (ROADMAP_TYPE_REGISTRY_GOVERNANCE.md §7 Issue 2.2):

* Tenant administrators create and update their tenant's namespaces.
* System-core (``std/*``) namespaces are platform-governed and read-only to tenant admins. The
  REST layer has no platform-admin role, so creating or modifying a system namespace through this
  API is rejected with 403 — system namespaces are seeded/curated out of band.
"""

import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException

from .auth import get_authenticated_user_id
from .database import db
from .feature_gating import require_primitives_registry
from .permissions import enforce_permission, Resource, Action
from .models import (
    RegistryCoverageStatsResponse,
    ResolvedPrimitiveRefs,
    ResolvedRefEdge,
    ResolveResponse,
    TypeNamespaceCreateRequest,
    TypeNamespaceSchema,
    TypeNamespaceUpdateRequest,
    TypeRegistrySettingsSchema,
    TypeRegistrySettingsUpdateRequest,
)
from .primitives_lookup import find_primitive_by_registry_uri
from .type_resolver import STATUS_RESOLVED, STATUS_UNRESOLVED, reresolve_edges

router = APIRouter(prefix="/v1/types", tags=["type-registry"])

# Registry root every base URI hangs off (matches the seeded std/v0 primitives, #3449).
REGISTRY_BASE_URL = "https://api.apiome.dev/types/"

# A namespace path is one or more lowercase, slash-separated segments (letters, digits, _ and -).
# e.g. std/v0/types, tenant/acme/v1/payments, vendor/fhir/r4.
_NAMESPACE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)*$")
# A version-root segment: a 'v' followed by digits (v0, v1, v2, ...).
_VERSION_SEGMENT_RE = re.compile(r"^v[0-9]+$")


def _assert_jwt_user(auth_data: Dict[str, Any]) -> str:
    """Require a resolvable acting user (JWT, or an API key mapped to a tenant user)."""
    uid = get_authenticated_user_id(auth_data)
    if not uid:
        raise HTTPException(
            status_code=403, detail="Authenticated user required for this operation"
        )
    return uid


def _assert_tenant_admin(tenant_id: str, user_id: str) -> None:
    """Require the acting user to be an administrator of the tenant."""
    if not db.is_user_tenant_admin(tenant_id, user_id):
        raise HTTPException(status_code=403, detail="Tenant administrator role required")


def _normalize_namespace(raw: str) -> str:
    """Validate and normalize a namespace path, raising 400 on a malformed value."""
    namespace = (raw or "").strip().strip("/")
    if not namespace or not _NAMESPACE_RE.match(namespace):
        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid namespace. Use lowercase slash-separated segments of letters, digits, "
                "'_' or '-' (e.g. tenant/acme/v1/types)."
            ),
        )
    return namespace


def _derive_version_root(namespace: str) -> Optional[str]:
    """Return the first ``vN`` segment of a namespace path, if any (e.g. std/v0/types -> v0)."""
    for segment in namespace.split("/"):
        if _VERSION_SEGMENT_RE.match(segment):
            return segment
    return None


def _to_schema(row: Dict[str, Any]) -> TypeNamespaceSchema:
    """Map an ``apiome.type_namespaces`` row (with type_count) to its API model."""
    is_system = bool(row.get("is_system"))
    tenant_id = row.get("tenant_id")
    return TypeNamespaceSchema(
        id=str(row["id"]),
        tenant_id=str(tenant_id) if tenant_id is not None else None,
        namespace=row["namespace"],
        base_uri=row["base_uri"],
        version_root=row.get("version_root"),
        description=row.get("description"),
        scope="system" if is_system else "tenant",
        is_system=is_system,
        is_public=bool(row.get("is_public")),
        is_default=bool(row.get("is_default")),
        type_count=int(row.get("type_count") or 0),
        created_by=str(row["created_by"]) if row.get("created_by") is not None else None,
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


@router.get("/{tenant_slug}/stats", response_model=RegistryCoverageStatsResponse)
async def get_registry_coverage_stats(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry),
) -> RegistryCoverageStatsResponse:
    """Return aggregate registry coverage KPIs for the Primitives overview (#3454).

    Counts core vs tenant types, imported schemas, property bindings, unresolved ``$ref``
    edges, and distinct namespaces. Feeds the Governance → Primitives KPI strip (#3467).

    Args:
        tenant_slug: The tenant slug.
        auth_data: Authentication data (injected by dependency).

    Returns:
        ``RegistryCoverageStatsResponse`` with the tenant's registry coverage counts.
    """
    stats = db.get_registry_coverage_stats(auth_data["tenant_id"])
    return RegistryCoverageStatsResponse(**stats)


@router.get("/{tenant_slug}/namespaces")
async def list_namespaces(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry),
) -> List[TypeNamespaceSchema]:
    """List namespaces visible to the tenant: system-core (``std/*``) plus the tenant's own.

    Args:
        tenant_slug: The tenant slug (caller scope comes from the authenticated token).
        auth_data: Authentication data (injected by dependency).

    Returns:
        Namespaces (system-core first, then alphabetical), each with its tenant-scoped type count.
    """
    rows = db.list_type_namespaces(auth_data["tenant_id"])
    return [_to_schema(r) for r in rows]


@router.post("/{tenant_slug}/namespaces")
async def create_namespace(
    tenant_slug: str,
    request: TypeNamespaceCreateRequest,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry),
) -> TypeNamespaceSchema:
    """Create a namespace.

    A tenant administrator may create a tenant-scoped namespace. Creating a system-core namespace
    requires a platform admin, which this API does not expose, so ``scope='system'`` is rejected
    with 403 — system namespaces are read-only here.

    Args:
        tenant_slug: The tenant slug.
        request: Namespace creation data.
        auth_data: Authentication data (injected by dependency).

    Returns:
        The created namespace.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.CREATE)
    tenant_id = auth_data["tenant_id"]
    user_id = _assert_jwt_user(auth_data)
    _assert_tenant_admin(tenant_id, user_id)

    if request.scope == "system":
        raise HTTPException(
            status_code=403,
            detail="Platform administrator role required to manage system namespaces",
        )

    namespace = _normalize_namespace(request.namespace)

    # The std/* root is reserved for platform-curated system-core namespaces; a tenant may not
    # create one there (it would shadow / squat the shared core layer).
    if namespace == "std" or namespace.startswith("std/"):
        raise HTTPException(
            status_code=403,
            detail="The 'std/' namespace root is reserved for platform system-core namespaces",
        )

    # Reject a duplicate within the tenant's scope up front for a clean 409 (the partial unique
    # index is the backstop for races).
    if db.get_type_namespace_by_path(namespace, tenant_id, is_system=False):
        raise HTTPException(
            status_code=409,
            detail=f"Namespace '{namespace}' already exists for this tenant",
        )

    base_uri = (request.base_uri or "").strip() or f"{REGISTRY_BASE_URL}{namespace}/"
    version_root = request.version_root or _derive_version_root(namespace)

    try:
        row = db.create_type_namespace(
            namespace=namespace,
            base_uri=base_uri,
            tenant_id=tenant_id,
            version_root=version_root,
            description=request.description,
            is_system=False,
            # Tenant namespaces are private to the tenant (scope-isolation rule); never public.
            is_public=False,
            is_default=bool(request.is_default),
            created_by=user_id,
        )
    except Exception as e:  # pragma: no cover - exercised via unique-violation test
        if "unique" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail=f"Namespace '{namespace}' already exists for this tenant",
            )
        raise HTTPException(status_code=500, detail=str(e))

    return _to_schema(row)


@router.put("/{tenant_slug}/namespaces/{namespace_id}")
async def update_namespace(
    tenant_slug: str,
    namespace_id: str,
    request: TypeNamespaceUpdateRequest,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry),
) -> TypeNamespaceSchema:
    """Update a tenant namespace's base URI, version root, description, visibility, or default flag.

    The namespace path itself is immutable (it links the namespace to its primitives). System-core
    namespaces are read-only and return 403.

    Args:
        tenant_slug: The tenant slug.
        namespace_id: The namespace row id.
        request: Namespace update data.
        auth_data: Authentication data (injected by dependency).

    Returns:
        The updated namespace.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.EDIT)
    tenant_id = auth_data["tenant_id"]
    user_id = _assert_jwt_user(auth_data)
    _assert_tenant_admin(tenant_id, user_id)

    existing = db.get_type_namespace_by_id(namespace_id, tenant_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"Namespace not found: {namespace_id}")

    if existing.get("is_system"):
        raise HTTPException(
            status_code=403,
            detail="System namespaces are read-only; platform administrator role required",
        )

    updates = request.model_dump(exclude_unset=True)
    if "base_uri" in updates and updates["base_uri"] is not None:
        base_uri = str(updates["base_uri"]).strip()
        if not base_uri:
            raise HTTPException(status_code=400, detail="base_uri may not be empty")
        updates["base_uri"] = base_uri

    try:
        row = db.update_type_namespace(namespace_id, tenant_id, updates)
    except Exception as e:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=str(e))

    if not row:
        raise HTTPException(status_code=404, detail=f"Namespace not found: {namespace_id}")

    return _to_schema(row)


@router.delete("/{tenant_slug}/namespaces/{namespace_id}")
async def delete_namespace(
    tenant_slug: str,
    namespace_id: str,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry),
) -> Dict[str, Any]:
    """Remove a tenant namespace registration.

    The namespace list is referential: ``apiome.primitives.namespace`` is a string column with no
    foreign key to ``apiome.type_namespaces``, so this unregisters the namespace and leaves its
    types untouched. They keep their namespace path and surface as "unregistered" on the Primitives
    dashboard, from which the namespace can be registered again. ``type_count`` is returned so the
    caller can report how many types are now unregistered.

    System-core namespaces are read-only and return 403.

    Args:
        tenant_slug: The tenant slug.
        namespace_id: The namespace row id.
        auth_data: Authentication data (injected by dependency).

    Returns:
        The deleted namespace's path and the number of types left unregistered.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.DELETE)
    tenant_id = auth_data["tenant_id"]
    user_id = _assert_jwt_user(auth_data)
    _assert_tenant_admin(tenant_id, user_id)

    existing = db.get_type_namespace_by_id(namespace_id, tenant_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"Namespace not found: {namespace_id}")

    if existing.get("is_system"):
        raise HTTPException(
            status_code=403,
            detail="System namespaces are read-only; platform administrator role required",
        )

    try:
        deleted = db.delete_type_namespace(namespace_id, tenant_id)
    except Exception as e:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=str(e))

    if not deleted:
        raise HTTPException(status_code=404, detail=f"Namespace not found: {namespace_id}")

    return {
        "success": True,
        "namespace": existing["namespace"],
        "unregistered_type_count": int(existing.get("type_count") or 0),
    }


def _settings_to_schema(row: Dict[str, Any]) -> TypeRegistrySettingsSchema:
    """Map a persisted ``apiome.type_registry_settings`` row to its API model.

    A persisted row is, by definition, not the defaults, so ``is_default`` is False.
    """
    return TypeRegistrySettingsSchema(
        default_draft=row["default_draft"],
        strict_validation=bool(row["strict_validation"]),
        allow_annotation_keywords=bool(row["allow_annotation_keywords"]),
        coerce_imported_drafts=bool(row["coerce_imported_drafts"]),
        resolution_base_url=row["resolution_base_url"],
        ref_style=row["ref_style"],
        allow_remote_refs=bool(row["allow_remote_refs"]),
        remote_host_allowlist=list(row.get("remote_host_allowlist") or []),
        max_resolution_depth=int(row["max_resolution_depth"]),
        circular_ref_policy=row["circular_ref_policy"],
        default_import_scope=row["default_import_scope"],
        default_target_namespace=row.get("default_target_namespace"),
        rewrite_refs_on_import=bool(row["rewrite_refs_on_import"]),
        accepted_formats=list(row.get("accepted_formats") or []),
        dedupe_identical_types=bool(row["dedupe_identical_types"]),
        validate_on_save=bool(row["validate_on_save"]),
        block_publish_on_errors=bool(row["block_publish_on_errors"]),
        core_publish_role=row["core_publish_role"],
        is_default=False,
        updated_by=str(row["updated_by"]) if row.get("updated_by") is not None else None,
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


@router.get("/{tenant_slug}/settings", response_model=TypeRegistrySettingsSchema)
async def get_registry_settings(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry),
) -> TypeRegistrySettingsSchema:
    """Return the tenant's type-registry settings (#3472).

    Serves the saved row when one exists. A tenant that has never saved settings receives the
    model defaults with ``is_default = true`` (a pure read never materializes a row), so the
    Settings UI always has a complete, effective configuration to render.

    Args:
        tenant_slug: The tenant slug (caller scope comes from the authenticated token).
        auth_data: Authentication data (injected by dependency).

    Returns:
        The tenant's effective type-registry settings.
    """
    row = db.get_type_registry_settings(auth_data["tenant_id"])
    if not row:
        # No saved row yet — return the defaults, flagged so the UI can show "using defaults".
        return TypeRegistrySettingsSchema()
    return _settings_to_schema(row)


@router.put("/{tenant_slug}/settings", response_model=TypeRegistrySettingsSchema)
async def update_registry_settings(
    tenant_slug: str,
    request: TypeRegistrySettingsUpdateRequest,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry),
) -> TypeRegistrySettingsSchema:
    """Save the tenant's type-registry settings (#3472).

    Tenant-administrator only. The request may be partial — omitted fields keep their current
    persisted value (or the table default on the first save). Enum and range validation happens
    on the request model, so an invalid value is rejected with 422 before the upsert. The saved
    settings become the source of truth the resolver and the validation gate (#3479) read.

    Args:
        tenant_slug: The tenant slug.
        request: The settings to persist (partial allowed).
        auth_data: Authentication data (injected by dependency).

    Returns:
        The full persisted settings after the write.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.EDIT)
    tenant_id = auth_data["tenant_id"]
    user_id = _assert_jwt_user(auth_data)
    _assert_tenant_admin(tenant_id, user_id)

    updates = request.model_dump(exclude_unset=True)

    # A non-empty base URL is required when supplied; an empty string would break $ref resolution.
    if "resolution_base_url" in updates:
        base = (updates["resolution_base_url"] or "").strip()
        if not base:
            raise HTTPException(status_code=400, detail="resolution_base_url may not be empty")
        updates["resolution_base_url"] = base

    try:
        row = db.upsert_type_registry_settings(tenant_id, updates, updated_by=user_id)
    except Exception as e:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=str(e))

    return _settings_to_schema(row)


@router.post("/{tenant_slug}/resolve", response_model=ResolveResponse)
async def resolve_refs(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry),
) -> ResolveResponse:
    """Re-resolve the tenant's ``$ref`` edges and return the dependency listing (#3459).

    The resolver API for the UI and Designer (#3470). It walks every primitive visible to
    the tenant (system-core ∪ own), re-evaluates each stored dependency edge's
    resolved/unresolved status against the *current* registry — so a target created since
    the edge was last computed now resolves, and a deleted one now dangles — and persists
    the refreshed edges for any of the tenant's own primitives whose status changed
    ("re-resolve updates statuses"). Each resolved edge is enriched with its dependency
    target's id and name so the response is the dependency graph the resolver UI lists.

    Only primitives that carry at least one ``$ref`` edge appear in ``primitives``; the
    flat system-core seed (no refs) is omitted. System-core rows are read-only, so a status
    change on one is reflected in the response but never written back.

    Args:
        tenant_slug: The tenant slug (caller scope comes from the authenticated token).
        auth_data: Authentication data (injected by dependency).

    Returns:
        ``ResolveResponse`` with tenant-wide edge counts, the number of primitives whose
        stored statuses were updated by this pass, and the per-primitive dependency listing.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.VIEW)
    tenant_id = auth_data["tenant_id"]
    primitives = db.get_primitives_for_tenant(tenant_id)

    # Each distinct target $id is resolved once and reused across every edge that points at
    # it (a target is commonly shared by many dependents); the cache also dedupes the
    # repeated misses for a still-missing target.
    target_cache: Dict[str, Optional[Dict[str, Any]]] = {}

    def _target_lookup(schema_id: str) -> Optional[Dict[str, Any]]:
        # Placement-aware (local-only): a stored edge's target is a local registry URI, and
        # the type answering to it may carry a foreign author-declared ``$id`` — it is still
        # found at its namespace + name.
        if schema_id not in target_cache:
            target_cache[schema_id] = find_primitive_by_registry_uri(db, schema_id, tenant_id)
        return target_cache[schema_id]

    listing: List[ResolvedPrimitiveRefs] = []
    ref_count = 0
    resolved_ref_count = 0
    unresolved_ref_count = 0
    affected_primitive_count = 0
    reresolved_primitive_count = 0

    for prim in primitives:
        stored_edges = prim.get("refs") or []
        if not stored_edges:
            continue  # No dependency edges — nothing to resolve or list.

        persisted, dependencies, changed = reresolve_edges(stored_edges, _target_lookup)

        # Persist the refreshed statuses for the tenant's own writable rows. System-core
        # rows are read-only (and flat, so they never change); skip writing those.
        if changed and not prim.get("is_system"):
            db.update_primitive(str(prim["id"]), tenant_id, {"refs": persisted})
            reresolved_primitive_count += 1

        resolved = sum(1 for e in persisted if e["status"] == STATUS_RESOLVED)
        unresolved = sum(1 for e in persisted if e["status"] == STATUS_UNRESOLVED)
        ref_count += len(persisted)
        resolved_ref_count += resolved
        unresolved_ref_count += unresolved
        if unresolved:
            affected_primitive_count += 1

        listing.append(
            ResolvedPrimitiveRefs(
                id=str(prim["id"]),
                name=prim["name"],
                schema_id=prim.get("schema_id"),
                namespace=prim.get("namespace"),
                base_uri=prim.get("base_uri"),
                ref_count=len(persisted),
                resolved_count=resolved,
                unresolved_count=unresolved,
                refs=[ResolvedRefEdge(**edge) for edge in dependencies],
            )
        )

    return ResolveResponse(
        total_primitives=len(listing),
        ref_count=ref_count,
        resolved_ref_count=resolved_ref_count,
        unresolved_ref_count=unresolved_ref_count,
        affected_primitive_count=affected_primitive_count,
        reresolved_primitive_count=reresolved_primitive_count,
        primitives=listing,
    )

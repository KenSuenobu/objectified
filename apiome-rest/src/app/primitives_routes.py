"""
Primitives API Routes

Provides CRUD endpoints for managing primitive type definitions.
All endpoints are tenant-scoped and require authentication via JWT token or API key.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from .auth import get_authenticated_user_id, validate_authentication
from .feature_gating import require_primitives_registry
from .database import db
from .permissions import enforce_permission, Resource, Action
from .import_ingestion import IngestionError, ingest_source
from .import_pipeline import VALID_SOURCE_KINDS, build_staged_import
from .models import (
    PrimitiveCreateRequest,
    PrimitiveImportRecord,
    PrimitiveImportRequest,
    PrimitiveImportStageRequest,
    PrimitiveImportStageResult,
    PrimitiveSchema,
    PrimitiveUpdateRequest,
    RegistryHealthResponse,
    UnresolvedRefPrimitive,
    UnresolvedRefsResponse,
)
from .primitives_bundle import (
    BundleError,
    parse_type_def_bundle,
)
from .primitives_resolver import build_ref_edges
from .primitives_review import (
    ACTION_RENAME,
    STATUS_INVALID,
    VALID_ACTIONS,
    allowed_resolutions,
    classify_status,
    decide,
)
from .primitives_rewrite import rewrite_import_schema
from .registry_audit import (
    ACTION_CREATE,
    ACTION_DELETE,
    ACTION_IMPORT,
    ACTION_UPDATE,
    OUTCOME_FAILURE,
    OUTCOME_SUCCESS,
    record_registry_audit,
)
from .primitives_scope import (
    ScopeViolationError,
    enforce_ref_scope,
    is_core_namespace,
    tenant_segment_of,
)
from .schema_validation import (
    REGISTRY_BASE_URL,
    SchemaValidationError,
    derive_base_uri,
    derive_draft,
    derive_schema_id,
    stamp_identity,
    validate_schema_document,
)

router = APIRouter(prefix="/v1/primitives", tags=["primitives"])

# Allowed import source shapes — must match the apiome.primitive_imports CHECK
# constraint. Sourced from the pipeline so the staging and legacy paths agree.
VALID_IMPORT_SOURCE_KINDS = VALID_SOURCE_KINDS


def _schema_validation_http_error(errors: List[Dict[str, str]]) -> HTTPException:
    """Build the 422 response for a JSON Schema that fails draft 2020-12 validation (#3452).

    Args:
        errors: Field-level errors from ``schema_validation.validate_schema_document``.

    Returns:
        An ``HTTPException`` whose detail carries a human message plus the structured,
        field-level ``errors`` list so clients can highlight the offending keywords.
    """
    return HTTPException(
        status_code=422,
        detail={
            "message": "Schema is not a valid JSON Schema draft 2020-12 document",
            "errors": errors,
        },
    )


def _scope_violation_http_error(error: ScopeViolationError) -> HTTPException:
    """Build the 422 response for a ``$ref`` that crosses a forbidden scope boundary (#3453).

    Args:
        error: The raised scope violation, carrying its per-ref ``violations`` list.

    Returns:
        An ``HTTPException`` whose detail carries a human message plus the
        structured ``violations`` so clients can highlight the offending ``$ref``.
    """
    return HTTPException(
        status_code=422,
        detail={
            "message": error.message,
            "violations": error.violations,
        },
    )


def resolve_primitive_refs(
    schema: Dict[str, Any], *, base_uri: str, tenant_id: str
) -> List[Dict[str, str]]:
    """Resolve a primitive's relative ``$ref`` edges against the registry (#3456).

    Walks the schema's ``$ref`` values, resolves each against ``base_uri``, and marks
    each edge ``resolved`` / ``unresolved`` by looking the target ``$id`` up in the
    tenant's read scope (system-core ∪ tenant), so resolution honors scope (#3453).

    Args:
        schema: The identity-stamped JSON Schema document of the source primitive.
        base_uri: The source primitive's base URI (relative refs resolve against it).
        tenant_id: The caller's tenant id, scoping target lookups.

    Returns:
        The ``{relative_ref, resolved_target, status}`` edge list to persist on
        ``apiome.primitives.refs``.
    """
    def _target_exists(absolute_uri: str) -> bool:
        return db.get_primitive_by_schema_id(absolute_uri, tenant_id) is not None

    return build_ref_edges(schema, base_uri=base_uri, target_exists=_target_exists)


def reconcile_dependents_for_target(schema_id: Optional[str], *, tenant_id: str) -> None:
    """Re-resolve the tenant's dangling edges that point at a now-existing target (#3457).

    The "fixing target clears on re-resolve" half of the acceptance criteria. When a
    primitive is created/imported (or repinned to a new ``$id``), any of the tenant's
    other primitives that held an *unresolved* edge aimed at that ``$id`` are cleared to
    ``resolved`` in place — no manual re-save of the dependent is required. Resolution is
    best-effort: a failure here must not fail the create/update that triggered it (the
    primitive is already persisted), so it is swallowed rather than surfaced.

    Args:
        schema_id: The ``$id`` of the just-persisted primitive (no-op when ``None``).
        tenant_id: The tenant whose dependents may reference the target.
    """
    if not schema_id:
        return
    try:
        db.mark_refs_resolved_to_target(tenant_id, schema_id)
    except Exception:
        # Reconciliation is a convenience pass over already-correct data; the dependent's
        # edge will also re-resolve the next time it is saved or re-resolved explicitly.
        pass


def load_publish_gate(tenant_id: str) -> tuple[bool, bool]:
    """Load a tenant's publish/save validation-gate flags (#3479).

    Reads the persisted type-registry settings (#3472) and returns the two toggles the
    create/update paths consult before persisting a primitive. A tenant that has never
    saved settings has no row; the registry defaults (gate fully on) apply, matching the
    strict behavior shipped before this gate existed.

    Args:
        tenant_id: The caller's tenant id.

    Returns:
        A ``(validate_on_save, block_publish_on_errors)`` tuple.
    """
    row = db.get_type_registry_settings(tenant_id)
    if not row:
        return True, True
    return (
        bool(row.get("validate_on_save", True)),
        bool(row.get("block_publish_on_errors", True)),
    )


def resolve_primitive_identity(
    schema: Dict[str, Any],
    *,
    name: str,
    namespace: Optional[str],
    base_uri: Optional[str],
    tenant_slug: str,
    is_system: bool = False,
    validate: bool = True,
    block_on_errors: bool = True,
) -> Dict[str, Any]:
    """Validate a schema and derive its persisted JSON Schema 2020-12 identity (#3452).

    Shared by the create, update, and import paths so all three reject invalid schemas
    identically and compute a stable ``$id`` the same way.

    The ``validate`` / ``block_on_errors`` flags implement the per-tenant publish/save gate
    (#3479): they govern only the draft 2020-12 *meta-schema* check. Structural reachability
    (the schema must be a JSON object to carry a derived ``$id``) and cross-tenant ``$ref``
    scope enforcement (#3453, a security boundary) are always applied regardless of the gate.

    Args:
        schema: The candidate JSON Schema document.
        name: The primitive name (drives the derived ``$id`` leaf).
        namespace: Optional registry namespace path.
        base_uri: Optional explicit base URI (wins over ``namespace``).
        tenant_slug: The tenant slug (used for the default base URI).
        is_system: Whether the primitive is system-core. Core types are held to the
            stricter reference-direction rule (they may not ``$ref`` a tenant
            namespace). A namespace under ``std/`` is also treated as core (#3453).
        validate: When True (the ``validate_on_save`` setting), run the draft 2020-12
            meta-schema check. When False the check is skipped entirely.
        block_on_errors: When True (the ``block_publish_on_errors`` setting), meta-schema
            errors abort with :class:`SchemaValidationError`. When False the (invalid)
            schema is persisted anyway; the gate is advisory only.

    Returns:
        A dict with ``schema`` (identity-stamped copy), ``schema_id``, ``draft``,
        and ``base_uri``.

    Raises:
        SchemaValidationError: If ``schema`` is not a JSON object (always), or — when
            ``validate`` and ``block_on_errors`` are both set — if it is not a valid
            draft 2020-12 document.
        ScopeViolationError: If a ``$ref`` crosses a forbidden scope boundary
            (core→tenant, or tenant→other-tenant) (#3453).
    """
    if not isinstance(schema, dict):
        # A non-object (e.g. boolean) schema can never carry a derived ``$id`` and cannot be
        # stored as a primitive row, so this is fatal even when the gate is relaxed.
        raise SchemaValidationError(
            [{"path": "(root)", "message": "Schema must be a JSON object", "keyword": "type"}]
        )

    if validate and block_on_errors:
        errors = validate_schema_document(schema)
        if errors:
            raise SchemaValidationError(errors)

    resolved_base = derive_base_uri(namespace, base_uri, tenant_slug)
    schema_id = derive_schema_id(schema, name=name, base_uri=resolved_base)
    draft = derive_draft(schema)

    # Centralized scope/visibility enforcement (#3453): a core type may not reference a
    # tenant namespace, and a tenant type may not reference another tenant's namespace.
    # Core-ness comes from the explicit flag or a std/* placement; the owning tenant is
    # derived from the resolved base URI (e.g. .../types/tenant/acme/... -> tenant/acme).
    base_path = (
        resolved_base[len(REGISTRY_BASE_URL):]
        if resolved_base.startswith(REGISTRY_BASE_URL)
        else None
    )
    is_core = is_system or is_core_namespace(namespace) or is_core_namespace(base_path)
    own_tenant_segment = None if is_core else tenant_segment_of(base_path)
    enforce_ref_scope(
        schema,
        is_core=is_core,
        base_uri=resolved_base,
        own_tenant_segment=own_tenant_segment,
    )

    stamped = stamp_identity(schema, schema_id=schema_id, draft=draft)
    return {
        "schema": stamped,
        "schema_id": schema_id,
        "draft": draft,
        "base_uri": resolved_base,
    }


@router.get("/health", response_model=RegistryHealthResponse)
async def registry_health() -> RegistryHealthResponse:
    """
    Health/ping for the Primitives type-registry layer (#3450).

    Reports whether the registry's storage backend — the shared
    ``apiome-db`` connection backing ``apiome.primitives`` — is reachable.
    Like the global ``/health`` endpoint this is intentionally anonymous so
    monitors can probe the registry layer without credentials; every data
    access endpoint below remains authenticated and tenant-scoped.

    Registered before ``GET /{tenant_slug}`` so the literal ``health`` path is
    matched here rather than being captured as a tenant slug.

    Returns:
        Registry health: overall ``status``, the ``apiome-db``
        ``connection`` state, and whether the ``apiome.primitives`` storage table
        is present. On failure ``status`` is ``unhealthy`` and ``error`` carries
        the driver message; the endpoint itself still responds 200 so the probe
        is always reachable (mirrors the global ``/health`` contract).
    """
    try:
        probe = db.registry_ping()
        return RegistryHealthResponse(
            status="healthy",
            connection=probe["connection"],
            storage_present=probe["storage_present"],
        )
    except Exception as e:
        return RegistryHealthResponse(
            status="unhealthy",
            connection="disconnected",
            storage_present=False,
            error=str(e),
        )


def determine_category_from_schema(schema: Dict[str, Any]) -> str:
    """
    Determine the category for a JSON Schema definition.

    Handles schemas with:
    - type: Direct type specification
    - anyOf/oneOf: Union types, infers from const values
    - allOf: Intersection types
    - enum: Enumeration values
    - const: Single constant value

    Args:
        schema: The JSON Schema definition

    Returns:
        The category string (e.g., 'string', 'number', 'object')
    """
    # If type is explicitly set, use it
    if 'type' in schema:
        schema_type = schema['type']
        if isinstance(schema_type, str):
            return schema_type
        if isinstance(schema_type, list) and len(schema_type) > 0:
            return schema_type[0]

    # For anyOf/oneOf with const values, infer type from the first const
    for key in ('anyOf', 'oneOf'):
        if key in schema:
            options = schema[key]
            if isinstance(options, list) and len(options) > 0:
                first_option = options[0]
                if isinstance(first_option, dict) and 'const' in first_option:
                    const_value = first_option['const']
                    if isinstance(const_value, str):
                        return 'string'
                    elif isinstance(const_value, bool):
                        return 'boolean'
                    elif isinstance(const_value, int):
                        return 'integer'
                    elif isinstance(const_value, float):
                        return 'number'

    # For enum, check the type of the first value
    if 'enum' in schema:
        enum_values = schema['enum']
        if isinstance(enum_values, list) and len(enum_values) > 0:
            first_value = enum_values[0]
            if isinstance(first_value, str):
                return 'string'
            elif isinstance(first_value, bool):
                return 'boolean'
            elif isinstance(first_value, int):
                return 'integer'
            elif isinstance(first_value, float):
                return 'number'

    # For const, check its type
    if 'const' in schema:
        const_value = schema['const']
        if isinstance(const_value, str):
            return 'string'
        elif isinstance(const_value, bool):
            return 'boolean'
        elif isinstance(const_value, int):
            return 'integer'
        elif isinstance(const_value, float):
            return 'number'

    # Default to object
    return 'object'


@router.get("/{tenant_slug}")
async def list_primitives(
    tenant_slug: str,
    category: Optional[str] = Query(None, description="Filter by category"),
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> List[PrimitiveSchema]:
    """
    List all primitives for a tenant.

    Supports authentication via:
    - JWT token in Authorization header (Bearer token)
    - API key in X-API-Key header

    Args:
        tenant_slug: The tenant slug
        category: Optional category filter
        auth_data: Authentication data (injected by dependency)

    Returns:
        List of primitives for the tenant
    """
    # Get primitives
    primitives = db.get_primitives_for_tenant(auth_data['tenant_id'], category)

    return [PrimitiveSchema(**p) for p in primitives]


@router.get("/{tenant_slug}/imports")
async def list_primitive_imports(
    tenant_slug: str,
    limit: int = Query(50, ge=1, le=500, description="Max number of records to return"),
    auth_data: Dict[str, Any] = Depends(require_primitives_registry)
) -> List[PrimitiveImportRecord]:
    """
    List primitive import provenance records for a tenant, newest first (#3448).

    Registered before GET /{tenant_slug}/{primitive_id} so the literal `imports`
    path is not captured as a primitive id.

    Args:
        tenant_slug: The tenant slug
        limit: Maximum number of records to return
        auth_data: Authentication data (injected by dependency)

    Returns:
        The tenant's import provenance records.
    """
    records = db.get_primitive_imports(auth_data['tenant_id'], limit)
    return [PrimitiveImportRecord(**r) for r in records]


@router.get("/{tenant_slug}/imports/{import_id}")
async def get_primitive_import(
    tenant_slug: str,
    import_id: str,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry)
) -> PrimitiveImportRecord:
    """
    Get a single primitive import provenance record, including its report JSON (#3448).

    Args:
        tenant_slug: The tenant slug
        import_id: The import provenance record id
        auth_data: Authentication data (injected by dependency)

    Returns:
        The provenance record with its full options/report payload.
    """
    record = db.get_primitive_import_by_id(import_id, auth_data['tenant_id'])
    if not record:
        raise HTTPException(
            status_code=404,
            detail=f"Import record not found: {import_id}"
        )
    return PrimitiveImportRecord(**record)


@router.get("/{tenant_slug}/unresolved", response_model=UnresolvedRefsResponse)
async def list_unresolved_refs(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry)
) -> UnresolvedRefsResponse:
    """Report the tenant's unresolved relative-``$ref`` edges and counts (#3457).

    A primitive's relative ``$ref`` values are resolved to registry edges on save/import
    and flagged ``resolved`` / ``unresolved`` (#3456). This endpoint aggregates the
    unresolved ones: the two top-level counts feed the registry coverage/stats KPIs
    (#3454), and ``primitives`` is the per-primitive breakdown — each with only its
    unresolved edges — the resolver UI lists (#3470).

    Registered before ``GET /{tenant_slug}/{primitive_id}`` so the literal ``unresolved``
    path is matched here rather than being captured as a primitive id.

    Args:
        tenant_slug: The tenant slug.
        auth_data: Authentication data (injected by dependency).

    Returns:
        ``UnresolvedRefsResponse`` with the total unresolved-edge count, the number of
        affected primitives, and the per-primitive unresolved-edge breakdown.
    """
    tenant_id = auth_data['tenant_id']
    counts = db.count_unresolved_refs(tenant_id)
    rows = db.get_primitives_with_unresolved_refs(tenant_id)

    primitives: List[UnresolvedRefPrimitive] = []
    for row in rows:
        unresolved = [
            edge for edge in (row.get('refs') or [])
            if edge.get('status') == 'unresolved'
        ]
        primitives.append(
            UnresolvedRefPrimitive(
                id=str(row['id']),
                name=row['name'],
                schema_id=row.get('schema_id'),
                namespace=row.get('namespace'),
                base_uri=row.get('base_uri'),
                unresolved_count=len(unresolved),
                unresolved_refs=unresolved,
            )
        )

    return UnresolvedRefsResponse(
        unresolved_ref_count=counts['unresolved_ref_count'],
        affected_primitive_count=counts['affected_primitive_count'],
        primitives=primitives,
    )


@router.get("/{tenant_slug}/{primitive_id}")
async def get_primitive(
    tenant_slug: str,
    primitive_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> PrimitiveSchema:
    """
    Get a specific primitive by ID.

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        primitive_id: The primitive ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        The primitive details
    """
    # Get primitive
    primitive = db.get_primitive_by_id(primitive_id, auth_data['tenant_id'])

    if not primitive:
        raise HTTPException(
            status_code=404,
            detail=f"Primitive not found: {primitive_id}"
        )

    return PrimitiveSchema(**primitive)


@router.post("/{tenant_slug}")
async def create_primitive(
    tenant_slug: str,
    request: PrimitiveCreateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> PrimitiveSchema:
    """
    Create a new primitive.

    Supports authentication via JWT token or API key.
    When using JWT, the created_by field will be set to the authenticated user.

    Args:
        tenant_slug: The tenant slug
        request: Primitive creation data
        auth_data: Authentication data (injected by dependency)

    Returns:
        The created primitive
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.CREATE)
    # Server-side draft 2020-12 validation + stable $id derivation (#3452), gated by the
    # tenant's publish/save settings (#3479): block invalid schemas only when the gate is on.
    validate_on_save, block_on_errors = load_publish_gate(auth_data['tenant_id'])
    try:
        identity = resolve_primitive_identity(
            request.schema,
            name=request.name,
            namespace=request.namespace,
            base_uri=request.base_uri,
            tenant_slug=tenant_slug,
            validate=validate_on_save,
            block_on_errors=block_on_errors,
        )
    except SchemaValidationError as e:
        raise _schema_validation_http_error(e.errors)
    except ScopeViolationError as e:
        raise _scope_violation_http_error(e)

    # Resolve relative $ref edges against the registry and persist them (#3456).
    refs = resolve_primitive_refs(
        identity['schema'], base_uri=identity['base_uri'], tenant_id=auth_data['tenant_id']
    )

    try:
        # Get user_id from auth data (will be None for API key auth)
        created_by = get_authenticated_user_id(auth_data)

        # Create primitive
        primitive = db.create_primitive(
            tenant_id=auth_data['tenant_id'],
            name=request.name,
            category=request.category,
            schema=identity['schema'],
            description=request.description,
            tags=request.tags,
            created_by=created_by,
            schema_id=identity['schema_id'],
            draft=identity['draft'],
            namespace=request.namespace,
            base_uri=identity['base_uri'],
            refs=refs,
        )

        # This new type may be the target of other primitives' dangling refs — clear
        # their unresolved flag now that it exists (#3457).
        reconcile_dependents_for_target(
            identity['schema_id'], tenant_id=auth_data['tenant_id']
        )

        # Record the governed create in the registry audit log (#3481).
        record_registry_audit(
            db,
            auth_data,
            ACTION_CREATE,
            primitive_id=str(primitive['id']),
            schema_id=identity['schema_id'],
            namespace=request.namespace,
            detail={
                "name": request.name,
                "category": request.category,
                "draft": identity['draft'],
            },
        )

        return PrimitiveSchema(**primitive)
    except HTTPException:
        raise
    except Exception as e:
        # Check for unique constraint violation
        if "unique constraint" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail=(
                    f"A type named '{request.name}' already exists in namespace "
                    f"'{request.namespace or '(unassigned)'}'. Names are unique per namespace — "
                    f"import into a different namespace to keep both."
                )
            )
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{tenant_slug}/{primitive_id}")
async def update_primitive(
    tenant_slug: str,
    primitive_id: str,
    request: PrimitiveUpdateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> PrimitiveSchema:
    """
    Update an existing primitive.

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        primitive_id: The primitive ID
        request: Primitive update data
        auth_data: Authentication data (injected by dependency)

    Returns:
        The updated primitive
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.EDIT)
    # Check if primitive exists
    existing = db.get_primitive_by_id(primitive_id, auth_data['tenant_id'])
    if not existing:
        raise HTTPException(
            status_code=404,
            detail=f"Primitive not found: {primitive_id}"
        )

    # Prevent updating system primitives
    if existing.get('is_system'):
        raise HTTPException(
            status_code=403,
            detail="Cannot update system primitives"
        )

    # Build updates dict from request
    updates = {}
    if request.name is not None:
        updates['name'] = request.name
    if request.description is not None:
        updates['description'] = request.description
    if request.category is not None:
        updates['category'] = request.category
    if request.tags is not None:
        updates['tags'] = request.tags
    if request.enabled is not None:
        updates['enabled'] = request.enabled
    if request.namespace is not None:
        updates['namespace'] = request.namespace

    # Re-validate and re-derive the JSON Schema 2020-12 identity whenever the schema or
    # its registry placement changes (#3452). Identity is computed against the effective
    # (post-update) name and namespace/base_uri, falling back to the stored values.
    identity_touched = (
        request.schema is not None
        or request.namespace is not None
        or request.base_uri is not None
        or request.name is not None
    )
    if identity_touched:
        schema_doc = request.schema if request.schema is not None else existing['schema']
        effective_name = request.name if request.name is not None else existing['name']
        effective_namespace = (
            request.namespace if request.namespace is not None else existing.get('namespace')
        )
        effective_base_uri = (
            request.base_uri if request.base_uri is not None else existing.get('base_uri')
        )
        # Honor the tenant's publish/save gate (#3479) on re-validation just like create.
        validate_on_save, block_on_errors = load_publish_gate(auth_data['tenant_id'])
        try:
            identity = resolve_primitive_identity(
                schema_doc,
                name=effective_name,
                namespace=effective_namespace,
                base_uri=effective_base_uri,
                tenant_slug=tenant_slug,
                validate=validate_on_save,
                block_on_errors=block_on_errors,
            )
        except SchemaValidationError as e:
            raise _schema_validation_http_error(e.errors)
        except ScopeViolationError as e:
            raise _scope_violation_http_error(e)
        updates['schema'] = identity['schema']
        updates['schema_id'] = identity['schema_id']
        updates['draft'] = identity['draft']
        updates['base_uri'] = identity['base_uri']
        # Re-resolve relative $ref edges whenever the schema or its base changes (#3456).
        updates['refs'] = resolve_primitive_refs(
            identity['schema'], base_uri=identity['base_uri'], tenant_id=auth_data['tenant_id']
        )

    try:
        # Update primitive
        primitive = db.update_primitive(
            primitive_id,
            auth_data['tenant_id'],
            updates
        )

        if not primitive:
            raise HTTPException(
                status_code=404,
                detail=f"Primitive not found: {primitive_id}"
            )

        # If the schema/placement changed, the (possibly new) $id may now satisfy other
        # primitives' dangling refs — clear their unresolved flag (#3457).
        if identity_touched:
            reconcile_dependents_for_target(
                updates.get('schema_id'), tenant_id=auth_data['tenant_id']
            )

        # Record the governed update in the registry audit log (#3481). The changed-field
        # list reflects what the request actually touched (drives a human-readable diff).
        record_registry_audit(
            db,
            auth_data,
            ACTION_UPDATE,
            primitive_id=str(primitive['id']),
            schema_id=primitive.get('schema_id'),
            namespace=primitive.get('namespace'),
            detail={
                "name": primitive.get('name'),
                "changed_fields": sorted(updates.keys()),
            },
        )

        return PrimitiveSchema(**primitive)
    except HTTPException:
        raise
    except Exception as e:
        # Check for unique constraint violation
        if "unique constraint" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail="A type with that name already exists in this namespace"
            )
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{tenant_slug}/{primitive_id}")
async def delete_primitive(
    tenant_slug: str,
    primitive_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> Dict[str, str]:
    """
    Delete a primitive (soft delete).

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        primitive_id: The primitive ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        Success message
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.DELETE)
    # Check if primitive exists
    existing = db.get_primitive_by_id(primitive_id, auth_data['tenant_id'])
    if not existing:
        raise HTTPException(
            status_code=404,
            detail=f"Primitive not found: {primitive_id}"
        )

    # Prevent deleting system primitives
    if existing.get('is_system'):
        raise HTTPException(
            status_code=403,
            detail="Cannot delete system primitives"
        )

    # Delete primitive
    success = db.delete_primitive(primitive_id, auth_data['tenant_id'])

    if not success:
        raise HTTPException(
            status_code=500,
            detail="Failed to delete primitive"
        )

    # Record the governed delete in the registry audit log (#3481). The primitive's $id and
    # namespace are captured here so the trail survives the (soft) deletion of the row.
    record_registry_audit(
        db,
        auth_data,
        ACTION_DELETE,
        primitive_id=primitive_id,
        schema_id=existing.get('schema_id'),
        namespace=existing.get('namespace'),
        detail={
            "name": existing.get('name'),
            "category": existing.get('category'),
        },
    )

    return {"message": "Primitive deleted successfully"}


@dataclass
class _PreparedDefinition:
    """A single imported definition resolved far enough to be reviewed or committed (#3464).

    Produced by :func:`_prepare_imported_definition`, which applies the ``$ref`` rewrite
    (#3463), validates + derives identity (#3452/#3453), resolves the ``refs`` edges (#3456),
    and looks the derived ``$id`` up against the registry so the definition can be classified
    New / Identical / Conflict. The same prepared state drives the dry-run review endpoint and
    the commit path, so a committed outcome can never disagree with the review that preceded it.

    The ``status`` field carries two related-but-distinct ideas under one ``STATUS_*`` value:
    a *registry* classification (``STATUS_NEW`` / ``STATUS_IDENTICAL`` / ``STATUS_CONFLICT``)
    for a committable definition, or ``STATUS_INVALID`` when the definition can't be committed
    at all. Use ``valid`` to disambiguate the latter: ``status == STATUS_INVALID`` covers both a
    malformed draft 2020-12 schema (``valid is False``, with ``validation_errors``) *and* a
    well-formed schema that violates scope (``valid is True``, with a ``scope_violation`` error).
    A caller that only cares about the New/Identical/Conflict classification should first gate on
    ``status == STATUS_INVALID`` (as the commit and review paths do) before reading the rest.

    Attributes:
        name: The definition's name (its registry-identity leaf).
        status: The classification — a ``primitives_review.STATUS_*`` value (``STATUS_INVALID``
            when the definition cannot be committed; see the note above on ``valid``).
        valid: Whether the fragment is a valid draft 2020-12 schema (scope violations are
            valid schemas, so this stays ``True`` for them).
        validation_errors: Field-level draft 2020-12 errors when ``valid`` is ``False``.
        error: A ``{"error", "details"}`` record when the definition cannot be committed
            (invalid schema or scope violation), else ``None``.
        schema_id: The derived ``$id`` (``None`` when the definition is invalid).
        identity: The full identity dict (stamped ``schema``/``schema_id``/``draft``/``base_uri``)
            when valid, else ``None``.
        rewritten: The rewritten schema (carries description/tags/category), or the original.
        refs: The resolved relative-``$ref`` edges to persist, or ``None`` when invalid.
        rewrites: The applied ``{"from", "to", "kind"}`` ref rewrites for the report.
        existing: The existing primitive row sharing this ``$id`` (Identical/Conflict), else ``None``.
    """

    name: str
    status: str
    valid: bool = True
    validation_errors: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[Dict[str, Any]] = None
    schema_id: Optional[str] = None
    identity: Optional[Dict[str, Any]] = None
    rewritten: Optional[Dict[str, Any]] = None
    refs: Optional[List[Dict[str, str]]] = None
    rewrites: List[Dict[str, str]] = field(default_factory=list)
    existing: Optional[Dict[str, Any]] = None


def _prepare_imported_definition(
    def_name: str,
    def_schema: Any,
    *,
    tenant_id: str,
    tenant_slug: str,
    target_namespace: Optional[str],
    map_core_formats: bool,
) -> _PreparedDefinition:
    """Rewrite, validate, resolve, and classify one imported definition (#3464).

    Runs the same registry pipeline a commit would — ``$ref`` rewrite (#3463), draft
    2020-12 validation + ``$id`` derivation + scope enforcement (#3452/#3453), and ``refs``
    resolution (#3456) — then looks the derived ``$id`` up in the caller's read scope to
    classify the definition New / Identical / Conflict (:func:`classify_status`). It never
    writes; the returned :class:`_PreparedDefinition` is consumed by both the review endpoint
    and the commit path. An invalid or scope-violating definition is returned with
    ``status == STATUS_INVALID`` and a populated ``error`` rather than raising, so one bad
    definition never blocks the rest of a bundle.

    Args:
        def_name: The definition's name (drives its derived ``$id`` leaf).
        def_schema: The raw definition fragment from the source document.
        tenant_id: The caller's tenant id (scopes ref resolution and the existing-row lookup).
        tenant_slug: The tenant slug (used for the default base URI).
        target_namespace: Optional registry namespace the definition is imported into.
        map_core_formats: Whether to map recognized formats to core types (#3463).

    Returns:
        The :class:`_PreparedDefinition` for this definition.
    """
    # Rewrite the definition's refs for its committed place in the registry before
    # validating/persisting (#3463). The base URI a definition's refs resolve against is the
    # same one resolve_primitive_identity derives, so the rewrite and the $id agree.
    if isinstance(def_schema, dict):
        base_uri = derive_base_uri(target_namespace, None, tenant_slug)
        rewritten_schema, applied = rewrite_import_schema(
            def_schema, base_uri=base_uri, map_core_formats=map_core_formats
        )
    else:
        # A non-object definition cannot be rewritten; let validation reject it below.
        rewritten_schema, applied = def_schema, []

    try:
        identity = resolve_primitive_identity(
            rewritten_schema,
            name=def_name,
            namespace=target_namespace,
            base_uri=None,
            tenant_slug=tenant_slug,
        )
    except SchemaValidationError as e:
        # Not a valid draft 2020-12 schema — the validation report records the field errors.
        return _PreparedDefinition(
            name=def_name,
            status=STATUS_INVALID,
            valid=False,
            validation_errors=e.errors,
            error={"error": "invalid_schema", "details": e.errors},
            rewritten=rewritten_schema if isinstance(rewritten_schema, dict) else None,
        )
    except ScopeViolationError as e:
        # A valid schema that crosses a forbidden scope boundary — valid stays True.
        return _PreparedDefinition(
            name=def_name,
            status=STATUS_INVALID,
            valid=True,
            error={"error": "scope_violation", "details": e.violations},
            rewritten=rewritten_schema if isinstance(rewritten_schema, dict) else None,
        )

    # The rewrite turned every intra-source/core ref into an ordinary registry-relative ref,
    # so the standard resolver (#3456) produces the full edge set — no internal-edge appending.
    refs = resolve_primitive_refs(
        identity['schema'], base_uri=identity['base_uri'], tenant_id=tenant_id
    )

    # Classify against the registry: does a visible type already hold this $id, and if so is
    # its schema identical (a dedupe) or divergent (a conflict the caller must resolve)?
    existing = db.get_primitive_by_schema_id(identity['schema_id'], tenant_id)
    status = classify_status(existing, identity['schema'])

    return _PreparedDefinition(
        name=def_name,
        status=status,
        valid=True,
        schema_id=identity['schema_id'],
        identity=identity,
        rewritten=rewritten_schema,
        refs=refs,
        rewrites=applied,
        existing=existing,
    )


def _create_primitive_from_prepared(
    prep: _PreparedDefinition,
    *,
    name: str,
    tenant_id: str,
    target_namespace: Optional[str],
    created_by: Optional[str],
) -> None:
    """Persist a prepared definition as a new ``apiome.primitives`` row and reconcile dependents.

    Shared by the New-import and rename paths so both create rows identically. After the row
    lands, any of the tenant's dangling edges that pointed at this ``$id`` are reconciled (#3457).

    Args:
        prep: The prepared definition (must be valid, i.e. carry an ``identity``).
        name: The name to create under (the original name, or a rename target).
        tenant_id: The owning tenant id.
        target_namespace: The registry namespace the row is placed in.
        created_by: The authenticated user id (None for API-key auth).
    """
    identity = prep.identity
    db.create_primitive(
        tenant_id=tenant_id,
        name=name,
        category=determine_category_from_schema(prep.rewritten),
        schema=identity['schema'],
        description=prep.rewritten.get('description'),
        tags=prep.rewritten.get('tags', []),
        created_by=created_by,
        source='imported',
        schema_id=identity['schema_id'],
        draft=identity['draft'],
        namespace=target_namespace,
        base_uri=identity['base_uri'],
        refs=prep.refs,
    )
    reconcile_dependents_for_target(identity['schema_id'], tenant_id=tenant_id)


def _commit_imported_definitions(
    definitions: Dict[str, Any],
    *,
    tenant_id: str,
    tenant_slug: str,
    target_namespace: Optional[str],
    created_by: Optional[str],
    map_core_formats: bool = True,
    dedupe: bool = True,
    resolutions: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Commit a ``name -> schema`` map of imported definitions, honoring review choices (#3464).

    Shared by the JSON Schema ``$defs`` import and the type-definition bundle import (#3462).
    Each definition is prepared (rewrite #3463, validate/derive identity #3452/#3453, resolve
    refs #3456) and classified against the registry, then committed according to its
    classification and the caller's per-type resolution:

    - **New** → a row is created (``imported``).
    - **Identical** → deduped and skipped when ``dedupe`` is on (``identical``); otherwise it
      is treated like a conflict so an explicit resolution still applies.
    - **Conflict** → the caller's resolution decides: ``overwrite`` replaces the existing row
      (``overwritten``), ``rename`` creates a copy under a new name (``renamed``), and the
      default ``keep`` leaves the existing type in place but **surfaces** the conflict
      (``skipped``) instead of dropping it silently.
    - **Invalid** / scope-violating definitions are recorded under ``errors`` without blocking
      the rest.

    Args:
        definitions: The ``name -> schema fragment`` map to import.
        tenant_id: The caller's tenant id (scopes ref resolution and reconciliation).
        tenant_slug: The tenant slug (used for the default base URI).
        target_namespace: Optional registry namespace each definition is imported into.
        created_by: The authenticated user id (None for API-key auth).
        map_core_formats: Whether to map recognized formats to core types (#3463).
        dedupe: Whether Identical definitions are auto-skipped (default) or surfaced.
        resolutions: Optional ``name -> {"action", "new_name"}`` conflict resolutions.

    Returns:
        A ``{"imported", "overwritten", "renamed", "identical", "skipped", "errors",
        "rewrites", "reviews"}`` outcome. ``reviews`` carries each definition's classification
        and validation report so the report can be shown to match the committed outcome.
    """
    resolutions = resolutions or {}
    imported: List[str] = []
    overwritten: List[str] = []
    renamed: List[Dict[str, str]] = []
    identical: List[str] = []
    skipped: List[str] = []
    errors: List[Dict[str, Any]] = []
    rewrites: Dict[str, List[Dict[str, str]]] = {}
    reviews: List[Dict[str, Any]] = []

    for def_name, def_schema in definitions.items():
        prep = _prepare_imported_definition(
            def_name,
            def_schema,
            tenant_id=tenant_id,
            tenant_slug=tenant_slug,
            target_namespace=target_namespace,
            map_core_formats=map_core_formats,
        )

        # Record the per-type classification + validation report (mirrors the review endpoint).
        reviews.append({
            "name": def_name,
            "status": prep.status,
            "valid": prep.valid,
            "validation_errors": prep.validation_errors,
            "existing_id": str(prep.existing["id"]) if prep.existing else None,
        })

        if prep.status == STATUS_INVALID:
            errors.append({"name": def_name, **prep.error})
            continue

        resolution = resolutions.get(def_name) or {}
        decision = decide(
            prep.status,
            action=resolution.get("action", "keep"),
            new_name=resolution.get("new_name"),
            dedupe=dedupe,
        )

        try:
            if decision.action == "create":
                _create_primitive_from_prepared(
                    prep,
                    name=def_name,
                    tenant_id=tenant_id,
                    target_namespace=target_namespace,
                    created_by=created_by,
                )
                imported.append(def_name)
                if prep.rewrites:
                    rewrites[def_name] = prep.rewrites

            elif decision.action == "update":
                # A conflict against a shared system-core type can't be overwritten by a tenant
                # import — the row isn't tenant-owned, so the update would silently match nothing.
                # Reject it explicitly rather than report a phantom overwrite.
                if prep.existing.get("is_system"):
                    errors.append({
                        "name": def_name,
                        "error": "cannot_overwrite_system",
                        "details": "A system-core type cannot be overwritten by an import",
                    })
                else:
                    # Overwrite the existing row's schema/refs in place; identity is unchanged
                    # (same name + namespace → same $id), so the edge graph stays consistent.
                    db.update_primitive(
                        str(prep.existing["id"]),
                        tenant_id,
                        {
                            "schema": prep.identity['schema'],
                            "category": determine_category_from_schema(prep.rewritten),
                            "description": prep.rewritten.get('description'),
                            "tags": prep.rewritten.get('tags', []),
                            "draft": prep.identity['draft'],
                            "refs": prep.refs,
                        },
                    )
                    reconcile_dependents_for_target(prep.schema_id, tenant_id=tenant_id)
                    overwritten.append(def_name)
                    if prep.rewrites:
                        rewrites[def_name] = prep.rewrites

            elif decision.action == "rename":
                # Re-prepare under the new name so it gets its own registry identity, then
                # create it — unless that name is itself already taken (a fresh conflict).
                # A rename only re-derives *this* definition's $id; sibling definitions in the
                # same bundle keep their own identities. A sibling's ``$ref`` therefore resolves
                # against the name it was authored to point at, not this new name — renaming one
                # type does not silently re-point its siblings' edges. An edge that pointed at
                # this type's original name lands in that sibling's ``unresolved_refs`` (the
                # review surfaces it), exactly as it would for any other unresolved registry ref.
                renamed_prep = _prepare_imported_definition(
                    decision.new_name,
                    def_schema,
                    tenant_id=tenant_id,
                    tenant_slug=tenant_slug,
                    target_namespace=target_namespace,
                    map_core_formats=map_core_formats,
                )
                if renamed_prep.status == STATUS_INVALID:
                    errors.append({"name": def_name, **renamed_prep.error})
                elif renamed_prep.existing is not None:
                    errors.append({
                        "name": def_name,
                        "error": "rename_conflict",
                        "details": f"A type named '{decision.new_name}' already exists",
                    })
                else:
                    _create_primitive_from_prepared(
                        renamed_prep,
                        name=decision.new_name,
                        tenant_id=tenant_id,
                        target_namespace=target_namespace,
                        created_by=created_by,
                    )
                    renamed.append({"from": def_name, "to": decision.new_name})
                    if renamed_prep.rewrites:
                        rewrites[decision.new_name] = renamed_prep.rewrites

            elif decision.action == "skip":
                if decision.outcome == "identical":
                    identical.append(def_name)
                else:
                    skipped.append(def_name)

            else:  # decision.action == "error"
                errors.append({"name": def_name, "error": decision.reason})

        except Exception as e:
            # A unique-constraint hit means another writer won the race for this identity;
            # surface it as a skip rather than a hard failure, mirroring prior behavior.
            if "unique constraint" in str(e).lower():
                skipped.append(def_name)
            else:
                errors.append({"name": def_name, "error": str(e)})

    return {
        "imported": imported,
        "overwritten": overwritten,
        "renamed": renamed,
        "identical": identical,
        "skipped": skipped,
        "errors": errors,
        "rewrites": rewrites,
        "reviews": reviews,
    }


def _review_imported_definitions(
    definitions: Dict[str, Any],
    *,
    tenant_id: str,
    tenant_slug: str,
    target_namespace: Optional[str],
    map_core_formats: bool,
    dedupe: bool,
) -> Dict[str, Any]:
    """Build a dry-run review of a ``name -> schema`` map without writing anything (#3464).

    Classifies each definition New / Identical / Conflict, attaches its draft 2020-12
    validation report and unresolved-ref mapping, and lists the resolution choices a
    Conflict offers — the report the import UI (#3469) renders before the user commits.

    Args:
        definitions: The ``name -> schema fragment`` map to review.
        tenant_id: The caller's tenant id (scopes the existing-row lookup).
        tenant_slug: The tenant slug (used for the default base URI).
        target_namespace: Optional registry namespace the import targets.
        map_core_formats: Whether recognized formats would be mapped to core types (#3463).
        dedupe: Whether Identical definitions would be auto-skipped — reflected in the summary.

    Returns:
        A ``{"status", "summary", "types"}`` review report (plus echoed source context added
        by the caller). Each ``types`` entry carries name, status, validation report,
        rewrites, ref counts, the existing row's id, and the allowed resolutions.
    """
    types: List[Dict[str, Any]] = []
    summary = {"new": 0, "identical": 0, "conflict": 0, "invalid": 0}

    for def_name, def_schema in definitions.items():
        prep = _prepare_imported_definition(
            def_name,
            def_schema,
            tenant_id=tenant_id,
            tenant_slug=tenant_slug,
            target_namespace=target_namespace,
            map_core_formats=map_core_formats,
        )
        summary[prep.status] = summary.get(prep.status, 0) + 1

        unresolved = [e for e in (prep.refs or []) if e.get("status") == "unresolved"]
        types.append({
            "name": def_name,
            "status": prep.status,
            "valid": prep.valid,
            "validation_errors": prep.validation_errors,
            "error": prep.error,
            "schema_id": prep.schema_id,
            "existing_id": str(prep.existing["id"]) if prep.existing else None,
            "rewrites": prep.rewrites,
            "ref_count": len(prep.refs or []),
            "unresolved_refs": unresolved,
            "allowed_resolutions": allowed_resolutions(prep.status),
        })

    return {
        "status": "review",
        "dedupe": dedupe,
        "summary": {**summary, "total": len(types)},
        "types": types,
    }


def _resolve_import_definitions(
    request: PrimitiveImportRequest,
) -> tuple[Dict[str, Any], List[str]]:
    """Resolve an import request's source document into a ``name -> schema`` map.

    Shared by the commit (``/import``) and review (``/import/review``) endpoints so both
    interpret the source identically. A type-def bundle is expanded by the bundle importer
    (#3462) — a malformed bundle is a clear 400 — while JSON Schema / OpenAPI documents
    extract their ``$defs`` / ``definitions``. The ``selected_definitions`` filter is applied
    here when ``import_all`` is false.

    Args:
        request: The import request carrying the source document and selection options.

    Returns:
        ``(definitions, warnings)`` — the resolved definitions and any non-fatal warnings
        (e.g. from bundle expansion).

    Raises:
        HTTPException: 400 for an invalid source kind, a malformed bundle, a document with no
            definitions, or a selection that matches nothing.
    """
    if request.source_kind not in VALID_IMPORT_SOURCE_KINDS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid source_kind '{request.source_kind}'. "
                f"Expected one of: {', '.join(sorted(VALID_IMPORT_SOURCE_KINDS))}"
            )
        )

    warnings: List[str] = []
    if request.source_kind == 'type-def-bundle':
        try:
            parsed_types, warnings = parse_type_def_bundle(
                request.schema, source_label=request.source_label
            )
        except BundleError as e:
            raise HTTPException(status_code=400, detail=e.message)
        definitions: Dict[str, Any] = {p.name: p.schema for p in parsed_types}
    else:
        definitions = {}
        # Check for $defs (JSON Schema 2020-12)
        if '$defs' in request.schema:
            definitions.update(request.schema['$defs'])
        # Check for definitions (older JSON Schema versions)
        if 'definitions' in request.schema:
            definitions.update(request.schema['definitions'])

        if not definitions:
            raise HTTPException(
                status_code=400,
                detail="No definitions found in JSON Schema. Schema must contain $defs or definitions."
            )

    # Filter definitions if specific ones are requested.
    if not request.import_all and request.selected_definitions:
        definitions = {
            k: v for k, v in definitions.items()
            if k in request.selected_definitions
        }

    if not definitions:
        raise HTTPException(
            status_code=400,
            detail="No matching definitions found to import"
        )

    return definitions, warnings


def _normalize_resolutions(
    request: PrimitiveImportRequest,
) -> Optional[Dict[str, Dict[str, Any]]]:
    """Validate and flatten a request's per-type conflict resolutions (#3464).

    Args:
        request: The import request whose ``resolutions`` map is being applied.

    Returns:
        A ``name -> {"action", "new_name"}`` map of plain dicts, or ``None`` when the
        request carries no resolutions.

    Raises:
        HTTPException: 400 if a resolution names an unknown action, or a ``rename`` omits
            its ``new_name``.
    """
    if not request.resolutions:
        return None
    normalized: Dict[str, Dict[str, Any]] = {}
    for name, resolution in request.resolutions.items():
        if resolution.action not in VALID_ACTIONS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid resolution action '{resolution.action}' for '{name}'. "
                    f"Expected one of: {', '.join(sorted(VALID_ACTIONS))}"
                )
            )
        if resolution.action == ACTION_RENAME and not resolution.new_name:
            raise HTTPException(
                status_code=400,
                detail=f"Resolution for '{name}' is 'rename' but no new_name was provided",
            )
        normalized[name] = {"action": resolution.action, "new_name": resolution.new_name}
    return normalized


@router.post("/{tenant_slug}/import/review")
async def review_import_primitives(
    tenant_slug: str,
    request: PrimitiveImportRequest,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry)
) -> Dict[str, Any]:
    """Dry-run review of an import: conflicts, dedupe, and a validation report (#3464).

    Resolves the source exactly as ``POST /import`` would, but **writes nothing** — it
    classifies each definition against the registry (New / Identical / Conflict), attaches its
    draft 2020-12 validation report and unresolved-ref mapping, and lists the resolution
    choices each conflict offers. This is the report the import wizard (#3469) renders so the
    user can pick keep / overwrite / rename before committing; the same classification drives
    the commit, so the committed result matches the review.

    Args:
        tenant_slug: The tenant slug.
        request: The import request (source document + options); ``resolutions`` is ignored.
        auth_data: Authentication data (injected by dependency).

    Returns:
        A ``{"status": "review", "summary", "types", ...}`` report.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.VIEW)
    definitions, warnings = _resolve_import_definitions(request)

    review = _review_imported_definitions(
        definitions,
        tenant_id=auth_data['tenant_id'],
        tenant_slug=tenant_slug,
        target_namespace=request.target_namespace,
        map_core_formats=request.map_core_formats,
        dedupe=request.dedupe,
    )

    return {
        "source_kind": request.source_kind,
        "source_label": request.source_label,
        "target_namespace": request.target_namespace,
        "warnings": warnings,
        **review,
    }


@router.post("/{tenant_slug}/import")
async def import_primitives(
    tenant_slug: str,
    request: PrimitiveImportRequest,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry)
) -> Dict[str, Any]:
    """
    Import primitives from a JSON Schema document or an Apiome type-def bundle.

    For ``source_kind='json-schema'`` (the default) and ``'openapi'``, type definitions are
    extracted from the document's ``$defs`` / ``definitions`` and each becomes a primitive.
    For ``source_kind='type-def-bundle'`` (#3462), the request ``schema`` is expanded as an
    Apiome type-definition bundle — its ``types`` (or ``$defs`` / ``definitions``)
    container is read into many interlinked types, each committed as a primitive with its
    inter-type ``$ref`` edges captured in the ``refs`` JSONB column for the rewrite stage
    (#3463). A bundle of N types imports N rows; a malformed bundle is rejected with a clear
    400 error.

    Supports authentication via JWT token or API key.
    When using JWT, the created_by field will be set to the authenticated user.

    Args:
        tenant_slug: The tenant slug
        request: Import request with the JSON Schema document or bundle
        auth_data: Authentication data (injected by dependency)

    Returns:
        Summary of imported primitives plus the id of the recorded provenance row.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.CREATE)
    # Resolve the source into a {name: schema} map of definitions (shared with /import/review).
    # A malformed bundle / empty document is a clear 400. Each definition's intra-source and
    # core-format refs are rewritten during commit (#3463).
    definitions, warnings = _resolve_import_definitions(request)
    resolutions = _normalize_resolutions(request)

    # Get user_id from auth data (will be None for API key auth)
    created_by = get_authenticated_user_id(auth_data)

    # Commit each definition as a primitive (shared by JSON Schema and bundle imports), honoring
    # the caller's conflict/dedupe resolutions (#3464). Each definition's refs are rewritten
    # relative + mapped to core types during commit (#3463).
    outcome = _commit_imported_definitions(
        definitions,
        tenant_id=auth_data['tenant_id'],
        tenant_slug=tenant_slug,
        target_namespace=request.target_namespace,
        created_by=created_by,
        map_core_formats=request.map_core_formats,
        dedupe=request.dedupe,
        resolutions=resolutions,
    )
    imported = outcome["imported"]
    overwritten = outcome["overwritten"]
    renamed = outcome["renamed"]
    identical = outcome["identical"]
    skipped = outcome["skipped"]
    errors = outcome["errors"]
    rewrites = outcome["rewrites"]
    reviews = outcome["reviews"]

    # Build the auditable report and persist a provenance record (#3448). The rewrites map
    # records the $ref rewrites applied per type (#3463) for the import-review table, and the
    # reviews list records each type's New/Identical/Conflict classification so the report can
    # be shown to match the committed outcome (#3464).
    report = {
        "imported": imported,
        "overwritten": overwritten,
        "renamed": renamed,
        "identical": identical,
        "skipped": skipped,
        "errors": errors,
        "warnings": warnings,
        "rewrites": rewrites,
        "reviews": reviews,
        "total_imported": len(imported),
        "total_overwritten": len(overwritten),
        "total_renamed": len(renamed),
        "total_identical": len(identical),
        "total_skipped": len(skipped),
        "total_errors": len(errors),
    }
    options = {
        "import_all": request.import_all,
        "selected_definitions": request.selected_definitions,
        "map_core_formats": request.map_core_formats,
        "dedupe": request.dedupe,
        "resolutions": resolutions,
    }

    # Rows written = newly created + overwritten + renamed; rows passed over = deduped
    # identical + kept conflicts. This keeps the provenance counts matching the outcome.
    written_count = len(imported) + len(overwritten) + len(renamed)
    passed_over_count = len(identical) + len(skipped)

    import_id = None
    try:
        import_record = db.create_primitive_import(
            tenant_id=auth_data['tenant_id'],
            report=report,
            source_kind=request.source_kind,
            source_label=request.source_label,
            target_namespace=request.target_namespace,
            options=options,
            imported_count=written_count,
            skipped_count=passed_over_count,
            error_count=len(errors),
            imported_by=created_by,
        )
        import_id = str(import_record['id'])
    except Exception as e:
        # Provenance is best-effort: a failure here must not lose a successful import,
        # but it is surfaced so the audit gap is visible.
        errors.append({"name": "_provenance", "error": f"Failed to record import provenance: {e}"})

    # Record the governed import as a single audit event (#3481). One import call binds many
    # types, so the event carries the per-outcome counts and the provenance id rather than a
    # row per type; an import that committed nothing but logged errors is a failure outcome.
    record_registry_audit(
        db,
        auth_data,
        ACTION_IMPORT,
        outcome=OUTCOME_SUCCESS if written_count > 0 or not errors else OUTCOME_FAILURE,
        namespace=request.target_namespace,
        detail={
            "import_id": import_id,
            "source_kind": request.source_kind,
            "source_label": request.source_label,
            "total_imported": len(imported),
            "total_overwritten": len(overwritten),
            "total_renamed": len(renamed),
            "total_identical": len(identical),
            "total_skipped": len(skipped),
            "total_errors": len(errors),
        },
    )

    return {
        "message": "Import completed",
        "import_id": import_id,
        **report,
    }


@router.post("/{tenant_slug}/import/stage", response_model=PrimitiveImportStageResult)
async def stage_import(
    tenant_slug: str,
    request: PrimitiveImportStageRequest,
    auth_data: Dict[str, Any] = Depends(require_primitives_registry)
) -> PrimitiveImportStageResult:
    """Stage an import through the unified pipeline (#3460).

    The single orchestration path for all source kinds and intake methods: it
    fetches the source (paste / file / url / git), parses it (JSON or YAML),
    detects the candidate types it carries (json-schema / type-def-bundle /
    openapi), records a provenance row on ``apiome.primitive_imports`` marked
    ``staged``, and returns the staged candidates.

    Nothing is committed to the registry here — parsing into discrete types
    (#3461/#3462), ``$ref`` rewrite (#3463), and conflict/dedupe review (#3464)
    operate on the staged result in the subsequent pipeline stages. The legacy
    ``POST /{tenant_slug}/import`` (paste, commit) remains supported alongside it.

    Args:
        tenant_slug: The tenant slug.
        request: The staging request (source kind/method + a method locator).
        auth_data: Authentication data (injected by dependency).

    Returns:
        The staged result: detected candidates plus the recorded ``import_id``.

    Raises:
        HTTPException: 400 for an invalid source kind/method or missing locator,
            422 for an unparseable source, 502 for a fetch failure.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.CREATE)
    if request.source_kind not in VALID_IMPORT_SOURCE_KINDS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid source_kind '{request.source_kind}'. "
                f"Expected one of: {', '.join(sorted(VALID_IMPORT_SOURCE_KINDS))}"
            )
        )

    # Ingest (fetch + parse) the source document for the declared method. A bad
    # locator or empty/invalid document is a 400/422; a remote fetch failure is a
    # 502 (the source, not the request, is at fault).
    git_locator = request.git.model_dump() if request.git is not None else None
    try:
        ingested = ingest_source(
            request.source_method,
            content=request.content,
            url=request.url,
            git=git_locator,
            source_label=request.source_label,
        )
    except IngestionError as e:
        # A network/remote failure is a 502; a client-side locator/parse problem is a 400.
        is_remote = request.source_method in ("url", "git") and (
            "fetch" in e.message.lower() or "http" in e.message.lower()
        )
        raise HTTPException(status_code=502 if is_remote else 400, detail=e.message)

    # Detect candidate types and assemble the staged result (pure; no commit).
    try:
        staged = build_staged_import(
            ingested.document,
            source_kind=request.source_kind,
            source_method=request.source_method,
            source_label=ingested.resolved_label,
            target_namespace=request.target_namespace,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Record an auditable provenance row for the staged import (#3448 reuse). The
    # report carries the staged candidates and warnings; counts stay zero because
    # nothing was committed. Best-effort: a record failure must not lose the
    # staged result, but it is surfaced as a warning so the audit gap is visible.
    created_by = get_authenticated_user_id(auth_data)
    import_id = None
    try:
        import_record = db.create_primitive_import(
            tenant_id=auth_data['tenant_id'],
            report=staged.report(),
            source_kind=staged.source_kind,
            source_label=staged.source_label,
            target_namespace=staged.target_namespace,
            options={"source_method": staged.source_method, "staged": True},
            imported_count=0,
            skipped_count=0,
            error_count=0,
            imported_by=created_by,
        )
        import_id = str(import_record['id'])
    except Exception as e:
        staged.warnings.append(f"Failed to record import provenance: {e}")

    return PrimitiveImportStageResult(
        import_id=import_id,
        status=staged.status,
        source_kind=staged.source_kind,
        source_method=staged.source_method,
        source_label=staged.source_label,
        target_namespace=staged.target_namespace,
        detected_count=staged.detected_count,
        candidates=[c.as_dict() for c in staged.candidates],
        warnings=staged.warnings,
    )

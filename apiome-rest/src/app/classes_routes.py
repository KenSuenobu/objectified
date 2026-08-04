"""
Classes API Routes

Provides CRUD endpoints for managing class definitions.
All endpoints are tenant-scoped and require authentication via JWT token or API key.
"""

from fastapi import APIRouter, HTTPException, Query, Depends
from typing import Optional, List, Dict, Any

from .database import db
from .models import (
    ClassSchema,
    ClassCreateRequest,
    ClassUpdateRequest
)
from .auth import validate_authentication, get_authenticated_user_id
from .permissions import enforce_permission, Resource, Action

router = APIRouter(prefix="/v1/classes", tags=["classes"])


@router.get("/{tenant_slug}")
async def list_classes(
    tenant_slug: str,
    version_id: Optional[str] = Query(None, description="Filter by version ID"),
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> List[ClassSchema]:
    """
    List all classes for a tenant, optionally filtered by version.

    Supports authentication via:
    - JWT token in Authorization header (Bearer token)
    - API key in X-API-Key header

    Args:
        tenant_slug: The tenant slug
        version_id: Optional version ID to filter by
        auth_data: Authentication data (injected by dependency)

    Returns:
        List of classes for the tenant/version
    """
    if version_id:
        # Verify version belongs to tenant
        version = db.get_version_for_tenant(auth_data['tenant_id'], version_id)
        if not version:
            raise HTTPException(
                status_code=404,
                detail=f"Version not found: {version_id}"
            )
        classes = db.get_classes_for_tenant_version(auth_data['tenant_id'], version_id)
    else:
        # Get all classes across all versions for the tenant
        # We'll need to get all versions first, then all classes for each
        versions = db.get_versions_for_tenant(auth_data['tenant_id'])
        classes = []
        for version in versions:
            version_classes = db.get_classes_for_tenant_version(
                auth_data['tenant_id'],
                version['id']
            )
            classes.extend(version_classes)

    return [ClassSchema(**c) for c in classes]


@router.get("/{tenant_slug}/{class_id}")
async def get_class(
    tenant_slug: str,
    class_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> ClassSchema:
    """
    Get a specific class by ID.

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        class_id: The class ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        The class details
    """
    class_data = db.get_class_by_id(class_id, auth_data['tenant_id'])

    if not class_data:
        raise HTTPException(
            status_code=404,
            detail=f"Class not found: {class_id}"
        )

    return ClassSchema(**class_data)


@router.post("/{tenant_slug}")
async def create_class(
    tenant_slug: str,
    request: ClassCreateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> ClassSchema:
    """
    Create a new class.

    Supports authentication via JWT token or API key.
    The class will be created in the specified version.

    Args:
        tenant_slug: The tenant slug
        request: Class creation data
        auth_data: Authentication data (injected by dependency)

    Returns:
        The created class
    """
    enforce_permission(db, auth_data, Resource.CLASSES, Action.CREATE)
    # Verify version belongs to tenant
    version = db.get_version_for_tenant(auth_data['tenant_id'], request.version_id)
    if not version:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {request.version_id}"
        )

    try:
        class_data = db.create_class(
            version_id=request.version_id,
            name=request.name,
            schema=request.schema,
            description=request.description,
            enabled=request.enabled
        )

        return ClassSchema(**class_data)
    except Exception as e:
        # Check for unique constraint violation
        if "unique constraint" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail=f"A class with name '{request.name}' already exists in this version"
            )
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{tenant_slug}/{class_id}")
async def update_class(
    tenant_slug: str,
    class_id: str,
    request: ClassUpdateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> ClassSchema:
    """
    Update an existing class.

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        class_id: The class ID
        request: Class update data
        auth_data: Authentication data (injected by dependency)

    Returns:
        The updated class
    """
    enforce_permission(db, auth_data, Resource.CLASSES, Action.EDIT)
    # Build updates dict from request, excluding None values
    updates = {}
    if request.name is not None:
        updates['name'] = request.name
    if request.description is not None:
        updates['description'] = request.description
    if request.schema is not None:
        updates['schema'] = request.schema
    if request.enabled is not None:
        updates['enabled'] = request.enabled
    if request.canvas_metadata is not None:
        updates['canvas_metadata'] = request.canvas_metadata

    try:
        class_data = db.update_class(
            class_id=class_id,
            tenant_id=auth_data['tenant_id'],
            updates=updates
        )

        if not class_data:
            raise HTTPException(
                status_code=404,
                detail=f"Class not found: {class_id}"
            )

        return ClassSchema(**class_data)
    except HTTPException:
        raise
    except Exception as e:
        # Check for unique constraint violation
        if "unique constraint" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail=f"A class with name '{request.name}' already exists in this version"
            )
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{tenant_slug}/{class_id}")
async def delete_class(
    tenant_slug: str,
    class_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> Dict[str, Any]:
    """
    Delete a class (soft delete).

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        class_id: The class ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        Success message
    """
    enforce_permission(db, auth_data, Resource.CLASSES, Action.DELETE)
    deleted = db.delete_class(class_id, auth_data['tenant_id'])

    if not deleted:
        raise HTTPException(
            status_code=404,
            detail=f"Class not found: {class_id}"
        )

    return {"message": "Class deleted successfully", "id": class_id}


@router.get("/{tenant_slug}/{class_id}/properties")
async def get_class_properties(
    tenant_slug: str,
    class_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> List[Dict[str, Any]]:
    """
    Get all properties for a specific class.

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        class_id: The class ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        List of properties for the class
    """
    # First verify the class exists and belongs to tenant
    class_data = db.get_class_by_id(class_id, auth_data['tenant_id'])

    if not class_data:
        raise HTTPException(
            status_code=404,
            detail=f"Class not found: {class_id}"
        )

    properties = db.get_properties_for_class(class_id)
    return properties


@router.post("/{tenant_slug}/{class_id}/properties")
async def add_property_to_class(
    tenant_slug: str,
    class_id: str,
    request: Dict[str, Any],
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> Dict[str, Any]:
    """
    Add a property to a class.

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        class_id: The class ID
        request: Property data containing:
            - property_id: Optional library property ID
            - name: Property name (required)
            - description: Optional property description
            - data: Property schema data (required)
            - parent_id: Optional parent property ID for nested properties
        auth_data: Authentication data (injected by dependency)

    Returns:
        The created class property
    """
    enforce_permission(db, auth_data, Resource.PROPERTIES, Action.CREATE)
    # First verify the class exists and belongs to tenant
    class_data = db.get_class_by_id(class_id, auth_data['tenant_id'])

    if not class_data:
        raise HTTPException(
            status_code=404,
            detail=f"Class not found: {class_id}"
        )

    # Validate required fields
    if not request.get('name') or not request['name'].strip():
        raise HTTPException(
            status_code=400,
            detail="Property name is required"
        )

    if not request.get('data'):
        raise HTTPException(
            status_code=400,
            detail="Property data is required"
        )

    try:
        property_data = db.add_property_to_class(
            class_id=class_id,
            property_id=request.get('property_id'),
            name=request['name'],
            description=request.get('description'),
            data=request['data'],
            parent_id=request.get('parent_id'),
            primitive_id=request.get('primitive_id'),
            primitive_ref=request.get('primitive_ref')
        )

        return property_data
    except ValueError as e:
        # Handle validation errors
        raise HTTPException(
            status_code=400,
            detail=str(e)
        )
    except Exception as e:
        # Check for unique constraint violation
        if "unique constraint" in str(e).lower() or "23505" in str(e):
            raise HTTPException(
                status_code=409,
                detail="A property with this name already exists at this level"
            )
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{tenant_slug}/{class_id}/properties/{class_property_id}")
async def update_class_property(
    tenant_slug: str,
    class_id: str,
    class_property_id: str,
    request: Dict[str, Any],
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> Dict[str, Any]:
    """
    Update a property in a class.

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        class_id: The class ID
        class_property_id: The class property ID
        request: Property update data containing:
            - name: Optional property name
            - description: Optional property description
            - data: Optional property schema data
        auth_data: Authentication data (injected by dependency)

    Returns:
        The updated class property
    """
    enforce_permission(db, auth_data, Resource.PROPERTIES, Action.EDIT)
    # First verify the class exists and belongs to tenant
    class_data = db.get_class_by_id(class_id, auth_data['tenant_id'])

    if not class_data:
        raise HTTPException(
            status_code=404,
            detail=f"Class not found: {class_id}"
        )

    # Validate name if provided
    if 'name' in request and request['name'] is not None and not request['name'].strip():
        raise HTTPException(
            status_code=400,
            detail="Property name cannot be empty"
        )

    try:
        # Build updates dict from request
        updates = {}
        if 'name' in request:
            updates['name'] = request['name']
        if 'description' in request:
            updates['description'] = request['description']
        if 'data' in request:
            updates['data'] = request['data']
        # Property→primitive binding (#3448). Present-but-None clears the binding.
        if 'primitive_id' in request:
            updates['primitive_id'] = request['primitive_id']
        if 'primitive_ref' in request:
            updates['primitive_ref'] = request['primitive_ref']

        property_data = db.update_class_property(
            class_property_id=class_property_id,
            class_id=class_id,
            tenant_id=auth_data['tenant_id'],
            updates=updates
        )

        if not property_data:
            raise HTTPException(
                status_code=404,
                detail=f"Class property not found: {class_property_id}"
            )

        return property_data
    except ValueError as e:
        # Handle validation errors
        raise HTTPException(
            status_code=400,
            detail=str(e)
        )
    except Exception as e:
        # Check for unique constraint violation
        if "unique constraint" in str(e).lower() or "23505" in str(e):
            raise HTTPException(
                status_code=409,
                detail="A property with this name already exists at this level"
            )
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{tenant_slug}/{class_id}/properties/{class_property_id}")
async def delete_class_property(
    tenant_slug: str,
    class_id: str,
    class_property_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> Dict[str, str]:
    """
    Delete a property from a class.

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        class_id: The class ID
        class_property_id: The class property ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        Success message
    """
    enforce_permission(db, auth_data, Resource.PROPERTIES, Action.DELETE)
    # First verify the class exists and belongs to tenant
    class_data = db.get_class_by_id(class_id, auth_data['tenant_id'])

    if not class_data:
        raise HTTPException(
            status_code=404,
            detail=f"Class not found: {class_id}"
        )

    # Delete the property
    success = db.delete_class_property(
        class_property_id,
        class_id,
        auth_data['tenant_id']
    )

    if not success:
        raise HTTPException(
            status_code=404,
            detail=f"Class property not found: {class_property_id}"
        )

    return {"message": "Class property deleted successfully"}


@router.get("/{tenant_slug}/version/{version_id}/with-properties-tags")
async def get_classes_with_properties_and_tags(
    tenant_slug: str,
    version_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> List[Dict[str, Any]]:
    """
    Get all classes for a version with their properties and tags.

    Deprecated for canvas hydration (DUW-1.2, private-suite#2569). This read has no LIMIT: it
    returns every class of the version with every property and every tag, which is why a large
    catalog makes the designer canvas choke. Surfaces that need a *selection* — the unified
    workspace and anything else hydrating what a user picked — must use
    ``GET /v1/workspace/{tenant_slug}/version/{version_id}/classes`` with ``class_ids`` or
    ``domain_id`` instead. It stays here, unchanged, for the surfaces that genuinely do need the
    whole version (exports, scoring, readiness sweeps).

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        version_id: The version ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        List of classes with properties and tags
    """
    # Verify version belongs to tenant
    version = db.get_version_for_tenant(auth_data['tenant_id'], version_id)
    if not version:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {version_id}"
        )

    classes = db.get_classes_with_properties_and_tags_for_version(version_id)
    return classes


@router.get("/{tenant_slug}/{class_id}/with-properties-tags")
async def get_class_with_properties_and_tags(
    tenant_slug: str,
    class_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> Dict[str, Any]:
    """
    Get a single class with its properties and tags.

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        class_id: The class ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        Class with properties and tags
    """
    # First verify the class exists and belongs to tenant
    class_data = db.get_class_by_id(class_id, auth_data['tenant_id'])

    if not class_data:
        raise HTTPException(
            status_code=404,
            detail=f"Class not found: {class_id}"
        )

    class_with_data = db.get_class_with_properties_and_tags(class_id)
    if not class_with_data:
        raise HTTPException(
            status_code=404,
            detail=f"Class not found: {class_id}"
        )

    return class_with_data

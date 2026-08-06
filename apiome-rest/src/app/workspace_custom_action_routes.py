"""Custom palette actions API — DUW-5.5 (private-suite#2592).

Tenant-scoped CRUD over the ⌘K palette's programmable actions:

* ``GET    /v1/workspace/{tenant_slug}/custom-actions``       — list the tenant's actions.
* ``POST   /v1/workspace/{tenant_slug}/custom-actions``       — create one.
* ``GET    /v1/workspace/{tenant_slug}/custom-actions/{id}``  — fetch one.
* ``PATCH  /v1/workspace/{tenant_slug}/custom-actions/{id}``  — update matcher, name or effects.
* ``DELETE /v1/workspace/{tenant_slug}/custom-actions/{id}``  — soft-delete it.

This is the whole management surface for now: the settings page that will wrap it is DUW-8.2
(private-suite#2602), and until it lands these routes are managed directly — which is why every
validation error names the field it rejects.

Three rules the surface rests on:

**A definition is declarative or it is a 422.** Everything a row may say is validated by
:mod:`app.workspace_custom_action_rules` — the closed effect vocabulary, the matcher kinds, the
https-only URL rule — before it reaches storage. There is no passthrough field, no
warn-and-store, and no arbitrary code path; SDK-script execution is DUW-7.4's sandbox, not this
table.

**Tenancy comes from the token, never the URL.** As across the workspace routes, the
``{tenant_slug}`` path segment is decorative; ``tenant_id`` off the validated token scopes every
statement, so another tenant's action is a 404 — whether it exists is not something this API
confirms.

**Writes need an attributable user and edit rights.** Reads are open to any authenticated member
— the palette itself performs one on behalf of everyone — but creating, changing or deleting the
tenant's shared action vocabulary is configuration work: it requires a user (not a bare API key,
matching the saved-search rule) holding VERSIONS/EDIT, the same gate the domain folders use for
reorganizing what everyone sees.
"""

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from . import workspace_custom_action_store as store
from .auth import get_authenticated_user_id, validate_authentication
from .database import db
from .models import (
    WorkspaceCustomActionCreate,
    WorkspaceCustomActionListResponse,
    WorkspaceCustomActionOut,
    WorkspaceCustomActionUpdate,
    workspace_custom_action_out_from_row,
)
from .permissions import Action, Resource, enforce_permission
from .workspace_custom_action_rules import (
    CustomActionValidationError,
    normalize_action_name,
    normalize_effects,
    normalize_name_contains,
    normalize_subject,
    validate_effects_against_subject,
)

router = APIRouter(prefix="/v1/workspace", tags=["workspace"])


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """The caller's tenant, or a 500 when the token carried none."""
    tid = auth_data.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=500, detail="Missing tenant context")
    return str(tid)


def _require_user_id(auth_data: Dict[str, Any]) -> str:
    """Resolve the authenticated user; writes to the shared action list are attributed."""
    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="Managing custom actions requires an attributable user",
        )
    return user_id


def _load_action(tenant_id: str, action_id: str) -> Dict[str, Any]:
    """Load a live action inside the caller's tenant, or 404.

    Args:
        tenant_id: The caller's tenant.
        action_id: The action.

    Returns:
        The action row.

    Raises:
        HTTPException: 404 when it is missing, deleted, or another tenant's.
    """
    row = store.get_action(db, tenant_id=tenant_id, action_id=action_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Custom action not found")
    return row


@router.get("/{tenant_slug}/custom-actions", response_model=WorkspaceCustomActionListResponse)
async def list_custom_actions(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> WorkspaceCustomActionListResponse:
    """List the tenant's live custom actions, alphabetically by name."""
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    rows = store.list_actions(db, tenant_id=tenant_id)
    return WorkspaceCustomActionListResponse(
        success=True,
        actions=[workspace_custom_action_out_from_row(row) for row in rows],
    )


@router.post(
    "/{tenant_slug}/custom-actions",
    response_model=WorkspaceCustomActionOut,
    status_code=201,
)
async def create_custom_action(
    tenant_slug: str,
    body: WorkspaceCustomActionCreate,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> WorkspaceCustomActionOut:
    """Create a custom action in the tenant."""
    _ = tenant_slug
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    tenant_id = _tenant_id(auth_data)
    user_id = _require_user_id(auth_data)

    try:
        name = normalize_action_name(body.name)
        subject = normalize_subject(body.subject)
        name_contains = normalize_name_contains(body.name_contains)
        effects = normalize_effects(body.effects)
        validate_effects_against_subject(subject, effects)
    except CustomActionValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        row = store.create_action(
            db,
            tenant_id=tenant_id,
            created_by=user_id,
            name=name,
            subject=subject,
            name_contains=name_contains,
            effects=effects,
        )
    except store.CustomActionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return workspace_custom_action_out_from_row(row)


@router.get(
    "/{tenant_slug}/custom-actions/{action_id}",
    response_model=WorkspaceCustomActionOut,
)
async def get_custom_action(
    tenant_slug: str,
    action_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> WorkspaceCustomActionOut:
    """Fetch one custom action in the tenant."""
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    return workspace_custom_action_out_from_row(_load_action(tenant_id, action_id))


@router.patch(
    "/{tenant_slug}/custom-actions/{action_id}",
    response_model=WorkspaceCustomActionOut,
)
async def update_custom_action(
    tenant_slug: str,
    action_id: str,
    body: WorkspaceCustomActionUpdate,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> WorkspaceCustomActionOut:
    """Update a custom action's name, matcher, or effects.

    Only supplied fields change. The cross-field rule (a consumption query needs a class subject)
    is checked against the row as it *will be* — the supplied half merged over the stored half —
    so a PATCH cannot leave a contradiction behind by changing one side of it.
    """
    _ = tenant_slug
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    tenant_id = _tenant_id(auth_data)
    _require_user_id(auth_data)

    current = _load_action(tenant_id, action_id)
    supplied = body.model_fields_set

    try:
        fields: Dict[str, Any] = {}
        if body.name is not None:
            fields["name"] = normalize_action_name(body.name)
        if body.subject is not None:
            fields["subject"] = normalize_subject(body.subject)
        if "name_contains" in supplied:
            fields["name_contains"] = normalize_name_contains(body.name_contains)
        if body.effects is not None:
            fields["effects"] = normalize_effects(body.effects)

        merged_subject = fields.get("subject", current["subject"])
        merged_effects = fields.get("effects", current["effects"] or [])
        validate_effects_against_subject(merged_subject, merged_effects)
    except CustomActionValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        row = store.update_action(db, tenant_id=tenant_id, action_id=action_id, **fields)
    except store.CustomActionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None

    if row is None:
        raise HTTPException(status_code=404, detail="Custom action not found")
    return workspace_custom_action_out_from_row(row)


@router.delete("/{tenant_slug}/custom-actions/{action_id}")
async def delete_custom_action(
    tenant_slug: str,
    action_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, bool]:
    """Soft-delete a custom action, freeing its name for reuse."""
    _ = tenant_slug
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    tenant_id = _tenant_id(auth_data)
    _require_user_id(auth_data)

    if not store.delete_action(db, tenant_id=tenant_id, action_id=action_id):
        raise HTTPException(status_code=404, detail="Custom action not found")
    return {"success": True}


__all__ = ["router"]

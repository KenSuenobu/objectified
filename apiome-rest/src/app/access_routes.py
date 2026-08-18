"""
Access & IAM API routes (#3611, RC1-1.1).

Tenant-scoped endpoints backing the Access UI (``docs/planning/mockups/access/``):

* **Roles & permissions** — list/create/update/delete roles and edit the resource x action matrix.
* **Members** — list members, invite, re-issue an invitation, assign role, suspend/reinstate, offboard.
* **Access audit** — read the append-only, hash-chained access ledger (JSON + CSV export).

Plus a small **platform-admin plane** endpoint (``/v1/platform/access-overrides``) that is separate
from tenant administration: it authenticates a platform administrator and records an ``admin.override``
into the audit ledger of the affected tenant.

Authorization flows through the central guard in ``permissions.py``. Managing roles and members maps to
the ``members`` resource (Owner/Admin only by default); reading roles/members/audit requires
``members:view`` (every built-in role has it). Every grant, matrix change, and lifecycle action is
recorded in ``apiome.access_audit``.
"""

import csv
import io
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .auth import validate_authentication, validate_session_credentials
from .config import settings
from .database import db
from .license_capacity import assert_member_seat_available, require_member_seat
from .permissions import (
    ACTIONS,
    RESOURCES,
    Action,
    Resource,
    enforce_permission,
    enforce_platform_admin,
    is_valid_permission,
)

router = APIRouter(prefix="/v1/access", tags=["access"])
platform_router = APIRouter(prefix="/v1/platform", tags=["platform-admin"])

_VALID_STATUSES = {"active", "pending", "suspended"}


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class PermissionCell(BaseModel):
    """A single allowed ``resource:action`` grant in a role's matrix."""

    resource: str
    action: str


class RoleWriteRequest(BaseModel):
    """Create/update payload for a role (name, description, full permission grid)."""

    name: str = Field(..., min_length=1, max_length=128)
    description: Optional[str] = None
    permissions: List[PermissionCell] = Field(default_factory=list)


class RoleDuplicateRequest(BaseModel):
    """Clone an existing role under a new name."""

    name: str = Field(..., min_length=1, max_length=128)


class MemberInviteRequest(BaseModel):
    """Invite an existing account to the tenant and assign a role."""

    email: str = Field(..., min_length=3, max_length=255)
    role_id: Optional[str] = None


class MemberUpdateRequest(BaseModel):
    """Change a member's role and/or lifecycle status."""

    role_id: Optional[str] = None
    status: Optional[str] = None


class PlatformOverrideRequest(BaseModel):
    """A platform-admin override action to record against a tenant's audit ledger."""

    tenant_id: str
    target: str
    detail: Optional[Dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _slugify(name: str) -> str:
    """Derive a stable role slug from a display name (lowercase, hyphen-separated)."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "role"


def _actor_label(auth_data: Dict[str, Any]) -> Optional[str]:
    """Best display label for the acting user in the audit log."""
    return auth_data.get("user_email") or auth_data.get("user_name")


def _audit(auth_data: Dict[str, Any], **kwargs: Any) -> None:
    """Write an access-audit row, swallowing failures (audit is never allowed to fail the action)."""
    try:
        db.write_access_audit(
            actor_label=_actor_label(auth_data),
            source="api_key" if auth_data.get("auth_method") == "api_key" else "web",
            **kwargs,
        )
    except Exception:  # pragma: no cover - best-effort
        pass


def _role_to_response(role: Dict[str, Any]) -> Dict[str, Any]:
    """Shape a role row + its permission grid for the API."""
    perms = db.get_role_permissions(role["id"])
    return {
        "id": role["id"],
        "slug": role["slug"],
        "name": role["name"],
        "description": role.get("description"),
        "is_builtin": role.get("is_builtin", False),
        "member_count": int(role.get("member_count", 0) or 0),
        "permissions": [{"resource": p["resource"], "action": p["action"]} for p in perms],
    }


def _validated_pairs(cells: List[PermissionCell]) -> List[tuple]:
    """Validate and de-duplicate permission cells against the canonical vocabulary."""
    pairs: set = set()
    for cell in cells:
        if not is_valid_permission(cell.resource, cell.action):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid permission '{cell.resource}:{cell.action}'. "
                    f"Resources: {sorted(RESOURCES)}; actions: {sorted(ACTIONS)}."
                ),
            )
        pairs.add((cell.resource, cell.action))
    return list(pairs)


# ---------------------------------------------------------------------------
# Self: effective permissions (drives UI capability gating)
# ---------------------------------------------------------------------------


@router.get("/{tenant_slug}/permissions/me")
async def get_my_permissions(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, Any]:
    """Return the caller's effective ``resource:action`` permissions in this tenant.

    Tenant administrators are reported as having every permission. The UI uses this to show/hide
    mutating controls without hard-coding role names.
    """
    tenant_id = auth_data["tenant_id"]
    user_id = auth_data.get("user_id")
    is_admin = bool(user_id and db.is_user_tenant_admin(tenant_id, user_id))
    if is_admin:
        granted = sorted({f"{r}:{a}" for r in RESOURCES for a in ACTIONS})
    else:
        granted = sorted(db.get_effective_permissions(tenant_id, user_id) if user_id else set())
    return {"is_admin": is_admin, "permissions": granted}


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------


@router.get("/{tenant_slug}/roles")
async def list_roles(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> List[Dict[str, Any]]:
    """List the tenant's roles (built-in first) with member counts and permission grids."""
    enforce_permission(db, auth_data, Resource.MEMBERS, Action.VIEW)
    tenant_id = auth_data["tenant_id"]
    db.ensure_builtin_roles(tenant_id)
    return [_role_to_response(r) for r in db.list_roles(tenant_id)]


@router.get("/{tenant_slug}/roles/{role_id}")
async def get_role(
    tenant_slug: str,
    role_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, Any]:
    """Fetch a single role with its permission grid."""
    enforce_permission(db, auth_data, Resource.MEMBERS, Action.VIEW)
    role = db.get_role(auth_data["tenant_id"], role_id)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role not found: {role_id}")
    role["member_count"] = 0
    return _role_to_response({**role, "member_count": 0})


@router.post("/{tenant_slug}/roles")
async def create_role(
    tenant_slug: str,
    request: RoleWriteRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, Any]:
    """Create a custom role with an initial permission grid (Owner/Admin only by default)."""
    user_id = enforce_permission(db, auth_data, Resource.MEMBERS, Action.CREATE)
    tenant_id = auth_data["tenant_id"]
    db.ensure_builtin_roles(tenant_id)
    pairs = _validated_pairs(request.permissions)
    slug = _slugify(request.name)
    try:
        role = db.create_role(tenant_id, slug, request.name, request.description)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(
                status_code=409, detail=f"A role named '{request.name}' already exists"
            )
        raise HTTPException(status_code=500, detail=str(e))
    db.set_role_permissions(role["id"], pairs)
    _audit(
        auth_data,
        tenant_id=tenant_id,
        actor_id=user_id,
        action="role.created",
        target=request.name,
        detail={"role_id": role["id"], "permissions": [f"{r}:{a}" for r, a in pairs]},
    )
    return _role_to_response({**role, "member_count": 0})


@router.put("/{tenant_slug}/roles/{role_id}")
async def update_role(
    tenant_slug: str,
    role_id: str,
    request: RoleWriteRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, Any]:
    """Update a role's name/description and replace its permission grid.

    Built-in role names are immutable, but their permission grids may be tuned by an administrator.
    """
    user_id = enforce_permission(db, auth_data, Resource.MEMBERS, Action.EDIT)
    tenant_id = auth_data["tenant_id"]
    existing = db.get_role(tenant_id, role_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"Role not found: {role_id}")

    pairs = _validated_pairs(request.permissions)
    before = {f"{p['resource']}:{p['action']}" for p in db.get_role_permissions(role_id)}
    after = {f"{r}:{a}" for r, a in pairs}

    name = existing["name"] if existing.get("is_builtin") else request.name
    updated = db.update_role(tenant_id, role_id, name, request.description)
    db.set_role_permissions(role_id, pairs)

    _audit(
        auth_data,
        tenant_id=tenant_id,
        actor_id=user_id,
        action="permission.changed",
        target=updated["name"],
        detail={
            "role_id": role_id,
            "granted": sorted(after - before),
            "revoked": sorted(before - after),
        },
    )
    return _role_to_response({**updated, "member_count": 0})


@router.post("/{tenant_slug}/roles/{role_id}/duplicate")
async def duplicate_role(
    tenant_slug: str,
    role_id: str,
    request: RoleDuplicateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, Any]:
    """Clone a role's permission grid into a new custom role."""
    user_id = enforce_permission(db, auth_data, Resource.MEMBERS, Action.CREATE)
    tenant_id = auth_data["tenant_id"]
    source = db.get_role(tenant_id, role_id)
    if not source:
        raise HTTPException(status_code=404, detail=f"Role not found: {role_id}")
    pairs = [(p["resource"], p["action"]) for p in db.get_role_permissions(role_id)]
    try:
        clone = db.create_role(
            tenant_id, _slugify(request.name), request.name, source.get("description")
        )
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(
                status_code=409, detail=f"A role named '{request.name}' already exists"
            )
        raise HTTPException(status_code=500, detail=str(e))
    db.set_role_permissions(clone["id"], pairs)
    _audit(
        auth_data,
        tenant_id=tenant_id,
        actor_id=user_id,
        action="role.created",
        target=request.name,
        detail={"cloned_from": source["name"], "role_id": clone["id"]},
    )
    return _role_to_response({**clone, "member_count": 0})


@router.delete("/{tenant_slug}/roles/{role_id}", status_code=204)
async def delete_role(
    tenant_slug: str,
    role_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> None:
    """Delete a custom role. Built-in roles cannot be deleted."""
    user_id = enforce_permission(db, auth_data, Resource.MEMBERS, Action.DELETE)
    tenant_id = auth_data["tenant_id"]
    role = db.get_role(tenant_id, role_id)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role not found: {role_id}")
    if role.get("is_builtin"):
        raise HTTPException(status_code=400, detail="Built-in roles cannot be deleted")
    db.delete_role(tenant_id, role_id)
    _audit(
        auth_data,
        tenant_id=tenant_id,
        actor_id=user_id,
        action="role.deleted",
        target=role["name"],
        detail={"role_id": role_id},
    )


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------


@router.get("/{tenant_slug}/members")
async def list_members(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> List[Dict[str, Any]]:
    """List tenant members with their role, lifecycle status, and admin flag."""
    enforce_permission(db, auth_data, Resource.MEMBERS, Action.VIEW)
    tenant_id = auth_data["tenant_id"]
    db.ensure_builtin_roles(tenant_id)
    return db.list_members(tenant_id)


@router.post("/{tenant_slug}/members")
async def invite_member(
    tenant_slug: str,
    request: MemberInviteRequest,
    auth_data: Dict[str, Any] = Depends(require_member_seat),
) -> Dict[str, Any]:
    """Invite an existing account into the tenant and optionally assign a role.

    The invitee must already have an Apiome account (email-only invites that provision brand-new
    accounts are a later SSO/SCIM ticket). The new membership is created ``active``.

    Seat-gated (OLO-5.3, #4213): when the tenant's license seats
    (``seats.max_users_per_tenant``) are all occupied by non-suspended members, the
    request is refused with a structured 403 (code ``license-seats-exhausted``)
    before any lookup or write happens — including re-invites of existing members,
    which are inert at capacity anyway.
    """
    actor_id = enforce_permission(db, auth_data, Resource.MEMBERS, Action.CREATE)
    tenant_id = auth_data["tenant_id"]
    # `get_user_by_email` canonicalizes (trim + lowercase), so any casing resolves to one account.
    user = db.get_user_by_email(request.email)
    if not user:
        raise HTTPException(
            status_code=404,
            detail=f"No Apiome account found for {request.email}; ask them to sign up first.",
        )
    db.add_member(tenant_id, user["id"], status="active")
    role_name = None
    if request.role_id:
        role = db.get_role(tenant_id, request.role_id)
        if not role:
            raise HTTPException(status_code=404, detail=f"Role not found: {request.role_id}")
        db.assign_member_role(tenant_id, user["id"], request.role_id)
        role_name = role["name"]
    _audit(
        auth_data,
        tenant_id=tenant_id,
        actor_id=actor_id,
        action="member.invited",
        target=user["email"],
        detail={"user_id": user["id"], "role": role_name},
    )
    return {"user_id": user["id"], "email": user["email"], "status": "active", "role": role_name}


@router.patch("/{tenant_slug}/members/{user_id}")
async def update_member(
    tenant_slug: str,
    user_id: str,
    request: MemberUpdateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, Any]:
    """Assign a member's role and/or change their lifecycle status (suspend / reinstate)."""
    actor_id = enforce_permission(db, auth_data, Resource.MEMBERS, Action.EDIT)
    tenant_id = auth_data["tenant_id"]

    if request.role_id is not None:
        role = db.get_role(tenant_id, request.role_id)
        if not role:
            raise HTTPException(status_code=404, detail=f"Role not found: {request.role_id}")
        db.assign_member_role(tenant_id, user_id, request.role_id)
        _audit(
            auth_data,
            tenant_id=tenant_id,
            actor_id=actor_id,
            action="role.assigned",
            target=user_id,
            detail={"role": role["name"], "role_id": request.role_id},
        )

    if request.status is not None:
        if request.status not in _VALID_STATUSES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status '{request.status}'; expected one of {sorted(_VALID_STATUSES)}",
            )
        # Seat guard (OLO-5.3, #4213): suspended members don't occupy a license seat,
        # so reinstating one consumes a seat — re-check capacity before the transition.
        # Without this, suspend → invite → reinstate would sail past the limit.
        # Suspending (or re-asserting a non-suspended status) never needs a seat.
        if (
            request.status != "suspended"
            and settings.license_enforcement_enabled
            and db.get_member_status(tenant_id, user_id) == "suspended"
        ):
            assert_member_seat_available(tenant_id)
        updated = db.set_member_status(tenant_id, user_id, request.status)
        if not updated:
            raise HTTPException(status_code=404, detail=f"Member not found: {user_id}")
        action = "member.suspended" if request.status == "suspended" else "member.reinstated"
        _audit(
            auth_data,
            tenant_id=tenant_id,
            actor_id=actor_id,
            action=action,
            target=user_id,
            detail={"status": request.status},
        )

    return {"user_id": user_id, "role_id": request.role_id, "status": request.status}


@router.post("/{tenant_slug}/members/{user_id}/resend-invite")
async def resend_member_invite(
    tenant_slug: str,
    user_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, Any]:
    """Re-issue a member's outstanding invitation (HIVE-5.2, #5305).

    Apiome does not mail invitations: :func:`invite_member` requires the invitee to hold an
    account already, and a ``pending`` membership becomes ``active`` the next time they sign
    in. Re-issuing therefore renews the invitation rather than re-sending a message — the
    membership row is re-stamped so the members screen's "Invited {date}" reads freshly, and
    the renewal is recorded in the access ledger as ``member.invite_resent`` so an access
    review can see who kept an outstanding invitation alive.

    Gated on ``members:create``, the same permission as issuing the invitation in the first
    place. Consumes no seat: the pending membership already holds one, so the OLO-5.3
    capacity guard is deliberately not consulted.

    :raises HTTPException: 404 when the user has no membership in the tenant, 409 when their
        membership is not pending (there is no invitation outstanding to renew).
    """
    actor_id = enforce_permission(db, auth_data, Resource.MEMBERS, Action.CREATE)
    tenant_id = auth_data["tenant_id"]
    if db.touch_pending_membership(tenant_id, user_id):
        _audit(
            auth_data,
            tenant_id=tenant_id,
            actor_id=actor_id,
            action="member.invite_resent",
            target=user_id,
            detail={"user_id": user_id},
        )
        return {"user_id": user_id, "status": "pending"}

    # Nothing was re-stamped: say which of the two reasons it was, because they ask for
    # different things of the reader — invite them, or stop waiting for them.
    status = db.get_member_status(tenant_id, user_id)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Member not found: {user_id}")
    raise HTTPException(
        status_code=409,
        detail=f"Member {user_id} has no outstanding invitation (status '{status}')",
    )


@router.delete("/{tenant_slug}/members/{user_id}", status_code=204)
async def offboard_member(
    tenant_slug: str,
    user_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> None:
    """Offboard a member: remove membership, role assignment, and any tenant-admin row."""
    actor_id = enforce_permission(db, auth_data, Resource.MEMBERS, Action.DELETE)
    tenant_id = auth_data["tenant_id"]
    removed = db.remove_member(tenant_id, user_id)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Member not found: {user_id}")
    _audit(
        auth_data,
        tenant_id=tenant_id,
        actor_id=actor_id,
        action="member.offboarded",
        target=user_id,
        detail={"user_id": user_id},
    )


# ---------------------------------------------------------------------------
# Access audit
# ---------------------------------------------------------------------------

# Maps the audit UI filter tabs to an action prefix (None = all events).
_AUDIT_FILTERS = {
    "all": None,
    "role": "role.",
    "permission": "permission.",
    "member": "member.",
    "admin": "admin.",
    # Style-guide governance: create / edit / assign of style guides (GOV-1.6, #4432).
    "styleGuide": "style_guide.",
}


def _parse_audit_since(since: Optional[str]) -> Optional[datetime]:
    """Parse the `since` query parameter into an aware instant.

    Rejected rather than ignored, unlike an unknown `filter`: a filter the server does not
    know widens the answer to "everything", which is visibly wrong to the reader, whereas a
    date it silently dropped returns *more* history than was asked for while the UI still
    says the range was applied — the one failure mode an evidence export must not have.

    Args:
        since: An ISO 8601 instant, with `Z` or an offset. `None` means no lower bound.

    Returns:
        The instant, or `None` when no bound was given. A value with no timezone is read
        as UTC, which is what the ledger stores.

    Raises:
        HTTPException: 400 when the value is not ISO 8601.
    """
    if since is None or since == "":
        return None
    try:
        parsed = datetime.fromisoformat(since.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid 'since' value '{since}'; expected an ISO 8601 instant",
        ) from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


@router.get("/{tenant_slug}/audit")
async def list_audit(
    tenant_slug: str,
    filter: str = Query("all"),
    since: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> List[Dict[str, Any]]:
    """List access-audit entries for the tenant, newest first, with an optional category filter.

    Categories are `all`, `role`, `permission`, `member`, `admin` and `styleGuide`
    (style-guide governance: create / edit / assign, GOV-1.6). An unknown value is treated
    as `all`.

    `since` is an optional ISO 8601 lower bound on `created_at` — what the UI's date range
    sends, and what its CSV export sends back so the two agree (HIVE-5.5, #5308).

    Each row carries `prev_hash` and `entry_hash`, its position in the tenant's hash chain.
    """
    enforce_permission(db, auth_data, Resource.MEMBERS, Action.VIEW)
    prefix = _AUDIT_FILTERS.get(filter, None)
    return db.list_access_audit(
        auth_data["tenant_id"],
        action_prefix=prefix,
        since=_parse_audit_since(since),
        limit=limit,
    )


@router.get("/{tenant_slug}/audit/export")
async def export_audit(
    tenant_slug: str,
    filter: str = Query("all"),
    since: Optional[str] = Query(None),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> StreamingResponse:
    """Export the tenant's access-audit ledger as CSV (SOC 2 / ISO 27001 access-review evidence).

    Takes the same `filter` and `since` narrowing as the list endpoint, so the CSV holds the
    rows the reader was looking at rather than a second, wider answer. Omitting both exports
    the whole ledger, which is what every caller before HIVE-5.5 (#5308) got.
    """
    enforce_permission(db, auth_data, Resource.MEMBERS, Action.VIEW)
    rows = db.list_access_audit(
        auth_data["tenant_id"],
        action_prefix=_AUDIT_FILTERS.get(filter, None),
        since=_parse_audit_since(since),
        limit=1000,
    )

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["when", "actor", "event", "target", "source"])
    for r in rows:
        writer.writerow(
            [
                r.get("created_at"),
                r.get("actor_label") or r.get("actor_id") or "",
                r.get("action"),
                r.get("target") or "",
                r.get("source") or "",
            ]
        )
    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{tenant_slug}-access-audit.csv"'},
    )


# ---------------------------------------------------------------------------
# Platform-admin plane (separate from tenant administration)
# ---------------------------------------------------------------------------


@platform_router.post("/access-overrides", status_code=201)
async def record_platform_override(
    request: PlatformOverrideRequest,
    auth_data: Dict[str, Any] = Depends(validate_session_credentials),
) -> Dict[str, Any]:
    """Record a platform-admin override against a tenant's audit ledger (``source='admin'``).

    This is the platform plane: the caller must be a platform administrator (``platform_administrators``),
    which is independent of any tenant's admin/Owner role. The action is logged for the named tenant.
    """
    actor_id = enforce_platform_admin(db, auth_data)
    _audit_kwargs = dict(
        tenant_id=request.tenant_id,
        actor_id=actor_id,
        actor_label="platform-admin",
        action="admin.override",
        target=request.target,
        source="admin",
        detail=request.detail,
    )
    try:
        db.write_access_audit(**_audit_kwargs)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to record override: {e}")
    return {"recorded": True, "action": "admin.override", "target": request.target}

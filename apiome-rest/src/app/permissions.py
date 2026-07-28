"""
Central permission guard for granular RBAC (#3611, RC1-1.1).

Every mutating REST route enforces a ``resource:action`` permission through :func:`enforce_permission`,
replacing the scattered ``_assert_tenant_admin`` / ``is_user_tenant_admin`` checks. Authorization is
resolved in two planes:

1. **Full-access plane** — a tenant administrator (``apiome.tenant_administrators``) is treated as Owner
   and passes every check. This preserves backward compatibility: existing admins are never locked out
   while roles are rolled out, and the UI continues to treat ``tenant_administrators`` as authoritative.

2. **Granular role plane** — otherwise the user's assigned role (``apiome.tenant_user_roles`` ->
   ``apiome.role_permissions``) is consulted. A plain member with no explicit role assignment inherits the
   built-in **Editor** grid (any member could create/edit content before RBAC; this keeps that true).

A denied request is recorded in the append-only ``apiome.access_audit`` ledger (best-effort) and answered
with HTTP 403.

The guard takes the ``db`` handle as its first argument so each route passes its own module-level
``db`` (the object route unit-tests patch). Resolution leans on the data helpers
``db.is_user_tenant_admin`` and ``db.get_effective_permissions``.
"""

from typing import Any, Dict, Optional

from fastapi import HTTPException


class Resource:
    """Permission resources (the rows of the matrix in ``access/roles.html``)."""

    PROJECTS = "projects"
    VERSIONS = "versions"
    CLASSES = "classes"
    PROPERTIES = "properties"
    PATHS = "paths"
    TYPES = "types"
    IMPORTS = "imports"
    MEMBERS = "members"
    API_KEYS = "api_keys"
    BILLING = "billing"
    LINT_FINDINGS = "lint_findings"
    VERIFICATION_TARGETS = "verification_targets"
    VERIFICATION_EVIDENCE = "verification_evidence"


class Action:
    """Permission actions (the columns of the matrix in ``access/roles.html``)."""

    VIEW = "view"
    CREATE = "create"
    EDIT = "edit"
    DELETE = "delete"
    PUBLISH = "publish"


# The canonical resource / action vocabulary. Used to validate custom-role permission grids.
RESOURCES = frozenset(
    {
        Resource.PROJECTS,
        Resource.VERSIONS,
        Resource.CLASSES,
        Resource.PROPERTIES,
        Resource.PATHS,
        Resource.TYPES,
        Resource.IMPORTS,
        Resource.MEMBERS,
        Resource.API_KEYS,
        Resource.BILLING,
        Resource.LINT_FINDINGS,
        Resource.VERIFICATION_TARGETS,
        Resource.VERIFICATION_EVIDENCE,
    }
)

ACTIONS = frozenset(
    {Action.VIEW, Action.CREATE, Action.EDIT, Action.DELETE, Action.PUBLISH}
)


def permission_key(resource: str, action: str) -> str:
    """Return the canonical ``resource:action`` key (e.g. ``version:publish`` -> ``versions:publish``)."""
    return f"{resource}:{action}"


def is_valid_permission(resource: str, action: str) -> bool:
    """True when ``resource`` and ``action`` are both part of the canonical vocabulary."""
    return resource in RESOURCES and action in ACTIONS


def _resolve_actor_id(db: Any, auth_data: Dict[str, Any]) -> Optional[str]:
    """
    Resolve the acting user id for attribution/authorization.

    JWT: the ``user_id`` claim. API key: ``user_id`` when the key carries one, otherwise the tenant's
    fallback creator (legacy keys). Uses the *passed* ``db`` so route unit-tests that patch their
    module-level ``db`` exercise the guard against the same double.
    """
    raw = auth_data.get("user_id")
    if raw is not None and str(raw).strip() != "":
        return str(raw)
    if auth_data.get("auth_method") == "api_key":
        tenant_id = auth_data.get("tenant_id")
        if tenant_id is not None and str(tenant_id).strip() != "":
            return db.get_fallback_creator_user_id_for_tenant(str(tenant_id))
    return None


def _audit_denied(
    db: Any,
    tenant_id: Optional[str],
    user_id: Optional[str],
    auth_data: Dict[str, Any],
    resource: str,
    action: str,
    target: Optional[str],
) -> None:
    """Best-effort denial entry; a failed audit insert must never mask the 403."""
    try:
        db.write_access_audit(
            tenant_id=tenant_id,
            actor_id=user_id,
            actor_label=auth_data.get("user_email") or auth_data.get("user_name"),
            action="permission.denied",
            target=target or permission_key(resource, action),
            source="api_key" if auth_data.get("auth_method") == "api_key" else "web",
            detail={"resource": resource, "action": action},
        )
    except Exception:  # pragma: no cover - audit is strictly best-effort
        pass


def enforce_permission(
    db: Any,
    auth_data: Dict[str, Any],
    resource: str,
    action: str,
    *,
    target: Optional[str] = None,
) -> str:
    """
    Require the authenticated caller to hold ``resource:action`` in the current tenant.

    Args:
        db: The database handle (each route passes its module-level ``db``).
        auth_data: The dict returned by ``validate_authentication`` (tenant_id, user_id, auth_method).
        resource: One of :class:`Resource`.
        action: One of :class:`Action`.
        target: Optional human-readable subject of the action, recorded on a denial.

    Returns:
        The resolved acting user id (handy for attributing the mutation).

    Raises:
        HTTPException: 403 when no user can be resolved or the permission is not granted.
    """
    user_id = _resolve_actor_id(db, auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="Authenticated user required for this operation",
        )

    tenant_id = auth_data.get("tenant_id")

    # Tenant administrators (Owner-equivalent) pass everything; otherwise the member's assigned role
    # (or the Editor default) must grant resource:action. Resolution lives in db.user_has_permission.
    if db.user_has_permission(tenant_id, user_id, resource, action):
        return user_id

    _audit_denied(db, tenant_id, user_id, auth_data, resource, action, target)
    raise HTTPException(
        status_code=403,
        detail=f"Permission denied: {permission_key(resource, action)} is required",
    )


def has_permission(
    db: Any, auth_data: Dict[str, Any], resource: str, action: str
) -> bool:
    """Non-raising variant of :func:`enforce_permission` for conditional UI/logic branches."""
    user_id = _resolve_actor_id(db, auth_data)
    if not user_id:
        return False
    tenant_id = auth_data.get("tenant_id")
    return db.user_has_permission(tenant_id, user_id, resource, action)


def enforce_platform_admin(db: Any, auth_data: Dict[str, Any]) -> str:
    """
    Require the caller to be a platform administrator (the plane separate from tenant admin).

    Platform admins act across tenants (support / compliance overrides) and are audited as
    ``source='admin'``. Returns the acting user id; raises 403 otherwise.
    """
    user_id = _resolve_actor_id(db, auth_data)
    if not user_id or not db.is_platform_admin(user_id):
        raise HTTPException(
            status_code=403,
            detail="Platform administrator privileges are required for this operation",
        )
    return user_id

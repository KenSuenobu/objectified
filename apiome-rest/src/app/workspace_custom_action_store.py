"""Custom palette actions — tenant-scoped persistence (DUW-5.5, private-suite#2592).

The SQL half of the custom-actions API: CRUD over ``apiome.workspace_custom_actions`` (V243).
Validation lives in :mod:`app.workspace_custom_action_rules` and never here — by the time a value
reaches this module it is canonical, and everything this module adds is scoping and durability:

**Every statement is scoped by ``tenant_id``.** An action is tenant configuration, reached through
nothing but the tenant, so the tenant appears in every WHERE clause — including the ones already
holding the row's own id. A row of another tenant is thereby unreadable, unupdatable and
undeletable rather than merely unlisted, and the routes' "another tenant's row is a 404" rule
falls out of the query shape instead of being asserted around it.

**Deletes are soft.** ``deleted_at`` is set, never the row removed, matching ``apiome.domains``
(V242): the partial unique index frees the name immediately, and the tombstone keeps the audit
trail. Every read filters ``deleted_at IS NULL``.

**Reads commit.** Matching :mod:`app.workspace_summary_store`: psycopg2 opens a transaction for a
bare SELECT too, and leaving the shared connection idle in one holds locks and blocks VACUUM.

Errors follow :mod:`app.domains_store`: the SQLSTATE is read off the exception (so a fake
connection works in tests), and a unique violation surfaces as the typed
:class:`CustomActionConflictError` the route maps to a 409.
"""

from __future__ import annotations

import json
import uuid as _uuid
from typing import Any, Dict, List, Optional, Protocol, Sequence

__all__ = [
    "ACTION_COLUMNS",
    "CustomActionConflictError",
    "create_action",
    "delete_action",
    "get_action",
    "list_actions",
    "update_action",
]

#: Every column the API reads back, in a stable order shared by SELECT and RETURNING.
ACTION_COLUMNS = (
    "id, tenant_id, created_by, name, subject, name_contains, effects, "
    "deleted_at, created_at, updated_at"
)


class _DbLike(Protocol):
    """Minimal database surface used by this module."""

    def connect(self) -> Any: ...


#: Distinguishes "field not supplied" from "field supplied as None" for the one nullable column.
_UNSET: Any = object()


class CustomActionConflictError(Exception):
    """A live action in this tenant already holds this name.

    Attributes:
        name: The colliding name, so the route can print which one to change.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f"A custom action named '{name}' already exists.")


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _as_dict(row: Any) -> Optional[Dict[str, Any]]:
    """Normalize a cursor row to a plain dict, preserving None."""
    return None if row is None else dict(row)


def _fetch_all(cursor: Any, query: str, params: Sequence[Any]) -> List[Dict[str, Any]]:
    """Execute a query and return every row as a plain dict."""
    cursor.execute(query, params)
    return [dict(row) for row in (cursor.fetchall() or [])]


def _fetch_one(cursor: Any, query: str, params: Sequence[Any]) -> Optional[Dict[str, Any]]:
    """Execute a query and return the first row as a plain dict, or None."""
    cursor.execute(query, params)
    return _as_dict(cursor.fetchone())


def _sqlstate(exc: Exception) -> str:
    """Best-effort SQLSTATE of a database error.

    Read from the exception rather than matched on its class so the module keeps working against a
    fake connection in tests, where ``psycopg2.errors.*`` is not what gets raised.

    Args:
        exc: The exception a write raised.

    Returns:
        The five-character SQLSTATE, or an empty string when there is none.
    """
    return str(getattr(exc, "pgcode", "") or "")


def _is_unique_violation(exc: Exception) -> bool:
    """Whether an exception is Postgres' unique-violation (SQLSTATE 23505)."""
    if _sqlstate(exc) == "23505":
        return True
    return "duplicate key" in str(exc).lower()


def _is_uuid(value: Optional[str]) -> bool:
    """Whether a string is something the ``uuid`` column type would accept.

    Guards every id before it reaches the driver, so garbage in a path segment reads as the 404 it
    means rather than as an ``InvalidTextRepresentation`` 500.

    Args:
        value: The candidate id.

    Returns:
        True when it can be cast to ``uuid``.
    """
    if not value:
        return False
    try:
        _uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return False
    return True


# ─── Reads ───────────────────────────────────────────────────────────────────


def list_actions(db: _DbLike, *, tenant_id: str) -> List[Dict[str, Any]]:
    """List a tenant's live custom actions, alphabetically by name.

    Alphabetical rather than by creation: the palette appends these after the built-ins, and a
    band whose custom rows reorder themselves when someone edits one would move rows under the
    reader's cursor between opens.

    Args:
        db: Database handle.
        tenant_id: The caller's tenant.

    Returns:
        The live action rows, name-ordered.
    """
    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            rows = _fetch_all(
                cursor,
                f"""
                SELECT {ACTION_COLUMNS}
                  FROM apiome.workspace_custom_actions
                 WHERE tenant_id = %s::uuid AND deleted_at IS NULL
                 ORDER BY lower(name) ASC
                """,
                (tenant_id,),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return rows


def get_action(db: _DbLike, *, tenant_id: str, action_id: str) -> Optional[Dict[str, Any]]:
    """Load one live action inside a tenant.

    Args:
        db: Database handle.
        tenant_id: The caller's tenant.
        action_id: The action.

    Returns:
        The row, or None when it is missing, deleted, malformed, or another tenant's.
    """
    if not _is_uuid(action_id):
        return None
    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            row = _fetch_one(
                cursor,
                f"""
                SELECT {ACTION_COLUMNS}
                  FROM apiome.workspace_custom_actions
                 WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
                """,
                (action_id, tenant_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return row


# ─── Writes ──────────────────────────────────────────────────────────────────


def create_action(
    db: _DbLike,
    *,
    tenant_id: str,
    created_by: Optional[str],
    name: str,
    subject: str,
    name_contains: Optional[str],
    effects: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Create a custom action in a tenant.

    Args:
        db: Database handle.
        tenant_id: The owning tenant.
        created_by: The creating user, for attribution; None for an unattributable principal.
        name: Display name, already validated.
        subject: Matcher subject kind, already validated.
        name_contains: Matcher substring, already validated; None for no narrowing.
        effects: The canonical effect list, already validated.

    Returns:
        The inserted row.

    Raises:
        CustomActionConflictError: When a live action in this tenant already holds the name.
    """
    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            row = _fetch_one(
                cursor,
                f"""
                INSERT INTO apiome.workspace_custom_actions
                    (tenant_id, created_by, name, subject, name_contains, effects)
                VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s::jsonb)
                RETURNING {ACTION_COLUMNS}
                """,
                (tenant_id, created_by, name, subject, name_contains, json.dumps(effects)),
            )
        conn.commit()
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed conflict or unchanged
        conn.rollback()
        if _is_unique_violation(exc):
            raise CustomActionConflictError(name) from exc
        raise
    if row is None:  # pragma: no cover - RETURNING always yields a row on a successful INSERT
        raise RuntimeError("The custom action could not be created.")
    return row


def update_action(
    db: _DbLike,
    *,
    tenant_id: str,
    action_id: str,
    name: Optional[str] = None,
    subject: Optional[str] = None,
    name_contains: Any = _UNSET,
    effects: Optional[List[Dict[str, Any]]] = None,
) -> Optional[Dict[str, Any]]:
    """Update a custom action; only supplied fields are written.

    ``name_contains`` is the one nullable field, so ``None`` is a *value* for it (clear the
    narrowing) rather than "leave it alone" — the ``_UNSET`` sentinel default distinguishes the
    two. Every other argument treats None as "not supplied", matching
    :func:`app.domains_store.update_domain`.

    Args:
        db: Database handle.
        tenant_id: The caller's tenant.
        action_id: The action.
        name: New display name, or None to leave it.
        subject: New subject kind, or None to leave it.
        name_contains: New matcher substring, None to clear it, or unsupplied to leave it.
        effects: New effect list, or None to leave it.

    Returns:
        The updated row, or None when the action is missing, deleted, or another tenant's. When
        nothing was supplied, the current row is returned unchanged.

    Raises:
        CustomActionConflictError: When the new name is taken by another live action.
    """
    if not _is_uuid(action_id):
        return None

    assignments: List[str] = []
    params: List[Any] = []
    if name is not None:
        assignments.append("name = %s")
        params.append(name)
    if subject is not None:
        assignments.append("subject = %s")
        params.append(subject)
    if name_contains is not _UNSET:
        assignments.append("name_contains = %s")
        params.append(name_contains)
    if effects is not None:
        assignments.append("effects = %s::jsonb")
        params.append(json.dumps(effects))

    if not assignments:
        return get_action(db, tenant_id=tenant_id, action_id=action_id)

    params.extend([action_id, tenant_id])
    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            row = _fetch_one(
                cursor,
                f"""
                UPDATE apiome.workspace_custom_actions
                   SET {', '.join(assignments)}
                 WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
                RETURNING {ACTION_COLUMNS}
                """,
                tuple(params),
            )
        conn.commit()
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed conflict or unchanged
        conn.rollback()
        if _is_unique_violation(exc):
            raise CustomActionConflictError(name or "") from exc
        raise
    return row


def delete_action(db: _DbLike, *, tenant_id: str, action_id: str) -> bool:
    """Soft-delete a custom action, freeing its name for reuse.

    Args:
        db: Database handle.
        tenant_id: The caller's tenant.
        action_id: The action.

    Returns:
        True when a live action was deleted; False when there was nothing to delete.
    """
    if not _is_uuid(action_id):
        return False
    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            row = _fetch_one(
                cursor,
                """
                UPDATE apiome.workspace_custom_actions
                   SET deleted_at = CURRENT_TIMESTAMP
                 WHERE id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL
                RETURNING id
                """,
                (action_id, tenant_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return row is not None

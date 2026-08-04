"""Persistence for domain folders — DUW-1.1 (private-suite#2568).

Reads and writes ``apiome.domains`` and the ``domain_id`` columns V242 adds to ``apiome.classes``
and ``apiome.version_path``. Follows :mod:`app.slate_cache_store`: a small ``_DbLike`` protocol
rather than a dependency on the concrete ``Database`` singleton, so every function here is
exercisable against a fake connection, and an explicit ``commit``/``rollback`` around each write.

Three things about the model are worth knowing before reading any function:

**`shared/` is not a row.** A class or path with ``domain_id IS NULL`` is *in* ``shared/``; the
bucket is derived, not stored. :data:`SHARED_DOMAIN_ID` is the token the REST layer accepts in
place of a UUID, and :func:`resolve_domain_id` is the single place it turns back into ``None``.
Because the bucket is derived it always exists, cannot be renamed, and needs no row to be listed —
which is why :func:`list_domains` synthesizes it rather than selecting it.

**Deleting a domain never deletes content.** :func:`delete_domain` soft-deletes, and V242's
``trg_domains_soft_delete_release`` releases the members to ``shared/`` in the same statement. The
release is deliberately *not* re-implemented here: leaving it to the trigger means a member cannot
be stranded behind a tombstone by any writer, including one that never calls this module.

**A domain belongs to exactly one version.** V242's membership guard rejects a cross-version
assignment with SQLSTATE 23503, so :func:`assign_class` and :func:`assign_path` translate that into
:class:`DomainScopeError` instead of letting an ``IntegrityError`` reach a route handler.
"""

from __future__ import annotations

import re
import uuid as _uuid
from typing import Any, Dict, List, Optional, Protocol, Sequence

__all__ = [
    "DOMAIN_COLUMNS",
    "SHARED_DOMAIN_ID",
    "DomainConflictError",
    "DomainScopeError",
    "assign_class",
    "assign_path",
    "count_members",
    "create_domain",
    "delete_domain",
    "get_class",
    "get_domain",
    "get_path",
    "is_valid_slug",
    "list_domains",
    "next_sort_order",
    "resolve_domain_id",
    "shared_bucket",
    "slugify",
    "update_domain",
]

#: Every column the API reads back, in a stable order shared by SELECT and RETURNING.
DOMAIN_COLUMNS = "id, version_id, name, slug, sort_order, deleted_at, created_at, updated_at"

#: The token standing in for "no domain" wherever a domain id is accepted. Matches the reserved
#: slug V242 forbids a stored domain from taking, so the two can never denote different folders.
SHARED_DOMAIN_ID = "shared"

#: Characters that survive a URL and a ``?domain_id=`` filter unescaped. Mirrors the
#: ``domains_slug_format`` CHECK in V242 — the database is the authority, this is the early answer.
_SLUG_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


class _DbLike(Protocol):
    """Minimal database surface used by this module."""

    def connect(self) -> Any: ...


class DomainConflictError(Exception):
    """A live domain in this version already holds this name or slug.

    Attributes:
        field: Which of ``name`` or ``slug`` collided, so the route can say which one to change.
    """

    def __init__(self, field: str, value: str) -> None:
        self.field = field
        self.value = value
        super().__init__(f"A domain with the {field} '{value}' already exists in this version.")


class DomainScopeError(Exception):
    """The target domain is deleted, missing, or belongs to a different version.

    Raised where V242's membership guard fires. All three cases collapse into one error because
    they are one fact from the caller's side: the domain it named is not a folder this item may
    join.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)


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


def _is_scope_violation(exc: Exception) -> bool:
    """Whether an exception is V242's membership guard firing (SQLSTATE 23503).

    The guard raises ``foreign_key_violation`` deliberately, so a cross-version assignment and a
    dangling ``domain_id`` are indistinguishable to the caller — both mean "not a folder you may
    join".
    """
    if _sqlstate(exc) == "23503":
        return True
    lowered = str(exc).lower()
    return "does not exist or has been deleted" in lowered or "belongs to version" in lowered


def _conflict_field(exc: Exception) -> str:
    """Which uniqueness the database rejected, read from the violated index name."""
    return "name" if "uq_domains_version_name" in str(exc) else "slug"


def _is_uuid(value: Optional[str]) -> bool:
    """Whether a string is something the ``uuid`` column type would accept.

    Deliberately as permissive as Postgres — any 32 hex digits — rather than RFC-4122-strict like
    :func:`app.revision_deprecation.is_uuid_string`. A stored id that predates ``uuid_generate_v4``
    or arrived from an import may not carry a conforming version/variant nibble, and answering 404
    for a row that exists would be worse than the cast error this guards against.

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


def slugify(text: str) -> Optional[str]:
    """Reduce free text to the slug format V242's CHECK accepts.

    Args:
        text: Any user-supplied name.

    Returns:
        A lowercase hyphen-separated slug, or None when nothing usable survives (an all-punctuation
        name, or the reserved ``shared``, which no stored domain may take).
    """
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    if not slug or slug == SHARED_DOMAIN_ID:
        return None
    return slug


def is_valid_slug(slug: str) -> bool:
    """Whether a caller-supplied slug is one the database will accept."""
    return bool(slug) and slug != SHARED_DOMAIN_ID and bool(_SLUG_PATTERN.match(slug))


def shared_bucket(version_id: str, sort_order: int) -> Dict[str, Any]:
    """Build the derived ``shared/`` folder for a version.

    Synthesized rather than selected, because the bucket is the *absence* of a domain and so has no
    row to select. It carries ``id=None`` — the signal to a client that this folder cannot be
    renamed, reordered or deleted — and sorts last, where the mockup draws it.

    Args:
        version_id: The version whose unassigned members it collects.
        sort_order: Position in the tree, normally one past the last real domain.

    Returns:
        A domain-shaped dict with no id and no timestamps.
    """
    return {
        "id": None,
        "version_id": version_id,
        "name": SHARED_DOMAIN_ID,
        "slug": SHARED_DOMAIN_ID,
        "sort_order": sort_order,
        "deleted_at": None,
        "created_at": None,
        "updated_at": None,
        "virtual": True,
    }


def resolve_domain_id(domain_id: Optional[str]) -> Optional[str]:
    """Turn an API-level domain reference into a storable ``domain_id``.

    ``None`` and the literal ``"shared"`` both denote the derived bucket and both store as NULL;
    everything else is passed through unchanged for the database to validate.

    Args:
        domain_id: A domain UUID, the :data:`SHARED_DOMAIN_ID` token, or None.

    Returns:
        The value to store — None for the shared bucket.
    """
    if domain_id is None or domain_id == SHARED_DOMAIN_ID:
        return None
    return domain_id


# ─── Reads ───────────────────────────────────────────────────────────────────


def get_domain(db: _DbLike, *, domain_id: str, include_deleted: bool = False) -> Optional[Dict[str, Any]]:
    """Load one domain by id.

    Not tenant-scoped: a domain is reached through its version, and the route layer resolves that
    version against the caller's tenant before calling here.

    Args:
        db: Database handle exposing ``connect()``.
        domain_id: The domain.
        include_deleted: Whether a soft-deleted row still counts as found. False everywhere except
            where a caller needs to distinguish "never existed" from "already deleted".

    Returns:
        The row, or None.
    """
    # A non-UUID id can never match and would otherwise raise InvalidTextRepresentation at the
    # `::uuid` cast — a 500 for what is really "no such domain".
    if not _is_uuid(domain_id):
        return None

    predicate = "" if include_deleted else " AND deleted_at IS NULL"
    conn = db.connect()
    with conn.cursor() as cursor:
        return _fetch_one(
            cursor,
            f"SELECT {DOMAIN_COLUMNS} FROM apiome.domains WHERE id = %s::uuid{predicate}",
            (domain_id,),
        )


def list_domains(db: _DbLike, *, version_id: str) -> List[Dict[str, Any]]:
    """List a version's live domains in tree order.

    Ordered by ``sort_order`` then ``slug`` so a tree drawn from this is stable even when two
    domains were given the same explicit order. The derived ``shared/`` bucket is not included —
    :func:`shared_bucket` synthesizes it, because it exists whether or not anything is in it.

    Args:
        db: Database handle.
        version_id: The version whose folders these are.

    Returns:
        The rows, in the order the workspace tree draws them.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        return _fetch_all(
            cursor,
            f"""
            SELECT {DOMAIN_COLUMNS}
              FROM apiome.domains
             WHERE version_id = %s::uuid AND deleted_at IS NULL
             ORDER BY sort_order, slug
            """,
            (version_id,),
        )


def next_sort_order(db: _DbLike, *, version_id: str) -> int:
    """The sort order placing a new domain last in this version's tree.

    Args:
        db: Database handle.
        version_id: The version.

    Returns:
        One past the highest live ``sort_order``, or 0 when the version has no domains.
    """
    conn = db.connect()
    with conn.cursor() as cursor:
        row = _fetch_one(
            cursor,
            """
            SELECT COALESCE(MAX(sort_order) + 1, 0) AS next
              FROM apiome.domains
             WHERE version_id = %s::uuid AND deleted_at IS NULL
            """,
            (version_id,),
        )
    return int((row or {}).get("next") or 0)


def count_members(db: _DbLike, *, domain_id: Optional[str], version_id: str) -> Dict[str, int]:
    """Count the classes and paths filed under one folder.

    Args:
        db: Database handle.
        domain_id: The domain, or None for the derived ``shared/`` bucket.
        version_id: The version. Required even with a ``domain_id``, because the shared bucket has
            no id and can only be identified by the version it belongs to.

    Returns:
        ``{"class_count", "path_count"}``. Soft-deleted classes are excluded; ``version_path`` has
        no soft delete, so every row counts.
    """
    if domain_id is None:
        class_query = """
            SELECT COUNT(*) AS n FROM apiome.classes
             WHERE version_id = %s::uuid AND deleted_at IS NULL AND domain_id IS NULL
        """
        path_query = """
            SELECT COUNT(*) AS n FROM apiome.version_path
             WHERE version_id = %s::uuid AND domain_id IS NULL
        """
        params: Sequence[Any] = (version_id,)
    else:
        class_query = """
            SELECT COUNT(*) AS n FROM apiome.classes
             WHERE version_id = %s::uuid AND deleted_at IS NULL AND domain_id = %s::uuid
        """
        path_query = """
            SELECT COUNT(*) AS n FROM apiome.version_path
             WHERE version_id = %s::uuid AND domain_id = %s::uuid
        """
        params = (version_id, domain_id)

    conn = db.connect()
    with conn.cursor() as cursor:
        classes = _fetch_one(cursor, class_query, params) or {}
        paths = _fetch_one(cursor, path_query, params) or {}
    return {
        "class_count": int(classes.get("n") or 0),
        "path_count": int(paths.get("n") or 0),
    }


def get_class(db: _DbLike, *, class_id: str) -> Optional[Dict[str, Any]]:
    """Load the membership-relevant columns of one class.

    Args:
        db: Database handle.
        class_id: The class.

    Returns:
        ``{"id", "version_id", "name", "domain_id"}``, or None when it is missing or soft-deleted.
    """
    if not _is_uuid(class_id):
        return None

    conn = db.connect()
    with conn.cursor() as cursor:
        return _fetch_one(
            cursor,
            """
            SELECT id, version_id, name, domain_id
              FROM apiome.classes
             WHERE id = %s::uuid AND deleted_at IS NULL
            """,
            (class_id,),
        )


def get_path(db: _DbLike, *, path_id: str) -> Optional[Dict[str, Any]]:
    """Load the membership-relevant columns of one path.

    Args:
        db: Database handle.
        path_id: The path.

    Returns:
        ``{"id", "version_id", "pathname", "domain_id"}``, or None.
    """
    if not _is_uuid(path_id):
        return None

    conn = db.connect()
    with conn.cursor() as cursor:
        return _fetch_one(
            cursor,
            """
            SELECT id, version_id, pathname, domain_id
              FROM apiome.version_path
             WHERE id = %s::uuid
            """,
            (path_id,),
        )


# ─── Writes ──────────────────────────────────────────────────────────────────


def create_domain(
    db: _DbLike,
    *,
    version_id: str,
    name: str,
    slug: str,
    sort_order: int,
) -> Dict[str, Any]:
    """Create a domain folder in a version.

    Args:
        db: Database handle.
        version_id: The version this folder groups within.
        name: Display name.
        slug: URL-safe identifier, already validated by :func:`is_valid_slug`.
        sort_order: Position in the tree.

    Returns:
        The inserted row.

    Raises:
        DomainConflictError: When a live domain in this version already holds the name or slug.
    """
    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            row = _fetch_one(
                cursor,
                f"""
                INSERT INTO apiome.domains (version_id, name, slug, sort_order)
                VALUES (%s::uuid, %s, %s, %s)
                RETURNING {DOMAIN_COLUMNS}
                """,
                (version_id, name, slug, sort_order),
            )
        conn.commit()
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed conflict or unchanged
        conn.rollback()
        if _is_unique_violation(exc):
            field = _conflict_field(exc)
            raise DomainConflictError(field, name if field == "name" else slug) from exc
        raise
    if row is None:  # pragma: no cover - RETURNING always yields a row on a successful INSERT
        raise DomainScopeError("The domain could not be created.")
    return row


def update_domain(
    db: _DbLike,
    *,
    domain_id: str,
    name: Optional[str] = None,
    slug: Optional[str] = None,
    sort_order: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Rename or reorder a domain.

    Every argument is optional and only the supplied ones are written, so a rename cannot silently
    reset a tree position the caller never mentioned.

    Args:
        db: Database handle.
        domain_id: The domain.
        name: New display name, or None to leave it.
        slug: New slug, or None to leave it.
        sort_order: New tree position, or None to leave it.

    Returns:
        The updated row, or None when the domain is missing or already deleted. When nothing was
        supplied, the current row is returned unchanged.

    Raises:
        DomainConflictError: When the new name or slug is taken by another live domain.
    """
    assignments: List[str] = []
    params: List[Any] = []
    if name is not None:
        assignments.append("name = %s")
        params.append(name)
    if slug is not None:
        assignments.append("slug = %s")
        params.append(slug)
    if sort_order is not None:
        assignments.append("sort_order = %s")
        params.append(sort_order)

    if not assignments:
        return get_domain(db, domain_id=domain_id)

    params.append(domain_id)
    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            row = _fetch_one(
                cursor,
                f"""
                UPDATE apiome.domains
                   SET {', '.join(assignments)}
                 WHERE id = %s::uuid AND deleted_at IS NULL
                RETURNING {DOMAIN_COLUMNS}
                """,
                tuple(params),
            )
        conn.commit()
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed conflict or unchanged
        conn.rollback()
        if _is_unique_violation(exc):
            field = _conflict_field(exc)
            raise DomainConflictError(field, (name or "") if field == "name" else (slug or "")) from exc
        raise
    return row


def delete_domain(db: _DbLike, *, domain_id: str) -> Optional[Dict[str, Any]]:
    """Soft-delete a domain, releasing its members to ``shared/``.

    The release is V242's ``trg_domains_soft_delete_release``, which fires on this same UPDATE. It
    is not repeated here on purpose: a member released by a trigger cannot be stranded by a writer
    that forgot to release it.

    Args:
        db: Database handle.
        domain_id: The domain.

    Returns:
        The tombstoned row, or None when it was already deleted or never existed.
    """
    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            row = _fetch_one(
                cursor,
                f"""
                UPDATE apiome.domains
                   SET deleted_at = CURRENT_TIMESTAMP
                 WHERE id = %s::uuid AND deleted_at IS NULL
                RETURNING {DOMAIN_COLUMNS}
                """,
                (domain_id,),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return row


def _assign(
    db: _DbLike,
    *,
    table: str,
    id_column: str,
    returning: str,
    member_id: str,
    domain_id: Optional[str],
    extra_predicate: str = "",
) -> Optional[Dict[str, Any]]:
    """Move one member between folders. Shared by :func:`assign_class` and :func:`assign_path`.

    Args:
        db: Database handle.
        table: Fully qualified member table.
        id_column: Primary key column name.
        returning: Columns to read back.
        member_id: The class or path being moved.
        domain_id: Destination domain, or None for ``shared/``.
        extra_predicate: Additional SQL predicate, used to exclude soft-deleted classes.

    Returns:
        The updated row, or None when the member does not exist.

    Raises:
        DomainScopeError: When V242's membership guard rejects the destination.
    """
    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            row = _fetch_one(
                cursor,
                f"""
                UPDATE {table}
                   SET domain_id = %s::uuid
                 WHERE {id_column} = %s::uuid{extra_predicate}
                RETURNING {returning}
                """,
                (domain_id, member_id),
            )
        conn.commit()
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed scope error or unchanged
        conn.rollback()
        if _is_scope_violation(exc):
            raise DomainScopeError(
                "That domain does not exist in this version, or has been deleted."
            ) from exc
        raise
    return row


def assign_class(db: _DbLike, *, class_id: str, domain_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """File a class under a domain, or release it to ``shared/`` with ``domain_id=None``.

    Args:
        db: Database handle.
        class_id: The class to move.
        domain_id: Destination domain, or None for the shared bucket.

    Returns:
        ``{"id", "version_id", "name", "domain_id"}``, or None when the class does not exist.

    Raises:
        DomainScopeError: When the destination is deleted, missing, or in another version.
    """
    return _assign(
        db,
        table="apiome.classes",
        id_column="id",
        returning="id, version_id, name, domain_id",
        member_id=class_id,
        domain_id=domain_id,
        extra_predicate=" AND deleted_at IS NULL",
    )


def assign_path(db: _DbLike, *, path_id: str, domain_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """File a path under a domain, or release it to ``shared/`` with ``domain_id=None``.

    Args:
        db: Database handle.
        path_id: The path to move.
        domain_id: Destination domain, or None for the shared bucket.

    Returns:
        ``{"id", "version_id", "pathname", "domain_id"}``, or None when the path does not exist.

    Raises:
        DomainScopeError: When the destination is deleted, missing, or in another version.
    """
    return _assign(
        db,
        table="apiome.version_path",
        id_column="id",
        returning="id, version_id, pathname, domain_id",
        member_id=path_id,
        domain_id=domain_id,
    )

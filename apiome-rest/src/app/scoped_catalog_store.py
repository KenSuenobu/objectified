"""Selection-scoped catalog reads — DUW-1.2 (private-suite#2569).

The workspace canvas hydrates what the user selected, not what the version contains. Every read in
this module is therefore bounded before it runs: by an explicit id set, or by one domain folder
plus a page size. There is deliberately **no** function here that reads a whole version — that is
what :meth:`app.database.Database.get_classes_with_properties_and_tags_for_version` does, and
replacing it at the call sites is the point of the epic.

Follows :mod:`app.domains_store`: a ``_DbLike`` protocol rather than a dependency on the concrete
``Database`` singleton, so every function is exercisable against a fake connection.

Four things about these reads are worth knowing before reading any function:

**A bounded read is still a bulk read.** Hydrating 20 classes must not become 20 round trips, so
each loader issues a fixed, small number of statements — three for classes (rows, properties,
tags), two for paths (rows, operations) — whatever the page size. The count of statements is a
property the tests assert, because an N+1 introduced here would be invisible until a real catalog
made it slow.

**Selection is scoped by version, never by id alone.** Every WHERE clause carries ``version_id``
even in id mode, where the ids would appear to identify the rows on their own. That is the tenancy
boundary: the route resolves the version against the caller's tenant, so an id belonging to another
tenant's catalog matches nothing instead of leaking a row.

**Ids the caller asked for that do not resolve are reported, not dropped.** A selection can outlive
the thing it selects — someone else deletes a class the client still has in its scope store. A
silently short response would leave a hole on the canvas with no way to know why, so
:attr:`ScopedPage.missing_ids` names them.

**Reads commit.** Matching :meth:`app.database.Database.execute_query`: psycopg2 opens a
transaction for a bare SELECT too, and leaving the shared connection "idle in transaction" holds
locks and blocks VACUUM.
"""

from __future__ import annotations

import uuid as _uuid
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Protocol, Sequence, Tuple

__all__ = [
    "CLASS_COLUMNS",
    "DEFAULT_PAGE_SIZE",
    "MAX_PAGE_SIZE",
    "MAX_SELECTED_IDS",
    "PATH_COLUMNS",
    "SHARED_DOMAIN_ID",
    "ScopedPage",
    "canonical_id",
    "clamp_page_size",
    "load_classes_by_domain",
    "load_classes_by_ids",
    "load_paths_by_domain",
    "load_paths_by_ids",
    "normalize_ids",
]

#: Most ids one request may name. A client with a larger selection pages it: the workspace's own
#: node budget (DUW-3.4) defaults to 60, so this is already generous, and a request for more is a
#: client bug rather than a case to serve slowly.
MAX_SELECTED_IDS = 200

#: Most items one page of a domain listing may contain. Larger ``limit`` values are clamped to this
#: rather than rejected, because a domain listing always offers a cursor to continue with.
MAX_PAGE_SIZE = 200

#: Page size used when a caller names none.
DEFAULT_PAGE_SIZE = 50

#: The token standing in for "no domain" in a ``?domain_id=`` filter. Same reserved word
#: :mod:`app.domains_store` uses, so one spelling means one folder across both APIs.
SHARED_DOMAIN_ID = "shared"

#: Every class column the workspace reads back, in a stable order. ``domain_id`` is included where
#: the legacy full-version read omits it: a scoped client needs to know which folder it just
#: hydrated from.
CLASS_COLUMNS = (
    "id, version_id, domain_id, name, description, schema, enabled, "
    "canvas_metadata, created_at, updated_at"
)

#: Every path column the workspace reads back. ``summary``/``description`` are projected out of
#: ``metadata`` exactly as :meth:`app.database.Database.get_paths_for_version_with_tenant` does, so
#: a scoped path and a listed path carry the same fields.
PATH_COLUMNS = (
    "id, version_id, domain_id, pathname, metadata, "
    "metadata->>'summary' AS summary, metadata->>'description' AS description, "
    "created_at, updated_at"
)


class _DbLike(Protocol):
    """Minimal database surface used by this module."""

    def connect(self) -> Any: ...


class ScopedPage(NamedTuple):
    """One bounded slice of a version's catalog.

    Attributes:
        items: The hydrated rows, in the module's stable order.
        total: How many items the selection resolves to in full — the page size for an id
            selection (which is never paginated), the whole domain's membership for a domain
            listing. This is what lets the tree show "12 of 40" before hydrating anything else.
        missing_ids: Ids the caller named that resolved to nothing in this version. Always empty
            for a domain listing, which names no ids.
        next_offset: Where a following page starts, or None when this page is the last.
    """

    items: List[Dict[str, Any]]
    total: int
    missing_ids: List[str]
    next_offset: Optional[int]


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _is_uuid(value: Any) -> bool:
    """Whether a value is something the ``uuid`` column type would accept.

    As permissive as Postgres — any 32 hex digits — rather than RFC-4122-strict, matching
    :func:`app.domains_store._is_uuid`: an id that arrived through an import may not carry a
    conforming version nibble, and treating a row that exists as missing would be worse than the
    cast error this guards against.

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


def normalize_ids(raw: Optional[Iterable[str]]) -> Tuple[List[str], List[str]]:
    """Reduce a caller-supplied id selection to what can be queried, and what cannot.

    Accepts the two spellings a client may send interchangeably — a repeated query parameter
    (``?class_ids=a&class_ids=b``) and a comma-separated one (``?class_ids=a,b``) — because both
    are natural to write and neither is worth a 400. Order is preserved and duplicates collapse, so
    a client that asks for the same class twice is charged for it once against the cap.

    Args:
        raw: The query parameter values as received, or None.

    Returns:
        ``(ids, malformed)`` — the ids fit to reach SQL, and the entries that are not ids at all.
        Malformed entries are returned rather than dropped so the response can name them among
        :attr:`ScopedPage.missing_ids`; sending them to Postgres would raise
        ``InvalidTextRepresentation`` at the ``::uuid`` cast, a 500 for what is really "no such
        class".
    """
    ids: List[str] = []
    malformed: List[str] = []
    seen = set()
    for value in raw or []:
        for token in str(value).split(","):
            token = token.strip()
            if not token or token in seen:
                continue
            seen.add(token)
            (ids if _is_uuid(token) else malformed).append(token)
    return ids, malformed


def clamp_page_size(limit: Optional[int]) -> int:
    """Resolve a caller's page size against the server cap.

    Clamped rather than rejected: a domain listing always returns a cursor, so an over-large
    request has a working continuation, and the response echoes the size actually applied.

    Args:
        limit: The requested page size, or None for the default.

    Returns:
        A page size in ``[1, MAX_PAGE_SIZE]``.
    """
    if limit is None:
        return DEFAULT_PAGE_SIZE
    return max(1, min(int(limit), MAX_PAGE_SIZE))


def _fetch_all(cursor: Any, query: str, params: Sequence[Any]) -> List[Dict[str, Any]]:
    """Execute a query and return every row as a plain dict."""
    cursor.execute(query, params)
    return [dict(row) for row in (cursor.fetchall() or [])]


def _fetch_one(cursor: Any, query: str, params: Sequence[Any]) -> Optional[Dict[str, Any]]:
    """Execute a query and return the first row as a plain dict, or None."""
    cursor.execute(query, params)
    row = cursor.fetchone()
    return None if row is None else dict(row)


def _group_by(rows: Iterable[Dict[str, Any]], key: str) -> Dict[Any, List[Dict[str, Any]]]:
    """Bucket rows by one column, preserving the order they arrived in.

    Args:
        rows: Rows carrying ``key``.
        key: The column to group on — a parent id.

    Returns:
        A mapping from parent id to its rows. Parents with no rows are simply absent; callers use
        ``.get(id, [])`` so an empty child list is not something a second query has to establish.
    """
    grouped: Dict[Any, List[Dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(row[key], []).append(row)
    return grouped


def canonical_id(value: Any) -> str:
    """The one spelling of an id that two sides can be compared on.

    A psycopg2 ``uuid`` column arrives as :class:`uuid.UUID` while the request carried text, and
    Postgres accepts spellings its output never uses — uppercase, braces, no hyphens. Comparing raw
    strings would report a class as missing that was returned.

    Args:
        value: An id in any accepted form.

    Returns:
        The canonical lowercase hyphenated form, or the value's plain string when it is not a UUID
        at all (a malformed entry, which can then still be matched against itself).
    """
    try:
        return str(_uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError):
        return str(value)


def _missing(requested: Sequence[str], found: Iterable[Dict[str, Any]]) -> List[str]:
    """Which requested ids are absent from a result set, in the order they were asked for.

    Args:
        requested: The ids the caller named.
        found: The rows that resolved, each carrying ``id``.

    Returns:
        The unresolved ids, in the caller's own spelling — that is what a client has to match them
        back against its selection.
    """
    resolved = {canonical_id(row["id"]) for row in found}
    return [candidate for candidate in requested if canonical_id(candidate) not in resolved]


# ─── Class reads ─────────────────────────────────────────────────────────────


def _hydrate_classes(cursor: Any, classes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Attach properties and tags to an already-selected page of classes.

    Two statements regardless of page size, so hydration cost tracks the *selection*, not the
    catalog. Both use ``= ANY(...)`` over the page's ids rather than re-deriving the selection, so
    a class cannot appear in the page without its children or vice versa.

    Args:
        cursor: An open cursor.
        classes: The class rows to hydrate, in the order they should be returned.

    Returns:
        The same rows, each with ``properties`` and ``tags`` lists.
    """
    if not classes:
        return []

    class_ids = [str(cls["id"]) for cls in classes]

    properties = _fetch_all(
        cursor,
        """
        SELECT cp.id, cp.class_id, cp.property_id, cp.name, cp.description, cp.data, cp.parent_id,
               cp.primitive_id, cp.primitive_ref,
               p.id AS property_source_id, p.name AS property_source_name,
               p.data AS property_source_data
          FROM apiome.class_properties cp
          LEFT JOIN apiome.properties p ON cp.property_id = p.id
         WHERE cp.class_id = ANY(%s::uuid[])
         ORDER BY cp.class_id, cp.parent_id NULLS FIRST, cp.name ASC
        """,
        (class_ids,),
    )

    tags = _fetch_all(
        cursor,
        """
        SELECT ct.id, ct.class_id, ct.tag_id, ct.created_at,
               t.name AS tag_name, t.color AS tag_color, t.description AS tag_description,
               t.project_id
          FROM apiome.class_tags ct
          JOIN apiome.tags t ON ct.tag_id = t.id
         WHERE ct.class_id = ANY(%s::uuid[])
         ORDER BY ct.class_id, t.name ASC
        """,
        (class_ids,),
    )

    properties_by_class = _group_by(properties, "class_id")
    tags_by_class = _group_by(tags, "class_id")
    return [
        {
            **cls,
            "properties": properties_by_class.get(cls["id"], []),
            "tags": tags_by_class.get(cls["id"], []),
        }
        for cls in classes
    ]


def load_classes_by_ids(
    db: _DbLike,
    *,
    version_id: str,
    class_ids: Sequence[str],
    malformed_ids: Sequence[str] = (),
) -> ScopedPage:
    """Load exactly the named classes of one version, with their properties and tags.

    The answer to the ticket's first acceptance criterion: three ids in, three classes out,
    whatever the catalog holds. Never paginated — the caller's id list is already the page, and the
    route caps its length.

    Args:
        db: Database handle exposing ``connect()``.
        version_id: The version the ids must belong to. Also the tenancy boundary: an id from
            another tenant's catalog resolves to nothing rather than to a row.
        class_ids: The classes to load, already validated as UUID-shaped.
        malformed_ids: Entries of the caller's selection that were not ids at all, folded into
            :attr:`ScopedPage.missing_ids` so one field answers "what did I ask for that I did not
            get".

    Returns:
        A page whose ``total`` is the number of classes that resolved.
    """
    if not class_ids:
        return ScopedPage(items=[], total=0, missing_ids=list(malformed_ids), next_offset=None)

    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            classes = _fetch_all(
                cursor,
                f"""
                SELECT {CLASS_COLUMNS}
                  FROM apiome.classes
                 WHERE version_id = %s::uuid
                   AND deleted_at IS NULL
                   AND id = ANY(%s::uuid[])
                 ORDER BY name ASC, id ASC
                """,
                (version_id, list(class_ids)),
            )
            items = _hydrate_classes(cursor, classes)
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    return ScopedPage(
        items=items,
        total=len(items),
        missing_ids=list(malformed_ids) + _missing(class_ids, classes),
        next_offset=None,
    )


def load_classes_by_domain(
    db: _DbLike,
    *,
    version_id: str,
    domain_id: Optional[str],
    limit: int,
    offset: int = 0,
) -> ScopedPage:
    """Load one page of a domain folder's classes, with their properties and tags.

    Args:
        db: Database handle.
        version_id: The version.
        domain_id: The folder, or None for the derived ``shared/`` bucket — the classes with no
            domain, which is a filter (``domain_id IS NULL``) rather than a value.
        limit: Page size, already clamped by :func:`clamp_page_size`.
        offset: Where this page starts.

    Returns:
        A page whose ``total`` is the folder's whole membership, so a client can size the selection
        before hydrating it, and whose ``next_offset`` is None once the page reaches the end.
    """
    predicate = "domain_id IS NULL" if domain_id is None else "domain_id = %s::uuid"
    scope: Tuple[Any, ...] = (version_id,) if domain_id is None else (version_id, domain_id)

    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            counted = _fetch_one(
                cursor,
                f"""
                SELECT COUNT(*) AS n
                  FROM apiome.classes
                 WHERE version_id = %s::uuid AND deleted_at IS NULL AND {predicate}
                """,
                scope,
            )
            classes = _fetch_all(
                cursor,
                f"""
                SELECT {CLASS_COLUMNS}
                  FROM apiome.classes
                 WHERE version_id = %s::uuid AND deleted_at IS NULL AND {predicate}
                 ORDER BY name ASC, id ASC
                 LIMIT %s OFFSET %s
                """,
                scope + (limit, offset),
            )
            items = _hydrate_classes(cursor, classes)
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    total = int((counted or {}).get("n") or 0)
    return ScopedPage(
        items=items,
        total=total,
        missing_ids=[],
        next_offset=_next_offset(offset=offset, returned=len(items), total=total),
    )


# ─── Path reads ──────────────────────────────────────────────────────────────


def _hydrate_paths(cursor: Any, paths: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Attach operations to an already-selected page of paths.

    One statement regardless of page size — the bulk form of
    :meth:`app.database.Database.get_operations_for_path`, which the workspace would otherwise call
    once per path.

    Each operation carries its description's ``operation_id``, ``summary`` and ``deprecated`` flag,
    because the mockup's paths lens draws the operationId beside every verb and the tree would
    otherwise need a second round trip per operation to render a row. The rest of an operation's
    detail — parameters, request body, responses — deliberately stays with
    ``GET /v1/paths/{tenant}/{version}/{path}/full``: that is inspector-sized data for one
    selected operation, and shipping it for a whole folder is the habit this endpoint exists to
    break.

    Args:
        cursor: An open cursor.
        paths: The path rows to hydrate, in the order they should be returned.

    Returns:
        The same rows, each with an ``operations`` list ordered by HTTP method.
    """
    if not paths:
        return []

    path_ids = [str(path["id"]) for path in paths]

    operations = _fetch_all(
        cursor,
        """
        SELECT po.id, po.version_path_id, po.operation, po.metadata,
               po.created_at, po.updated_at,
               pod.operation_id,
               pod.summary,
               COALESCE((pod.metadata->>'deprecated')::boolean, false) AS deprecated
          FROM apiome.path_operation po
          LEFT JOIN apiome.path_operation_description pod ON pod.path_operation_id = po.id
         WHERE po.version_path_id = ANY(%s::uuid[])
         ORDER BY po.version_path_id,
                  CASE po.operation
                      WHEN 'GET' THEN 1 WHEN 'POST' THEN 2 WHEN 'PUT' THEN 3
                      WHEN 'PATCH' THEN 4 WHEN 'DELETE' THEN 5 ELSE 6
                  END,
                  po.operation,
                  po.id
        """,
        (path_ids,),
    )

    operations_by_path = _group_by(operations, "version_path_id")
    return [{**path, "operations": operations_by_path.get(path["id"], [])} for path in paths]


def load_paths_by_ids(
    db: _DbLike,
    *,
    version_id: str,
    path_ids: Sequence[str],
    malformed_ids: Sequence[str] = (),
) -> ScopedPage:
    """Load exactly the named paths of one version, with their operations.

    Args:
        db: Database handle.
        version_id: The version the ids must belong to, and the tenancy boundary.
        path_ids: The paths to load, already validated as UUID-shaped.
        malformed_ids: Entries of the caller's selection that were not ids at all.

    Returns:
        A page whose ``total`` is the number of paths that resolved.
    """
    if not path_ids:
        return ScopedPage(items=[], total=0, missing_ids=list(malformed_ids), next_offset=None)

    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            paths = _fetch_all(
                cursor,
                f"""
                SELECT {PATH_COLUMNS}
                  FROM apiome.version_path
                 WHERE version_id = %s::uuid
                   AND id = ANY(%s::uuid[])
                 ORDER BY pathname ASC, id ASC
                """,
                (version_id, list(path_ids)),
            )
            items = _hydrate_paths(cursor, paths)
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    return ScopedPage(
        items=items,
        total=len(items),
        missing_ids=list(malformed_ids) + _missing(path_ids, paths),
        next_offset=None,
    )


def load_paths_by_domain(
    db: _DbLike,
    *,
    version_id: str,
    domain_id: Optional[str],
    limit: int,
    offset: int = 0,
) -> ScopedPage:
    """Load one page of a domain folder's paths, with their operations.

    ``apiome.version_path`` has no soft delete, so unlike the class reads there is no
    ``deleted_at`` predicate here — every row of the version counts.

    Args:
        db: Database handle.
        version_id: The version.
        domain_id: The folder, or None for the derived ``shared/`` bucket.
        limit: Page size, already clamped by :func:`clamp_page_size`.
        offset: Where this page starts.

    Returns:
        A page whose ``total`` is the folder's whole path membership.
    """
    predicate = "domain_id IS NULL" if domain_id is None else "domain_id = %s::uuid"
    scope: Tuple[Any, ...] = (version_id,) if domain_id is None else (version_id, domain_id)

    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            counted = _fetch_one(
                cursor,
                f"""
                SELECT COUNT(*) AS n
                  FROM apiome.version_path
                 WHERE version_id = %s::uuid AND {predicate}
                """,
                scope,
            )
            paths = _fetch_all(
                cursor,
                f"""
                SELECT {PATH_COLUMNS}
                  FROM apiome.version_path
                 WHERE version_id = %s::uuid AND {predicate}
                 ORDER BY pathname ASC, id ASC
                 LIMIT %s OFFSET %s
                """,
                scope + (limit, offset),
            )
            items = _hydrate_paths(cursor, paths)
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    total = int((counted or {}).get("n") or 0)
    return ScopedPage(
        items=items,
        total=total,
        missing_ids=[],
        next_offset=_next_offset(offset=offset, returned=len(items), total=total),
    )


def _next_offset(*, offset: int, returned: int, total: int) -> Optional[int]:
    """Where the following page starts, or None when there is no following page.

    Guards on ``returned`` as well as the arithmetic: a page that came back empty because the
    caller paged past the end must not hand out a cursor that would return empty forever.

    Args:
        offset: Where this page started.
        returned: How many items it contained.
        total: The selection's full size.

    Returns:
        The next offset, or None.
    """
    if returned == 0:
        return None
    following = offset + returned
    return following if following < total else None

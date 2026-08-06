"""Property-name search across a version — DUW-5.3 (private-suite#2590).

The ⌘K palette's `Properties` band lists the properties a query names and, beside each, how many
classes carry it: ``customer_id · used by 14 classes``. That count is the band's whole reason for
existing — it is the fact that turns "a property called this exists" into "this property is a
convention across the catalog" — and it is not derivable from anything the workspace already
fetches. The DUW-1.3 summary carries no properties at all (deliberately: shipping them would
rebuild the full-catalog read this epic deleted), so a browser answering this question would first
have to hydrate every class in the version.

So the question is asked where the rows are:

**One aggregate, not a scan.** ``COUNT(DISTINCT class_id)`` over ``apiome.class_properties``,
grouped by property name, filtered by an ``ILIKE`` on the name. The count covers the whole version
— every class carrying that name, including classes this response does not list — because a usage
count that only covered the returned owners would be a count of the answer rather than of the
catalog.

**Names are the unit, classes are the evidence.** A hit is a property *name*; the classes carrying
it come with it, bounded by ``owner_limit``, so the palette can open the top one on ⏎ and list the
rest in place without a second request. A name whose owner list was cut says so.

**A property is counted once per class.** ``apiome.class_properties`` holds nested rows too — a
class with an ``address.customer_id`` and a top-level ``customer_id`` has two rows of that name —
and a class that carries a name twice still uses it once. ``DISTINCT class_id`` is what makes the
count "how many classes use this", which is what the band claims.

**Deleted classes and other versions are not in the catalog.** Every statement joins through
``apiome.classes`` and is scoped by ``version_id`` with ``deleted_at IS NULL``, so a soft-deleted
class cannot inflate a count. Tenancy is resolved through the version by the route, exactly as in
DUW-1.2/1.3/1.4.

**Reads commit.** Matching :mod:`app.workspace_summary_store`: psycopg2 opens a transaction for a
bare SELECT too, and leaving the shared connection idle in one holds locks and blocks VACUUM.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from .workspace_summary_store import class_kind_expression

__all__ = [
    "DEFAULT_OWNER_LIMIT",
    "DEFAULT_PROPERTY_LIMIT",
    "MAX_OWNER_LIMIT",
    "MAX_PROPERTY_LIMIT",
    "MIN_QUERY_LENGTH",
    "clamp_owner_limit",
    "clamp_property_limit",
    "like_pattern",
    "normalize_query",
    "search_version_properties",
]

#: Most property names one response may carry. The band is a band, not a report: a query matching
#: more names than this is a query still being typed, and the response says it was capped.
MAX_PROPERTY_LIMIT = 50

#: Property names returned when a caller names no limit. Comfortably more than the band draws.
DEFAULT_PROPERTY_LIMIT = 25

#: Most owning classes one property may list. Bounded per name rather than in total, so a common
#: property does not starve the rest of the answer.
MAX_OWNER_LIMIT = 50

#: Owning classes per property when a caller names no limit.
DEFAULT_OWNER_LIMIT = 10

#: The shortest query worth searching on. One character matches most of a catalog's properties, and
#: the round trip would only prove it.
MIN_QUERY_LENGTH = 2

#: The character that escapes a wildcard inside a LIKE pattern. A property legitimately named
#: ``percent_%`` must match itself rather than everything.
_LIKE_ESCAPE = "\\"


def normalize_query(raw: Optional[str]) -> str:
    """Reduce what the caller sent to what the statements compare.

    Args:
        raw: The ``q`` query value, or None.

    Returns:
        The query, trimmed. Empty when there is nothing to search for — which is a legitimate
        request answered with no hits, not an error.
    """
    return (raw or "").strip()


def like_pattern(query: str, *, prefix: bool = False) -> str:
    """Turn a query into a LIKE pattern that matches it literally.

    ``%`` and ``_`` are wildcards and the escape character is itself special, so all three are
    escaped: a search for ``id_`` must not match ``idx``.

    Args:
        query: The normalized query.
        prefix: True for a pattern anchored at the start (``customer%``), which is how a prefix
            match is told apart from a mid-word one; False for a containment pattern.

    Returns:
        The pattern, for a statement that declares ``ESCAPE '\\'``.
    """
    escaped = (
        query.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
        .replace("%", f"{_LIKE_ESCAPE}%")
        .replace("_", f"{_LIKE_ESCAPE}_")
    )
    return f"{escaped}%" if prefix else f"%{escaped}%"


def _clamp(limit: Optional[int], *, default: int, maximum: int) -> int:
    """Resolve a caller's limit against a server cap.

    Clamped rather than rejected, as :func:`app.workspace_summary_store.clamp_member_limit` is: the
    response echoes the limit actually applied, so an over-large request is answered rather than
    argued with.

    Args:
        limit: The requested limit, or None for the default.
        default: What None means.
        maximum: The server's cap.

    Returns:
        A limit in ``[0, maximum]``.
    """
    if limit is None:
        return default
    return max(0, min(int(limit), maximum))


def clamp_property_limit(limit: Optional[int]) -> int:
    """Resolve the per-response property-name limit. See :func:`_clamp`."""
    return _clamp(limit, default=DEFAULT_PROPERTY_LIMIT, maximum=MAX_PROPERTY_LIMIT)


def clamp_owner_limit(limit: Optional[int]) -> int:
    """Resolve the per-property owning-class limit. See :func:`_clamp`."""
    return _clamp(limit, default=DEFAULT_OWNER_LIMIT, maximum=MAX_OWNER_LIMIT)


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _fetch_all(cursor: Any, query: str, params: Sequence[Any]) -> List[Dict[str, Any]]:
    """Execute a query and return every row as a plain dict."""
    cursor.execute(query, params)
    return [dict(row) for row in (cursor.fetchall() or [])]


def _int(value: Any) -> int:
    """A count column as a plain int, treating a missing aggregate as zero."""
    return 0 if value is None else int(value)


# ─── Statements ──────────────────────────────────────────────────────────────

#: Every property name the query matches, with how many of the version's classes carry it.
#:
#: ``COUNT(DISTINCT cp.class_id)`` is the number the band prints, and the ``DISTINCT`` is what makes
#: it a count of *classes* rather than of property rows: a class carrying the name at two nesting
#: levels uses it once.
#:
#: ``COUNT(*) OVER ()`` carries the size of the whole match set onto every returned row, so the
#: response can report that it capped without a second statement counting what it just grouped.
#:
#: The ordering is the band's: a name the query starts is a better answer than one it appears
#: inside (booleans sort false-first, so the prefix test is taken DESC), then the most widely used
#: name, then alphabetically — deterministic all the way down, because a list that reshuffles
#: between identical searches is a list nobody can learn.
_PROPERTY_MATCH_QUERY = """
    WITH matched AS (
        SELECT cp.name AS name,
               COUNT(DISTINCT cp.class_id) AS class_count
          FROM apiome.class_properties cp
          JOIN apiome.classes c ON c.id = cp.class_id
         WHERE c.version_id = %s::uuid
           AND c.deleted_at IS NULL
           AND cp.name ILIKE %s ESCAPE '\\'
         GROUP BY cp.name
    ),
    ranked AS (
        SELECT name,
               class_count,
               COUNT(*) OVER () AS match_count,
               ROW_NUMBER() OVER (
                   ORDER BY (lower(name) LIKE lower(%s) ESCAPE '\\') DESC,
                            class_count DESC,
                            name ASC
               ) AS rn
          FROM matched
    )
    SELECT name, class_count, match_count
      FROM ranked
     WHERE rn <= %s
     ORDER BY rn
"""

#: The classes carrying each returned name, capped per name.
#:
#: ``DISTINCT`` before the ranking, not after: a class carrying the name twice is one owner, and
#: ranking the duplicate rows would let it consume two of the ``owner_limit`` slots.
#:
#: Alphabetical by class name, so "the top owning class" — the one ⏎ opens — is a stable answer
#: rather than whichever row Postgres happened to return first.
_PROPERTY_OWNERS_QUERY = f"""
    WITH owned AS (
        SELECT DISTINCT
               cp.name AS property_name,
               c.id AS class_id,
               c.name AS class_name,
               c.domain_id AS domain_id,
               ({class_kind_expression("c.schema")}) AS kind
          FROM apiome.class_properties cp
          JOIN apiome.classes c ON c.id = cp.class_id
         WHERE c.version_id = %s::uuid
           AND c.deleted_at IS NULL
           AND cp.name = ANY(%s::text[])
    ),
    ranked AS (
        SELECT property_name, class_id, class_name, domain_id, kind,
               ROW_NUMBER() OVER (
                   PARTITION BY property_name ORDER BY class_name ASC, class_id ASC
               ) AS rn
          FROM owned
    )
    SELECT property_name, class_id, class_name, domain_id, kind
      FROM ranked
     WHERE rn <= %s
     ORDER BY property_name, rn
"""


# ─── Projection ──────────────────────────────────────────────────────────────


def _owner_rows(rows: Sequence[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Group owning-class rows by the property name they carry.

    Args:
        rows: The rows of :data:`_PROPERTY_OWNERS_QUERY`, already ordered per name.

    Returns:
        Owners keyed by property name, each row carrying what a palette row draws: the class's id
        and name, the folder it lives in, and which tree group it belongs to.
    """
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row["property_name"]), []).append(
            {
                "class_id": str(row["class_id"]),
                "class_name": row["class_name"],
                "domain_id": None if row["domain_id"] is None else str(row["domain_id"]),
                "kind": row["kind"],
            }
        )
    return grouped


def _empty_result(limit: int, owner_limit: int) -> Dict[str, Any]:
    """The answer to a query with nothing to search for.

    Args:
        limit: The property limit that was applied.
        owner_limit: The owner limit that was applied.

    Returns:
        No hits, and no claim to have looked at a catalog.
    """
    return {
        "properties": [],
        "total": 0,
        "limit": limit,
        "owner_limit": owner_limit,
        "truncated": False,
    }


# ─── The read ────────────────────────────────────────────────────────────────


def search_version_properties(
    db: Any,
    *,
    version_id: str,
    query: str,
    limit: int,
    owner_limit: int,
) -> Dict[str, Any]:
    """Find the properties of one version whose name matches a query.

    Two statements: the matching names with their version-wide usage counts, and the owning classes
    of the names that came back. The second is skipped when the first found nothing, and when
    ``owner_limit`` is zero — a caller that only wants counts pays for one.

    Args:
        db: Database handle exposing ``connect()``.
        version_id: The version to search. The caller must already have resolved it against the
            tenant — every statement here is scoped by it and by nothing else, exactly as the other
            workspace reads are.
        query: The normalized query. Anything shorter than :data:`MIN_QUERY_LENGTH` is answered
            with no hits rather than with most of the catalog.
        limit: Most property names to return, already clamped by :func:`clamp_property_limit`.
        owner_limit: Most owning classes per name, already clamped by :func:`clamp_owner_limit`.

    Returns:
        A dict with ``properties`` (name, ``class_count``, ``owners``, ``owners_truncated``),
        ``total`` — every name that matched, before the cap, which is what tells a client its
        answer is a slice — the two limits actually applied, and ``truncated``.
    """
    if len(query) < MIN_QUERY_LENGTH or limit == 0:
        return _empty_result(limit, owner_limit)

    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            matches = _fetch_all(
                cursor,
                _PROPERTY_MATCH_QUERY,
                (version_id, like_pattern(query), like_pattern(query, prefix=True), limit),
            )
            names = [str(row["name"]) for row in matches]
            owners = (
                _fetch_all(cursor, _PROPERTY_OWNERS_QUERY, (version_id, names, owner_limit))
                if names and owner_limit > 0
                else []
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    owners_by_name = _owner_rows(owners)
    total = _int(matches[0]["match_count"]) if matches else 0

    properties: List[Dict[str, Any]] = []
    for row in matches:
        name = str(row["name"])
        class_count = _int(row["class_count"])
        listed = owners_by_name.get(name, [])
        properties.append(
            {
                "name": name,
                "class_count": class_count,
                "owners": listed,
                # The owner list is short of the count either because it hit the cap or because the
                # caller asked for none; both mean "there are classes here this row does not name".
                "owners_truncated": len(listed) < class_count,
            }
        )

    return {
        "properties": properties,
        "total": total,
        "limit": limit,
        "owner_limit": owner_limit,
        "truncated": total > len(properties),
    }

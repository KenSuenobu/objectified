"""Bounded search over the primitives type registry — DWX-3.1 (private-suite#2683).

``GET /v1/primitives/{tenant_slug}`` has always answered with *every* primitive the tenant can
see. A tenant that has imported a standard library has thousands of rows, and the unified
workspace's type picker — a 320px rail — cannot be built on a read like that. This module is the
bounded read that replaces it: a query, a scope, a namespace, a limit and a cursor in; at most
``limit`` rows and the four tab counts out.

Five properties the surface rests on, each of which fails silently if it is ever weakened:

**The scope classification is the client's, expressed in SQL.** The picker's four tabs — Standard,
Core, Tenant, Custom — are derived in the browser today by ``classifyPrimitive`` in
``designer/src/components/PrimitiveSelector.tsx``. Once the server filters by scope, the two
implementations must agree on *every* row, or a tab silently drops types that exist. The rule is
therefore transcribed rather than reinvented (see :data:`SCOPE_EXPRESSION`), and the ticket's
acceptance criterion is a test that runs both over the same fixtures.

**The counts cover the match, not the page.** ``counts`` is the size of each scope *within the
current query*, computed before the scope filter and before the limit. That is what the tab badges
show: switching from Standard to Custom must not require a second round trip, and a badge that
counted the returned page would read `25` forever.

**No answer exceeds the limit.** The page statement asks for ``limit + 1`` rows and returns at most
``limit`` of them; the extra row is how the cursor learns whether there is a next page without a
second count. ``limit`` is clamped, not rejected — an over-large request is answered rather than
argued with, exactly as in :mod:`app.workspace_property_store`.

**The cursor is keyset, not an offset.** It carries the sort key of the last row handed out, so a
primitive created mid-scroll cannot shift a page boundary and make a row appear twice or not at
all. It is opaque to the client and validated on the way back in: a cursor that does not decode is
a 400, never a silently ignored parameter that would return page one again.

**Visibility is the existing read scope, unchanged.** ``is_system`` rows (shared system-core types)
unioned with the caller's own, deduplicated by ``(namespace, name)`` preferring the caller's copy —
identical to :meth:`app.database.Database.get_primitives_for_tenant`, because this endpoint and
that one must list the same catalog. Another tenant's private type is not in the ``visible`` CTE at
all, so no query, no cursor and no ``$ref`` can reach one.
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any, Dict, List, Optional, Sequence, Tuple

# The one implementation of "escape a caller's text so LIKE matches it literally" in this service.
# Duplicating it here is how a type legitimately named ``pct_%`` ends up matching everything.
from .workspace_property_store import like_pattern

__all__ = [
    "DEFAULT_LIMIT",
    "MAX_LIMIT",
    "SCOPES",
    "InvalidCursorError",
    "clamp_limit",
    "classify_scope",
    "decode_cursor",
    "encode_cursor",
    "normalize_namespace",
    "normalize_query",
    "normalize_scope",
    "search_primitives",
]

#: Rows one response may carry when the caller names no limit. The rail draws far fewer.
DEFAULT_LIMIT = 25

#: Most rows one response may carry, whatever the caller asks for. The bound is the point of the
#: endpoint: a surface that can request 5,000 rows is the surface this ticket exists to delete.
MAX_LIMIT = 100

#: The four type-picker tabs, in the order the picker draws them. Also the vocabulary the ``scope``
#: parameter accepts — anything else is a 400 rather than a silently empty page.
SCOPES: Tuple[str, ...] = ("standard", "core", "tenant", "custom")

#: Version tag stored in every cursor. A cursor minted by an older shape of the sort key must be
#: refused rather than misread, because misreading one skips or repeats rows without saying so.
_CURSOR_VERSION = 1


class InvalidCursorError(ValueError):
    """Raised when a ``cursor`` value did not come from :func:`encode_cursor`."""


# ─── SQL fragments ───────────────────────────────────────────────────────────

#: A namespace with its trailing slashes removed, mirroring the client's
#: ``p.namespace.replace(/\\/+$/, '')``. NULL and empty both reduce to the empty string, which is
#: what makes a namespace-less legacy primitive fall through to the tenant/core branches rather
#: than erroring.
_NAMESPACE_KEY = "regexp_replace(COALESCE(p.namespace, ''), '/+$', '')"

#: The stable registry ``$ref`` a primitive binds by — ``std/v0/types`` + ``date`` →
#: ``std/v0/types/date`` — mirroring the client's ``buildTypeRef``. NULL for the legacy flat
#: primitives that have no namespace: those bind by inline schema and have no ref to match on.
TYPE_REF_EXPRESSION = f"""
    CASE WHEN btrim(COALESCE(p.namespace, '')) <> ''
         THEN {_NAMESPACE_KEY} || '/' || p.name
    END
"""

#: The picker's four tabs as a SQL expression — the transcription of ``classifyPrimitive``.
#:
#: ``is_system`` rows in a ``.../primitives`` namespace are the JSON Schema base types (Standard);
#: every other system row is a derived/composite core type (Core). Tenant-owned rows split on
#: provenance: ``source = 'imported'`` is Custom, everything else is Tenant.
#:
#: The ``LIKE '%/primitives'`` is exactly the client's ``endsWith('/primitives')``: the pattern is a
#: literal with one leading wildcard, so a namespace *called* ``primitives`` (no separator) is Core
#: on both sides, and one called ``std/v0/primitives//`` is Standard on both sides.
#:
#: The wildcard is written ``%%`` because every statement in this module is executed with bound
#: parameters, and psycopg2 reads a lone ``%`` in that case as the start of a placeholder.
SCOPE_EXPRESSION = f"""
    CASE
        WHEN p.is_system THEN
            CASE WHEN {_NAMESPACE_KEY} LIKE '%%/primitives' THEN 'standard' ELSE 'core' END
        WHEN p.source = 'imported' THEN 'custom'
        ELSE 'tenant'
    END
"""

def classify_scope(is_system: bool, namespace: Optional[str], source: Optional[str]) -> str:
    """Classify one primitive into a type-picker tab, in Python.

    The reference implementation of :data:`SCOPE_EXPRESSION`, and the middle link of the parity
    chain the ticket's acceptance criterion asks for: the designer's ``classifyPrimitive`` and this
    function are checked against the same fixture file, and this function and the SQL are checked
    against each other over the same rows in ``tests/test_primitives_search_db.py``. Three
    implementations, one rule, and no pair of them may disagree.

    Args:
        is_system: The row's ``is_system`` flag.
        namespace: The row's registry namespace, possibly None or empty.
        source: The row's provenance, ``human`` or ``imported``.

    Returns:
        One of :data:`SCOPES`.
    """
    if is_system:
        trimmed = (namespace or "").rstrip("/")
        return "standard" if trimmed.endswith("/primitives") else "core"
    return "custom" if source == "imported" else "tenant"


#: The columns a primitive row is projected from — the same list
#: :meth:`app.database.Database.get_primitives_for_tenant` selects, so the two listings return
#: identical rows and a client cannot tell which one produced a primitive.
_PRIMITIVE_COLUMNS = """
    id, tenant_id, name, description, category, schema, tags,
    created_by, is_system, is_public, usage_count, source,
    schema_id, draft, namespace, base_uri, refs,
    created_at, updated_at
"""

#: Everything the caller may see, deduplicated exactly as the classic listing deduplicates it.
#:
#: System-core types are seeded *per tenant*, so a tenant that holds its own copy of ``std/v0/types
#: /date`` would otherwise see it twice. ``DISTINCT ON (namespace, name)`` — the pair the registry
#: derives ``$id`` from, and the pair ``primitives_tenant_namespace_name_unique`` (V216) keys on —
#: collapses those, and the trailing ``(tenant_id = %s) DESC`` prefers the caller's own row.
#:
#: Two bound parameters: the caller's tenant, twice.
_VISIBLE_CTE = f"""
    visible AS (
        SELECT DISTINCT ON (namespace, name) {_PRIMITIVE_COLUMNS}
          FROM apiome.primitives
         WHERE (tenant_id = %s OR is_system = true)
         ORDER BY namespace, name, (tenant_id = %s) DESC
    )
"""

#: Every visible row with the three derived values the rest of the statement filters and orders by.
#:
#: ``sort_key`` is the client's ordering key — the registry ``$ref`` when there is one, the bare
#: name otherwise — so the rail lists types in the order the classic dialog listed them.
_CLASSIFIED_CTE = f"""
    classified AS (
        SELECT p.*,
               ({SCOPE_EXPRESSION}) AS scope,
               ({TYPE_REF_EXPRESSION}) AS type_ref,
               COALESCE(({TYPE_REF_EXPRESSION}), p.name) AS sort_key,
               {_NAMESPACE_KEY} AS namespace_key
          FROM visible p
    )
"""


def _match_clause(query: str, category: Optional[str], namespace: Optional[str]) -> Tuple[str, List[Any]]:
    """Build the predicate that decides which rows a request matches, and its parameters.

    The three narrowings compose: a query, a category and a namespace all applied together mean
    "types of this category, in this namespace, that this text names".

    ``q`` spans the same five fields the classic dialog's client-side filter spans — name,
    namespace, the derived registry ``$ref``, description and tags — so moving the search to the
    server does not change which types a reader can find by typing. The ticket names four of them;
    ``description`` is the fifth because dropping it would make the same keystrokes return fewer
    rows than they do today, which reads as data loss rather than as a bounded read. ``schema_id``
    is a sixth, matched because the absolute ``$id`` is the other spelling of the ticket's
    "``$ref``" and a reader who has one in hand should be able to paste it.

    Args:
        query: The normalized query; empty means "no text narrowing", which is the picker's
            initial listing rather than an error.
        category: Optional category filter (``string``, ``object``, …), matched exactly. Carried
            over from the classic listing, whose callers pass it.
        namespace: Optional namespace filter, matched exactly against the namespace with its
            trailing slashes removed — ``std/v0/types`` selects that namespace, not its children.

    Returns:
        A ``WHERE``-ready fragment (always at least ``TRUE``) and the parameters it binds.
    """
    clauses: List[str] = ["TRUE"]
    params: List[Any] = []

    if query:
        pattern = like_pattern(query)
        clauses.append(
            """
            (
                   name ILIKE %s ESCAPE '\\'
                OR COALESCE(namespace, '') ILIKE %s ESCAPE '\\'
                OR COALESCE(type_ref, '') ILIKE %s ESCAPE '\\'
                OR COALESCE(schema_id, '') ILIKE %s ESCAPE '\\'
                OR COALESCE(description, '') ILIKE %s ESCAPE '\\'
                OR EXISTS (
                       SELECT 1 FROM unnest(COALESCE(tags, ARRAY[]::text[])) AS tag
                        WHERE tag ILIKE %s ESCAPE '\\'
                   )
            )
            """
        )
        params.extend([pattern] * 6)

    if category:
        clauses.append("category = %s")
        params.append(category)

    if namespace is not None:
        clauses.append("namespace_key = %s")
        params.append(namespace)

    return " AND ".join(clauses), params


def _rank_expression(query: str) -> Tuple[str, List[Any]]:
    """Build the relevance rank the page is ordered by, and its parameters.

    Rank 0 is a type the query *starts* — ``dat`` finding ``date`` — and rank 1 is one it merely
    appears inside. Two buckets rather than a score: the rank is part of the cursor, and a score
    that shifted as rows changed would make an old cursor point somewhere meaningless.

    With no query every row ranks 0, which reduces the ordering to the alphabetical listing the
    picker opens on.

    Args:
        query: The normalized query.

    Returns:
        A SQL expression yielding an integer rank, and the parameters it binds.
    """
    if not query:
        return "0", []
    prefix = like_pattern(query, prefix=True)
    return (
        """
        CASE WHEN name ILIKE %s ESCAPE '\\' OR sort_key ILIKE %s ESCAPE '\\' THEN 0 ELSE 1 END
        """,
        [prefix, prefix],
    )


# ─── Parameter normalization ─────────────────────────────────────────────────


def normalize_query(raw: Optional[str]) -> str:
    """Reduce what the caller sent to what the statements compare.

    Args:
        raw: The ``q`` value, or None.

    Returns:
        The query, trimmed. Empty is a legitimate request — the picker's initial listing — rather
        than an error, and unlike the palette there is no length floor here: every answer is capped
        by ``limit``, so a one-character query costs one bounded page, not a catalog.
    """
    return (raw or "").strip()


def normalize_namespace(raw: Optional[str]) -> Optional[str]:
    """Reduce a namespace filter to the form the ``namespace_key`` column holds.

    Args:
        raw: The ``namespace`` value, or None.

    Returns:
        The namespace with surrounding whitespace and trailing slashes removed, or None when the
        caller named none. An empty string normalizes to None rather than to "the namespace-less
        rows" — ``?namespace=`` is an unfilled form field, not a filter.
    """
    trimmed = (raw or "").strip()
    if not trimmed:
        return None
    return trimmed.rstrip("/")


def normalize_scope(raw: Optional[str]) -> Optional[str]:
    """Validate a scope filter against the four tabs.

    Args:
        raw: The ``scope`` value, or None.

    Returns:
        The scope, lower-cased, or None when the caller named none.

    Raises:
        ValueError: When the value is not one of :data:`SCOPES`. Refused rather than ignored: a
            misspelled scope that silently listed everything would make an unbounded read look like
            a bounded one.
    """
    trimmed = (raw or "").strip().lower()
    if not trimmed:
        return None
    if trimmed not in SCOPES:
        raise ValueError(f"scope must be one of {', '.join(SCOPES)}; got '{raw}'")
    return trimmed


def clamp_limit(limit: Optional[int]) -> int:
    """Resolve a caller's page size against the server cap.

    Clamped rather than rejected, matching :func:`app.workspace_property_store.clamp_property_limit`:
    the response echoes the limit actually applied, so an over-large request is answered.

    Args:
        limit: The requested page size, or None for :data:`DEFAULT_LIMIT`.

    Returns:
        A size in ``[0, MAX_LIMIT]``. Zero is meaningful — it asks for the tab counts alone, which
        costs one statement instead of two.
    """
    if limit is None:
        return DEFAULT_LIMIT
    return max(0, min(int(limit), MAX_LIMIT))


# ─── Cursor ──────────────────────────────────────────────────────────────────


def encode_cursor(rank: int, sort_key: str, primitive_id: str) -> str:
    """Encode the position of the last row of a page.

    The three values are exactly the ordering tuple, so resuming is a single row comparison rather
    than a count of skipped rows: nothing inserted or deleted between two pages can shift the
    boundary.

    Args:
        rank: The row's relevance rank.
        sort_key: The row's ordering key (its registry ``$ref``, or its name).
        primitive_id: The row's id, which breaks ties between identical keys.

    Returns:
        An opaque URL-safe token. Base64 of compact JSON — readable by a maintainer holding one,
        and unguessable enough that nobody builds one by hand and depends on the shape.
    """
    payload = json.dumps(
        {"v": _CURSOR_VERSION, "r": int(rank), "k": sort_key, "i": str(primitive_id)},
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")


def decode_cursor(raw: Optional[str]) -> Optional[Tuple[int, str, str]]:
    """Decode a cursor back into the ordering tuple it names.

    Args:
        raw: The ``cursor`` value, or None.

    Returns:
        ``(rank, sort_key, primitive_id)``, or None when the caller named no cursor.

    Raises:
        InvalidCursorError: When the value did not come from :func:`encode_cursor` — bad base64,
            bad JSON, a version this build does not mint, or a missing field. Refused rather than
            ignored, because ignoring it silently restarts the caller at page one and a client
            paging a long list would loop forever without ever seeing an error.
    """
    if raw is None or not raw.strip():
        return None

    token = raw.strip()
    padded = token + "=" * (-len(token) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise InvalidCursorError("cursor is not a valid pagination token") from exc

    if not isinstance(payload, dict) or payload.get("v") != _CURSOR_VERSION:
        raise InvalidCursorError("cursor was issued by a different version of this endpoint")

    try:
        rank = int(payload["r"])
        sort_key = str(payload["k"])
        primitive_id = str(payload["i"])
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidCursorError("cursor is missing its position") from exc

    if not primitive_id:
        raise InvalidCursorError("cursor is missing its position")
    return rank, sort_key, primitive_id


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _fetch_all(cursor: Any, query: str, params: Sequence[Any]) -> List[Dict[str, Any]]:
    """Execute a statement and return every row as a plain dict."""
    cursor.execute(query, params)
    return [dict(row) for row in (cursor.fetchall() or [])]


def _empty_counts() -> Dict[str, int]:
    """Zero for every tab, so a badge always has a number to draw."""
    return {scope: 0 for scope in SCOPES}


def _project(row: Dict[str, Any]) -> Dict[str, Any]:
    """Strip a row's derived ordering columns, leaving the primitive the API returns.

    ``scope`` is kept — it is the tab a row belongs to, and the picker needs it to place a row it
    received without a scope filter. ``sort_key``, ``namespace_key`` and ``rank`` are internal to
    the ordering and are not part of the contract.

    Args:
        row: One row of :data:`_PAGE_QUERY`.

    Returns:
        The row without its internal ordering columns.
    """
    projected = dict(row)
    for internal in ("sort_key", "namespace_key", "rank", "type_ref"):
        projected.pop(internal, None)
    return projected


# ─── The read ────────────────────────────────────────────────────────────────


def search_primitives(
    db: Any,
    *,
    tenant_id: str,
    query: str = "",
    scope: Optional[str] = None,
    namespace: Optional[str] = None,
    category: Optional[str] = None,
    limit: int = DEFAULT_LIMIT,
    cursor: Optional[Tuple[int, str, str]] = None,
) -> Dict[str, Any]:
    """Answer one bounded search over the tenant's visible primitives.

    Two statements, in one transaction so the page and the counts describe the same catalog:

    1. **the counts** — how many rows match the query in each of the four scopes, computed *before*
       the scope filter, because that is what the tab badges show;
    2. **the page** — the matching rows in the requested scope, ordered by relevance then by
       registry ``$ref``, resumed from the cursor and capped at ``limit``.

    The second is skipped when ``limit`` is zero, which is how a caller asks for the badges alone.

    Args:
        db: Database handle exposing ``connect()``.
        tenant_id: The caller's tenant. The only visibility gate: every statement runs inside the
            ``visible`` CTE, so another tenant's private types are not merely filtered out, they are
            never in scope.
        query: The normalized query; empty lists the scope without text narrowing.
        scope: One of :data:`SCOPES`, or None for every scope at once.
        namespace: Exact namespace filter, already normalized, or None.
        category: Exact category filter, or None. The classic listing's parameter, preserved.
        limit: Rows to return, already clamped by :func:`clamp_limit`.
        cursor: The decoded position to resume after, or None to start at the first row.

    Returns:
        A dict with ``items`` (at most ``limit`` primitives, each carrying its ``scope``),
        ``counts`` (all four tabs, over the match set), ``total`` (the match set within the applied
        scope, before the limit — what tells a client its page is a slice), ``limit``,
        ``next_cursor`` (None when this was the last page) and ``truncated``.
    """
    match_sql, match_params = _match_clause(query, category, namespace)
    rank_sql, rank_params = _rank_expression(query)

    # `matched` is the request's whole answer set, scope filter aside. The counts group it; the
    # page filters and slices it. Sharing the CTE is what makes a badge and its tab agree.
    prelude = f"""
        WITH {_VISIBLE_CTE},
        {_CLASSIFIED_CTE},
        matched AS (
            SELECT *, ({rank_sql}) AS rank
              FROM classified
             WHERE {match_sql}
        )
    """
    prelude_params = [tenant_id, tenant_id, *rank_params, *match_params]

    counts_sql = prelude + """
        SELECT scope, COUNT(*) AS n
          FROM matched
         GROUP BY scope
    """

    page_clauses = ["TRUE"]
    page_params: List[Any] = []
    if scope is not None:
        page_clauses.append("scope = %s")
        page_params.append(scope)
    if cursor is not None:
        # Row comparison, not three ORed inequalities: it is one expression, it cannot be written
        # subtly wrong, and it uses the same collation the ORDER BY does.
        page_clauses.append("(rank, sort_key, id) > (%s, %s, %s::uuid)")
        page_params.extend([cursor[0], cursor[1], cursor[2]])

    # `limit + 1` is how the cursor learns there is a next page. Counting the remainder instead
    # would be a third statement to answer a yes/no question.
    page_sql = prelude + f"""
        SELECT *
          FROM matched
         WHERE {' AND '.join(page_clauses)}
         ORDER BY rank ASC, sort_key ASC, id ASC
         LIMIT %s
    """

    conn = db.connect()
    try:
        with conn.cursor() as db_cursor:
            count_rows = _fetch_all(db_cursor, counts_sql, tuple(prelude_params))
            page_rows = (
                _fetch_all(
                    db_cursor,
                    page_sql,
                    tuple([*prelude_params, *page_params, limit + 1]),
                )
                if limit > 0
                else []
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    counts = _empty_counts()
    for row in count_rows:
        key = str(row["scope"])
        if key in counts:
            counts[key] = int(row["n"] or 0)

    total = counts[scope] if scope is not None else sum(counts.values())

    has_more = len(page_rows) > limit
    kept = page_rows[:limit]
    next_cursor = (
        encode_cursor(int(kept[-1]["rank"]), str(kept[-1]["sort_key"]), str(kept[-1]["id"]))
        if has_more and kept
        else None
    )

    return {
        "items": [_project(row) for row in kept],
        "counts": counts,
        "total": total,
        "limit": limit,
        "next_cursor": next_cursor,
        # True whenever this response does not carry the whole match set — including the
        # ``limit=0`` badges-only request, which carries none of it.
        "truncated": len(kept) < total,
    }

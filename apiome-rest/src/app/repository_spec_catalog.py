"""
Cross-repository discovered-spec catalog (REPO-6.4, #2797).

The per-repository Files browser (REPO-6.2) answers "what specs live in *this* repo on *this*
branch". Operators running more than a handful of repositories need the tenant-wide view:
every discovered spec in one searchable, server-paginated list, filterable by format,
repository, project mapping and status.

This module owns the vocabulary that view is built on — the format families, the derived
status, and the SQL fragments that express both. Keeping them here means the filter predicate,
the projected column and the facet ``GROUP BY`` are literally the same expression, so a row can
never be listed under a status it cannot be filtered by.

Nothing here touches the database; :meth:`app.database.Database.tenant_repository_spec_catalog`
and the ``/repository-files`` route compose these fragments.

Note on ``%%``: every fragment below is interpolated into a query that psycopg2 executes *with*
parameters, so literal percent signs must be doubled. That is why the ILIKE patterns read
``'openapi%%'`` rather than ``'openapi%'``.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

# --- Format families ---------------------------------------------------------------------

#: Stable family key → human label. The key is the API/query-parameter value; the label is what
#: the catalog UI shows in its "Format" filter. ``unclassified`` covers files the walker indexed
#: but could not type; ``other`` covers a typed file whose kind has no family of its own yet.
SPEC_FORMAT_LABELS: Dict[str, str] = {
    "openapi": "OpenAPI",
    "arazzo": "Arazzo",
    "asyncapi": "AsyncAPI",
    "json_schema": "JSON Schema",
    "graphql": "GraphQL",
    "protobuf": "Protobuf",
    "postman": "Postman",
    "sql_ddl": "SQL DDL",
    "prisma": "Prisma",
    "avro": "Avro",
    "dbml": "DBML",
    "other": "Other",
    "unclassified": "Unclassified",
}

#: SQL expression mapping a ``tenant_repository_files`` row to one :data:`SPEC_FORMAT_LABELS`
#: key. Requires the files table aliased as ``f``. The JSON Schema arm intentionally repeats the
#: path test from :data:`app.database.REPOSITORY_FILE_IMPORTABLE_SQL` so a file is filed under
#: ``json_schema`` exactly when that predicate counts it as importable.
SPEC_FORMAT_SQL = """CASE
          WHEN f.detected_kind IS NULL THEN 'unclassified'
          WHEN f.detected_kind ILIKE 'openapi%%' OR f.detected_kind ILIKE 'swagger%%' THEN 'openapi'
          WHEN f.detected_kind ILIKE 'arazzo%%' THEN 'arazzo'
          WHEN f.detected_kind ILIKE 'asyncapi%%' THEN 'asyncapi'
          WHEN f.detected_kind ILIKE 'graphql%%' THEN 'graphql'
          WHEN f.detected_kind ILIKE 'protobuf%%' THEN 'protobuf'
          WHEN f.detected_kind ILIKE 'postman%%' THEN 'postman'
          WHEN f.detected_kind ILIKE 'sql-ddl%%' THEN 'sql_ddl'
          WHEN f.detected_kind ILIKE 'prisma%%' THEN 'prisma'
          WHEN f.detected_kind ILIKE 'avro%%' THEN 'avro'
          WHEN f.detected_kind ILIKE 'dbml%%' THEN 'dbml'
          WHEN f.detected_kind ILIKE 'json%%' AND (
            f.path ILIKE '%%.schema.json' OR
            f.path ILIKE '%%/schemas/%%.json' OR f.path ILIKE 'schemas/%%.json'
          ) THEN 'json_schema'
          ELSE 'other'
        END"""


# --- Derived status ----------------------------------------------------------------------

#: Stable status key → human label, in precedence order (see :data:`SPEC_STATUS_SQL`).
SPEC_STATUS_LABELS: Dict[str, str] = {
    "needs_attention": "Needs attention",
    "imported": "Imported",
    "mapped": "Mapped",
    "discovered": "Discovered",
}

#: SQL expression deriving a single catalog status per file. Requires the files table aliased as
#: ``f``, the most-recent import row as ``imp`` and the import spec as ``spec``.
#:
#: The four states are mutually exclusive and evaluated in this order:
#:
#: * ``needs_attention`` — the file failed quality scoring, or the scan left external ``$ref``s
#:   unresolved (REPO-3.9). Ranked first on purpose: an operator scanning the catalog wants the
#:   broken rows surfaced even when the spec has already been imported.
#: * ``imported`` — at least one ``tenant_repository_imports`` row exists for this file.
#: * ``mapped`` — a ``repository_import_spec`` binds the file to a project, but no import has
#:   run yet.
#: * ``discovered`` — indexed by the walker, not yet bound to anything.
SPEC_STATUS_SQL = """CASE
          WHEN f.quality_status = 'error' OR f.external_ref_warning IS NOT NULL
            THEN 'needs_attention'
          WHEN imp.id IS NOT NULL THEN 'imported'
          WHEN spec.id IS NOT NULL THEN 'mapped'
          ELSE 'discovered'
        END"""

#: Numeric twin of :data:`SPEC_STATUS_SQL`, projected alongside it so the catalog can be sorted
#: by severity. Sorting the text status instead would order it alphabetically — "discovered"
#: ahead of "needs_attention" — which is the opposite of what an operator triaging the catalog
#: is asking for.
SPEC_STATUS_RANK_SQL = """CASE
          WHEN f.quality_status = 'error' OR f.external_ref_warning IS NOT NULL THEN 0
          WHEN imp.id IS NOT NULL THEN 1
          WHEN spec.id IS NOT NULL THEN 2
          ELSE 3
        END"""


# --- Sorting -----------------------------------------------------------------------------

#: Sort key → ``ORDER BY`` clause. Every clause ends with ``f.id`` so that paging through a
#: 10k-row catalog is deterministic: without a unique tiebreaker, rows sharing a sort value can
#: swap between pages and be shown twice or skipped.
SPEC_SORT_SQL: Dict[str, str] = {
    "path": "f.path ASC, f.id ASC",
    "repository": "r.repository_full_name ASC, f.path ASC, f.id ASC",
    "format": "format_key ASC, f.path ASC, f.id ASC",
    "status": "status_rank ASC, f.path ASC, f.id ASC",
    "recent": "COALESCE(imp.created_at, f.created_at) DESC NULLS LAST, f.id ASC",
}

#: Sort applied when the caller supplies nothing (or something unrecognised).
DEFAULT_SPEC_SORT = "repository"


def normalize_sort(sort: Optional[str]) -> str:
    """Resolve a caller-supplied sort key to one this module can execute.

    Args:
        sort: The raw ``sort`` query parameter, possibly ``None`` or unrecognised.

    Returns:
        A key guaranteed to be present in :data:`SPEC_SORT_SQL`. Unknown values fall back to
        :data:`DEFAULT_SPEC_SORT` rather than raising — a stale bookmark should still render a
        catalog, and the key is never interpolated into SQL unvalidated.
    """
    key = (sort or "").strip().lower()
    return key if key in SPEC_SORT_SQL else DEFAULT_SPEC_SORT


def normalize_format(fmt: Optional[str]) -> Optional[str]:
    """Resolve a caller-supplied format filter to a known family key.

    Args:
        fmt: The raw ``format`` query parameter. ``None``, empty and ``"all"`` all mean
            "do not filter".

    Returns:
        A key from :data:`SPEC_FORMAT_LABELS`, or ``None`` for no filter.

    Raises:
        ValueError: If a non-empty value names no known family. Silently ignoring it would
            show the operator every row while the filter chip claims otherwise.
    """
    key = (fmt or "").strip().lower()
    if not key or key == "all":
        return None
    if key not in SPEC_FORMAT_LABELS:
        raise ValueError(
            f"unknown format '{key}'; expected one of: {', '.join(sorted(SPEC_FORMAT_LABELS))}"
        )
    return key


def normalize_status(status: Optional[str]) -> Optional[str]:
    """Resolve a caller-supplied status filter to a known status key.

    Args:
        status: The raw ``status`` query parameter. ``None``, empty and ``"all"`` all mean
            "do not filter".

    Returns:
        A key from :data:`SPEC_STATUS_LABELS`, or ``None`` for no filter.

    Raises:
        ValueError: If a non-empty value names no known status.
    """
    key = (status or "").strip().lower()
    if not key or key == "all":
        return None
    if key not in SPEC_STATUS_LABELS:
        raise ValueError(
            f"unknown status '{key}'; expected one of: {', '.join(SPEC_STATUS_LABELS)}"
        )
    return key


def escape_like(term: str) -> str:
    """Escape a user search term for use as a ``... ILIKE %s ESCAPE '\\'`` parameter.

    A term such as ``100%`` or ``user_id`` contains LIKE metacharacters. Left unescaped they
    silently widen the search — ``user_id`` would also match ``userXid`` — so each is prefixed
    with the backslash the ``ESCAPE`` clause declares.

    Args:
        term: The raw search text.

    Returns:
        The term with ``\\``, ``%`` and ``_`` escaped. Callers wrap the result in ``%`` to make
        it a contains-match.
    """
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def search_term_to_like(term: str) -> str:
    """Turn a raw search term into a contains-match ILIKE pattern.

    Args:
        term: The raw ``q`` query parameter.

    Returns:
        ``%<escaped term>%``.
    """
    return f"%{escape_like(term.strip())}%"


#: Longest search term accepted. The catalog search is a substring scan; an unbounded term is
#: pointless work rather than a useful query.
MAX_SEARCH_TERM_LENGTH = 256


def validate_search_term(term: Optional[str]) -> Optional[str]:
    """Normalize and bound the free-text ``q`` parameter.

    Args:
        term: The raw ``q`` query parameter.

    Returns:
        The trimmed term, or ``None`` when the caller supplied nothing searchable.

    Raises:
        ValueError: If the term contains a NUL byte (rejected by Postgres text parameters) or
            exceeds :data:`MAX_SEARCH_TERM_LENGTH`.
    """
    if term is None:
        return None
    trimmed = term.strip()
    if not trimmed:
        return None
    if "\x00" in trimmed:
        raise ValueError("search term contains an invalid character")
    if len(trimmed) > MAX_SEARCH_TERM_LENGTH:
        raise ValueError(f"search term is too long (max {MAX_SEARCH_TERM_LENGTH} characters)")
    return trimmed


def format_facet_options(counts: List[Tuple[str, int]]) -> List[Dict[str, object]]:
    """Attach display labels to raw ``(format_key, count)`` pairs.

    Args:
        counts: Grouped counts straight from the catalog facet query.

    Returns:
        One dict per family with ``value``, ``label`` and ``count``, ordered by descending
        count then key so the operator's biggest formats lead the filter list.
    """
    return [
        {"value": key, "label": SPEC_FORMAT_LABELS.get(key, key), "count": int(count)}
        for key, count in sorted(counts, key=lambda kv: (-kv[1], kv[0]))
    ]


def status_facet_options(counts: List[Tuple[str, int]]) -> List[Dict[str, object]]:
    """Attach display labels to raw ``(status_key, count)`` pairs.

    Args:
        counts: Grouped counts straight from the catalog facet query.

    Returns:
        One dict per status with ``value``, ``label`` and ``count``, in the fixed precedence
        order of :data:`SPEC_STATUS_LABELS` — unlike formats, an operator reads statuses as a
        severity ladder, so a stable order beats a count-sorted one. Statuses with no rows are
        omitted.
    """
    by_key = {str(key): int(count) for key, count in counts}
    return [
        {"value": key, "label": label, "count": by_key[key]}
        for key, label in SPEC_STATUS_LABELS.items()
        if key in by_key
    ]

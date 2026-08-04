"""Per-domain summary aggregation — DUW-1.3 (private-suite#2570).

The workspace tree draws every domain folder with a badge *before* anything is hydrated:
``customers/ 3·4``, ``billing/ 5·9``, ``shared/ 8``. Each lens reads a different number out of the
same folder — the schemas lens says ``3 classes``, the paths lens says ``4 ops``, the combined lens
prints both. Computing any of that in the browser would mean fetching the whole catalog first,
which is the exact read :mod:`app.scoped_catalog_store` exists to eliminate. So the counting happens
here, in SQL, over the whole version at once.

Four properties are load-bearing:

**Counts are exhaustive; member lists are not.** A badge that is only right for the first page is
not a badge, so every count covers the folder's entire membership. The shallow member rows beside
it are capped per domain, and a folder whose list was cut says so through ``classes_truncated`` /
``paths_truncated`` — the client continues it with the DUW-1.2 scoped reads rather than guessing.

**Enums are counted apart from objects.** The mockup's schemas lens draws two groups under a
folder, ``Schemas`` and ``Enums & unions``, and badges the folder with the first group's size only
(``customers/ 3 classes`` above a list of three objects and one enum). ``class_count`` and
``enum_count`` therefore *partition* the folder's classes rather than overlapping;
:func:`class_kind_expression` is the single definition of which side a class falls on.

**One pass per member kind, whatever the version holds.** Counting and listing are the same scan:
a window function carries each domain's totals onto its own member rows, so a summary of a
40-folder catalog costs the same four statements as a summary of a one-folder catalog. A per-domain
count query would be the N+1 this endpoint exists to prevent, and would pass every functional test.

**Reads commit.** Matching :mod:`app.scoped_catalog_store`: psycopg2 opens a transaction for a bare
SELECT too, and leaving the shared connection "idle in transaction" holds locks and blocks VACUUM.

The per-path *schema* rows the combined lens nests under each operation are not here: which classes
a path consumes is the schema↔path index of DUW-1.4. This module supplies the folders, the badges,
the class rows and the path/operation rows all three panels are built from.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence

from .domains_store import DOMAIN_COLUMNS, shared_bucket

__all__ = [
    "DEFAULT_MEMBER_LIMIT",
    "MAX_MEMBER_LIMIT",
    "clamp_member_limit",
    "class_kind_expression",
    "load_version_summary",
    "version_badge",
]

#: Most shallow member rows one domain may carry in a summary, per member kind. A folder larger
#: than this is listed up to the cap and flagged truncated; the client continues it through
#: ``GET /v1/workspace/{tenant}/version/{version}/classes?domain_id=…`` (DUW-1.2), which pages.
MAX_MEMBER_LIMIT = 200

#: Member rows per domain when a caller names no limit. Comfortably above the folder sizes the
#: mockup draws, and small enough that a catalog with many folders stays one modest response.
DEFAULT_MEMBER_LIMIT = 50

#: What a class row's ``kind`` may be. ``object`` is the mockup's ``Schemas`` group; ``enum`` and
#: ``union`` are its ``Enums & unions`` group, kept apart so the tree can draw the two icons the
#: mockup uses without re-reading the schema body.
CLASS_KIND_OBJECT = "object"
CLASS_KIND_ENUM = "enum"
CLASS_KIND_UNION = "union"


def class_kind_expression(column: str = "schema") -> str:
    """The SQL deciding which tree group a class belongs to.

    A class row stores its source schema minus ``properties``/``required`` (those become
    ``class_properties`` rows), so an enum component keeps its ``enum`` array and a union keeps its
    ``oneOf``/``anyOf`` — which makes the kind readable from the stored column with no join and no
    application-side pass over the catalog.

    Written as one expression, in one place, because it is used three times in the same statement —
    to label a member row, to count the ``Schemas`` group, and to count the ``Enums & unions``
    group — and three spellings that drifted apart would badge a folder with a number its own list
    contradicts.

    Args:
        column: The JSONB column or alias holding the schema.

    Returns:
        A SQL ``CASE`` expression evaluating to ``object``, ``enum`` or ``union``.
    """
    return f"""
        CASE
            WHEN jsonb_typeof({column} -> 'enum') = 'array' THEN '{CLASS_KIND_ENUM}'
            WHEN jsonb_typeof({column} -> 'oneOf') = 'array'
              OR jsonb_typeof({column} -> 'anyOf') = 'array' THEN '{CLASS_KIND_UNION}'
            ELSE '{CLASS_KIND_OBJECT}'
        END
    """


def clamp_member_limit(limit: Optional[int]) -> int:
    """Resolve a caller's per-domain member limit against the server cap.

    Clamped rather than rejected, following :func:`app.scoped_catalog_store.clamp_page_size`: an
    over-large request has a working continuation in the scoped reads, and the response echoes the
    limit actually applied.

    Zero is a legitimate value, not an empty request: it asks for badges alone, which is what a
    tree needs after an edit that changed counts but not the folder the user is looking at.

    Args:
        limit: The requested per-domain limit, or None for the default.

    Returns:
        A limit in ``[0, MAX_MEMBER_LIMIT]``.
    """
    if limit is None:
        return DEFAULT_MEMBER_LIMIT
    return max(0, min(int(limit), MAX_MEMBER_LIMIT))


def version_badge(version_label: Optional[str]) -> Optional[str]:
    """The badge the tree prints beside a schema row, from a version's own label.

    A class has no version of its own — ``apiome.classes`` has no such column, and could not: a
    class *is* one version's definition of a name, and the mockup's ``v2.1`` names the catalog the
    row was read from. This normalizes the stored label (``2.1``, ``v2.1``, ``1.4.2-draft``) to the
    one spelling the tree draws.

    Args:
        version_label: ``apiome.versions.version_id`` — the human version string, not the record
            UUID — or None.

    Returns:
        The badge text, or None when the version carries no label to badge with.
    """
    if version_label is None:
        return None
    label = str(version_label).strip()
    if not label:
        return None
    return label if label[:1].lower() == "v" else f"v{label}"


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _fetch_all(cursor: Any, query: str, params: Sequence[Any]) -> List[Dict[str, Any]]:
    """Execute a query and return every row as a plain dict."""
    cursor.execute(query, params)
    return [dict(row) for row in (cursor.fetchall() or [])]


def _key(domain_id: Any) -> Optional[str]:
    """The one spelling of a domain id both sides of a join can be keyed on.

    A ``uuid`` column arrives as :class:`uuid.UUID` from one statement and as text from another;
    None stays None, because that is the ``shared/`` bucket and it must not collide with a real id.

    Args:
        domain_id: A domain id in any accepted form, or None.

    Returns:
        The lowercase string form, or None for ``shared/``.
    """
    return None if domain_id is None else str(domain_id).lower()


def _int(value: Any) -> int:
    """A count column as a plain int, treating a missing aggregate as zero."""
    return 0 if value is None else int(value)


def _group_by_domain(rows: Iterable[Dict[str, Any]]) -> Dict[Optional[str], List[Dict[str, Any]]]:
    """Bucket aggregate rows by their domain, preserving the order they arrived in."""
    grouped: Dict[Optional[str], List[Dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(_key(row["domain_id"]), []).append(row)
    return grouped


# ─── Statements ──────────────────────────────────────────────────────────────

#: The version's live folders, in tree order. Inlined rather than delegated to
#: :func:`app.domains_store.list_domains` so the whole summary is one cursor, one transaction and
#: one statement tally — the "single round trip" the ticket asks for is a property worth being able
#: to assert. The column list is shared with that module so the two cannot describe a folder
#: differently.
_DOMAINS_QUERY = f"""
    SELECT {DOMAIN_COLUMNS}
      FROM apiome.domains
     WHERE version_id = %s::uuid AND deleted_at IS NULL
     ORDER BY sort_order, slug
"""

#: Every domain's class counts, plus that domain's first ``member_limit`` class rows.
#:
#: The ``counted`` CTE is the authority on the badge — it aggregates the whole version, so a count
#: is never a page's length. ``ranked`` numbers each folder's rows independently, and the LEFT JOIN
#: keeps a folder that has classes but was asked for none (``member_limit = 0``), and a folder that
#: has none at all, in the result with its counts intact.
#:
#: ``IS NOT DISTINCT FROM`` joins the buckets rather than ``=``: the ``shared/`` bucket's domain is
#: NULL on both sides, and ``NULL = NULL`` would drop the largest folder in most catalogs.
#:
#: Objects sort before enums and unions so a truncated list is cut from the ``Enums & unions``
#: group upward, matching the order the mockup draws the two groups in.
_CLASS_SUMMARY_QUERY = f"""
    WITH scoped AS (
        SELECT id, name, domain_id, ({class_kind_expression()}) AS kind
          FROM apiome.classes
         WHERE version_id = %s::uuid AND deleted_at IS NULL
    ),
    counted AS (
        SELECT domain_id,
               COUNT(*) FILTER (WHERE kind = '{CLASS_KIND_OBJECT}') AS class_count,
               COUNT(*) FILTER (WHERE kind <> '{CLASS_KIND_OBJECT}') AS enum_count
          FROM scoped
         GROUP BY domain_id
    ),
    ranked AS (
        SELECT id, name, domain_id, kind,
               ROW_NUMBER() OVER (
                   PARTITION BY domain_id
                   ORDER BY (kind <> '{CLASS_KIND_OBJECT}'), name ASC, id ASC
               ) AS rn
          FROM scoped
    )
    SELECT c.domain_id, c.class_count, c.enum_count,
           r.id, r.name, r.kind, r.rn
      FROM counted c
      LEFT JOIN ranked r
             ON r.domain_id IS NOT DISTINCT FROM c.domain_id
            AND r.rn <= %s
     ORDER BY c.domain_id, r.rn
"""

#: Every domain's path and operation counts, plus that domain's first ``member_limit`` path rows.
#:
#: ``op_count`` is counted per path in the scan and summed per domain by the same aggregate, so the
#: paths-lens badge (``customers/ 4 ops``) and the per-path badge (``/customers  2 ops``) are two
#: readings of one number and cannot disagree. The domain total covers paths the member list does
#: not reach, which is why it is not derivable from the rows returned.
_PATH_SUMMARY_QUERY = """
    WITH scoped AS (
        SELECT vp.id, vp.pathname, vp.domain_id,
               (SELECT COUNT(*) FROM apiome.path_operation po
                 WHERE po.version_path_id = vp.id) AS op_count
          FROM apiome.version_path vp
         WHERE vp.version_id = %s::uuid
    ),
    counted AS (
        SELECT domain_id,
               COUNT(*) AS path_count,
               COALESCE(SUM(op_count), 0) AS op_count
          FROM scoped
         GROUP BY domain_id
    ),
    ranked AS (
        SELECT id, pathname, domain_id, op_count,
               ROW_NUMBER() OVER (
                   PARTITION BY domain_id ORDER BY pathname ASC, id ASC
               ) AS rn
          FROM scoped
    )
    SELECT c.domain_id, c.path_count, c.op_count AS domain_op_count,
           r.id, r.pathname, r.op_count AS path_op_count, r.rn
      FROM counted c
      LEFT JOIN ranked r
             ON r.domain_id IS NOT DISTINCT FROM c.domain_id
            AND r.rn <= %s
     ORDER BY c.domain_id, r.rn
"""

#: The operations of the paths a summary actually returned — verb, operationId, summary and the
#: deprecation flag, which is every field the mockup's paths lens draws on an operation row.
#:
#: Complete rather than capped, unlike the member lists above: ``apiome.path_operation`` is unique
#: on ``(version_path_id, operation)``, so a path can carry at most one row per HTTP method and the
#: list is bounded by the method vocabulary, not by the catalog.
_OPERATIONS_QUERY = """
    SELECT po.id, po.version_path_id, po.operation,
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
"""


# ─── Projection ──────────────────────────────────────────────────────────────


def _class_rows(rows: Sequence[Dict[str, Any]], badge: Optional[str]) -> List[Dict[str, Any]]:
    """Shallow class rows for one folder, from that folder's aggregate rows.

    Args:
        rows: The folder's rows from :data:`_CLASS_SUMMARY_QUERY`. A folder with no members, or
            one asked for none, contributes a single row whose member columns are NULL; it is
            skipped here rather than becoming a nameless tree entry.
        badge: The version badge to stamp on each row, or None.

    Returns:
        One dict per class: id, name, kind, badge. No schema body, no properties, no tags — a tree
        row needs none of them, and shipping them is the habit this epic exists to break.
    """
    return [
        {
            "id": str(row["id"]),
            "name": row["name"],
            "kind": row["kind"],
            "version_badge": badge,
        }
        for row in rows
        if row["id"] is not None
    ]


def _path_rows(
    rows: Sequence[Dict[str, Any]],
    operations_by_path: Dict[str, List[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Shallow path rows for one folder, each carrying its operations.

    Args:
        rows: The folder's rows from :data:`_PATH_SUMMARY_QUERY`.
        operations_by_path: Operations keyed by path id, as loaded for every returned path.

    Returns:
        One dict per path: id, pathname, its operation count, and its operations.
    """
    projected: List[Dict[str, Any]] = []
    for row in rows:
        if row["id"] is None:
            continue
        path_id = str(row["id"])
        projected.append(
            {
                "id": path_id,
                "pathname": row["pathname"],
                "op_count": _int(row["path_op_count"]),
                "operations": operations_by_path.get(path_id, []),
            }
        )
    return projected


def _operation_rows(rows: Iterable[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Group shallow operation rows by the path they belong to."""
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row["version_path_id"]), []).append(
            {
                "id": str(row["id"]),
                "operation": row["operation"],
                "operation_id": row.get("operation_id"),
                "summary": row.get("summary"),
                "deprecated": bool(row.get("deprecated")),
            }
        )
    return grouped


def _domain_summary(
    domain: Dict[str, Any],
    *,
    class_rows: Sequence[Dict[str, Any]],
    path_rows: Sequence[Dict[str, Any]],
    operations_by_path: Dict[str, List[Dict[str, Any]]],
    badge: Optional[str],
) -> Dict[str, Any]:
    """Assemble one folder's entry: its identity, its four counts, its member lists.

    Args:
        domain: The folder — a ``apiome.domains`` row, or the synthesized ``shared/`` bucket.
        class_rows: That folder's rows from the class statement, possibly empty.
        path_rows: That folder's rows from the path statement, possibly empty.
        operations_by_path: Operations for every path the summary returned.
        badge: The version badge stamped on each class row.

    Returns:
        The folder's summary, counts included whether or not any member row came back with them —
        an empty folder still draws in the tree, with zeroes.
    """
    classes = _class_rows(class_rows, badge)
    paths = _path_rows(path_rows, operations_by_path)

    class_count = _int(class_rows[0]["class_count"]) if class_rows else 0
    enum_count = _int(class_rows[0]["enum_count"]) if class_rows else 0
    path_count = _int(path_rows[0]["path_count"]) if path_rows else 0
    op_count = _int(path_rows[0]["domain_op_count"]) if path_rows else 0

    return {
        "id": None if domain["id"] is None else str(domain["id"]),
        "name": domain["name"],
        "slug": domain["slug"],
        "sort_order": _int(domain["sort_order"]),
        "virtual": bool(domain.get("virtual", False)),
        "class_count": class_count,
        "enum_count": enum_count,
        "path_count": path_count,
        "op_count": op_count,
        "classes": classes,
        "paths": paths,
        "classes_truncated": len(classes) < class_count + enum_count,
        "paths_truncated": len(paths) < path_count,
    }


# ─── The read ────────────────────────────────────────────────────────────────


def load_version_summary(
    db: Any,
    *,
    version_id: str,
    member_limit: int,
    badge: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Summarize every domain folder of one version in a single round trip.

    Four statements, whatever the version holds: the folders, the class aggregate, the path
    aggregate, and the operations of the paths that came back. The fourth is skipped when no path
    row was returned, so a badges-only summary costs three.

    Args:
        db: Database handle exposing ``connect()``.
        version_id: The version to summarize. The caller must already have resolved it against the
            tenant — every statement here is scoped by it and by nothing else, exactly as the
            scoped reads are.
        member_limit: Most member rows to return per folder, per kind. Already clamped by
            :func:`clamp_member_limit`; zero returns counts alone.
        badge: The version badge to stamp on each class row, from :func:`version_badge`.

    Returns:
        One entry per folder in tree order — the version's live domains by ``sort_order`` then
        ``slug``, then the derived ``shared/`` bucket last, where the mockup draws it. Every folder
        appears whether or not it has members, because a tree that hides empty folders would make a
        newly created one look like a failed write.

        Folders drive the result, not the aggregates: a member is drawn under the folder it names.
        A member naming a folder that is not live cannot exist — V242 releases members to
        ``shared/`` when a domain is soft-deleted and ``ON DELETE SET NULL`` covers a hard delete —
        so there is no orphan bucket to synthesize here.
    """
    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            domains = _fetch_all(cursor, _DOMAINS_QUERY, (version_id,))
            class_rows = _fetch_all(cursor, _CLASS_SUMMARY_QUERY, (version_id, member_limit))
            path_rows = _fetch_all(cursor, _PATH_SUMMARY_QUERY, (version_id, member_limit))

            path_ids = [str(row["id"]) for row in path_rows if row["id"] is not None]
            operations = (
                _fetch_all(cursor, _OPERATIONS_QUERY, (path_ids,)) if path_ids else []
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    classes_by_domain = _group_by_domain(class_rows)
    paths_by_domain = _group_by_domain(path_rows)
    operations_by_path = _operation_rows(operations)

    folders = list(domains) + [shared_bucket(version_id, len(domains))]
    return [
        _domain_summary(
            domain,
            class_rows=classes_by_domain.get(_key(domain["id"]), []),
            path_rows=paths_by_domain.get(_key(domain["id"]), []),
            operations_by_path=operations_by_path,
            badge=badge,
        )
        for domain in folders
    ]

"""Consumption-index reads — DUW-1.4 (private-suite#2571).

Everything the schema↔path index is computed from, loaded in a fixed **seven statements** whatever
the version holds: the classes, their properties, the paths in scope, those paths' operations, and
the three places an operation names a schema — its request body, its responses, its parameters.

Traversal and resolution live in :mod:`app.consumption_index`; this module only fetches. The split
is deliberate: the graph rules are the part worth testing on fixtures, and the SQL is the part
worth pinning to a real server.

Four decisions are load-bearing:

**Seven statements, never per-operation.** Hydrating one operation's schemas through
:meth:`app.database.Database.get_responses_for_operation` and friends is three round trips *per
operation*; a 218-path catalog would be six hundred. Each loader here is scoped by version and by
the request's path scope, so cost tracks the catalog once rather than the operation count. The
statement tally is asserted directly, because an N+1 introduced here would pass every functional
test and only surface as latency on a catalog no fixture has.

**Classes are loaded whole-version even when paths are scoped.** A nested edge can leave the
scoped folder — ``customers/`` returning ``Customer`` drags in a ``shared/`` ``Address`` — so
restricting the class graph to the scope would drop exactly the edges the dashed rose lens exists
to draw. The rows are small: id, name, the schema column and each property's ``data``, with no
tags, descriptions or canvas metadata.

**Schema sources mirror what the emitter reads, not what the schema still contains.** Responses
come from ``shared_path_response`` + ``shared_path_response_content``, request bodies from
``shared_path_request_body_content``, parameters from ``shared_path_parameter`` — the tables
:mod:`app.paths_generator` builds the OpenAPI document from. The V028-era ``path_response``,
``path_response_content``, ``path_operation_schema`` and ``path_parameter_schema`` tables were
superseded by V031–V034 and are read by nothing; indexing them would invent edges that no exported
document contains.

**Reads commit.** Matching :mod:`app.scoped_catalog_store` and :mod:`app.workspace_summary_store`:
psycopg2 opens a transaction for a bare SELECT too, and leaving the shared connection "idle in
transaction" holds locks and blocks VACUUM.
"""

from __future__ import annotations

from typing import Any, Dict, List, NamedTuple, Optional, Protocol, Sequence

from .scoped_catalog_store import SHARED_DOMAIN_ID

__all__ = [
    "SHARED_DOMAIN_ID",
    "VersionFacts",
    "domain_scope",
    "id_scope",
    "load_version_facts",
    "whole_version_scope",
]


class _DbLike(Protocol):
    """Minimal database surface used by this module."""

    def connect(self) -> Any: ...


class _Scope(NamedTuple):
    """Which of a version's paths the index covers.

    Attributes:
        sql: A SQL fragment appended to every ``version_path`` predicate, or an empty string for
            the whole version.
        params: The parameters ``sql`` binds, in order.
        kind: How the scope was selected — ``version``, ``domain`` or ``path_ids`` — echoed back to
            the caller so a response says which question it answered.
        domain_id: The folder scoped to, or None.
        path_ids: The paths scoped to, or an empty tuple.
    """

    sql: str
    params: tuple
    kind: str
    domain_id: Optional[str]
    path_ids: tuple


def whole_version_scope() -> _Scope:
    """Every path of the version.

    The default. Unlike the DUW-1.2 catalog reads, an unscoped index is not the read this epic
    exists to prevent: an edge is a handful of ids, the whole version's edges are one modest
    response, and the status bar's link count is a version-wide question. The response is still
    bounded — see the route's edge cap.
    """
    return _Scope(sql="", params=(), kind="version", domain_id=None, path_ids=())


def domain_scope(domain_id: Optional[str]) -> _Scope:
    """Only paths filed under one folder.

    ``IS NOT DISTINCT FROM`` rather than ``=``, because ``shared/`` is ``domain_id IS NULL`` on
    both sides and ``NULL = NULL`` is NULL — which would answer "that folder is empty" for the
    largest folder in most catalogs.

    Args:
        domain_id: The folder's UUID, or None for ``shared/``.
    """
    return _Scope(
        sql=" AND vp.domain_id IS NOT DISTINCT FROM %s::uuid",
        params=(domain_id,),
        kind="domain",
        domain_id=domain_id,
        path_ids=(),
    )


def id_scope(path_ids: Sequence[str]) -> _Scope:
    """Only the named paths.

    Args:
        path_ids: Path UUIDs, already validated as castable by
            :func:`app.scoped_catalog_store.normalize_ids`.
    """
    ids = tuple(str(value) for value in path_ids)
    return _Scope(
        sql=" AND vp.id = ANY(%s::uuid[])",
        params=(list(ids),),
        kind="path_ids",
        domain_id=None,
        path_ids=ids,
    )


class VersionFacts(NamedTuple):
    """Everything one consumption index is computed from.

    Attributes:
        classes: ``id``, ``name``, ``schema`` for every live class of the version.
        class_properties: ``class_id``, ``data`` for every property of those classes.
        paths: ``id``, ``pathname``, ``domain_id`` for the paths in scope.
        operations: ``id``, ``version_path_id``, ``operation``, ``operation_id``, ``summary``,
            ``deprecated`` for those paths' operations.
        request_contents: One row per request-body content type reachable from those operations.
        response_contents: One row per (response, content type) pair, the content columns NULL when
            the response defines no content row.
        parameters: One row per parameter linked to those operations.
    """

    classes: List[Dict[str, Any]]
    class_properties: List[Dict[str, Any]]
    paths: List[Dict[str, Any]]
    operations: List[Dict[str, Any]]
    request_contents: List[Dict[str, Any]]
    response_contents: List[Dict[str, Any]]
    parameters: List[Dict[str, Any]]


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _fetch_all(cursor: Any, query: str, params: Sequence[Any]) -> List[Dict[str, Any]]:
    """Execute a query and return every row as a plain dict."""
    cursor.execute(query, params)
    return [dict(row) for row in (cursor.fetchall() or [])]


# ─── Statements ──────────────────────────────────────────────────────────────

#: The version's classes, reduced to what the graph needs. ``schema`` carries the class-level
#: ``allOf``/``anyOf``/``oneOf``, which is how a union names its members; the description, tags and
#: canvas metadata a class also has are not references and are left where they are.
_CLASSES_QUERY = """
    SELECT id, name, schema
      FROM apiome.classes
     WHERE version_id = %s::uuid AND deleted_at IS NULL
     ORDER BY name, id
"""

#: Every property of those classes, reduced to the column references live in. Joined through
#: ``classes`` rather than filtered by a class-id array so the statement is independent of how many
#: classes the version holds.
_CLASS_PROPERTIES_QUERY = """
    SELECT cp.class_id, cp.data
      FROM apiome.class_properties cp
      JOIN apiome.classes c ON c.id = cp.class_id
     WHERE c.version_id = %s::uuid AND c.deleted_at IS NULL
     ORDER BY cp.class_id, cp.name
"""

#: The paths in scope. ``{scope}`` is the request's path predicate, empty for a whole-version read.
_PATHS_QUERY = """
    SELECT vp.id, vp.pathname, vp.domain_id
      FROM apiome.version_path vp
     WHERE vp.version_id = %s::uuid{scope}
     ORDER BY vp.pathname, vp.id
"""

#: Those paths' operations, with the fields an edge names an operation by.
_OPERATIONS_QUERY = """
    SELECT po.id, po.version_path_id, po.operation,
           pod.operation_id,
           pod.summary,
           COALESCE((pod.metadata->>'deprecated')::boolean, false) AS deprecated
      FROM apiome.path_operation po
      JOIN apiome.version_path vp ON vp.id = po.version_path_id
      LEFT JOIN apiome.path_operation_description pod ON pod.path_operation_id = po.id
     WHERE vp.version_id = %s::uuid{scope}
     ORDER BY po.version_path_id, po.operation, po.id
"""

#: Request-body schemas per operation. A request body is shared across a path's operations through
#: ``path_operation_request_body_link``, so the same content row can legitimately appear under
#: several operations — each is its own edge, because each operation really does consume it.
_REQUEST_CONTENTS_QUERY = """
    SELECT link.path_operation_id, rbc.class_id, rbc.inline_schema
      FROM apiome.path_operation_request_body_link link
      JOIN apiome.path_operation po ON po.id = link.path_operation_id
      JOIN apiome.version_path vp ON vp.id = po.version_path_id
      JOIN apiome.shared_path_request_body_content rbc
        ON rbc.shared_path_request_body_id = link.shared_path_request_body_id
     WHERE vp.version_id = %s::uuid{scope}
     ORDER BY link.path_operation_id, rbc.media_type
"""

#: Response schemas per operation, one row per (response, content type).
#:
#: The LEFT JOIN keeps responses that define no content row, which are the ones whose schema is on
#: the response itself — the fallback :func:`app.paths_generator.build_response_for_openapi` reads.
#: Precedence between the two is applied by :func:`app.consumption_index.resolve_operations`, not
#: here, because it is a rule about what the emitted document says rather than about what is
#: stored.
_RESPONSE_CONTENTS_QUERY = """
    SELECT porl.path_operation_id,
           spr.id AS response_id,
           spr.status_code,
           spr.class_id,
           spr.inline_schema,
           spr.data,
           rc.id AS content_id,
           rc.class_id AS content_class_id,
           rc.inline_schema AS content_inline_schema
      FROM apiome.path_operation_response_link porl
      JOIN apiome.path_operation po ON po.id = porl.path_operation_id
      JOIN apiome.version_path vp ON vp.id = po.version_path_id
      JOIN apiome.shared_path_response spr ON spr.id = porl.shared_path_response_id
      LEFT JOIN apiome.shared_path_response_content rc ON rc.shared_path_response_id = spr.id
     WHERE vp.version_id = %s::uuid{scope}
     ORDER BY porl.path_operation_id, spr.status_code, rc.media_type
"""

#: Parameters per operation. A parameter's ``data`` is a schema like any other and may ``$ref`` a
#: class — rare in practice, and an edge the client-side derivation never drew.
_PARAMETERS_QUERY = """
    SELECT popl.path_operation_id, spp.data
      FROM apiome.path_operation_parameter_link popl
      JOIN apiome.path_operation po ON po.id = popl.path_operation_id
      JOIN apiome.version_path vp ON vp.id = po.version_path_id
      JOIN apiome.shared_path_parameter spp ON spp.id = popl.shared_path_parameter_id
     WHERE vp.version_id = %s::uuid{scope}
     ORDER BY popl.path_operation_id, spp.in_location, spp.name
"""


# ─── The read ────────────────────────────────────────────────────────────────


def load_version_facts(db: _DbLike, *, version_id: str, scope: _Scope) -> VersionFacts:
    """Load everything one consumption index is computed from.

    Args:
        db: Database handle exposing ``connect()``.
        version_id: The version to index. The caller must already have resolved it against the
            tenant — every statement is scoped by it and by nothing else, exactly as the DUW-1.2
            and DUW-1.3 reads are.
        scope: Which paths to cover, from :func:`whole_version_scope`, :func:`domain_scope` or
            :func:`id_scope`. It narrows the *path* side only; classes are always loaded whole so a
            nested edge may leave the scope.

    Returns:
        The raw rows, unresolved. Seven statements, whatever the version or the scope holds.
    """
    scoped_params = (version_id,) + tuple(scope.params)

    conn = db.connect()
    try:
        with conn.cursor() as cursor:
            classes = _fetch_all(cursor, _CLASSES_QUERY, (version_id,))
            class_properties = _fetch_all(cursor, _CLASS_PROPERTIES_QUERY, (version_id,))
            paths = _fetch_all(cursor, _PATHS_QUERY.format(scope=scope.sql), scoped_params)
            operations = _fetch_all(
                cursor, _OPERATIONS_QUERY.format(scope=scope.sql), scoped_params
            )
            request_contents = _fetch_all(
                cursor, _REQUEST_CONTENTS_QUERY.format(scope=scope.sql), scoped_params
            )
            response_contents = _fetch_all(
                cursor, _RESPONSE_CONTENTS_QUERY.format(scope=scope.sql), scoped_params
            )
            parameters = _fetch_all(
                cursor, _PARAMETERS_QUERY.format(scope=scope.sql), scoped_params
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    return VersionFacts(
        classes=classes,
        class_properties=class_properties,
        paths=paths,
        operations=operations,
        request_contents=request_contents,
        response_contents=response_contents,
        parameters=parameters,
    )

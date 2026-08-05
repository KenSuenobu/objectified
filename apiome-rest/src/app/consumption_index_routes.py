"""Schema↔path consumption index API — DUW-1.4 (private-suite#2571).

One read that answers *which operations consume which classes, and how*. Five surfaces of the
unified workspace are built on it and today each would have to derive it in the browser:

* the combined lens's edges — solid amber for a schema named directly by a request or response,
  dashed rose for one reached through a parent class;
* the tree's per-path ``Schemas`` rows (``Customer 200``, ``Address nested``);
* the palette's "find every path that consumes X" action;
* the inspector's ``Consumes`` list;
* the status bar's ``N schema↔path links`` chip.

Today's derivation is ``createAllEdges`` in the designer: O(classes×properties) over a full-catalog
fetch, and schema↔schema only — it has never known that an *operation* consumes anything.

Four rules the surface rests on:

**The whole version is the default scope, and the selectors filter it.** Unlike the DUW-1.2
catalog reads, an unscoped index is not the read this epic exists to prevent: an edge is a handful
of ids rather than a schema body, and "how many links does this version have" is a question the
status bar actually asks. ``domain_id`` and ``path_ids`` narrow the *path* side and are mutually
exclusive; ``class_ids`` narrows the *class* side and composes with either, because "which of these
classes does ``customers/`` consume" is a real question and refusing it would only push the
intersection into the client.

**Classes are never scoped away from the walk.** A nested edge routinely leaves the scoped folder —
``customers/`` returning ``Customer`` drags in a ``shared/`` ``Address``. The class graph is built
over the whole version and the filters are applied to the resulting edges, so a scoped answer is a
subset of the unscoped one rather than a differently-computed one.

**The answer is bounded, and says when it was bounded.** :data:`MAX_EDGES` caps the edge list;
:data:`~app.consumption_index.MAX_NESTING_DEPTH` caps how far a nested edge may sit from its root.
Hitting either is reported (``truncated``, ``depth_capped``) rather than silently absorbed. There
is no cursor: an edge means nothing without both members it connects, so a half-drawn graph is
worse than a smaller scope.

**Caching is content-addressed.** The index is computed on read and never persisted (no table in
v1), and the response carries a strong ``ETag`` that is a digest of the body itself. That keys it
on version content by construction — and on the scope too, which a stored version-content hash
would not — so a client polling the same scope gets ``304 Not Modified`` until something the index
actually depends on changes. Same convention as the APX-3.4 agent outputs.

**Tenancy is resolved through the version**, as in DUW-1.2/1.3: the version is looked up inside the
caller's tenant first and every statement is then scoped by it. Another tenant's version is a 404.
"""

import hashlib
import json
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from fastapi.responses import JSONResponse

from . import consumption_index as index
from . import consumption_index_store as store
from . import domains_store
from .auth import validate_authentication
from .database import db
from .models import ConsumptionIndex
from .scoped_catalog_store import (
    MAX_SELECTED_IDS,
    SHARED_DOMAIN_ID,
    canonical_id,
    normalize_ids,
)

router = APIRouter(prefix="/v1/workspace", tags=["workspace"])

#: Most edges one response may carry. Sized well above any hand-drawn catalog — the mockup's whole
#: scenario is seven — and below the point where a JSON body stops being a thing a browser should
#: parse on a keystroke. A request that reaches it is asking a question about a catalog, not about
#: a canvas, and the answer says so rather than paging: an edge is only meaningful beside the two
#: members it connects, so a cursor would hand back half-drawn graphs.
MAX_EDGES = 5000

#: How long a client may reuse the body without revalidating. Short, because a catalog edit should
#: show up on the canvas promptly; the ETag makes the revalidation itself free.
_MAX_AGE = 30

_DOMAIN_DESCRIPTION = (
    "Restrict to operations on paths in this folder, or the literal 'shared' for paths with no "
    "folder. Mutually exclusive with path_ids. Nested edges may still name classes outside the "
    "folder — that is what 'nested via parent' means."
)

_PATH_IDS_DESCRIPTION = (
    "Restrict to these paths. Repeat the parameter or comma-separate the values; duplicates "
    f"collapse. At most {MAX_SELECTED_IDS} ids per request. Mutually exclusive with domain_id."
)

_CLASS_IDS_DESCRIPTION = (
    "Restrict to edges consuming these classes — 'every path that consumes X'. Filters the class "
    f"side only, so it composes with domain_id or path_ids. At most {MAX_SELECTED_IDS} ids."
)


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """The caller's tenant, or a 500 when the token carried none."""
    tid = auth_data.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=500, detail="Missing tenant context")
    return str(tid)


def _assert_version_in_tenant(version_id: str, tenant_id: str) -> Dict[str, Any]:
    """Resolve a version inside the caller's tenant, or 404.

    The only tenancy gate in this module: classes, paths and domains are all reached through their
    version, so scoping the version scopes the whole index.

    Args:
        version_id: The version record UUID.
        tenant_id: The caller's tenant.

    Returns:
        The version row.

    Raises:
        HTTPException: 404 when the version does not exist in this tenant.
    """
    version = db.get_version_by_id(version_id, tenant_id)
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    return version


def _blank_to_none(value: Optional[str]) -> Optional[str]:
    """Treat an empty or whitespace-only query value as absent.

    ``?domain_id=`` is a client that meant to send a folder and sent nothing; reading it as "no
    folder" would silently answer for ``shared/`` instead.
    """
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def _selected_ids(raw: Optional[List[str]], *, parameter: str) -> Tuple[List[str], List[str]]:
    """Normalize an id selector against the shared cap.

    Reuses :func:`app.scoped_catalog_store.normalize_ids` so all three workspace reads accept the
    same two spellings (repeated parameter and comma-separated) and enforce one cap.

    Args:
        raw: The query parameter values as received, or None.
        parameter: The parameter's name, for an error that names what the caller actually sent.

    Returns:
        ``(ids, malformed)`` — ids fit to reach SQL, and entries that are not ids at all. Malformed
        entries are reported among ``missing_ids`` rather than sent to Postgres, where a ``::uuid``
        cast would raise a 500 for what is really "no such path".

    Raises:
        HTTPException: 400 when more than :data:`~app.scoped_catalog_store.MAX_SELECTED_IDS` were
            given. Rejected rather than truncated: there is no cursor for an arbitrary id set, so
            quietly answering a smaller question would be undetectable.
    """
    ids, malformed = normalize_ids(raw)
    requested = len(ids) + len(malformed)
    if requested > MAX_SELECTED_IDS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"At most {MAX_SELECTED_IDS} {parameter} per request; {requested} were given. "
                "Split the selection across requests."
            ),
        )
    return ids, malformed


def _resolve_scope(
    *,
    domain_id: Optional[str],
    path_ids: Optional[List[str]],
    version_id: str,
) -> Tuple[Any, List[str]]:
    """Decide which paths the index covers, and validate the selector that says so.

    Args:
        domain_id: The ``domain_id`` query value, or None.
        path_ids: The ``path_ids`` query values, or None.
        version_id: The version, for verifying a named folder belongs to it.

    Returns:
        ``(scope, malformed_path_ids)`` — the store scope, and any path ids that are not ids at
        all, for ``missing_ids``.

    Raises:
        HTTPException: 400 when both path selectors are given, 404 when the named folder is not a
            live folder of this version.
    """
    domain = _blank_to_none(domain_id)
    ids, malformed = _selected_ids(path_ids, parameter="path_ids")

    if domain is not None and (ids or malformed):
        raise HTTPException(
            status_code=400, detail="Use either path_ids or domain_id, not both."
        )

    if domain is not None:
        resolved = None if domain == SHARED_DOMAIN_ID else domain
        _assert_domain_in_version(resolved, version_id)
        return store.domain_scope(resolved), []

    if ids or malformed:
        return store.id_scope(ids), malformed

    return store.whole_version_scope(), []


def _assert_domain_in_version(domain_id: Optional[str], version_id: str) -> None:
    """Check that a named domain is a live folder of this version.

    ``shared/`` (None) is always valid — it is the absence of a domain and exists in every version.
    A real domain is verified so a stale or foreign id answers 404 with a reason rather than an
    empty index a client would read as "that folder consumes nothing".

    Args:
        domain_id: The resolved domain, or None for ``shared/``.
        version_id: The version the index is scoped to.

    Raises:
        HTTPException: 404 when the domain is missing, deleted, or belongs to another version.
    """
    if domain_id is None:
        return
    domain = domains_store.get_domain(db, domain_id=domain_id)
    if not domain or str(domain["version_id"]) != str(version_id):
        raise HTTPException(status_code=404, detail="Domain not found in this version")


def _missing_path_ids(scope: Any, paths: Sequence[Dict[str, Any]]) -> List[str]:
    """Path ids the caller named that this version does not hold.

    Args:
        scope: The resolved scope; only a ``path_ids`` scope names any.
        paths: The path rows that did resolve.

    Returns:
        The named-but-absent ids, in the caller's own spelling and in the order they were
        requested — that is what a client matches them back against its selection. A path deleted
        since the selection was made, or one from another tenant's catalog, lands here rather than
        simply being absent from the answer.
    """
    if scope.kind != "path_ids":
        return []
    resolved = {canonical_id(row["id"]) for row in paths}
    return [value for value in scope.path_ids if canonical_id(value) not in resolved]


def _filter_by_classes(
    edges: Sequence[index.ConsumptionEdge], class_ids: Sequence[str]
) -> List[index.ConsumptionEdge]:
    """Keep only the edges consuming one of the named classes.

    Applied *after* the walk, never before it: restricting the graph first would drop the very
    parents a nested edge is reached through, and "every path that consumes Address" would then
    miss every path that consumes it through ``Customer`` — which is most of them.

    Args:
        edges: Every edge in the path scope.
        class_ids: The classes to keep, already normalized.

    Returns:
        The matching edges, in their existing order.
    """
    wanted = {canonical_id(value) for value in class_ids}
    return [edge for edge in edges if canonical_id(edge.class_id) in wanted]


def _via(graph: index.ClassGraph, chain: Sequence[str]) -> List[Dict[str, Any]]:
    """Name each hop of a nested edge's parent chain."""
    return [{"class_id": class_id, "class_name": graph.name_of(class_id)} for class_id in chain]


def _edge_payload(edge: index.ConsumptionEdge, graph: index.ClassGraph) -> Dict[str, Any]:
    """Project one resolved edge onto the response shape."""
    return {
        "path_id": edge.path_id,
        "pathname": edge.pathname,
        "domain_id": edge.domain_id,
        "operation_uuid": edge.operation_uuid,
        "method": edge.method,
        "operation_id": edge.operation_id,
        "class_id": edge.class_id,
        "class_name": edge.class_name,
        "kind": edge.kind,
        "roles": list(edge.roles),
        "via": _via(graph, edge.via),
        "depth": edge.depth,
    }


def _path_payload(rolled: Dict[str, Any], graph: index.ClassGraph) -> Dict[str, Any]:
    """Project one rolled-up path onto the response shape."""
    return {
        "path_id": rolled["path_id"],
        "pathname": rolled["pathname"],
        "domain_id": rolled["domain_id"],
        "classes": [
            {
                "class_id": row["class_id"],
                "class_name": row["class_name"],
                "kind": row["kind"],
                "roles": row["roles"],
                "badge": row["badge"],
                "via": _via(graph, row["via"]),
                "depth": row["depth"],
            }
            for row in rolled["classes"]
        ],
    }


def _etag(payload: Dict[str, Any]) -> str:
    """A strong, content-addressed ETag for a response body.

    Digests the canonical form of the payload rather than the serialized bytes, so a change in JSON
    formatting cannot invalidate every client's cache while a change in the index cannot fail to.
    Same double-quoted 16-hex convention as :func:`app.slate_agent_outputs.output_etag`, so one
    client-side comparison works across the API.

    Args:
        payload: The response body as plain JSON-able data.

    Returns:
        The quoted ETag value.
    """
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return '"' + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16] + '"'


def _if_none_match_hit(if_none_match: Optional[str], etag: str) -> bool:
    """Whether the client's ``If-None-Match`` already holds this ETag.

    Tolerates the weak-validator ``W/`` prefix, the ``*`` wildcard and a comma-separated list,
    matching :func:`app.slate_agent_outputs_routes._if_none_match_hit`.
    """
    if not if_none_match:
        return False
    for candidate in if_none_match.split(","):
        token = candidate.strip()
        if token == "*":
            return True
        if token.startswith("W/"):
            token = token[2:].strip()
        if token == etag:
            return True
    return False


@router.get(
    "/{tenant_slug}/version/{version_id}/consumption",
    response_model=ConsumptionIndex,
    responses={
        304: {"description": "Not modified (ETag matched If-None-Match)."},
        400: {"description": "Conflicting path selectors, or an id list over the cap."},
        404: {"description": "Version, or scoped domain, not found in this tenant."},
    },
)
async def get_consumption_index(
    tenant_slug: str,
    version_id: str,
    domain_id: Optional[str] = Query(None, description=_DOMAIN_DESCRIPTION),
    path_ids: Optional[List[str]] = Query(None, description=_PATH_IDS_DESCRIPTION),
    class_ids: Optional[List[str]] = Query(None, description=_CLASS_IDS_DESCRIPTION),
    if_none_match: Optional[str] = Header(None, alias="If-None-Match"),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Response:
    """Which operations consume which classes in this version, directly or through a parent.

    Every edge carries both members, how the consumption arrives (``request``, ``parameter``,
    ``response.<status>``) and — for a nested one — the chain of classes it hangs off, so the
    combined lens, the tree, the palette, the inspector and the status bar all render from one
    request. The same facts arrive twice: flat in ``edges``, the shape the canvas draws, and rolled
    up per path in ``paths``, the shape the tree nests under a path.
    """
    tenant_id = _tenant_id(auth_data)
    _assert_version_in_tenant(version_id, tenant_id)

    scope, malformed_paths = _resolve_scope(
        domain_id=domain_id, path_ids=path_ids, version_id=version_id
    )
    selected_classes, malformed_classes = _selected_ids(class_ids, parameter="class_ids")

    facts = store.load_version_facts(db, version_id=version_id, scope=scope)

    graph = index.ClassGraph(facts.classes, facts.class_properties)
    edges, depth_capped = index.build_edges(
        paths=index.resolve_paths(facts.paths),
        operations=index.resolve_operations(
            operations=facts.operations,
            request_contents=facts.request_contents,
            response_contents=facts.response_contents,
            parameters=facts.parameters,
            graph=graph,
        ),
        graph=graph,
    )

    missing_ids = _missing_path_ids(scope, facts.paths) + malformed_paths + malformed_classes
    if selected_classes or malformed_classes:
        known = {canonical_id(row["id"]) for row in facts.classes}
        missing_ids += [
            value for value in selected_classes if canonical_id(value) not in known
        ]
        edges = _filter_by_classes(edges, selected_classes)

    truncated = len(edges) > MAX_EDGES
    edges = edges[:MAX_EDGES]
    rolled = index.roll_up_paths(edges)

    body = ConsumptionIndex(
        version_id=version_id,
        scope=scope.kind,
        domain_id=scope.domain_id,
        path_ids=list(scope.path_ids),
        class_ids=list(selected_classes),
        missing_ids=missing_ids,
        edges=[_edge_payload(edge, graph) for edge in edges],
        paths=[_path_payload(entry, graph) for entry in rolled],
        link_count=len(edges),
        path_link_count=sum(len(entry["classes"]) for entry in rolled),
        depth_cap=index.MAX_NESTING_DEPTH,
        depth_capped=depth_capped,
        edge_limit=MAX_EDGES,
        truncated=truncated,
    ).model_dump(mode="json")

    etag = _etag(body)
    headers = {"ETag": etag, "Cache-Control": f"private, max-age={_MAX_AGE}"}
    if _if_none_match_hit(if_none_match, etag):
        return Response(status_code=304, headers=headers)
    return JSONResponse(content=body, headers=headers)

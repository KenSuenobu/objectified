"""Schema↔path consumption resolution — DUW-1.4 (private-suite#2571).

Which classes an operation consumes, and *how*: directly, because a request body, a response or a
parameter names the class, or **nested**, because a class the operation names refers on to it. The
combined lens draws the first as a solid amber edge and the second as a dashed rose one; the tree
prints them as a path's ``Schemas`` rows (``Customer 200``, ``Address nested``); the inspector
lists them under ``Consumes``; the status bar counts them.

This module is the resolution, with no database in it — SQL lives in
:mod:`app.consumption_index_store` and the HTTP surface in :mod:`app.consumption_index_routes`.
Splitting it out is what makes the ticket's hard part — a cycle-safe, depth-capped walk of a
reference graph — testable on fixture graphs written by hand rather than seeded into Postgres.

Five decisions are load-bearing:

**A reference is a ``$ref`` anywhere in a payload.** The catalog stores an operation's schemas in
several shapes — a ``class_id`` column, an inline schema object, a legacy ``data`` blob — and a
class's own references in as many more (``$ref``, ``items.$ref``, ``allOf``/``anyOf``/``oneOf``
arrays, and any of those nested inside another). Enumerating the shapes would mean re-deriving
:mod:`app.openapi_generator`'s emit rules in reverse and quietly missing an edge whenever they
gained a case. :func:`collect_ref_names` instead walks the JSON and collects every ``$ref`` it
finds, which is exactly the set of names the emitted document would carry.

**Nesting is resolved per class, not per operation.** Two operations that both return ``Customer``
reach the same descendants through the same edges, so :meth:`ClassGraph.descendants` walks once per
*class* and is memoized. Walking per operation would repeat the same traversal for every operation
in the catalog — the O(classes×properties) client-side derivation this ticket exists to replace,
moved to the server and multiplied by the operation count.

**The walk is breadth-first, so ``via`` is the shortest parent chain.** A class reachable by two
routes is reported once, through the shorter one; ties break on class name so the answer does not
depend on row order. Depth-first would report whichever chain the iteration happened to find first,
which would make the inspector's "nested via X" text unstable across identical catalogs.

**Cycles terminate by construction.** The BFS keeps a visited set that includes the root, so a
self-referencing class (``Node.parent → Node``) and a mutual pair (``A → B → A``) are both walked
once and never re-entered. The root is never reported as nested under itself.

**Depth is capped, and the cap is reported.** :data:`MAX_NESTING_DEPTH` bounds how far a nested
edge may sit from its direct root. A catalog deep enough to hit it gets an answer that says so
(``depth_capped``) rather than one that silently omits the far edges.
"""

from __future__ import annotations

from collections import deque
from typing import (
    Any,
    Dict,
    Iterable,
    List,
    Mapping,
    NamedTuple,
    Optional,
    Sequence,
    Set,
    Tuple,
)

__all__ = [
    "BADGE_NESTED",
    "ClassGraph",
    "ConsumptionEdge",
    "Kind",
    "MAX_NESTING_DEPTH",
    "MAX_SCAN_NODES",
    "OperationFacts",
    "PathFacts",
    "ROLE_PARAMETER",
    "ROLE_REQUEST",
    "Walk",
    "build_edges",
    "class_name_from_ref",
    "collect_ref_names",
    "direct_badge",
    "resolve_operations",
    "resolve_paths",
    "response_role",
    "roll_up_paths",
]

#: How far a nested edge may sit from the direct class that reaches it. Six hops is well past the
#: depth any hand-authored catalog nests to (``Customer → Address → ContactMethod`` is two) and far
#: enough short of a runaway that a pathological import cannot turn one operation into a walk of
#: the whole catalog. A walk that stops here reports ``depth_capped`` rather than pretending the
#: graph ended.
MAX_NESTING_DEPTH = 6

#: Most JSON nodes :func:`collect_ref_names` will visit in one payload. Inline schemas are small by
#: construction, but ``data`` is a free-form blob an importer wrote, and an unbounded recursive walk
#: over attacker-shaped JSON is a denial of service with extra steps. Reaching the budget stops the
#: scan, which can only lose edges — never invent one.
MAX_SCAN_NODES = 20_000

#: The two ways an operation can consume a class.
KIND_DIRECT = "direct"
KIND_NESTED = "nested"

#: Roles a *direct* consumption can hold. Responses carry their status code
#: (``response.200``), which the tree prints as the row's badge.
ROLE_REQUEST = "request"
ROLE_PARAMETER = "parameter"

#: What the tree prints beside a nested row, in place of a status code.
BADGE_NESTED = "nested"

#: What it prints for the two direct roles that have no status code of their own.
BADGE_REQUEST = "body"
BADGE_PARAMETER = "param"

Kind = str


def response_role(status_code: Optional[str]) -> str:
    """The role naming a response by its status code.

    Args:
        status_code: The response's status code as stored — ``200``, ``2XX``, ``default``. A
            missing code yields the bare ``response`` role rather than ``response.None``.

    Returns:
        ``response.<status>``, or ``response`` when there is no code.
    """
    code = (status_code or "").strip()
    return f"response.{code}" if code else "response"


def class_name_from_ref(ref: Any) -> Optional[str]:
    """The class name a ``$ref`` points at.

    A stored reference is a JSON pointer into the emitted document
    (``#/components/schemas/Customer``), and the catalog keys classes by name within a version, so
    the last segment is the identity. Matches the designer's ``extractClassNameFromRef`` exactly —
    the two derive the same edges and must not disagree about what a reference names.

    Args:
        ref: The reference value, which is only a reference when it is a string.

    Returns:
        The referenced name, or None when the value is not a usable reference.
    """
    if not isinstance(ref, str):
        return None
    name = ref.rsplit("/", 1)[-1].strip()
    return name or None


def collect_ref_names(payload: Any, *, budget: int = MAX_SCAN_NODES) -> List[str]:
    """Every class name referenced anywhere inside a JSON payload, in first-seen order.

    Walks the whole structure rather than the handful of positions a reference is *expected* in.
    ``{"$ref": …}``, ``{"items": {"$ref": …}}``, ``{"allOf": [{"$ref": …}]}`` and an ``anyOf``
    buried three levels inside an inline schema's property list are all the same case here, which
    is why gaining a new composition keyword upstream cannot silently lose an edge.

    Iterative rather than recursive: a deeply nested payload from an import would otherwise be a
    ``RecursionError`` — a 500 for a document Postgres accepted.

    Args:
        payload: Any JSON value. Non-containers contribute nothing.
        budget: Most nodes to visit before stopping, defaulting to :data:`MAX_SCAN_NODES`.

    Returns:
        The referenced names, deduplicated, in the order the walk first met them. Order is stable
        for a given payload, so callers that resolve these into ids get a stable result too.
    """
    names: List[str] = []
    seen: Set[str] = set()
    stack: List[Any] = [payload]
    visited = 0

    while stack and visited < budget:
        node = stack.pop()
        visited += 1
        if isinstance(node, Mapping):
            name = class_name_from_ref(node.get("$ref"))
            if name and name not in seen:
                seen.add(name)
                names.append(name)
            # Reversed so the LIFO stack yields keys in declaration order, which is what makes
            # "first-seen order" mean the document's order rather than its mirror image.
            for value in reversed(list(node.values())):
                if isinstance(value, (Mapping, list, tuple)):
                    stack.append(value)
        elif isinstance(node, (list, tuple)):
            for value in reversed(node):
                if isinstance(value, (Mapping, list, tuple)):
                    stack.append(value)

    return names


class Walk(NamedTuple):
    """The result of walking one class's references.

    Attributes:
        reached: Every class reachable from the root, mapped to the chain of classes traversed to
            get there — the root first, the discovered class's parent last. ``Address`` reached
            through ``Customer.address`` has the chain ``("Customer's id",)``; its own child has
            ``("Customer's id", "Address's id")``. The chain's length is the class's depth.
        capped: True when :data:`MAX_NESTING_DEPTH` stopped the walk with references still
            unexplored, so a caller can report an answer as bounded rather than complete.
    """

    reached: Dict[str, Tuple[str, ...]]
    capped: bool


class ClassGraph:
    """A version's classes and the references between them.

    Built once per request and shared by every operation, because the graph is a property of the
    catalog rather than of any one operation. Reference *targets* are resolved by name against this
    version's classes only: a ``$ref`` naming something the version does not define — a dangling
    reference, or a primitive from another document — resolves to nothing and produces no edge,
    which is the same thing the designer's client-side derivation does with an unknown name.
    """

    def __init__(
        self,
        classes: Sequence[Mapping[str, Any]],
        property_rows: Sequence[Mapping[str, Any]] = (),
    ) -> None:
        """Index a version's classes and build their reference adjacency.

        Args:
            classes: Rows carrying ``id``, ``name`` and the stored ``schema`` column. The schema
                contributes the class-level composition references (``allOf``/``anyOf``/``oneOf``),
                which is how a union names its members.
            property_rows: Rows carrying ``class_id`` and the property's ``data`` column — one per
                property of any class in ``classes``. Properties are where ordinary references
                live (``address: {"$ref": …}``, ``tags: {"items": {"$ref": …}}``).
        """
        self._names: Dict[str, str] = {}
        self._by_name: Dict[str, str] = {}
        refs: Dict[str, List[str]] = {}

        for row in classes:
            class_id = str(row["id"])
            name = row.get("name")
            self._names[class_id] = name
            if name is not None and name not in self._by_name:
                # First definition wins. A version is unique on (version_id, name), so a collision
                # can only mean the caller mixed two versions — in which case dropping the second
                # is safer than letting it silently redirect the first version's edges.
                self._by_name[str(name)] = class_id
            refs.setdefault(class_id, [])

        for row in classes:
            self._add_refs(refs, str(row["id"]), row.get("schema"))
        for row in property_rows:
            class_id = str(row["class_id"])
            if class_id in refs:
                self._add_refs(refs, class_id, row.get("data"))

        # Sorted by target name so a walk's tie-breaks — and therefore every ``via`` chain it
        # reports — depend on the catalog rather than on the order rows came back in.
        self._refs: Dict[str, Tuple[str, ...]] = {
            class_id: tuple(sorted(targets, key=lambda cid: (self._names.get(cid) or "", cid)))
            for class_id, targets in refs.items()
        }
        self._walks: Dict[str, Walk] = {}

    def _add_refs(self, refs: Dict[str, List[str]], class_id: str, payload: Any) -> None:
        """Record every class ``payload`` references as an edge out of ``class_id``.

        Self-references are kept out of the adjacency rather than filtered during the walk: a class
        referring to itself is a legitimate recursive schema, and it consumes nothing new.
        """
        bucket = refs.setdefault(class_id, [])
        for name in collect_ref_names(payload):
            target = self._by_name.get(name)
            if target is not None and target != class_id and target not in bucket:
                bucket.append(target)

    def __contains__(self, class_id: object) -> bool:
        """Whether a class id belongs to this version."""
        return str(class_id) in self._names

    def name_of(self, class_id: str) -> Optional[str]:
        """The name of a class in this version, or None if it holds no such class."""
        return self._names.get(str(class_id))

    def id_of(self, name: str) -> Optional[str]:
        """The id of a class by name, or None when the version defines no such class."""
        return self._by_name.get(name)

    def resolve(self, payload: Any) -> List[str]:
        """The ids of the classes a payload references, in first-seen order.

        Args:
            payload: Any JSON value — an inline schema, a legacy response blob, a parameter's data.

        Returns:
            Ids of the referenced classes this version defines. Names it does not define are
            dropped: an edge to a class that is not in the catalog has nothing to draw at either
            end.
        """
        resolved: List[str] = []
        for name in collect_ref_names(payload):
            class_id = self._by_name.get(name)
            if class_id is not None and class_id not in resolved:
                resolved.append(class_id)
        return resolved

    def references(self, class_id: str) -> Tuple[str, ...]:
        """The classes one class refers to directly, in class-name order."""
        return self._refs.get(str(class_id), ())

    def descendants(self, class_id: str) -> Walk:
        """Every class reachable from one class, with the shortest chain that reaches it.

        Breadth-first, so the first chain found for a class is a shortest one and no later route
        can improve it. The root is seeded into the visited set, which is what makes a
        self-referencing schema and a reference cycle terminate: a class already reached is never
        queued again, so each is visited exactly once however many ways lead to it.

        Memoized per class. The graph is shared by every operation in the request, and two
        operations returning the same class must not pay for the same walk twice.

        Args:
            class_id: The class to walk from — a *direct* consumption of some operation.

        Returns:
            The :class:`Walk`. An unknown class yields an empty, uncapped walk rather than an
            error: the caller is asking what a class reaches, and a class that is not here reaches
            nothing.
        """
        root = str(class_id)
        cached = self._walks.get(root)
        if cached is not None:
            return cached

        reached: Dict[str, Tuple[str, ...]] = {}
        capped = False
        if root in self._names:
            visited: Set[str] = {root}
            queue: deque = deque([(root, ())])
            while queue:
                current, chain = queue.popleft()
                next_chain = chain + (current,)
                for target in self._refs.get(current, ()):
                    if target in visited:
                        continue
                    if len(next_chain) > MAX_NESTING_DEPTH:
                        # The graph continues past the cap. Say so rather than reporting a
                        # partial answer as a complete one.
                        capped = True
                        continue
                    visited.add(target)
                    reached[target] = next_chain
                    queue.append((target, next_chain))

        walk = Walk(reached=reached, capped=capped)
        self._walks[root] = walk
        return walk


class PathFacts(NamedTuple):
    """One path, as an edge needs to name it.

    Attributes:
        id: The ``apiome.version_path`` UUID.
        pathname: The path template, e.g. ``/customers/{id}``.
        domain_id: The folder the path is filed under, or None for ``shared/``.
    """

    id: str
    pathname: str
    domain_id: Optional[str]


class OperationFacts(NamedTuple):
    """One operation, and the classes it names directly.

    Attributes:
        id: The ``apiome.path_operation`` UUID.
        path_id: The path this operation belongs to.
        method: The HTTP method, upper-case.
        operation_id: The spec's ``operationId``, or None.
        summary: The operation's summary, or None.
        deprecated: Whether the spec marks it deprecated.
        direct: Class id → the roles through which this operation names it. A class named by both
            a request body and a 200 response appears once, with two roles.
    """

    id: str
    path_id: str
    method: str
    operation_id: Optional[str]
    summary: Optional[str]
    deprecated: bool
    direct: Dict[str, Set[str]]


def resolve_paths(rows: Iterable[Mapping[str, Any]]) -> List[PathFacts]:
    """Project ``version_path`` rows onto :class:`PathFacts`.

    Args:
        rows: Rows carrying ``id``, ``pathname`` and ``domain_id``.

    Returns:
        One entry per row, ids stringified so a ``uuid`` column and a text one key the same.
    """
    return [
        PathFacts(
            id=str(row["id"]),
            pathname=row["pathname"],
            domain_id=None if row.get("domain_id") is None else str(row["domain_id"]),
        )
        for row in rows
    ]


def resolve_operations(
    *,
    operations: Iterable[Mapping[str, Any]],
    request_contents: Iterable[Mapping[str, Any]] = (),
    response_contents: Iterable[Mapping[str, Any]] = (),
    parameters: Iterable[Mapping[str, Any]] = (),
    graph: ClassGraph,
) -> List[OperationFacts]:
    """Turn the stored schema rows of each operation into the classes it names directly.

    An operation names a class three ways, and all three are read the way
    :mod:`app.paths_generator` reads them when it emits the document — so an edge exists here
    exactly when a ``$ref`` would appear there:

    * **Request body** — each content type's ``class_id``, plus any ``$ref`` inside its inline
      schema. Role ``request``.
    * **Response** — each content type's ``class_id`` or inline schema; a response that defines
      *no* content row falls back to its own ``class_id`` / ``inline_schema`` / legacy ``data``
      blob, which is the same precedence the emitter applies. Role ``response.<status>``, which is
      what the tree prints as the row's badge.
    * **Parameter** — any ``$ref`` inside the parameter's schema. Role ``parameter``.

    The content-row fallback matters: a response that has content rows but whose selected content
    type carries an inline schema must *not* pick up the response-level ``class_id``, or an
    operation would be reported as consuming a class its document never references. Precedence is
    therefore decided per response, after its rows are grouped, rather than per row with a
    ``COALESCE``.

    Args:
        operations: ``path_operation`` rows joined to their description.
        request_contents: Request-body content rows keyed by ``path_operation_id``.
        response_contents: Response rows keyed by ``path_operation_id``, one per content type.
        parameters: Parameter rows keyed by ``path_operation_id``.
        graph: The version's class graph, which resolves reference names to ids and drops names the
            version does not define.

    Returns:
        One :class:`OperationFacts` per operation row, in the order given, each carrying every
        class it names and the roles it names it through.
    """
    direct: Dict[str, Dict[str, Set[str]]] = {}

    def _record(operation_id: Any, class_ids: Iterable[str], role: str) -> None:
        """File one consumption under its operation, unioning roles for a repeated class."""
        bucket = direct.setdefault(str(operation_id), {})
        for class_id in class_ids:
            bucket.setdefault(class_id, set()).add(role)

    def _named(class_id: Any, payload: Any) -> List[str]:
        """The classes one stored schema names: an explicit column, else refs in the payload."""
        if class_id is not None and str(class_id) in graph:
            return [str(class_id)]
        return graph.resolve(payload)

    for row in request_contents:
        _record(
            row["path_operation_id"],
            _named(row.get("class_id"), row.get("inline_schema")),
            ROLE_REQUEST,
        )

    # Grouped per (operation, response) so the content rows of one response can outvote the
    # response-level columns as a set, matching the emitter.
    grouped: Dict[Tuple[str, str], List[Mapping[str, Any]]] = {}
    group_order: List[Tuple[str, str]] = []
    for row in response_contents:
        key = (str(row["path_operation_id"]), str(row.get("response_id")))
        if key not in grouped:
            grouped[key] = []
            group_order.append(key)
        grouped[key].append(row)

    for key in group_order:
        rows = grouped[key]
        operation_id, _ = key
        role = response_role(rows[0].get("status_code"))
        contents = [row for row in rows if row.get("content_id") is not None]
        if contents:
            for row in contents:
                _record(
                    operation_id,
                    _named(row.get("content_class_id"), row.get("content_inline_schema")),
                    role,
                )
            continue
        row = rows[0]
        _record(
            operation_id,
            _named(row.get("class_id"), row.get("inline_schema") or row.get("data")),
            role,
        )

    for row in parameters:
        _record(row["path_operation_id"], graph.resolve(row.get("data")), ROLE_PARAMETER)

    resolved: List[OperationFacts] = []
    for row in operations:
        operation_id = str(row["id"])
        resolved.append(
            OperationFacts(
                id=operation_id,
                path_id=str(row["version_path_id"]),
                method=str(row["operation"] or "").upper(),
                operation_id=row.get("operation_id"),
                summary=row.get("summary"),
                deprecated=bool(row.get("deprecated")),
                direct=direct.get(operation_id, {}),
            )
        )
    return resolved


class ConsumptionEdge(NamedTuple):
    """One operation consuming one class.

    Attributes:
        path_id: The path the operation belongs to.
        pathname: That path's template.
        domain_id: That path's folder, or None for ``shared/``.
        operation_uuid: The ``apiome.path_operation`` UUID.
        method: The HTTP method.
        operation_id: The spec's ``operationId``, or None.
        class_id: The consumed class.
        class_name: That class's name.
        kind: ``direct`` or ``nested``.
        roles: The roles the consumption arrives through, sorted. For a nested edge these are the
            roles of the *direct* class it hangs off, which is what lets a client filter
            "everything this response drags in" without re-walking the graph.
        via: For a nested edge, the chain of class ids from the direct root to this class's parent.
            Empty for a direct edge.
        depth: ``len(via)`` — 0 for direct, 1 for a class one hop under a directly named one.
    """

    path_id: str
    pathname: str
    domain_id: Optional[str]
    operation_uuid: str
    method: str
    operation_id: Optional[str]
    class_id: str
    class_name: Optional[str]
    kind: Kind
    roles: Tuple[str, ...]
    via: Tuple[str, ...]
    depth: int


#: Sort weight per HTTP method, so operations come back in the order the tree draws them rather
#: than alphabetically (``DELETE`` before ``GET`` reads as a bug in a path listing).
_METHOD_ORDER = {"GET": 1, "POST": 2, "PUT": 3, "PATCH": 4, "DELETE": 5}


def _method_rank(method: str) -> Tuple[int, str]:
    """Sort key placing the common verbs in spec order and the rest after them, alphabetically."""
    return (_METHOD_ORDER.get(method.upper(), 9), method.upper())


def direct_badge(roles: Iterable[str]) -> str:
    """The label the tree prints beside a *direct* schema row.

    The mockup prints ``Customer 200`` — the status code of the response that returns it. An
    operation can name one class through several roles at once, so one has to win: a response
    first (that is the badge the mockup shows), then a request body, then a parameter. Responses
    tie-break on status code so ``200`` beats ``201`` deterministically.

    Args:
        roles: The roles of one direct consumption.

    Returns:
        The status code for a response role, ``body`` for a request, ``param`` for a parameter, and
        an empty string when there are no roles at all — a row that is drawn with no badge rather
        than with a misleading one.
    """
    responses = sorted(role for role in roles if role.startswith("response"))
    if responses:
        _, _, code = responses[0].partition(".")
        return code or "response"
    if ROLE_REQUEST in set(roles):
        return BADGE_REQUEST
    if ROLE_PARAMETER in set(roles):
        return BADGE_PARAMETER
    return ""


def build_edges(
    *,
    paths: Sequence[PathFacts],
    operations: Sequence[OperationFacts],
    graph: ClassGraph,
) -> Tuple[List[ConsumptionEdge], bool]:
    """Resolve every operation's consumption into the flat edge list the clients draw.

    For each operation: the classes it names are ``direct`` edges, and everything those classes
    reach — through the memoized per-class walk — is a ``nested`` edge, unless the operation names
    it directly too. A class that is both named and reachable is one *direct* edge, not two: the
    canvas draws one line between two nodes, and the solid one is the truthful description.

    When a class is reachable from more than one of the operation's direct classes, the shorter
    chain wins, ties breaking on the root's name — so the ``via`` an inspector shows is a property
    of the catalog and not of row order.

    Args:
        paths: The paths in scope. An operation whose path is not here is skipped, which is how a
            domain- or path-scoped request narrows the answer.
        operations: The operations to resolve, each carrying its direct consumption.
        graph: The version's class graph.

    Returns:
        ``(edges, depth_capped)`` — the edges in a total order (pathname, method, then direct
        before nested, then class name), and whether any walk stopped at
        :data:`MAX_NESTING_DEPTH`.
    """
    path_by_id = {path.id: path for path in paths}
    edges: List[ConsumptionEdge] = []
    depth_capped = False

    for operation in operations:
        path = path_by_id.get(operation.path_id)
        if path is None:
            continue

        # Best nested chain per class: (depth, root name, root id, chain, roles of that root).
        nested: Dict[str, Tuple[int, str, str, Tuple[str, ...], Tuple[str, ...]]] = {}
        for root_id, roles in operation.direct.items():
            walk = graph.descendants(root_id)
            depth_capped = depth_capped or walk.capped
            root_name = graph.name_of(root_id) or ""
            root_roles = tuple(sorted(roles))
            for class_id, chain in walk.reached.items():
                if class_id in operation.direct:
                    continue
                candidate = (len(chain), root_name, root_id, chain, root_roles)
                current = nested.get(class_id)
                if current is None or candidate[:3] < current[:3]:
                    nested[class_id] = candidate

        for class_id, roles in operation.direct.items():
            edges.append(
                _edge(
                    path,
                    operation,
                    class_id=class_id,
                    class_name=graph.name_of(class_id),
                    kind=KIND_DIRECT,
                    roles=tuple(sorted(roles)),
                    via=(),
                )
            )
        for class_id, (_, _, _, chain, roles) in nested.items():
            edges.append(
                _edge(
                    path,
                    operation,
                    class_id=class_id,
                    class_name=graph.name_of(class_id),
                    kind=KIND_NESTED,
                    roles=roles,
                    via=chain,
                )
            )

    edges.sort(
        key=lambda edge: (
            edge.pathname,
            _method_rank(edge.method),
            0 if edge.kind == KIND_DIRECT else 1,
            edge.class_name or "",
            edge.class_id,
        )
    )
    return edges, depth_capped


def _edge(
    path: PathFacts,
    operation: OperationFacts,
    *,
    class_id: str,
    class_name: Optional[str],
    kind: Kind,
    roles: Tuple[str, ...],
    via: Tuple[str, ...],
) -> ConsumptionEdge:
    """Assemble one edge from a path, an operation and a resolved consumption."""
    return ConsumptionEdge(
        path_id=path.id,
        pathname=path.pathname,
        domain_id=path.domain_id,
        operation_uuid=operation.id,
        method=operation.method,
        operation_id=operation.operation_id,
        class_id=class_id,
        class_name=class_name,
        kind=kind,
        roles=roles,
        via=via,
        depth=len(via),
    )


def roll_up_paths(edges: Sequence[ConsumptionEdge]) -> List[Dict[str, Any]]:
    """Collapse per-operation edges into the per-path ``Schemas`` block the tree draws.

    The tree nests schema rows under a *path*, not under an operation: ``/customers`` shows
    ``Customer 200`` and ``Address nested`` once, however many of its operations reach them.

    Direct beats nested when a path's operations disagree, because a path that names a class
    somewhere is drawn as consuming it directly. The row's roles are then the roles of the *direct*
    edges only: a nested edge carries the roles of the parent it hangs off, and folding those in
    would badge the row with a status code belonging to a different class.

    Paths with no consumption at all are absent rather than present-and-empty: the tree draws the
    ``Schemas`` label only where there is something under it.

    Args:
        edges: The edges to roll up, already ordered by :func:`build_edges`.

    Returns:
        One entry per path, in the edges' own path order, each with its class rows ordered direct
        first then by name — the order the mockup lists them in.
    """
    order: List[str] = []
    paths: Dict[str, Dict[str, Any]] = {}

    for edge in edges:
        entry = paths.get(edge.path_id)
        if entry is None:
            order.append(edge.path_id)
            entry = paths[edge.path_id] = {
                "path_id": edge.path_id,
                "pathname": edge.pathname,
                "domain_id": edge.domain_id,
                "_classes": {},
            }
        row = entry["_classes"].get(edge.class_id)
        if row is None:
            row = entry["_classes"][edge.class_id] = {
                "class_id": edge.class_id,
                "class_name": edge.class_name,
                "has_direct": False,
                "direct_roles": set(),
                "nested_roles": set(),
                "via": [],
                "depth": 0,
            }
        if edge.kind == KIND_DIRECT:
            row["has_direct"] = True
            row["direct_roles"].update(edge.roles)
            continue
        row["nested_roles"].update(edge.roles)
        if not row["via"] or edge.depth < row["depth"]:
            row["via"] = list(edge.via)
            row["depth"] = edge.depth

    rolled: List[Dict[str, Any]] = []
    for path_id in order:
        entry = paths[path_id]
        rows = list(entry.pop("_classes").values())
        for row in rows:
            direct_roles = row.pop("direct_roles")
            nested_roles = row.pop("nested_roles")
            if row.pop("has_direct"):
                row["kind"] = KIND_DIRECT
                row["roles"] = sorted(direct_roles)
                row["via"] = []
                row["depth"] = 0
                row["badge"] = direct_badge(row["roles"])
            else:
                row["kind"] = KIND_NESTED
                row["roles"] = sorted(nested_roles)
                row["badge"] = BADGE_NESTED
        rows.sort(
            key=lambda row: (
                0 if row["kind"] == KIND_DIRECT else 1,
                row["class_name"] or "",
                row["class_id"],
            )
        )
        entry["classes"] = rows
        rolled.append(entry)
    return rolled

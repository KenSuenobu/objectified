"""Consumption resolution on fixture graphs — DUW-1.4 (private-suite#2571).

The hard part of this ticket is a graph walk, so it is tested as one: :mod:`app.consumption_index`
has no database in it and every case below is a reference graph written by hand. What the SQL
returns is pinned in ``test_consumption_index_store.py``; what a real catalog does is pinned in
``test_consumption_index_db.py``.

The claims nothing here is allowed to weaken:

* **Cycles terminate.** A self-referencing class and a mutual pair both finish, and neither reports
  a class as nested under itself.
* **``via`` is the shortest chain, deterministically.** A class reachable two ways is reported once
  through the shorter route, and ties break on the catalog rather than on row order.
* **Direct beats nested.** An operation that both names a class and reaches it through a parent
  gets one solid edge, not one of each.
* **A reference is a ``$ref`` anywhere.** ``items``, ``allOf``, ``anyOf``, ``oneOf`` and anything
  nested inside them are the same case, because the alternative is re-deriving the emitter's rules
  in reverse and losing an edge every time they gain one.
* **The depth cap is reported, not absorbed.** A graph deeper than the cap comes back flagged.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from app.consumption_index import (
    BADGE_NESTED,
    KIND_DIRECT,
    KIND_NESTED,
    MAX_NESTING_DEPTH,
    ROLE_PARAMETER,
    ROLE_REQUEST,
    ClassGraph,
    build_edges,
    class_name_from_ref,
    collect_ref_names,
    direct_badge,
    resolve_operations,
    resolve_paths,
    response_role,
    roll_up_paths,
)

CUSTOMER = "11111111-1111-1111-1111-1111111111c0"
ADDRESS = "11111111-1111-1111-1111-1111111111a0"
CONTACT = "11111111-1111-1111-1111-1111111111m0"
ORPHAN = "11111111-1111-1111-1111-1111111111f0"

PATH_LIST = "22222222-2222-2222-2222-2222222222a0"
PATH_ITEM = "22222222-2222-2222-2222-2222222222b0"

OP_LIST = "33333333-3333-3333-3333-33333333aaa0"
OP_CREATE = "33333333-3333-3333-3333-33333333bbb0"
OP_READ = "33333333-3333-3333-3333-33333333ccc0"
OP_DELETE = "33333333-3333-3333-3333-33333333ddd0"

DOMAIN = "44444444-4444-4444-4444-444444444440"


# ─── Fixture builders ────────────────────────────────────────────────────────


def ref(name: str) -> Dict[str, Any]:
    """A JSON-pointer reference to a class by name, as the catalog stores one."""
    return {"$ref": f"#/components/schemas/{name}"}


def class_row(class_id: str, name: str, schema: Any = None) -> Dict[str, Any]:
    """One ``apiome.classes`` row as the class statement returns it."""
    return {"id": class_id, "name": name, "schema": schema or {"type": "object"}}


def property_row(class_id: str, data: Any) -> Dict[str, Any]:
    """One ``apiome.class_properties`` row as the property statement returns it."""
    return {"class_id": class_id, "data": data}


def path_row(path_id: str, pathname: str, domain_id: Optional[str] = DOMAIN) -> Dict[str, Any]:
    """One ``apiome.version_path`` row."""
    return {"id": path_id, "pathname": pathname, "domain_id": domain_id}


def operation_row(
    operation_id: str,
    path_id: str,
    method: str,
    *,
    name: Optional[str] = None,
    deprecated: bool = False,
) -> Dict[str, Any]:
    """One ``apiome.path_operation`` row joined to its description."""
    return {
        "id": operation_id,
        "version_path_id": path_id,
        "operation": method,
        "operation_id": name,
        "summary": None,
        "deprecated": deprecated,
    }


def response_row(
    operation_id: str,
    status_code: str,
    *,
    response_id: Optional[str] = None,
    class_id: Optional[str] = None,
    inline_schema: Any = None,
    data: Any = None,
    content_id: Optional[str] = None,
    content_class_id: Optional[str] = None,
    content_inline_schema: Any = None,
) -> Dict[str, Any]:
    """One (response, content) row as the response statement returns it.

    ``content_id`` None is the LEFT JOIN's "this response defines no content type" row, which is
    what makes the response-level columns the fallback rather than an alternative.
    """
    return {
        "path_operation_id": operation_id,
        "response_id": response_id or f"{operation_id}:{status_code}",
        "status_code": status_code,
        "class_id": class_id,
        "inline_schema": inline_schema,
        "data": data,
        "content_id": content_id,
        "content_class_id": content_class_id,
        "content_inline_schema": content_inline_schema,
    }


def request_row(
    operation_id: str, *, class_id: Optional[str] = None, inline_schema: Any = None
) -> Dict[str, Any]:
    """One request-body content row."""
    return {
        "path_operation_id": operation_id,
        "class_id": class_id,
        "inline_schema": inline_schema,
    }


def parameter_row(operation_id: str, data: Any) -> Dict[str, Any]:
    """One parameter row."""
    return {"path_operation_id": operation_id, "data": data}


def customer_graph() -> ClassGraph:
    """The mockup's three classes: ``Customer → Address → ContactMethod``."""
    return ClassGraph(
        [
            class_row(CUSTOMER, "Customer"),
            class_row(ADDRESS, "Address"),
            class_row(CONTACT, "ContactMethod"),
        ],
        [
            property_row(CUSTOMER, ref("Address")),
            property_row(ADDRESS, {"type": "array", "items": ref("ContactMethod")}),
            property_row(CONTACT, {"type": "string"}),
        ],
    )


def edges_for(
    graph: ClassGraph,
    *,
    paths: List[Dict[str, Any]],
    operations: List[Dict[str, Any]],
    requests: List[Dict[str, Any]] = (),
    responses: List[Dict[str, Any]] = (),
    parameters: List[Dict[str, Any]] = (),
):
    """Resolve and build in one call, as the route does."""
    return build_edges(
        paths=resolve_paths(paths),
        operations=resolve_operations(
            operations=operations,
            request_contents=requests,
            response_contents=responses,
            parameters=parameters,
            graph=graph,
        ),
        graph=graph,
    )


def summarize(edges) -> List[tuple]:
    """Edges reduced to what a reader can check at a glance."""
    return [
        (edge.pathname, edge.method, edge.class_name, edge.kind, tuple(edge.roles), edge.depth)
        for edge in edges
    ]


# ─── Reference scanning ──────────────────────────────────────────────────────


class TestCollectRefNames:
    """A reference is a ``$ref`` anywhere in the payload, not in a list of expected positions."""

    @pytest.mark.parametrize(
        "payload,expected",
        [
            (ref("Customer"), ["Customer"]),
            ({"type": "array", "items": ref("Customer")}, ["Customer"]),
            ({"allOf": [ref("A"), ref("B")]}, ["A", "B"]),
            ({"anyOf": [ref("A"), {"type": "null"}]}, ["A"]),
            ({"oneOf": [ref("A"), ref("B")]}, ["A", "B"]),
            ({"items": {"oneOf": [ref("Deep")]}}, ["Deep"]),
            ({"properties": [{"data": {"items": ref("Nested")}}]}, ["Nested"]),
        ],
    )
    def test_finds_refs_wherever_they_sit(self, payload, expected):
        assert collect_ref_names(payload) == expected

    def test_ignores_non_containers_and_missing_refs(self):
        assert collect_ref_names(None) == []
        assert collect_ref_names("Customer") == []
        assert collect_ref_names({"type": "string"}) == []
        assert collect_ref_names({"$ref": 7}) == []

    def test_deduplicates_and_preserves_document_order(self):
        payload = {"allOf": [ref("B"), ref("A"), ref("B")]}
        assert collect_ref_names(payload) == ["B", "A"]

    def test_deeply_nested_payload_does_not_recurse(self):
        """An import can store arbitrarily deep JSON; a RecursionError would be a 500 for it."""
        payload: Dict[str, Any] = ref("Deep")
        for _ in range(5000):
            payload = {"items": payload}
        assert collect_ref_names(payload) == ["Deep"]

    def test_node_budget_bounds_the_scan(self):
        """The budget can only lose references, never invent one."""
        payload = {"properties": [ref(f"C{i}") for i in range(50)]}
        assert collect_ref_names(payload, budget=5) != collect_ref_names(payload)
        assert set(collect_ref_names(payload, budget=5)) <= set(collect_ref_names(payload))

    @pytest.mark.parametrize(
        "value,expected",
        [
            ("#/components/schemas/Customer", "Customer"),
            ("Customer", "Customer"),
            ("#/components/schemas/", None),
            (None, None),
            (12, None),
        ],
    )
    def test_class_name_from_ref(self, value, expected):
        assert class_name_from_ref(value) == expected


# ─── The class graph ─────────────────────────────────────────────────────────


class TestClassGraph:
    """Names resolve against this version's classes, and nothing else does."""

    def test_resolves_names_to_ids(self):
        graph = customer_graph()
        assert graph.resolve(ref("Address")) == [ADDRESS]
        assert graph.id_of("Customer") == CUSTOMER
        assert graph.name_of(CUSTOMER) == "Customer"

    def test_unknown_names_produce_no_edge(self):
        """A dangling reference has nothing to draw at the far end."""
        graph = customer_graph()
        assert graph.resolve(ref("NoSuchClass")) == []

    def test_self_reference_is_not_an_edge(self):
        graph = ClassGraph([class_row(CUSTOMER, "Customer")], [property_row(CUSTOMER, ref("Customer"))])
        assert graph.references(CUSTOMER) == ()

    def test_class_level_composition_counts_as_a_reference(self):
        """A union names its members in the schema column, not in a property row."""
        graph = ClassGraph(
            [
                class_row(CUSTOMER, "Customer", {"oneOf": [ref("Address")]}),
                class_row(ADDRESS, "Address"),
            ]
        )
        assert graph.references(CUSTOMER) == (ADDRESS,)

    def test_adjacency_is_ordered_by_target_name(self):
        """Row order must not decide which parent a nested edge is reported through."""
        graph = ClassGraph(
            [
                class_row(CUSTOMER, "Customer"),
                class_row(ADDRESS, "Address"),
                class_row(CONTACT, "ContactMethod"),
            ],
            [
                property_row(CUSTOMER, ref("ContactMethod")),
                property_row(CUSTOMER, ref("Address")),
            ],
        )
        assert graph.references(CUSTOMER) == (ADDRESS, CONTACT)

    def test_membership_and_lookup_of_unknown_ids(self):
        graph = customer_graph()
        assert CUSTOMER in graph
        assert ORPHAN not in graph
        assert graph.name_of(ORPHAN) is None
        assert graph.references(ORPHAN) == ()


class TestDescendants:
    """The walk is breadth-first, memoized, cycle-safe and depth-capped."""

    def test_reports_the_shortest_chain(self):
        walk = customer_graph().descendants(CUSTOMER)
        assert walk.reached == {ADDRESS: (CUSTOMER,), CONTACT: (CUSTOMER, ADDRESS)}
        assert walk.capped is False

    def test_a_shorter_route_wins_over_a_longer_one(self):
        graph = ClassGraph(
            [
                class_row(CUSTOMER, "Customer"),
                class_row(ADDRESS, "Address"),
                class_row(CONTACT, "ContactMethod"),
            ],
            [
                property_row(CUSTOMER, {"allOf": [ref("Address"), ref("ContactMethod")]}),
                property_row(ADDRESS, ref("ContactMethod")),
            ],
        )
        assert graph.descendants(CUSTOMER).reached[CONTACT] == (CUSTOMER,)

    def test_self_reference_terminates_and_is_not_nested_under_itself(self):
        graph = ClassGraph([class_row(CUSTOMER, "Customer")], [property_row(CUSTOMER, ref("Customer"))])
        assert graph.descendants(CUSTOMER).reached == {}

    def test_mutual_cycle_terminates(self):
        graph = ClassGraph(
            [class_row(CUSTOMER, "Customer"), class_row(ADDRESS, "Address")],
            [property_row(CUSTOMER, ref("Address")), property_row(ADDRESS, ref("Customer"))],
        )
        assert graph.descendants(CUSTOMER).reached == {ADDRESS: (CUSTOMER,)}
        assert graph.descendants(ADDRESS).reached == {CUSTOMER: (ADDRESS,)}

    def test_three_class_cycle_terminates(self):
        graph = ClassGraph(
            [
                class_row(CUSTOMER, "Customer"),
                class_row(ADDRESS, "Address"),
                class_row(CONTACT, "ContactMethod"),
            ],
            [
                property_row(CUSTOMER, ref("Address")),
                property_row(ADDRESS, ref("ContactMethod")),
                property_row(CONTACT, ref("Customer")),
            ],
        )
        walk = graph.descendants(CUSTOMER)
        assert set(walk.reached) == {ADDRESS, CONTACT}
        assert walk.capped is False

    def test_depth_cap_bounds_the_walk_and_says_so(self):
        depth = MAX_NESTING_DEPTH + 3
        classes = [class_row(f"c{i}", f"C{i}") for i in range(depth)]
        properties = [property_row(f"c{i}", ref(f"C{i + 1}")) for i in range(depth - 1)]
        walk = ClassGraph(classes, properties).descendants("c0")

        assert walk.capped is True
        assert len(walk.reached) == MAX_NESTING_DEPTH
        assert max(len(chain) for chain in walk.reached.values()) == MAX_NESTING_DEPTH

    def test_a_graph_that_ends_exactly_at_the_cap_is_not_flagged(self):
        depth = MAX_NESTING_DEPTH + 1
        classes = [class_row(f"c{i}", f"C{i}") for i in range(depth)]
        properties = [property_row(f"c{i}", ref(f"C{i + 1}")) for i in range(depth - 1)]
        walk = ClassGraph(classes, properties).descendants("c0")

        assert walk.capped is False
        assert len(walk.reached) == MAX_NESTING_DEPTH

    def test_walks_are_memoized_per_class(self):
        graph = customer_graph()
        assert graph.descendants(CUSTOMER) is graph.descendants(CUSTOMER)

    def test_unknown_class_reaches_nothing(self):
        assert customer_graph().descendants(ORPHAN) == ({}, False)


# ─── Direct consumption ──────────────────────────────────────────────────────


class TestResolveOperations:
    """The three ways an operation names a class, read the way the emitter reads them."""

    def test_request_body_class_and_role(self):
        graph = customer_graph()
        resolved = resolve_operations(
            operations=[operation_row(OP_CREATE, PATH_LIST, "POST")],
            request_contents=[request_row(OP_CREATE, class_id=CUSTOMER)],
            graph=graph,
        )
        assert resolved[0].direct == {CUSTOMER: {ROLE_REQUEST}}

    def test_response_role_carries_the_status_code(self):
        graph = customer_graph()
        resolved = resolve_operations(
            operations=[operation_row(OP_LIST, PATH_LIST, "GET")],
            response_contents=[
                response_row(OP_LIST, "200", content_id="ct", content_class_id=CUSTOMER)
            ],
            graph=graph,
        )
        assert resolved[0].direct == {CUSTOMER: {"response.200"}}

    def test_parameter_refs_are_consumption(self):
        graph = customer_graph()
        resolved = resolve_operations(
            operations=[operation_row(OP_READ, PATH_ITEM, "GET")],
            parameters=[parameter_row(OP_READ, {"schema": ref("Address")})],
            graph=graph,
        )
        assert resolved[0].direct == {ADDRESS: {ROLE_PARAMETER}}

    def test_one_class_named_twice_keeps_both_roles(self):
        graph = customer_graph()
        resolved = resolve_operations(
            operations=[operation_row(OP_CREATE, PATH_LIST, "POST")],
            request_contents=[request_row(OP_CREATE, class_id=CUSTOMER)],
            response_contents=[
                response_row(OP_CREATE, "201", content_id="ct", content_class_id=CUSTOMER)
            ],
            graph=graph,
        )
        assert resolved[0].direct == {CUSTOMER: {ROLE_REQUEST, "response.201"}}

    def test_content_rows_outvote_the_response_level_class(self):
        """A response with an inline content type must not pick up its own fallback column.

        Resolving row-by-row with a COALESCE would report the operation as consuming ``Customer``
        when the emitted document references nothing at all.
        """
        graph = customer_graph()
        resolved = resolve_operations(
            operations=[operation_row(OP_LIST, PATH_LIST, "GET")],
            response_contents=[
                response_row(
                    OP_LIST,
                    "200",
                    class_id=CUSTOMER,
                    content_id="ct",
                    content_inline_schema={"type": "string"},
                )
            ],
            graph=graph,
        )
        assert resolved[0].direct == {}

    def test_response_level_class_is_the_fallback_when_there_is_no_content_row(self):
        graph = customer_graph()
        resolved = resolve_operations(
            operations=[operation_row(OP_LIST, PATH_LIST, "GET")],
            response_contents=[response_row(OP_LIST, "200", class_id=CUSTOMER)],
            graph=graph,
        )
        assert resolved[0].direct == {CUSTOMER: {"response.200"}}

    def test_inline_schema_refs_are_followed(self):
        graph = customer_graph()
        resolved = resolve_operations(
            operations=[operation_row(OP_LIST, PATH_LIST, "GET")],
            response_contents=[
                response_row(
                    OP_LIST,
                    "200",
                    content_id="ct",
                    content_inline_schema={"type": "array", "items": ref("Customer")},
                )
            ],
            graph=graph,
        )
        assert resolved[0].direct == {CUSTOMER: {"response.200"}}

    def test_legacy_data_blob_is_the_last_fallback(self):
        graph = customer_graph()
        resolved = resolve_operations(
            operations=[operation_row(OP_LIST, PATH_LIST, "GET")],
            response_contents=[
                response_row(OP_LIST, "200", data={"schema": ref("Customer")})
            ],
            graph=graph,
        )
        assert resolved[0].direct == {CUSTOMER: {"response.200"}}

    def test_a_class_id_from_another_version_is_ignored(self):
        """The column is trusted only when this version actually holds the class."""
        graph = customer_graph()
        resolved = resolve_operations(
            operations=[operation_row(OP_LIST, PATH_LIST, "GET")],
            response_contents=[response_row(OP_LIST, "200", class_id=ORPHAN)],
            graph=graph,
        )
        assert resolved[0].direct == {}

    def test_operations_with_no_schemas_resolve_to_nothing(self):
        graph = customer_graph()
        resolved = resolve_operations(
            operations=[operation_row(OP_DELETE, PATH_ITEM, "delete")], graph=graph
        )
        assert resolved[0].direct == {}
        assert resolved[0].method == "DELETE"

    @pytest.mark.parametrize(
        "status,expected",
        [("200", "response.200"), ("2XX", "response.2XX"), ("", "response"), (None, "response")],
    )
    def test_response_role_formatting(self, status, expected):
        assert response_role(status) == expected


# ─── Edges ───────────────────────────────────────────────────────────────────


class TestBuildEdges:
    """Direct beats nested, nesting hangs off the right parent, order is total."""

    def test_direct_and_nested_edges_for_one_operation(self):
        graph = customer_graph()
        edges, capped = edges_for(
            graph,
            paths=[path_row(PATH_LIST, "/customers")],
            operations=[operation_row(OP_LIST, PATH_LIST, "GET")],
            responses=[response_row(OP_LIST, "200", content_id="ct", content_class_id=CUSTOMER)],
        )
        assert capped is False
        assert summarize(edges) == [
            ("/customers", "GET", "Customer", KIND_DIRECT, ("response.200",), 0),
            ("/customers", "GET", "Address", KIND_NESTED, ("response.200",), 1),
            ("/customers", "GET", "ContactMethod", KIND_NESTED, ("response.200",), 2),
        ]

    def test_nested_edge_names_its_parent_chain(self):
        graph = customer_graph()
        edges, _ = edges_for(
            graph,
            paths=[path_row(PATH_LIST, "/customers")],
            operations=[operation_row(OP_LIST, PATH_LIST, "GET")],
            responses=[response_row(OP_LIST, "200", content_id="ct", content_class_id=CUSTOMER)],
        )
        by_class = {edge.class_name: edge for edge in edges}
        assert by_class["Address"].via == (CUSTOMER,)
        assert by_class["ContactMethod"].via == (CUSTOMER, ADDRESS)

    def test_a_directly_named_class_is_never_also_nested(self):
        """One line between two nodes, and the solid one is the truthful description."""
        graph = customer_graph()
        edges, _ = edges_for(
            graph,
            paths=[path_row(PATH_LIST, "/customers")],
            operations=[operation_row(OP_LIST, PATH_LIST, "GET")],
            responses=[
                response_row(OP_LIST, "200", content_id="c1", content_class_id=CUSTOMER),
                response_row(OP_LIST, "201", content_id="c2", content_class_id=ADDRESS),
            ],
        )
        address = [edge for edge in edges if edge.class_name == "Address"]
        assert [edge.kind for edge in address] == [KIND_DIRECT]
        assert address[0].roles == ("response.201",)

    def test_nested_roles_come_from_the_root_that_reaches_it(self):
        graph = customer_graph()
        edges, _ = edges_for(
            graph,
            paths=[path_row(PATH_LIST, "/customers")],
            operations=[operation_row(OP_CREATE, PATH_LIST, "POST")],
            requests=[request_row(OP_CREATE, class_id=CUSTOMER)],
            responses=[
                response_row(OP_CREATE, "201", content_id="ct", content_class_id=CUSTOMER)
            ],
        )
        nested = {edge.class_name: edge.roles for edge in edges if edge.kind == KIND_NESTED}
        assert nested == {
            "Address": (ROLE_REQUEST, "response.201"),
            "ContactMethod": (ROLE_REQUEST, "response.201"),
        }

    def test_operations_on_paths_outside_the_scope_are_dropped(self):
        graph = customer_graph()
        edges, _ = edges_for(
            graph,
            paths=[path_row(PATH_LIST, "/customers")],
            operations=[
                operation_row(OP_LIST, PATH_LIST, "GET"),
                operation_row(OP_READ, PATH_ITEM, "GET"),
            ],
            responses=[
                response_row(OP_LIST, "200", content_id="c1", content_class_id=CUSTOMER),
                response_row(OP_READ, "200", content_id="c2", content_class_id=CUSTOMER),
            ],
        )
        assert {edge.pathname for edge in edges} == {"/customers"}

    def test_edges_are_totally_ordered(self):
        graph = customer_graph()
        edges, _ = edges_for(
            graph,
            paths=[path_row(PATH_ITEM, "/customers/{id}"), path_row(PATH_LIST, "/customers")],
            operations=[
                operation_row(OP_DELETE, PATH_ITEM, "DELETE"),
                operation_row(OP_READ, PATH_ITEM, "GET"),
                operation_row(OP_LIST, PATH_LIST, "GET"),
            ],
            responses=[
                response_row(OP_DELETE, "409", content_id="c1", content_class_id=CONTACT),
                response_row(OP_READ, "200", content_id="c2", content_class_id=ADDRESS),
                response_row(OP_LIST, "200", content_id="c3", content_class_id=ADDRESS),
            ],
        )
        assert [(edge.pathname, edge.method, edge.class_name) for edge in edges] == [
            ("/customers", "GET", "Address"),
            ("/customers", "GET", "ContactMethod"),
            ("/customers/{id}", "GET", "Address"),
            ("/customers/{id}", "GET", "ContactMethod"),
            ("/customers/{id}", "DELETE", "ContactMethod"),
        ]

    def test_depth_cap_is_reported_through_the_edges(self):
        depth = MAX_NESTING_DEPTH + 3
        classes = [class_row(f"c{i}", f"C{i}") for i in range(depth)]
        properties = [property_row(f"c{i}", ref(f"C{i + 1}")) for i in range(depth - 1)]
        graph = ClassGraph(classes, properties)

        edges, capped = edges_for(
            graph,
            paths=[path_row(PATH_LIST, "/deep")],
            operations=[operation_row(OP_LIST, PATH_LIST, "GET")],
            responses=[response_row(OP_LIST, "200", class_id="c0")],
        )
        assert capped is True
        assert len(edges) == MAX_NESTING_DEPTH + 1

    def test_a_cycle_reachable_from_an_operation_terminates(self):
        graph = ClassGraph(
            [class_row(CUSTOMER, "Customer"), class_row(ADDRESS, "Address")],
            [property_row(CUSTOMER, ref("Address")), property_row(ADDRESS, ref("Customer"))],
        )
        edges, capped = edges_for(
            graph,
            paths=[path_row(PATH_LIST, "/customers")],
            operations=[operation_row(OP_LIST, PATH_LIST, "GET")],
            responses=[response_row(OP_LIST, "200", class_id=CUSTOMER)],
        )
        assert capped is False
        assert summarize(edges) == [
            ("/customers", "GET", "Customer", KIND_DIRECT, ("response.200",), 0),
            ("/customers", "GET", "Address", KIND_NESTED, ("response.200",), 1),
        ]


# ─── Badges and the per-path roll-up ─────────────────────────────────────────


class TestDirectBadge:
    """What the tree prints beside a direct row when an operation names a class several ways."""

    @pytest.mark.parametrize(
        "roles,expected",
        [
            (["response.200"], "200"),
            (["response.201", "response.200"], "200"),
            ([ROLE_REQUEST, "response.200"], "200"),
            ([ROLE_REQUEST], "body"),
            ([ROLE_PARAMETER], "param"),
            ([ROLE_REQUEST, ROLE_PARAMETER], "body"),
            (["response"], "response"),
            ([], ""),
        ],
    )
    def test_badge_precedence(self, roles, expected):
        assert direct_badge(roles) == expected


class TestRollUpPaths:
    """The tree nests schema rows under a path, not under an operation."""

    def test_operations_of_one_path_collapse_into_one_block(self):
        graph = customer_graph()
        edges, _ = edges_for(
            graph,
            paths=[path_row(PATH_LIST, "/customers")],
            operations=[
                operation_row(OP_LIST, PATH_LIST, "GET"),
                operation_row(OP_CREATE, PATH_LIST, "POST"),
            ],
            requests=[request_row(OP_CREATE, class_id=CUSTOMER)],
            responses=[response_row(OP_LIST, "200", content_id="ct", content_class_id=CUSTOMER)],
        )
        rolled = roll_up_paths(edges)

        assert len(rolled) == 1
        assert [(row["class_name"], row["kind"], row["badge"]) for row in rolled[0]["classes"]] == [
            ("Customer", KIND_DIRECT, "200"),
            ("Address", KIND_NESTED, BADGE_NESTED),
            ("ContactMethod", KIND_NESTED, BADGE_NESTED),
        ]
        assert rolled[0]["classes"][0]["roles"] == [ROLE_REQUEST, "response.200"]

    def test_direct_wins_when_a_paths_operations_disagree(self):
        graph = customer_graph()
        edges, _ = edges_for(
            graph,
            paths=[path_row(PATH_LIST, "/customers")],
            operations=[
                operation_row(OP_LIST, PATH_LIST, "GET"),
                operation_row(OP_CREATE, PATH_LIST, "POST"),
            ],
            responses=[
                response_row(OP_LIST, "200", content_id="c1", content_class_id=CUSTOMER),
                response_row(OP_CREATE, "201", content_id="c2", content_class_id=ADDRESS),
            ],
        )
        address = [row for row in roll_up_paths(edges)[0]["classes"] if row["class_name"] == "Address"]
        assert address[0]["kind"] == KIND_DIRECT
        assert address[0]["via"] == []
        assert address[0]["badge"] == "201"

    def test_paths_that_consume_nothing_are_absent(self):
        graph = customer_graph()
        edges, _ = edges_for(
            graph,
            paths=[path_row(PATH_LIST, "/customers"), path_row(PATH_ITEM, "/health")],
            operations=[
                operation_row(OP_LIST, PATH_LIST, "GET"),
                operation_row(OP_READ, PATH_ITEM, "GET"),
            ],
            responses=[response_row(OP_LIST, "200", class_id=CUSTOMER)],
        )
        assert [entry["pathname"] for entry in roll_up_paths(edges)] == ["/customers"]

    def test_shortest_via_survives_the_roll_up(self):
        graph = ClassGraph(
            [
                class_row(CUSTOMER, "Customer"),
                class_row(ADDRESS, "Address"),
                class_row(CONTACT, "ContactMethod"),
            ],
            [
                property_row(CUSTOMER, ref("Address")),
                property_row(ADDRESS, ref("ContactMethod")),
            ],
        )
        edges, _ = edges_for(
            graph,
            paths=[path_row(PATH_LIST, "/customers")],
            operations=[
                operation_row(OP_LIST, PATH_LIST, "GET"),
                operation_row(OP_CREATE, PATH_LIST, "POST"),
            ],
            responses=[
                response_row(OP_LIST, "200", class_id=CUSTOMER),
                response_row(OP_CREATE, "201", class_id=ADDRESS),
            ],
        )
        contact = [
            row for row in roll_up_paths(edges)[0]["classes"] if row["class_name"] == "ContactMethod"
        ][0]
        assert contact["via"] == [ADDRESS]
        assert contact["depth"] == 1


# ─── The acceptance scenario ─────────────────────────────────────────────────


class TestMockupScenario:
    """The ticket's first acceptance criterion: Customer/Address/ContactMethod × 4 operations.

    The catalog is the one the mockup describes — ``Customer`` carrying an ``Address``, ``Address``
    carrying ``ContactMethod`` ("Cascades to Address, ContactMethod", workspace.html line 480) —
    consumed by two paths of two operations each.

    Two of the mockup's own numbers come out of it exactly: the inspector's ``Consumes`` reading of
    ``/customers/{id}`` (``Customer`` direct, ``Address`` nested, ``ContactMethod`` nested — the
    amber icon on the first and grey on the other two, lines 194–214) and the status bar's
    ``6 schema↔path links`` (line 1040), which is the count of distinct path↔class pairs across the
    two paths.

    One does not: the mockup's ``/customers`` block lists two schema rows where the index finds
    three, because ``ContactMethod`` hangs off ``Customer`` there too. That is the mockup
    abbreviating a static drawing — no class graph can have ``ContactMethod`` under
    ``/customers/{id}`` but not under ``/customers`` while both return ``Customer``. The reading
    that reproduces that block instead — ``ContactMethod`` named directly by ``DELETE``'s 409 —
    contradicts both of the numbers above, so this is the fixture that matches the most of the
    mockup rather than the one that matches one line of it.
    """

    @pytest.fixture
    def scenario(self):
        graph = customer_graph()
        return edges_for(
            graph,
            paths=[
                path_row(PATH_LIST, "/customers"),
                path_row(PATH_ITEM, "/customers/{id}"),
            ],
            operations=[
                operation_row(OP_LIST, PATH_LIST, "GET", name="customers.list"),
                operation_row(OP_CREATE, PATH_LIST, "POST", name="customers.create"),
                operation_row(OP_READ, PATH_ITEM, "GET", name="customers.read"),
                operation_row(OP_DELETE, PATH_ITEM, "DELETE", name="customers.delete"),
            ],
            requests=[request_row(OP_CREATE, class_id=CUSTOMER)],
            responses=[
                response_row(OP_LIST, "200", content_id="r1", content_class_id=CUSTOMER),
                response_row(OP_CREATE, "201", content_id="r2", content_class_id=CUSTOMER),
                response_row(OP_READ, "200", content_id="r3", content_class_id=CUSTOMER),
                response_row(OP_DELETE, "204"),
                response_row(OP_DELETE, "404"),
                response_row(OP_DELETE, "409", content_id="r4", content_class_id=CUSTOMER),
            ],
        )[0]

    def test_edge_set(self, scenario):
        assert summarize(scenario) == [
            ("/customers", "GET", "Customer", KIND_DIRECT, ("response.200",), 0),
            ("/customers", "GET", "Address", KIND_NESTED, ("response.200",), 1),
            ("/customers", "GET", "ContactMethod", KIND_NESTED, ("response.200",), 2),
            ("/customers", "POST", "Customer", KIND_DIRECT, (ROLE_REQUEST, "response.201"), 0),
            ("/customers", "POST", "Address", KIND_NESTED, (ROLE_REQUEST, "response.201"), 1),
            ("/customers", "POST", "ContactMethod", KIND_NESTED, (ROLE_REQUEST, "response.201"), 2),
            ("/customers/{id}", "GET", "Customer", KIND_DIRECT, ("response.200",), 0),
            ("/customers/{id}", "GET", "Address", KIND_NESTED, ("response.200",), 1),
            ("/customers/{id}", "GET", "ContactMethod", KIND_NESTED, ("response.200",), 2),
            ("/customers/{id}", "DELETE", "Customer", KIND_DIRECT, ("response.409",), 0),
            ("/customers/{id}", "DELETE", "Address", KIND_NESTED, ("response.409",), 1),
            ("/customers/{id}", "DELETE", "ContactMethod", KIND_NESTED, ("response.409",), 2),
        ]

    def test_customer_is_direct_in_all_four_operations(self, scenario):
        """The legend's solid amber edges."""
        direct = [edge for edge in scenario if edge.kind == KIND_DIRECT]
        assert {edge.class_name for edge in direct} == {"Customer"}
        assert len({edge.operation_uuid for edge in direct}) == 4

    def test_nested_edges_name_the_parent_they_hang_off(self, scenario):
        """The legend's dashed rose edges: 'nested via parent class'."""
        nested = {
            (edge.class_name, edge.via) for edge in scenario if edge.kind == KIND_NESTED
        }
        assert nested == {("Address", (CUSTOMER,)), ("ContactMethod", (CUSTOMER, ADDRESS))}

    def test_tree_block_for_the_detail_path(self, scenario):
        """workspace.html lines 194–214: Customer, Address, ContactMethod under /customers/{id}."""
        block = [entry for entry in roll_up_paths(scenario) if entry["pathname"] == "/customers/{id}"][0]
        assert [(row["class_name"], row["kind"], row["badge"]) for row in block["classes"]] == [
            ("Customer", KIND_DIRECT, "200"),
            ("Address", KIND_NESTED, BADGE_NESTED),
            ("ContactMethod", KIND_NESTED, BADGE_NESTED),
        ]

    def test_tree_block_for_the_collection_path_badges_the_status_code(self, scenario):
        """workspace.html lines 182–193: ``Customer 200`` above ``Address nested``."""
        block = [entry for entry in roll_up_paths(scenario) if entry["pathname"] == "/customers"][0]
        rows = {row["class_name"]: row for row in block["classes"]}
        assert rows["Customer"]["badge"] == "200"
        assert rows["Address"]["badge"] == BADGE_NESTED
        assert rows["Address"]["via"] == [CUSTOMER]

    def test_status_bar_link_count(self, scenario):
        """workspace.html line 1040: ``6 schema↔path links`` — distinct path↔class pairs."""
        rolled = roll_up_paths(scenario)
        assert sum(len(entry["classes"]) for entry in rolled) == 6

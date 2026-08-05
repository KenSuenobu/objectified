"""Consumption index REST surface — DUW-1.4 (private-suite#2571).

Route-level tests over :mod:`app.consumption_index_routes`, following the
``test_workspace_summary_routes.py`` precedent: a module-level ``TestClient``, auth through the
dependency override, and the database and the store's loader patched where used. The resolution
itself is left real — the graph walk is the rule under test, and mocking it into agreeing with the
route would prove nothing.

:class:`TestAcceptance` walks the ticket's acceptance criteria a route can answer; the one that
needs a catalog (statement count and latency on the 218-path catalog) lives in
``test_consumption_index_db.py``.

The claims nothing below is allowed to weaken:

* **`?class_ids=X` answers "every path that consumes X"** — including the paths that reach it
  through a parent, which is most of them and the reason the filter is applied after the walk.
* **The scope narrows paths, never the graph.** A domain-scoped answer still names classes outside
  the domain, because that is what "nested via parent" means.
* **A repeat read is a 304**, and the tag changes when the index does — including when only the
  scope changed.
* **Tenancy is resolved before anything is read.** Another tenant's version is a 404 and no
  statement runs.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.consumption_index import MAX_NESTING_DEPTH
from app.consumption_index_routes import MAX_EDGES
from app.consumption_index_store import VersionFacts
from app.main import app
from app.scoped_catalog_store import MAX_SELECTED_IDS

client = TestClient(app)

TENANT = "11111111-1111-1111-1111-111111111111"
VERSION = "22222222-2222-2222-2222-222222222222"
DOMAIN = "33333333-3333-3333-3333-33333333aaaa"
OTHER_DOMAIN = "33333333-3333-3333-3333-33333333bbbb"

CUSTOMER = "44444444-4444-4444-4444-4444444444c0"
ADDRESS = "44444444-4444-4444-4444-4444444444a0"
UNKNOWN_CLASS = "44444444-4444-4444-4444-4444444444ff"

PATH_LIST = "55555555-5555-5555-5555-5555555555a0"
PATH_ITEM = "55555555-5555-5555-5555-5555555555b0"
UNKNOWN_PATH = "55555555-5555-5555-5555-5555555555ff"

OP_LIST = "66666666-6666-6666-6666-66666666aaaa"
OP_READ = "66666666-6666-6666-6666-66666666bbbb"

URL = f"/v1/workspace/acme/version/{VERSION}/consumption"

_MOCK_JWT: Dict[str, Any] = {
    "auth_method": "jwt",
    "user_id": "77777777-7777-7777-7777-777777777777",
    "tenant_id": TENANT,
}


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def ref(name: str) -> Dict[str, Any]:
    """A JSON-pointer reference to a class by name."""
    return {"$ref": f"#/components/schemas/{name}"}


def facts(
    *,
    paths: Optional[List[Dict[str, Any]]] = None,
    operations: Optional[List[Dict[str, Any]]] = None,
    responses: Optional[List[Dict[str, Any]]] = None,
) -> VersionFacts:
    """The mockup's two classes and two paths, unless a case overrides part of it.

    ``Customer`` carries an ``Address``, so every operation returning ``Customer`` also consumes
    ``Address`` nested — which is what makes the class filter and the scope tests meaningful.
    """
    return VersionFacts(
        classes=[
            {"id": CUSTOMER, "name": "Customer", "schema": {"type": "object"}},
            {"id": ADDRESS, "name": "Address", "schema": {"type": "object"}},
        ],
        class_properties=[{"class_id": CUSTOMER, "data": ref("Address")}],
        paths=paths
        if paths is not None
        else [
            {"id": PATH_LIST, "pathname": "/customers", "domain_id": DOMAIN},
            {"id": PATH_ITEM, "pathname": "/customers/{id}", "domain_id": None},
        ],
        operations=operations
        if operations is not None
        else [
            {
                "id": OP_LIST,
                "version_path_id": PATH_LIST,
                "operation": "GET",
                "operation_id": "customers.list",
                "summary": "List customers",
                "deprecated": False,
            },
            {
                "id": OP_READ,
                "version_path_id": PATH_ITEM,
                "operation": "GET",
                "operation_id": "customers.read",
                "summary": None,
                "deprecated": False,
            },
        ],
        request_contents=[],
        response_contents=responses
        if responses is not None
        else [
            {
                "path_operation_id": OP_LIST,
                "response_id": "r1",
                "status_code": "200",
                "class_id": None,
                "inline_schema": None,
                "data": None,
                "content_id": "c1",
                "content_class_id": CUSTOMER,
                "content_inline_schema": None,
            },
            {
                "path_operation_id": OP_READ,
                "response_id": "r2",
                "status_code": "200",
                "class_id": None,
                "inline_schema": None,
                "data": None,
                "content_id": "c2",
                "content_class_id": CUSTOMER,
                "content_inline_schema": None,
            },
        ],
        parameters=[],
    )


def get(url: str = URL, *, loaded: Optional[VersionFacts] = None, **kwargs):
    """Call the endpoint with the version and any named domain resolvable, the loader scripted."""
    with patch("app.consumption_index_routes.db") as mock_db, patch(
        "app.consumption_index_routes.domains_store.get_domain",
        return_value={"id": DOMAIN, "version_id": VERSION},
    ), patch(
        "app.consumption_index_routes.store.load_version_facts",
        return_value=loaded if loaded is not None else facts(),
    ) as loader:
        mock_db.get_version_by_id.return_value = {"id": VERSION, "version_id": "2.1"}
        response = client.get(url, **kwargs)
    response.loader = loader  # type: ignore[attr-defined]
    return response


def names(body: Dict[str, Any]) -> List[tuple]:
    """Edges reduced to what a reader can check at a glance."""
    return [(e["pathname"], e["method"], e["class_name"], e["kind"]) for e in body["edges"]]


# ─── The unscoped read ───────────────────────────────────────────────────────


class TestWholeVersion:
    """The default scope, which the status bar's version-wide link count needs."""

    def test_returns_every_edge_with_both_members_named(self):
        body = get().json()
        assert body["scope"] == "version"
        assert names(body) == [
            ("/customers", "GET", "Customer", "direct"),
            ("/customers", "GET", "Address", "nested"),
            ("/customers/{id}", "GET", "Customer", "direct"),
            ("/customers/{id}", "GET", "Address", "nested"),
        ]

    def test_nested_edges_name_the_parent_they_hang_off(self):
        body = get().json()
        nested = [edge for edge in body["edges"] if edge["kind"] == "nested"][0]
        assert nested["via"] == [{"class_id": CUSTOMER, "class_name": "Customer"}]
        assert nested["depth"] == 1
        assert nested["roles"] == ["response.200"]

    def test_edges_carry_the_operation_the_inspector_names(self):
        edge = get().json()["edges"][0]
        assert edge["operation_uuid"] == OP_LIST
        assert edge["operation_id"] == "customers.list"
        assert edge["method"] == "GET"
        assert edge["domain_id"] == DOMAIN

    def test_rolls_up_per_path_for_the_tree(self):
        body = get().json()
        assert [(p["pathname"], [c["class_name"] for c in p["classes"]]) for p in body["paths"]] == [
            ("/customers", ["Customer", "Address"]),
            ("/customers/{id}", ["Customer", "Address"]),
        ]
        badges = [c["badge"] for c in body["paths"][0]["classes"]]
        assert badges == ["200", "nested"]

    def test_reports_both_link_counts(self):
        body = get().json()
        assert body["link_count"] == 4
        assert body["path_link_count"] == 4

    def test_reports_its_own_bounds(self):
        body = get().json()
        assert body["depth_cap"] == MAX_NESTING_DEPTH
        assert body["depth_capped"] is False
        assert body["edge_limit"] == MAX_EDGES
        assert body["truncated"] is False

    def test_a_version_with_nothing_in_it_is_an_empty_index_not_an_error(self):
        empty = VersionFacts([], [], [], [], [], [], [])
        body = get(loaded=empty).json()
        assert body["edges"] == []
        assert body["paths"] == []
        assert body["link_count"] == 0


# ─── Scoping ─────────────────────────────────────────────────────────────────


class TestPathScope:
    """``domain_id`` and ``path_ids`` narrow the path side, and are mutually exclusive."""

    def test_domain_scope_is_passed_to_the_store(self):
        response = get(f"{URL}?domain_id={DOMAIN}")
        scope = response.loader.call_args.kwargs["scope"]
        assert (scope.kind, scope.domain_id) == ("domain", DOMAIN)
        assert response.json()["domain_id"] == DOMAIN

    def test_shared_is_the_absence_of_a_folder_not_the_absence_of_a_scope(self):
        response = get(f"{URL}?domain_id=shared")
        scope = response.loader.call_args.kwargs["scope"]
        assert (scope.kind, scope.domain_id) == ("domain", None)
        body = response.json()
        assert body["scope"] == "domain"
        assert body["domain_id"] is None

    def test_path_ids_accept_both_spellings(self):
        response = get(f"{URL}?path_ids={PATH_LIST},{PATH_ITEM}")
        assert response.loader.call_args.kwargs["scope"].path_ids == (PATH_LIST, PATH_ITEM)

        response = get(f"{URL}?path_ids={PATH_LIST}&path_ids={PATH_ITEM}")
        assert response.loader.call_args.kwargs["scope"].path_ids == (PATH_LIST, PATH_ITEM)

    def test_both_path_selectors_at_once_is_a_400(self):
        response = get(f"{URL}?domain_id={DOMAIN}&path_ids={PATH_LIST}")
        assert response.status_code == 400
        assert "not both" in response.json()["detail"]

    def test_an_id_list_over_the_cap_is_refused_not_truncated(self):
        ids = ",".join(f"{i:032x}" for i in range(MAX_SELECTED_IDS + 1))
        response = get(f"{URL}?path_ids={ids}")
        assert response.status_code == 400
        assert str(MAX_SELECTED_IDS) in response.json()["detail"]

    def test_a_blank_domain_reads_as_no_selector_not_as_shared(self):
        response = get(f"{URL}?domain_id=%20")
        assert response.json()["scope"] == "version"

    def test_unresolved_path_ids_are_reported(self):
        response = get(f"{URL}?path_ids={PATH_LIST},{UNKNOWN_PATH}", loaded=facts(
            paths=[{"id": PATH_LIST, "pathname": "/customers", "domain_id": DOMAIN}],
            operations=[
                {
                    "id": OP_LIST,
                    "version_path_id": PATH_LIST,
                    "operation": "GET",
                    "operation_id": "customers.list",
                    "summary": None,
                    "deprecated": False,
                }
            ],
        ))
        assert response.json()["missing_ids"] == [UNKNOWN_PATH]

    def test_a_malformed_path_id_is_missing_rather_than_a_500(self):
        """Sending it to Postgres would raise at the ``::uuid`` cast."""
        response = get(f"{URL}?path_ids=not-a-uuid")
        assert response.status_code == 200
        assert "not-a-uuid" in response.json()["missing_ids"]
        assert response.loader.call_args.kwargs["scope"].path_ids == ()

    def test_an_unknown_domain_is_a_404(self):
        with patch("app.consumption_index_routes.db") as mock_db, patch(
            "app.consumption_index_routes.domains_store.get_domain", return_value=None
        ), patch("app.consumption_index_routes.store.load_version_facts") as loader:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            response = client.get(f"{URL}?domain_id={OTHER_DOMAIN}")
        assert response.status_code == 404
        loader.assert_not_called()

    def test_a_domain_from_another_version_is_a_404(self):
        with patch("app.consumption_index_routes.db") as mock_db, patch(
            "app.consumption_index_routes.domains_store.get_domain",
            return_value={"id": DOMAIN, "version_id": "another-version"},
        ), patch("app.consumption_index_routes.store.load_version_facts") as loader:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            response = client.get(f"{URL}?domain_id={DOMAIN}")
        assert response.status_code == 404
        loader.assert_not_called()


class TestClassFilter:
    """The palette's action: every path that consumes X, however it reaches it."""

    def test_filters_edges_to_the_named_classes(self):
        body = get(f"{URL}?class_ids={CUSTOMER}").json()
        assert {edge["class_name"] for edge in body["edges"]} == {"Customer"}
        assert body["class_ids"] == [CUSTOMER]

    def test_finds_the_paths_that_consume_a_class_through_a_parent(self):
        """Filtering the graph first would lose exactly these, which are most of them."""
        body = get(f"{URL}?class_ids={ADDRESS}").json()
        assert {edge["pathname"] for edge in body["edges"]} == {"/customers", "/customers/{id}"}
        assert {edge["kind"] for edge in body["edges"]} == {"nested"}

    def test_composes_with_a_path_scope(self):
        body = get(f"{URL}?domain_id={DOMAIN}&class_ids={ADDRESS}").json()
        assert body["scope"] == "domain"
        assert body["class_ids"] == [ADDRESS]

    def test_a_class_this_version_does_not_hold_is_reported_missing(self):
        body = get(f"{URL}?class_ids={UNKNOWN_CLASS}").json()
        assert body["missing_ids"] == [UNKNOWN_CLASS]
        assert body["edges"] == []

    def test_matching_tolerates_a_spelling_postgres_accepts_but_never_prints(self):
        body = get(f"{URL}?class_ids={CUSTOMER.upper()}").json()
        assert body["missing_ids"] == []
        assert {edge["class_name"] for edge in body["edges"]} == {"Customer"}

    def test_an_id_list_over_the_cap_is_refused(self):
        ids = ",".join(f"{i:032x}" for i in range(MAX_SELECTED_IDS + 1))
        response = get(f"{URL}?class_ids={ids}")
        assert response.status_code == 400
        assert "class_ids" in response.json()["detail"]


# ─── Caching ─────────────────────────────────────────────────────────────────


class TestCaching:
    """Content-addressed, so the tag keys on the version's content and on the scope."""

    def test_a_read_carries_a_strong_etag_and_a_cache_policy(self):
        response = get()
        assert response.headers["ETag"].startswith('"')
        assert "W/" not in response.headers["ETag"]
        assert "private" in response.headers["Cache-Control"]

    def test_the_same_index_yields_the_same_tag(self):
        assert get().headers["ETag"] == get().headers["ETag"]

    def test_a_repeat_read_is_a_304_with_no_body(self):
        etag = get().headers["ETag"]
        response = get(headers={"If-None-Match": etag})
        assert response.status_code == 304
        assert response.content == b""
        assert response.headers["ETag"] == etag

    @pytest.mark.parametrize("header", ["*", 'W/{etag}', '"other", {etag}'])
    def test_conditional_variants_are_honoured(self, header):
        etag = get().headers["ETag"]
        response = get(headers={"If-None-Match": header.format(etag=etag)})
        assert response.status_code == 304

    def test_a_stale_tag_gets_the_body(self):
        response = get(headers={"If-None-Match": '"0000000000000000"'})
        assert response.status_code == 200

    def test_changing_the_version_content_changes_the_tag(self):
        before = get().headers["ETag"]
        changed = facts(responses=[])
        assert get(loaded=changed).headers["ETag"] != before

    def test_changing_the_scope_changes_the_tag(self):
        """A stored version-content hash would hand one scope's body to another scope's client."""
        assert get().headers["ETag"] != get(f"{URL}?class_ids={ADDRESS}").headers["ETag"]


# ─── Tenancy ─────────────────────────────────────────────────────────────────


class TestTenancy:
    """Resolved through the version, before anything is read."""

    def test_another_tenants_version_is_a_404_and_reads_nothing(self):
        with patch("app.consumption_index_routes.db") as mock_db, patch(
            "app.consumption_index_routes.store.load_version_facts"
        ) as loader:
            mock_db.get_version_by_id.return_value = None
            response = client.get(URL)
        assert response.status_code == 404
        loader.assert_not_called()

    def test_the_version_is_resolved_inside_the_callers_tenant(self):
        with patch("app.consumption_index_routes.db") as mock_db, patch(
            "app.consumption_index_routes.store.load_version_facts", return_value=facts()
        ):
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            client.get(URL)
        mock_db.get_version_by_id.assert_called_once_with(VERSION, TENANT)

    def test_a_token_with_no_tenant_is_a_500_not_an_unscoped_read(self):
        app.dependency_overrides[validate_authentication] = lambda: {"auth_method": "jwt"}
        try:
            with patch("app.consumption_index_routes.store.load_version_facts") as loader:
                response = client.get(URL)
        finally:
            app.dependency_overrides[validate_authentication] = lambda: _MOCK_JWT
        assert response.status_code == 500
        loader.assert_not_called()


# ─── Acceptance ──────────────────────────────────────────────────────────────


class TestAcceptance:
    """The ticket's acceptance criteria a route can answer."""

    def test_class_ids_answers_every_path_that_consumes_x(self):
        """Criterion 2, the palette's 'Find every path that consumes X' action."""
        body = get(f"{URL}?class_ids={ADDRESS}").json()
        assert sorted({edge["pathname"] for edge in body["edges"]}) == [
            "/customers",
            "/customers/{id}",
        ]

    def test_a_self_referencing_schema_terminates(self):
        """Criterion 3: cycle-safe. A 200 here is the whole assertion — a walk that did not
        terminate would never produce one."""
        recursive = facts()._replace(
            class_properties=[
                {"class_id": CUSTOMER, "data": ref("Address")},
                {"class_id": ADDRESS, "data": ref("Customer")},
            ]
        )
        body = get(loaded=recursive).json()
        assert body["link_count"] == 4
        assert {edge["kind"] for edge in body["edges"]} == {"direct", "nested"}

    def test_the_depth_cap_is_documented_in_the_response(self):
        """Criterion 3: the cap is a documented number, not an implementation detail."""
        assert get().json()["depth_cap"] == MAX_NESTING_DEPTH

    def test_the_second_read_is_a_304_until_the_content_changes(self):
        """Criterion 4."""
        first = get()
        assert get(headers={"If-None-Match": first.headers["ETag"]}).status_code == 304

        changed = get(loaded=facts(responses=[]))
        assert changed.headers["ETag"] != first.headers["ETag"]
        assert (
            get(loaded=facts(responses=[]), headers={"If-None-Match": first.headers["ETag"]}).status_code
            == 200
        )

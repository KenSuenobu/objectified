"""The primitives list endpoint's two shapes — DWX-3.1 (private-suite#2683).

Route-level tests over ``GET /v1/primitives/{tenant_slug}`` in :mod:`app.primitives_routes`,
following the ``test_workspace_property_routes.py`` precedent: a module-level ``TestClient``, auth
supplied through the dependency override, and the database and the store's search patched where
they are used. The store's constants and pure helpers are left real — the caps, the scope
vocabulary and the cursor codec are the rules under test, and mocking them into always agreeing
would prove nothing.

The claims nothing below is allowed to weaken:

* **The classic shape is untouched.** A caller that asks no bounded question still gets the JSON
  array it has always got, from the same ``get_primitives_for_tenant`` read. The classic property
  dialogs are the reason this ticket does not simply replace the endpoint.
* **Any bounded parameter switches the shape.** ``q``, ``scope``, ``namespace``, ``limit`` and
  ``cursor`` each do it on their own, so a picker cannot accidentally ask an unbounded question.
* **A bad parameter is a 400, never a wrong answer.** An unknown scope and a forged cursor both
  refuse; silently ignoring either turns a bounded read into an unbounded one, or a paging client
  into an infinite loop.
* **The tenant comes from the token.** The ``{tenant_slug}`` in the path is decorative; a slug
  naming another tenant cannot widen what comes back.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.primitives_search_store import DEFAULT_LIMIT, MAX_LIMIT, SCOPES, encode_cursor

client = TestClient(app)

TENANT = "11111111-1111-1111-1111-111111111111"
OTHER_TENANT = "22222222-2222-2222-2222-222222222222"

URL = "/v1/primitives/acme"

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


def primitive(
    name: str,
    *,
    scope: str = "core",
    namespace: Optional[str] = "std/v0/types",
    primitive_id: str = "00000000-0000-4000-8000-000000000001",
) -> Dict[str, Any]:
    """One row as the store projects it, ready for the route's response model."""
    return {
        "id": primitive_id,
        "tenant_id": TENANT,
        "name": name,
        "description": None,
        "category": "string",
        "schema": {"type": "string"},
        "tags": [],
        "created_by": None,
        "is_system": scope in ("standard", "core"),
        "is_public": False,
        "usage_count": 0,
        "source": "imported" if scope == "custom" else "human",
        "schema_id": None,
        "draft": "2020-12",
        "namespace": namespace,
        "base_uri": None,
        "refs": [],
        "created_at": None,
        "updated_at": None,
        "scope": scope,
    }


def page(
    items: Optional[List[Dict[str, Any]]] = None,
    *,
    counts: Optional[Dict[str, int]] = None,
    total: int = 0,
    limit: int = DEFAULT_LIMIT,
    next_cursor: Optional[str] = None,
    truncated: bool = False,
) -> Dict[str, Any]:
    """One answer as the store returns it."""
    return {
        "items": items or [],
        "counts": counts or {scope: 0 for scope in SCOPES},
        "total": total,
        "limit": limit,
        "next_cursor": next_cursor,
        "truncated": truncated,
    }


class TestClassicShape:
    """A caller that asks no bounded question is unaffected by this ticket."""

    def test_no_parameters_returns_the_array(self) -> None:
        with patch("app.primitives_routes.db.get_primitives_for_tenant", return_value=[]) as read:
            response = client.get(URL)
        assert response.status_code == 200
        assert response.json() == []
        read.assert_called_once_with(TENANT, None)

    def test_category_alone_stays_unbounded(self) -> None:
        """`category` predates the ticket; switching its shape would break the classic dialogs."""
        with patch("app.primitives_routes.db.get_primitives_for_tenant", return_value=[]) as read:
            response = client.get(URL, params={"category": "string"})
        assert isinstance(response.json(), list)
        read.assert_called_once_with(TENANT, "string")

    def test_the_classic_read_is_not_used_for_a_bounded_question(self) -> None:
        with patch("app.primitives_routes.db.get_primitives_for_tenant") as classic, patch(
            "app.primitives_routes.search_store.search_primitives", return_value=page()
        ):
            client.get(URL, params={"limit": 5})
        classic.assert_not_called()


class TestShapeSwitch:
    """Which parameters make the endpoint answer with a page."""

    @pytest.mark.parametrize(
        "params",
        [
            {"q": "dat"},
            {"scope": "core"},
            {"namespace": "std/v0/types"},
            {"limit": 5},
            {"cursor": encode_cursor(0, "std/v0/types/date", TENANT)},
        ],
        ids=["q", "scope", "namespace", "limit", "cursor"],
    )
    def test_each_bounded_parameter_switches_the_shape(self, params: Dict[str, Any]) -> None:
        with patch("app.primitives_routes.search_store.search_primitives", return_value=page()):
            response = client.get(URL, params=params)
        assert response.status_code == 200
        body = response.json()
        assert isinstance(body, dict) and "items" in body and "counts" in body

    def test_an_empty_query_still_counts_as_a_bounded_question(self) -> None:
        """`?q=` is a picker that has been opened but not typed into — still a bounded read."""
        with patch(
            "app.primitives_routes.search_store.search_primitives", return_value=page()
        ) as search:
            response = client.get(URL, params={"q": ""})
        assert isinstance(response.json(), dict)
        assert search.call_args.kwargs["query"] == ""


class TestBoundedAnswer:
    """What a page carries."""

    def test_the_page_carries_rows_counts_and_the_applied_filters(self) -> None:
        answer = page(
            [primitive("date")],
            counts={"standard": 12, "core": 40, "tenant": 3, "custom": 7},
            total=40,
            limit=25,
            next_cursor="abc",
            truncated=True,
        )
        with patch("app.primitives_routes.search_store.search_primitives", return_value=answer):
            response = client.get(URL, params={"q": " dat ", "scope": "core", "limit": 25})

        body = response.json()
        assert [item["name"] for item in body["items"]] == ["date"]
        assert body["counts"] == {"standard": 12, "core": 40, "tenant": 3, "custom": 7}
        assert body["total"] == 40
        assert body["limit"] == 25
        assert body["query"] == "dat"
        assert body["scope"] == "core"
        assert body["next_cursor"] == "abc"
        assert body["truncated"] is True

    def test_every_row_carries_its_tab(self) -> None:
        answer = page([primitive("Sku", scope="custom", namespace="tenant/acme/imported")])
        with patch("app.primitives_routes.search_store.search_primitives", return_value=answer):
            body = client.get(URL, params={"limit": 5}).json()
        assert body["items"][0]["scope"] == "custom"

    def test_no_response_exceeds_the_limit(self) -> None:
        """The endpoint's one hard promise, asserted end to end against a store that respects it."""
        with patch(
            "app.primitives_routes.search_store.search_primitives",
            side_effect=lambda db, **kw: page(
                [
                    primitive(f"t{i}", primitive_id=f"00000000-0000-4000-8000-{i:012d}")
                    for i in range(kw["limit"])
                ],
                total=5_000,
                limit=kw["limit"],
                truncated=True,
            ),
        ):
            for requested in (1, 25, MAX_LIMIT, 5_000):
                body = client.get(URL, params={"limit": requested}).json()
                assert len(body["items"]) <= MAX_LIMIT
                assert len(body["items"]) == body["limit"] <= min(requested, MAX_LIMIT)

    def test_an_over_large_limit_is_clamped_not_refused(self) -> None:
        with patch(
            "app.primitives_routes.search_store.search_primitives", return_value=page()
        ) as search:
            response = client.get(URL, params={"limit": 5_000})
        assert response.status_code == 200
        assert search.call_args.kwargs["limit"] == MAX_LIMIT

    def test_the_namespace_filter_is_normalized_before_it_is_used(self) -> None:
        with patch(
            "app.primitives_routes.search_store.search_primitives", return_value=page()
        ) as search:
            client.get(URL, params={"namespace": " std/v0/types// "})
        assert search.call_args.kwargs["namespace"] == "std/v0/types"

    def test_the_category_filter_still_applies_to_a_bounded_read(self) -> None:
        with patch(
            "app.primitives_routes.search_store.search_primitives", return_value=page()
        ) as search:
            body = client.get(URL, params={"q": "dat", "category": "string"}).json()
        assert search.call_args.kwargs["category"] == "string"
        assert body["category"] == "string"

    def test_badges_only(self) -> None:
        """`limit=0` is how the picker sizes its four tabs without listing any of them."""
        answer = page(counts={"standard": 12, "core": 40, "tenant": 3, "custom": 7}, limit=0,
                      total=62, truncated=True)
        with patch("app.primitives_routes.search_store.search_primitives", return_value=answer):
            body = client.get(URL, params={"limit": 0}).json()
        assert body["items"] == []
        assert sum(body["counts"].values()) == 62


class TestRefusals:
    """A bad parameter is refused, never quietly reinterpreted."""

    def test_an_unknown_scope_is_a_400(self) -> None:
        with patch("app.primitives_routes.search_store.search_primitives") as search:
            response = client.get(URL, params={"scope": "standrad"})
        assert response.status_code == 400
        assert "standrad" in response.json()["detail"]
        search.assert_not_called()

    def test_a_forged_cursor_is_a_400(self) -> None:
        with patch("app.primitives_routes.search_store.search_primitives") as search:
            response = client.get(URL, params={"cursor": "not-a-real-cursor!!"})
        assert response.status_code == 400
        search.assert_not_called()

    def test_a_negative_limit_is_a_422(self) -> None:
        """Caught by the FastAPI `ge=0` bound before any of this module's code runs."""
        response = client.get(URL, params={"limit": -1})
        assert response.status_code == 422

    @pytest.mark.parametrize("scope", SCOPES)
    def test_every_documented_scope_is_accepted(self, scope: str) -> None:
        with patch(
            "app.primitives_routes.search_store.search_primitives", return_value=page()
        ) as search:
            response = client.get(URL, params={"scope": scope})
        assert response.status_code == 200
        assert search.call_args.kwargs["scope"] == scope


class TestTenancy:
    """The token is the tenant; the path segment is decorative."""

    def test_the_search_is_scoped_by_the_tokens_tenant(self) -> None:
        with patch(
            "app.primitives_routes.search_store.search_primitives", return_value=page()
        ) as search:
            client.get(URL, params={"q": "dat"})
        assert search.call_args.kwargs["tenant_id"] == TENANT

    def test_a_foreign_slug_in_the_path_does_not_widen_the_read(self) -> None:
        with patch(
            "app.primitives_routes.search_store.search_primitives", return_value=page()
        ) as search:
            client.get("/v1/primitives/globex", params={"q": "dat"})
        assert search.call_args.kwargs["tenant_id"] == TENANT
        assert OTHER_TENANT not in str(search.call_args)

"""Property-name search REST surface — DUW-5.3 (private-suite#2590).

Route-level tests over :mod:`app.workspace_property_routes`, following the
``test_workspace_summary_routes.py`` precedent: a module-level ``TestClient``, auth supplied
through the dependency override, and the database and the store's search patched where used. The
store's constants and pure helpers are left real — the caps and the query floor are the rules under
test, and mocking them into always agreeing would prove nothing.

:class:`TestAcceptance` walks the ticket's acceptance criteria that a route can answer; the one
that needs a catalog (counts match SQL truth) lives in ``test_workspace_property_db.py``.

The claims nothing below is allowed to weaken:

* **The band renders from one response.** The name, the usage count, the owning classes and their
  folders all arrive together, so ⏎ opens the top owner and the secondary action lists the rest
  without a second request.
* **Tenancy is resolved before anything is read.** Another tenant's version is a 404 and no
  statement runs.
* **The response says what it actually did** — the limits applied, how many names matched, and
  whether it capped.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.workspace_property_store import (
    DEFAULT_OWNER_LIMIT,
    DEFAULT_PROPERTY_LIMIT,
    MAX_OWNER_LIMIT,
    MAX_PROPERTY_LIMIT,
)

client = TestClient(app)

TENANT = "11111111-1111-1111-1111-111111111111"
VERSION = "22222222-2222-2222-2222-222222222222"
CUSTOMERS = "33333333-3333-3333-3333-33333333aaaa"
BILLING = "33333333-3333-3333-3333-33333333bbbb"
INVOICE = "44444444-4444-4444-4444-44444444aaaa"
CUSTOMER = "44444444-4444-4444-4444-44444444bbbb"

URL = f"/v1/workspace/acme/version/{VERSION}/properties"

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


def owner(
    class_id: str,
    class_name: str,
    *,
    domain_id: Optional[str] = CUSTOMERS,
    kind: str = "object",
) -> Dict[str, Any]:
    """One owning class as the store returns it."""
    return {
        "class_id": class_id,
        "class_name": class_name,
        "domain_id": domain_id,
        "kind": kind,
    }


def hit(
    name: str,
    class_count: int,
    *,
    owners: Optional[List[Dict[str, Any]]] = None,
    owners_truncated: bool = False,
) -> Dict[str, Any]:
    """One property hit as the store returns it."""
    return {
        "name": name,
        "class_count": class_count,
        "owners": owners or [],
        "owners_truncated": owners_truncated,
    }


#: The mockup's own band (workspace.html lines 601–607): `customer_id · used by 14 classes`, with
#: the two classes a reader would open it from.
MOCKUP_BAND = {
    "properties": [
        hit(
            "customer_id",
            14,
            owners=[
                owner(CUSTOMER, "Customer"),
                owner(INVOICE, "Invoice", domain_id=BILLING),
            ],
            owners_truncated=True,
        )
    ],
    "total": 1,
    "limit": DEFAULT_PROPERTY_LIMIT,
    "owner_limit": DEFAULT_OWNER_LIMIT,
    "truncated": False,
}


def get(
    url: str = f"{URL}?q=customer",
    *,
    result: Optional[Dict[str, Any]] = None,
    version: Optional[Dict[str, Any]] = None,
):
    """Call the endpoint with the database and the store's search patched.

    Args:
        url: The request URL.
        result: What the store should return, or None for the mockup band.
        version: The version row the tenancy gate resolves, or None for a live one.

    Returns:
        ``(response, search_mock)`` so a test can assert on what reached the store.
    """
    with patch("app.workspace_property_routes.db") as mock_db, patch(
        "app.workspace_property_routes.store.search_version_properties"
    ) as search:
        mock_db.get_version_by_id.return_value = (
            {"id": VERSION, "version_id": "2.1"} if version is None else version
        )
        search.return_value = MOCKUP_BAND if result is None else result
        return client.get(url), search


class TestAcceptance:
    """The band renders from one response, and its counts are the catalog's."""

    def test_reproduces_the_mockups_row(self):
        response, _ = get()
        body = response.json()

        assert response.status_code == 200
        assert body["properties"][0]["name"] == "customer_id"
        assert body["properties"][0]["class_count"] == 14

    def test_carries_everything_an_activation_needs_without_a_second_request(self):
        # ⏎ opens the top owning class, and the secondary action lists the rest in place: both need
        # the class's id, its name and the folder it lives in.
        response, _ = get()
        owners = response.json()["properties"][0]["owners"]

        assert [o["class_name"] for o in owners] == ["Customer", "Invoice"]
        assert owners[0]["class_id"] == CUSTOMER
        assert owners[1]["domain_id"] == BILLING
        assert {o["kind"] for o in owners} == {"object"}

    def test_says_when_a_property_has_more_owners_than_it_named(self):
        response, _ = get()

        assert response.json()["properties"][0]["owners_truncated"] is True

    def test_answers_a_query_nothing_matches_with_an_empty_band(self):
        # The palette hides the section on this, which is the acceptance criterion; the route's
        # part of it is answering 200 with no hits rather than 404.
        response, _ = get(
            result={
                "properties": [],
                "total": 0,
                "limit": DEFAULT_PROPERTY_LIMIT,
                "owner_limit": DEFAULT_OWNER_LIMIT,
                "truncated": False,
            }
        )

        assert response.status_code == 200
        assert response.json()["properties"] == []
        assert response.json()["total"] == 0


class TestQuery:
    """What the caller asked, as it reaches the store."""

    def test_normalizes_the_query_and_echoes_what_it_searched_for(self):
        response, search = get(f"{URL}?q=%20customer_id%20")

        assert search.call_args.kwargs["query"] == "customer_id"
        assert response.json()["query"] == "customer_id"

    def test_treats_a_missing_query_as_an_empty_one_rather_than_an_error(self):
        response, search = get(URL)

        assert response.status_code == 200
        assert search.call_args.kwargs["query"] == ""

    def test_passes_the_version_through_and_never_the_tenant_slug(self):
        _, search = get()

        assert search.call_args.kwargs["version_id"] == VERSION


class TestLimits:
    """The response reports the limits it applied, not the ones it was asked for."""

    def test_defaults_both_limits(self):
        response, search = get()

        assert search.call_args.kwargs["limit"] == DEFAULT_PROPERTY_LIMIT
        assert search.call_args.kwargs["owner_limit"] == DEFAULT_OWNER_LIMIT
        assert response.json()["limit"] == DEFAULT_PROPERTY_LIMIT
        assert response.json()["owner_limit"] == DEFAULT_OWNER_LIMIT

    def test_clamps_an_over_large_request_rather_than_refusing_it(self):
        _, search = get(f"{URL}?q=customer&limit=9999&owner_limit=9999")

        assert search.call_args.kwargs["limit"] == MAX_PROPERTY_LIMIT
        assert search.call_args.kwargs["owner_limit"] == MAX_OWNER_LIMIT

    def test_honours_a_counts_only_request(self):
        _, search = get(f"{URL}?q=customer&owner_limit=0")

        assert search.call_args.kwargs["owner_limit"] == 0

    def test_refuses_a_negative_limit_at_the_edge(self):
        response, _ = get(f"{URL}?q=customer&limit=-1")

        assert response.status_code == 422

    def test_reports_a_capped_answer_and_the_size_of_the_whole_match_set(self):
        response, _ = get(
            result={
                "properties": [hit("customer_id", 14)],
                "total": 9,
                "limit": 1,
                "owner_limit": DEFAULT_OWNER_LIMIT,
                "truncated": True,
            }
        )
        body = response.json()

        assert (body["total"], body["truncated"], body["limit"]) == (9, True, 1)


class TestTenancy:
    """The version is resolved inside the caller's tenant before anything is read."""

    def test_a_version_outside_the_tenant_is_not_searched(self):
        response, search = get(version={})

        assert response.status_code == 404
        search.assert_not_called()

    def test_a_token_without_a_tenant_is_a_500_rather_than_a_wide_open_read(self):
        app.dependency_overrides[validate_authentication] = lambda: {"auth_method": "jwt"}
        try:
            response, search = get()
        finally:
            app.dependency_overrides[validate_authentication] = lambda: _MOCK_JWT

        assert response.status_code == 500
        search.assert_not_called()

    def test_requires_authentication(self):
        app.dependency_overrides.pop(validate_authentication, None)
        response = client.get(f"{URL}?q=customer")

        assert response.status_code in (401, 403)

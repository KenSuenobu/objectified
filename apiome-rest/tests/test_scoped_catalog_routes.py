"""Selection-scoped catalog REST surface — DUW-1.2 (private-suite#2569).

Route-level tests over :mod:`app.scoped_catalog_routes`, following the ``test_domains_routes.py``
precedent: a module-level ``TestClient``, auth supplied through the dependency override, and the
database and the store's *loaders* patched where used. The store's constants and pure helpers are
deliberately left real — the cap and what counts as an id are the rules under test, and mocking
them into always agreeing would prove nothing.

:class:`TestAcceptance` walks the ticket's acceptance criteria directly.

The claims nothing below is allowed to weaken:

* **This endpoint cannot return a whole version.** Omitting both selectors is an error, not a
  default. That is the entire point of the ticket.
* **The cap is real in both modes** — clamped for a domain listing, which has a cursor to continue
  with; refused for an id list, which does not.
* **Tenancy is resolved before anything is read.** Another tenant's version is a 404 and no query
  runs.
* **A selection that has gone stale says so**, rather than coming back quietly short.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.export_projection import decode_page_cursor, encode_page_cursor
from app.main import app
from app.scoped_catalog_store import (
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    MAX_SELECTED_IDS,
    ScopedPage,
)

client = TestClient(app)

TENANT = "11111111-1111-1111-1111-111111111111"
VERSION = "22222222-2222-2222-2222-222222222222"
OTHER_VERSION = "22222222-2222-2222-2222-2222222222ff"
DOMAIN = "33333333-3333-3333-3333-333333333333"
CLASS_A = "44444444-4444-4444-4444-44444444aaaa"
CLASS_B = "44444444-4444-4444-4444-44444444bbbb"
CLASS_C = "44444444-4444-4444-4444-44444444cccc"
PATH_A = "55555555-5555-5555-5555-55555555aaaa"
PATH_B = "55555555-5555-5555-5555-55555555bbbb"

CLASSES_URL = f"/v1/workspace/acme/version/{VERSION}/classes"
PATHS_URL = f"/v1/workspace/acme/version/{VERSION}/paths"

_MOCK_JWT: Dict[str, Any] = {
    "auth_method": "jwt",
    "user_id": "66666666-6666-6666-6666-666666666666",
    "tenant_id": TENANT,
}


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def page(
    items: Optional[List[Dict[str, Any]]] = None,
    *,
    total: Optional[int] = None,
    missing_ids: Optional[List[str]] = None,
    next_offset: Optional[int] = None,
) -> ScopedPage:
    """A store page, defaulting `total` to the page's own length."""
    rows = items if items is not None else []
    return ScopedPage(
        items=rows,
        total=len(rows) if total is None else total,
        missing_ids=missing_ids or [],
        next_offset=next_offset,
    )


def class_item(class_id: str, name: str) -> Dict[str, Any]:
    return {
        "id": class_id,
        "version_id": VERSION,
        "domain_id": DOMAIN,
        "name": name,
        "properties": [{"id": "p1", "class_id": class_id, "name": "id"}],
        "tags": [],
    }


def path_item(path_id: str, pathname: str) -> Dict[str, Any]:
    return {
        "id": path_id,
        "version_id": VERSION,
        "domain_id": DOMAIN,
        "pathname": pathname,
        "operations": [{"id": "o1", "operation": "GET", "operation_id": "listCustomers"}],
    }


class TestSelectionIsMandatory:
    """The endpoint that exists so a whole version is never fetched cannot be asked for one."""

    def test_no_selector_is_a_400_naming_both_options(self):
        with patch("app.scoped_catalog_routes.db") as mock_db:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            response = client.get(CLASSES_URL)

        assert response.status_code == 400
        detail = response.json()["detail"]
        assert "class_ids" in detail and "domain_id" in detail

    def test_an_empty_domain_value_is_no_selector_not_an_empty_folder(self):
        with patch("app.scoped_catalog_routes.db") as mock_db:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            response = client.get(CLASSES_URL, params={"domain_id": "  "})

        assert response.status_code == 400

    def test_both_selectors_is_a_400_rather_than_a_guess(self):
        with patch("app.scoped_catalog_routes.db") as mock_db:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            response = client.get(
                CLASSES_URL, params={"class_ids": CLASS_A, "domain_id": DOMAIN}
            )

        assert response.status_code == 400
        assert "not both" in response.json()["detail"]

    def test_the_paths_endpoint_names_its_own_parameter_and_its_own_fallback(self):
        # Pointing a paths caller at the classes endpoint would be a wrong answer to "then how do
        # I get everything?".
        with patch("app.scoped_catalog_routes.db") as mock_db:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            response = client.get(PATHS_URL)

        assert response.status_code == 400
        detail = response.json()["detail"]
        assert "path_ids" in detail
        assert "/v1/paths/" in detail
        assert "/v1/classes/" not in detail

    def test_the_classes_endpoint_points_at_the_legacy_full_version_read(self):
        with patch("app.scoped_catalog_routes.db") as mock_db:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            response = client.get(CLASSES_URL)

        assert "with-properties-tags" in response.json()["detail"]


class TestIdSelection:
    def test_three_ids_return_three_classes(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page(
                [
                    class_item(CLASS_A, "Address"),
                    class_item(CLASS_B, "Customer"),
                    class_item(CLASS_C, "Order"),
                ]
            )
            response = client.get(
                CLASSES_URL, params={"class_ids": [CLASS_A, CLASS_B, CLASS_C]}
            )

        assert response.status_code == 200
        body = response.json()
        assert len(body["items"]) == 3
        assert body["total"] == 3
        assert body["scope"] == "ids"
        assert body["next_cursor"] is None
        assert body["missing_ids"] == []
        # Properties and tags travel with the class, so hydrating a selection is one request.
        assert body["items"][0]["properties"][0]["name"] == "id"

    def test_a_comma_separated_list_is_the_same_request(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page([class_item(CLASS_A, "Address")])
            client.get(CLASSES_URL, params={"class_ids": f"{CLASS_A},{CLASS_B}"})

        assert load.call_args.kwargs["class_ids"] == [CLASS_A, CLASS_B]

    def test_the_id_cap_is_refused_not_truncated(self):
        # There is no cursor for an arbitrary id set, so answering a different question than the
        # one asked would be undetectable to the caller.
        ids = [f"00000000-0000-4000-8000-{index:012d}" for index in range(MAX_SELECTED_IDS + 1)]
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            response = client.get(CLASSES_URL, params={"class_ids": ids})

        assert response.status_code == 400
        assert str(MAX_SELECTED_IDS) in response.json()["detail"]
        load.assert_not_called()

    def test_a_selection_exactly_at_the_cap_is_served(self):
        ids = [f"00000000-0000-4000-8000-{index:012d}" for index in range(MAX_SELECTED_IDS)]
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page([])
            response = client.get(CLASSES_URL, params={"class_ids": ids})

        assert response.status_code == 200

    def test_duplicates_do_not_consume_the_cap_twice(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page([class_item(CLASS_A, "Address")])
            client.get(CLASSES_URL, params={"class_ids": [CLASS_A] * 5})

        assert load.call_args.kwargs["class_ids"] == [CLASS_A]

    def test_the_response_states_the_bound_it_was_served_under(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page([class_item(CLASS_A, "Address")])
            body = client.get(CLASSES_URL, params={"class_ids": CLASS_A}).json()

        assert body["limit"] == MAX_SELECTED_IDS

    def test_a_stale_selection_is_reported_rather_than_silently_short(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page([class_item(CLASS_A, "Address")], missing_ids=[CLASS_B])
            body = client.get(CLASSES_URL, params={"class_ids": [CLASS_A, CLASS_B]}).json()

        assert body["total"] == 1
        assert body["missing_ids"] == [CLASS_B]

    def test_a_selection_of_only_malformed_ids_is_still_a_selection(self):
        # Not "no selector": the caller did name items, they are simply not ids. Falling through to
        # the mandatory-selection error would be a misleading message.
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page([], missing_ids=["nope"])
            response = client.get(CLASSES_URL, params={"class_ids": "nope"})

        assert response.status_code == 200
        assert response.json()["missing_ids"] == ["nope"]
        assert load.call_args.kwargs["malformed_ids"] == ["nope"]

    def test_driver_native_values_survive_the_response_model(self):
        # psycopg2 hands back `uuid.UUID` and `datetime`, and `items` is typed Dict[str, Any]
        # inside a Pydantic model. If those did not serialize, every real request would 500 while
        # every dict-fixtured test stayed green.
        import datetime
        import uuid

        native = {
            "id": uuid.UUID(CLASS_A),
            "version_id": uuid.UUID(VERSION),
            "domain_id": None,
            "name": "Customer",
            "schema": {"type": "object"},
            "created_at": datetime.datetime(2026, 8, 4, 12, 0, 0),
            "properties": [{"id": uuid.UUID(CLASS_B), "name": "id"}],
            "tags": [],
        }
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page([native])
            response = client.get(CLASSES_URL, params={"class_ids": CLASS_A})

        assert response.status_code == 200
        item = response.json()["items"][0]
        assert item["id"] == CLASS_A
        assert item["created_at"].startswith("2026-08-04T12:00:00")
        assert item["properties"][0]["id"] == CLASS_B

    def test_paths_are_selected_the_same_way(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_paths_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page([path_item(PATH_A, "/customers")])
            body = client.get(PATHS_URL, params={"path_ids": PATH_A}).json()

        assert body["items"][0]["operations"][0]["operation_id"] == "listCustomers"
        assert load.call_args.kwargs["path_ids"] == [PATH_A]


class TestDomainListing:
    def test_it_pages_and_reports_the_whole_folder(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.domains_store"
        ) as mock_domains, patch(
            "app.scoped_catalog_routes.store.load_classes_by_domain"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_domains.get_domain.return_value = {"id": DOMAIN, "version_id": VERSION}
            load.return_value = page(
                [class_item(CLASS_A, "Address")], total=40, next_offset=1
            )
            body = client.get(CLASSES_URL, params={"domain_id": DOMAIN, "limit": 1}).json()

        assert body["scope"] == "domain"
        assert body["domain_id"] == DOMAIN
        assert body["total"] == 40
        assert body["limit"] == 1
        assert decode_page_cursor(body["next_cursor"]) == 1

    def test_a_cursor_round_trips_into_the_next_offset(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.domains_store"
        ) as mock_domains, patch(
            "app.scoped_catalog_routes.store.load_classes_by_domain"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_domains.get_domain.return_value = {"id": DOMAIN, "version_id": VERSION}
            load.return_value = page([], total=40)
            client.get(
                CLASSES_URL,
                params={"domain_id": DOMAIN, "cursor": encode_page_cursor(25)},
            )

        assert load.call_args.kwargs["offset"] == 25

    def test_the_last_page_has_no_cursor(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.domains_store"
        ) as mock_domains, patch(
            "app.scoped_catalog_routes.store.load_classes_by_domain"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_domains.get_domain.return_value = {"id": DOMAIN, "version_id": VERSION}
            load.return_value = page([class_item(CLASS_A, "Address")], total=1)
            body = client.get(CLASSES_URL, params={"domain_id": DOMAIN}).json()

        assert body["next_cursor"] is None

    def test_a_malformed_cursor_is_a_400(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.domains_store"
        ) as mock_domains, patch(
            "app.scoped_catalog_routes.store.load_classes_by_domain"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_domains.get_domain.return_value = {"id": DOMAIN, "version_id": VERSION}
            response = client.get(
                CLASSES_URL, params={"domain_id": DOMAIN, "cursor": "not-a-cursor"}
            )

        assert response.status_code == 400
        assert response.json()["detail"] == "Malformed cursor"
        load.assert_not_called()

    def test_an_over_large_limit_is_clamped_and_echoed(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.domains_store"
        ) as mock_domains, patch(
            "app.scoped_catalog_routes.store.load_classes_by_domain"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_domains.get_domain.return_value = {"id": DOMAIN, "version_id": VERSION}
            load.return_value = page([], total=1000)
            body = client.get(CLASSES_URL, params={"domain_id": DOMAIN, "limit": 5000}).json()

        assert load.call_args.kwargs["limit"] == MAX_PAGE_SIZE
        assert body["limit"] == MAX_PAGE_SIZE

    def test_no_limit_takes_the_documented_default(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.domains_store"
        ) as mock_domains, patch(
            "app.scoped_catalog_routes.store.load_classes_by_domain"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_domains.get_domain.return_value = {"id": DOMAIN, "version_id": VERSION}
            load.return_value = page([], total=0)
            client.get(CLASSES_URL, params={"domain_id": DOMAIN})

        assert load.call_args.kwargs["limit"] == DEFAULT_PAGE_SIZE

    def test_a_zero_limit_is_rejected_by_the_schema(self):
        with patch("app.scoped_catalog_routes.db") as mock_db:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            response = client.get(CLASSES_URL, params={"domain_id": DOMAIN, "limit": 0})

        assert response.status_code == 422

    def test_shared_lists_the_items_with_no_domain(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.domains_store"
        ) as mock_domains, patch(
            "app.scoped_catalog_routes.store.load_classes_by_domain"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page([class_item(CLASS_A, "Address")], total=8)
            body = client.get(CLASSES_URL, params={"domain_id": "shared"}).json()

        assert load.call_args.kwargs["domain_id"] is None
        assert body["domain_id"] is None
        # `shared/` is the absence of a domain, so there is no row to look up and no way for it to
        # be missing from a version.
        mock_domains.get_domain.assert_not_called()

    def test_an_unknown_domain_is_a_404_not_an_empty_page(self):
        # An empty page reads as "that folder is empty", which is a different fact.
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.domains_store"
        ) as mock_domains, patch(
            "app.scoped_catalog_routes.store.load_classes_by_domain"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_domains.get_domain.return_value = None
            response = client.get(CLASSES_URL, params={"domain_id": DOMAIN})

        assert response.status_code == 404
        load.assert_not_called()

    def test_a_domain_from_another_version_is_a_404(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.domains_store"
        ) as mock_domains, patch(
            "app.scoped_catalog_routes.store.load_classes_by_domain"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_domains.get_domain.return_value = {"id": DOMAIN, "version_id": OTHER_VERSION}
            response = client.get(CLASSES_URL, params={"domain_id": DOMAIN})

        assert response.status_code == 404
        load.assert_not_called()

    def test_paths_list_by_domain_the_same_way(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.domains_store"
        ) as mock_domains, patch(
            "app.scoped_catalog_routes.store.load_paths_by_domain"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_domains.get_domain.return_value = {"id": DOMAIN, "version_id": VERSION}
            load.return_value = page(
                [path_item(PATH_A, "/customers"), path_item(PATH_B, "/customers/{id}")],
                total=218,
                next_offset=2,
            )
            body = client.get(PATHS_URL, params={"domain_id": DOMAIN, "limit": 2}).json()

        assert body["total"] == 218
        assert decode_page_cursor(body["next_cursor"]) == 2


class TestTenancy:
    def test_another_tenants_version_is_not_found_and_nothing_is_read(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = None
            response = client.get(CLASSES_URL, params={"class_ids": CLASS_A})

        assert response.status_code == 404
        load.assert_not_called()

    def test_the_version_is_resolved_against_the_callers_tenant(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page([])
            client.get(CLASSES_URL, params={"class_ids": CLASS_A})

        mock_db.get_version_by_id.assert_called_once_with(VERSION, TENANT)

    def test_every_read_is_scoped_to_that_version(self):
        # The ids alone would appear to identify the rows; the version predicate is what stops one
        # tenant's UUID guess from resolving in another tenant's catalog.
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page([])
            client.get(CLASSES_URL, params={"class_ids": CLASS_A})

        assert load.call_args.kwargs["version_id"] == VERSION

    def test_paths_are_gated_the_same_way(self):
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_paths_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = None
            response = client.get(PATHS_URL, params={"path_ids": PATH_A})

        assert response.status_code == 404
        load.assert_not_called()

    def test_a_token_with_no_tenant_is_a_500_not_an_unscoped_read(self):
        app.dependency_overrides[validate_authentication] = lambda: {"auth_method": "jwt"}
        try:
            with patch("app.scoped_catalog_routes.store.load_classes_by_ids") as load:
                response = client.get(CLASSES_URL, params={"class_ids": CLASS_A})
        finally:
            app.dependency_overrides[validate_authentication] = lambda: _MOCK_JWT

        assert response.status_code == 500
        load.assert_not_called()


class TestAcceptance:
    """The ticket's acceptance criteria, stated as tests."""

    def test_three_classes_come_back_from_a_two_hundred_and_eighteen_path_catalog(self):
        # "Requesting 3 classes returns exactly 3, with properties+tags, regardless of catalog
        # size." The catalog's size never enters the request, which is why it cannot affect the
        # response — proven against real SQL in test_scoped_catalog_db.py.
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.store.load_classes_by_ids"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            load.return_value = page(
                [
                    class_item(CLASS_A, "Address"),
                    class_item(CLASS_B, "Customer"),
                    class_item(CLASS_C, "Order"),
                ]
            )
            body = client.get(
                CLASSES_URL, params={"class_ids": [CLASS_A, CLASS_B, CLASS_C]}
            ).json()

        assert len(body["items"]) == 3
        assert all("properties" in item and "tags" in item for item in body["items"])

    def test_domain_reads_paginate_and_carry_a_total_for_the_budget_notice(self):
        # "Domain-scoped reads paginate; `total` present; server cap enforced and documented."
        with patch("app.scoped_catalog_routes.db") as mock_db, patch(
            "app.scoped_catalog_routes.domains_store"
        ) as mock_domains, patch(
            "app.scoped_catalog_routes.store.load_classes_by_domain"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION}
            mock_domains.get_domain.return_value = {"id": DOMAIN, "version_id": VERSION}
            load.return_value = page(
                [class_item(CLASS_A, "Address")], total=94, next_offset=1
            )
            body = client.get(CLASSES_URL, params={"domain_id": DOMAIN, "limit": 1}).json()

        assert body["total"] == 94
        assert body["next_cursor"] is not None

    def test_the_cap_is_documented_in_the_api_schema(self):
        # "server cap enforced and documented" — a client should not have to trigger a 400 to
        # discover the limit.
        schema = app.openapi()["paths"][
            "/v1/workspace/{tenant_slug}/version/{version_id}/classes"
        ]["get"]
        described = " ".join(
            param.get("description", "") for param in schema.get("parameters", [])
        )
        assert str(MAX_SELECTED_IDS) in described
        assert str(MAX_PAGE_SIZE) in described

    def test_the_legacy_full_version_read_still_points_here(self):
        # "Legacy full-version endpoint untouched but gains a deprecation note pointing here."
        legacy = app.openapi()["paths"][
            "/v1/classes/{tenant_slug}/version/{version_id}/with-properties-tags"
        ]["get"]
        assert "/v1/workspace/" in legacy["description"]

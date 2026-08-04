"""Domain summary REST surface — DUW-1.3 (private-suite#2570).

Route-level tests over :mod:`app.workspace_summary_routes`, following the
``test_scoped_catalog_routes.py`` precedent: a module-level ``TestClient``, auth supplied through
the dependency override, and the database and the store's loader patched where used. The store's
constants and pure helpers are left real — the cap and the badge format are the rules under test,
and mocking them into always agreeing would prove nothing.

:class:`TestAcceptance` walks the ticket's acceptance criteria that a route can answer; the two
that need a catalog (counts match SQL truth, p95 under 300 ms) live in
``test_workspace_summary_db.py``.

The claims nothing below is allowed to weaken:

* **All three lens panels render from one response.** Every field each panel draws is present, for
  every folder, in a single request.
* **Tenancy is resolved before anything is read.** Another tenant's version is a 404 and no
  aggregate runs.
* **The response says what it actually did** — the limit applied, and which folders were cut.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.workspace_summary_store import DEFAULT_MEMBER_LIMIT, MAX_MEMBER_LIMIT

client = TestClient(app)

TENANT = "11111111-1111-1111-1111-111111111111"
VERSION = "22222222-2222-2222-2222-222222222222"
OTHER_VERSION = "22222222-2222-2222-2222-2222222222ff"
CUSTOMERS = "33333333-3333-3333-3333-33333333aaaa"
CLASS_A = "44444444-4444-4444-4444-44444444aaaa"
ENUM_A = "44444444-4444-4444-4444-44444444eeee"
PATH_A = "55555555-5555-5555-5555-55555555aaaa"
OP_A = "66666666-6666-6666-6666-66666666aaaa"

SUMMARY_URL = f"/v1/workspace/acme/version/{VERSION}/summary"

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


def folder(
    slug: str,
    *,
    domain_id: Optional[str] = CUSTOMERS,
    class_count: int = 0,
    enum_count: int = 0,
    path_count: int = 0,
    op_count: int = 0,
    classes: Optional[List[Dict[str, Any]]] = None,
    paths: Optional[List[Dict[str, Any]]] = None,
    classes_truncated: bool = False,
    paths_truncated: bool = False,
    virtual: bool = False,
    sort_order: int = 0,
) -> Dict[str, Any]:
    """One folder entry shaped as :func:`app.workspace_summary_store.load_version_summary` returns."""
    return {
        "id": domain_id,
        "name": slug,
        "slug": slug,
        "sort_order": sort_order,
        "virtual": virtual,
        "class_count": class_count,
        "enum_count": enum_count,
        "path_count": path_count,
        "op_count": op_count,
        "classes": classes or [],
        "paths": paths or [],
        "classes_truncated": classes_truncated,
        "paths_truncated": paths_truncated,
    }


def class_row(name: str, kind: str = "object", badge: Optional[str] = "v2.1") -> Dict[str, Any]:
    return {
        "id": ENUM_A if kind != "object" else CLASS_A,
        "name": name,
        "kind": kind,
        "version_badge": badge,
    }


def path_row(pathname: str = "/customers") -> Dict[str, Any]:
    return {
        "id": PATH_A,
        "pathname": pathname,
        "op_count": 2,
        "operations": [
            {
                "id": OP_A,
                "operation": "GET",
                "operation_id": "customers.list",
                "summary": "List customers",
                "deprecated": False,
            },
            {
                "id": OP_A[:-1] + "b",
                "operation": "POST",
                "operation_id": "customers.create",
                "summary": None,
                "deprecated": True,
            },
        ],
    }


#: The mockup's own tree: `customers/ 3·4` with three schemas and one enum, and a `shared/` bucket
#: holding eight classes and no operations.
MOCKUP_TREE = [
    folder(
        "customers",
        class_count=3,
        enum_count=1,
        path_count=2,
        op_count=4,
        classes=[
            class_row("Customer"),
            class_row("Address"),
            class_row("ContactMethod"),
            class_row("CountryCode", kind="enum"),
        ],
        paths=[path_row("/customers"), path_row("/customers/{id}")],
    ),
    folder(
        "shared",
        domain_id=None,
        virtual=True,
        sort_order=1,
        class_count=8,
        classes=[class_row(f"Shared{i}") for i in range(8)],
    ),
]


def get(url: str = SUMMARY_URL, *, domains=None, version: Optional[Dict[str, Any]] = None):
    """Call the endpoint with the database and the store's loader patched.

    Args:
        url: The request URL.
        domains: What the store should return, or None for the mockup tree.
        version: The version row the tenancy gate resolves, or None for a live one labelled 2.1.

    Returns:
        ``(response, load_mock)`` so a test can assert on what reached the store.
    """
    with patch("app.workspace_summary_routes.db") as mock_db, patch(
        "app.workspace_summary_routes.store.load_version_summary"
    ) as load:
        mock_db.get_version_by_id.return_value = (
            {"id": VERSION, "version_id": "2.1"} if version is None else version
        )
        load.return_value = MOCKUP_TREE if domains is None else domains
        return client.get(url), load


class TestAcceptance:
    """"The response renders all three mockup tree panels with zero additional requests."""

    def test_the_combined_lens_badge_is_present_for_every_folder(self):
        # `customers/ 3·4` — classes and ops, in one place, before anything is hydrated.
        response, _ = get()
        by_slug = {d["slug"]: d for d in response.json()["domains"]}

        assert (by_slug["customers"]["counts"]["class_count"],
                by_slug["customers"]["counts"]["op_count"]) == (3, 4)
        assert by_slug["shared"]["counts"]["class_count"] == 8

    def test_the_schemas_lens_can_split_its_two_groups_without_a_second_pass(self):
        # `3 classes` above three objects, with the enum in its own group — the kind label on each
        # row is what lets the client draw both without re-reading a schema body.
        response, _ = get()
        customers = response.json()["domains"][0]
        kinds = [row["kind"] for row in customers["classes"]]

        assert customers["counts"]["class_count"] == kinds.count("object")
        assert customers["counts"]["enum_count"] == len([k for k in kinds if k != "object"])

    def test_the_paths_lens_has_every_field_it_draws(self):
        # `/customers  2 ops`, then a verb and an operationId per row.
        response, _ = get()
        path = response.json()["domains"][0]["paths"][0]

        assert path["pathname"] == "/customers"
        assert path["op_count"] == 2
        assert [op["operation"] for op in path["operations"]] == ["GET", "POST"]
        assert path["operations"][0]["operation_id"] == "customers.list"
        assert path["operations"][1]["deprecated"] is True

    def test_the_whole_tree_arrives_in_one_request(self):
        response, load = get()

        assert response.status_code == 200
        assert load.call_count == 1
        assert len(response.json()["domains"]) == 2

    def test_the_version_badge_is_on_the_envelope_and_on_every_class_row(self):
        response, _ = get()
        body = response.json()

        assert body["version_badge"] == "v2.1"
        assert all(row["version_badge"] == "v2.1" for row in body["domains"][0]["classes"])

    def test_a_version_with_no_label_badges_nothing_rather_than_guessing(self):
        response, _ = get(version={"id": VERSION, "version_id": None})

        assert response.json()["version_badge"] is None


class TestTenancy:
    """The version is the only gate, and it closes before anything is read."""

    def test_a_version_outside_the_tenant_is_a_404_and_reads_nothing(self):
        with patch("app.workspace_summary_routes.db") as mock_db, patch(
            "app.workspace_summary_routes.store.load_version_summary"
        ) as load:
            mock_db.get_version_by_id.return_value = None
            response = client.get(f"/v1/workspace/acme/version/{OTHER_VERSION}/summary")

        assert response.status_code == 404
        assert load.call_count == 0

    def test_the_version_is_resolved_against_the_callers_tenant(self):
        with patch("app.workspace_summary_routes.db") as mock_db, patch(
            "app.workspace_summary_routes.store.load_version_summary"
        ) as load:
            mock_db.get_version_by_id.return_value = {"id": VERSION, "version_id": "2.1"}
            load.return_value = []
            client.get(SUMMARY_URL)

        mock_db.get_version_by_id.assert_called_once_with(VERSION, TENANT)

    def test_a_token_without_a_tenant_is_a_500_not_a_cross_tenant_read(self):
        app.dependency_overrides[validate_authentication] = lambda: {"auth_method": "jwt"}
        try:
            with patch("app.workspace_summary_routes.store.load_version_summary") as load:
                response = client.get(SUMMARY_URL)
        finally:
            app.dependency_overrides[validate_authentication] = lambda: _MOCK_JWT

        assert response.status_code == 500
        assert load.call_count == 0


class TestMemberLimit:
    """The response says which limit it actually applied, and who was cut by it."""

    def test_the_default_limit_is_applied_and_echoed(self):
        response, load = get()

        assert response.json()["member_limit"] == DEFAULT_MEMBER_LIMIT
        assert load.call_args.kwargs["member_limit"] == DEFAULT_MEMBER_LIMIT

    def test_an_over_large_limit_is_clamped_not_refused(self):
        response, load = get(f"{SUMMARY_URL}?member_limit={MAX_MEMBER_LIMIT + 1000}")

        assert response.status_code == 200
        assert response.json()["member_limit"] == MAX_MEMBER_LIMIT
        assert load.call_args.kwargs["member_limit"] == MAX_MEMBER_LIMIT

    def test_zero_asks_for_badges_alone(self):
        response, load = get(f"{SUMMARY_URL}?member_limit=0")

        assert response.json()["member_limit"] == 0
        assert load.call_args.kwargs["member_limit"] == 0

    def test_a_negative_limit_is_rejected_by_the_schema(self):
        response, _ = get(f"{SUMMARY_URL}?member_limit=-1")

        assert response.status_code == 422

    def test_a_cut_folder_says_so(self):
        response, _ = get(
            domains=[
                folder(
                    "billing",
                    class_count=99,
                    classes=[class_row("Bulk0001")],
                    classes_truncated=True,
                    path_count=40,
                    paths_truncated=True,
                )
            ]
        )
        billing = response.json()["domains"][0]

        assert billing["classes_truncated"] is True
        assert billing["paths_truncated"] is True
        assert billing["counts"]["class_count"] == 99


class TestResponseShape:
    """What a client is entitled to rely on."""

    def test_the_shared_bucket_is_identified_by_a_null_id_and_a_virtual_flag(self):
        response, _ = get()
        shared = response.json()["domains"][1]

        assert shared["id"] is None
        assert shared["virtual"] is True
        assert shared["slug"] == "shared"

    def test_folders_keep_the_order_the_store_gave_them(self):
        response, _ = get()

        assert [d["slug"] for d in response.json()["domains"]] == ["customers", "shared"]

    def test_totals_are_the_sum_of_every_folder(self):
        response, _ = get()
        totals = response.json()["totals"]

        assert totals == {
            "class_count": 11,
            "path_count": 2,
            "op_count": 4,
            "enum_count": 1,
        }

    def test_a_version_with_no_folders_is_an_empty_tree_not_an_error(self):
        response, _ = get(domains=[])
        body = response.json()

        assert response.status_code == 200
        assert body["domains"] == []
        assert body["totals"]["class_count"] == 0

    def test_the_envelope_names_the_version_it_summarized(self):
        response, _ = get()

        assert response.json()["version_id"] == VERSION

    def test_no_schema_bodies_or_properties_are_in_the_response(self):
        # The habit this epic exists to break: a tree row is a label, an icon and a badge.
        response, _ = get()

        for row in response.json()["domains"][0]["classes"]:
            assert set(row) == {"id", "name", "kind", "version_badge"}

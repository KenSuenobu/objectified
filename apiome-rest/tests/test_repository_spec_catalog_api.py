"""The cross-repo spec catalog REST surface (REPO-6.4, #2797).

``GET /v1/tenants/{slug}/repository-files`` is the tenant-wide answer to "where does this spec
live". These tests pin the projection an operator's catalog page renders, the fact that the
tenant scope comes from the token rather than the path, and the validation rails that turn a
bad filter into a 400 instead of a silently-unfiltered list.
"""

from typing import Any, Dict
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_REPO_ID = "880e8400-e29b-41d4-a716-446655440003"
_PROJECT_ID = "770e8400-e29b-41d4-a716-446655440002"
_VERSION_ID = "660e8400-e29b-41d4-a716-446655440009"
_FILE_ID = "990e8400-e29b-41d4-a716-446655440001"

_JWT = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": "660e8400-e29b-41d4-a716-446655440001",
    "auth_method": "jwt",
}

_URL = "/v1/tenants/acme/repository-files"


@pytest.fixture(autouse=True)
def auth_jwt():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _row(**overrides: Any) -> Dict[str, Any]:
    """One row as the catalog DAO returns it."""
    row = {
        "id": _FILE_ID,
        "repository_id": _REPO_ID,
        "branch": "main",
        "path": "services/orders/openapi.yaml",
        "name": "openapi.yaml",
        "ext": "yaml",
        "size_bytes": 4096,
        "blob_sha": "aaa111",
        "detected_kind": "openapi-3.1",
        "quality_score": 87,
        "quality_grade": "B",
        "quality_status": "scored",
        "quality_reason": None,
        "external_ref_warning": None,
        "discovered_at": "2026-07-01T10:00:00Z",
        "repository_full_name": "acme/api-platform",
        "provider": "github",
        "default_branch": "main",
        "project_id": _PROJECT_ID,
        "project_name": "Orders API",
        "project_slug": "orders-api",
        "version_id": _VERSION_ID,
        "last_imported_at": "2026-07-20T09:30:00Z",
        "format_key": "openapi",
        "status_key": "imported",
        "status_rank": 1,
    }
    row.update(overrides)
    return row


def _page(rows=None, **overrides: Any) -> Dict[str, Any]:
    page = {
        "catalog_total": 120,
        "match_count": 1,
        "limit": 50,
        "offset": 0,
        "sort": "repository",
        "rows": rows if rows is not None else [_row()],
        "facets": None,
    }
    page.update(overrides)
    return page


# --- projection -------------------------------------------------------------------------


def test_a_catalog_row_carries_its_repository_project_and_import_context() -> None:
    """The point of the cross-repo view: a row is useless without knowing where it lives."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page()
        r = client.get(_URL)

    assert r.status_code == 200
    body = r.json()
    assert body["catalog_total"] == 120
    assert body["match_count"] == 1
    spec = body["specs"][0]
    assert spec["repository_full_name"] == "acme/api-platform"
    assert spec["branch"] == "main"
    assert spec["path"] == "services/orders/openapi.yaml"
    assert spec["project_name"] == "Orders API"
    assert spec["version_id"] == _VERSION_ID
    assert spec["last_imported_at"] == "2026-07-20T09:30:00Z"
    assert spec["status"] == "imported"


def test_the_format_family_carries_its_display_label() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page(
            rows=[_row(format_key="json_schema", detected_kind="json-candidate")]
        )
        r = client.get(_URL)

    spec = r.json()["specs"][0]
    assert spec["format"] == "json_schema"
    assert spec["display_kind"] == "JSON Schema"


def test_an_unknown_family_falls_back_to_its_key_rather_than_failing() -> None:
    """A family added in SQL must still render before the label ships."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page(rows=[_row(format_key="raml")])
        r = client.get(_URL)

    assert r.json()["specs"][0]["display_kind"] == "raml"


def test_unresolved_external_refs_are_summarised_as_a_count() -> None:
    """The itemized references stay on the row; a 500-file page must stay small."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page(
            rows=[
                _row(
                    status_key="needs_attention",
                    external_ref_warning={"policy": "block", "unresolved_count": 3},
                )
            ]
        )
        r = client.get(_URL)

    spec = r.json()["specs"][0]
    assert spec["external_ref_unresolved_count"] == 3
    assert spec["status"] == "needs_attention"


def test_a_malformed_ref_warning_does_not_break_the_listing() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page(
            rows=[_row(external_ref_warning="not-json")]
        )
        r = client.get(_URL)

    assert r.status_code == 200
    assert r.json()["specs"][0]["external_ref_unresolved_count"] is None


def test_an_unmapped_spec_reports_null_project_and_version() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page(
            rows=[
                _row(
                    status_key="discovered",
                    project_id=None,
                    project_name=None,
                    project_slug=None,
                    version_id=None,
                    last_imported_at=None,
                )
            ]
        )
        r = client.get(_URL)

    spec = r.json()["specs"][0]
    assert spec["project_id"] is None
    assert spec["version_id"] is None
    assert spec["status"] == "discovered"


def test_an_empty_catalog_returns_an_empty_list_not_an_error() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page(
            rows=[], catalog_total=0, match_count=0
        )
        r = client.get(_URL)

    assert r.status_code == 200
    assert r.json()["specs"] == []


# --- scoping and filter plumbing --------------------------------------------------------


def test_the_tenant_comes_from_the_token_not_the_path() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page()
        r = client.get("/v1/tenants/some-other-slug/repository-files")

    assert r.status_code == 200
    assert mdb.tenant_repository_spec_catalog.call_args.args[0] == _TENANT_ID


def test_filters_reach_the_dao_normalized() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page()
        r = client.get(
            _URL,
            params={
                "q": "  orders  ",
                "format": "OpenAPI",
                "status": "Imported",
                "repository_id": _REPO_ID,
                "project_id": _PROJECT_ID,
                "sort": "recent",
                "all_branches": "true",
                "importable_only": "false",
                "limit": 25,
                "offset": 50,
                "include_facets": "true",
            },
        )

    assert r.status_code == 200
    kwargs = mdb.tenant_repository_spec_catalog.call_args.kwargs
    assert kwargs["search"] == "orders"
    assert kwargs["format_key"] == "openapi"
    assert kwargs["status_key"] == "imported"
    assert kwargs["repository_id"] == _REPO_ID
    assert kwargs["project_id"] == _PROJECT_ID
    assert kwargs["sort"] == "recent"
    assert kwargs["all_branches"] is True
    assert kwargs["importable_only"] is False
    assert kwargs["limit"] == 25
    assert kwargs["offset"] == 50
    assert kwargs["include_facets"] is True


def test_the_defaults_list_one_row_per_spec() -> None:
    """Default branch only, importable only — otherwise the catalog is mostly noise."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page()
        client.get(_URL)

    kwargs = mdb.tenant_repository_spec_catalog.call_args.kwargs
    assert kwargs["all_branches"] is False
    assert kwargs["importable_only"] is True
    assert kwargs["include_facets"] is False
    assert kwargs["search"] is None
    assert kwargs["format_key"] is None
    assert kwargs["status_key"] is None


@pytest.mark.parametrize("value", ["all", ""])
def test_an_all_filter_is_treated_as_no_filter(value: str) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page()
        r = client.get(_URL, params={"format": value, "status": value})

    assert r.status_code == 200
    kwargs = mdb.tenant_repository_spec_catalog.call_args.kwargs
    assert kwargs["format_key"] is None
    assert kwargs["status_key"] is None


# --- validation -------------------------------------------------------------------------


def test_an_unknown_format_is_a_400_not_an_unfiltered_list() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        r = client.get(_URL, params={"format": "raml"})

    assert r.status_code == 400
    assert "raml" in r.json()["detail"]
    mdb.tenant_repository_spec_catalog.assert_not_called()


def test_an_unknown_status_is_a_400() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        r = client.get(_URL, params={"status": "broken"})

    assert r.status_code == 400
    mdb.tenant_repository_spec_catalog.assert_not_called()


def test_an_overlong_search_term_is_a_400() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        r = client.get(_URL, params={"q": "x" * 500})

    assert r.status_code == 400
    mdb.tenant_repository_spec_catalog.assert_not_called()


def test_an_unknown_sort_is_accepted_and_falls_back() -> None:
    """A stale bookmark should still render a catalog rather than an error page."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page()
        r = client.get(_URL, params={"sort": "created_at"})

    assert r.status_code == 200
    assert mdb.tenant_repository_spec_catalog.call_args.kwargs["sort"] == "repository"


def test_a_non_uuid_repository_filter_is_rejected_by_validation() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        r = client.get(_URL, params={"repository_id": "not-a-uuid"})

    assert r.status_code == 422
    mdb.tenant_repository_spec_catalog.assert_not_called()


@pytest.mark.parametrize("limit", [0, 501])
def test_the_page_size_bounds_are_enforced_at_the_edge(limit: int) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        r = client.get(_URL, params={"limit": limit})

    assert r.status_code == 422
    mdb.tenant_repository_spec_catalog.assert_not_called()


# --- facets -----------------------------------------------------------------------------


def test_facets_are_absent_unless_requested() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page()
        r = client.get(_URL)

    assert r.json()["facets"] is None


def test_requested_facets_come_back_labelled_and_ordered() -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page(
            facets={
                "formats": [("asyncapi", 2), ("openapi", 9)],
                "statuses": [("discovered", 90), ("needs_attention", 1)],
                "repositories": [{"id": _REPO_ID, "label": "acme/api-platform", "count": 11}],
                "projects": [{"id": _PROJECT_ID, "label": "Orders API", "count": 4}],
            }
        )
        r = client.get(_URL, params={"include_facets": "true"})

    facets = r.json()["facets"]
    assert [f["value"] for f in facets["formats"]] == ["openapi", "asyncapi"]
    assert facets["formats"][0]["label"] == "OpenAPI"
    # Statuses keep severity order rather than count order.
    assert [s["value"] for s in facets["statuses"]] == ["needs_attention", "discovered"]
    assert facets["repositories"][0]["label"] == "acme/api-platform"
    assert facets["projects"][0]["value"] == _PROJECT_ID


def test_a_repository_with_no_name_falls_back_to_its_id() -> None:
    """An unnamed option would render as a blank, unselectable row in the filter."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.tenant_repository_spec_catalog.return_value = _page(
            facets={
                "formats": [],
                "statuses": [],
                "repositories": [{"id": _REPO_ID, "label": "", "count": 1}],
                "projects": [],
            }
        )
        r = client.get(_URL, params={"include_facets": "true"})

    assert r.json()["facets"]["repositories"][0]["label"] == _REPO_ID

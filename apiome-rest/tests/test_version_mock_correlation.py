"""Version mock response-correlation REST route tests (#5527, MSC-1.1)."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

TENANT = "acme-corp"
PROJECT_ID = "proj-1"
VERSION_ID = "ver-1"
USER_ID = "user-1"
_AUTH = {"tenant_id": "t1", "user_id": USER_ID, "auth_method": "api_key"}
ROUTE = f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/correlation"

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets/{petId}": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"schema": {"type": "object"}}},
                    }
                }
            }
        }
    },
}

STORED_SETTINGS = {
    "mode": "private",
    "responseCorrelation": {
        "mode": "inferred",
        "operations": {"GET /pets/{petId}": {"/id": "{{request.path.petId}}"}},
    },
}


@pytest.fixture
def client() -> TestClient:
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield TestClient(app)
    app.dependency_overrides.clear()


def _version_row(*, mock_settings: dict | None = None) -> dict:
    return {
        "id": VERSION_ID,
        "project_id": PROJECT_ID,
        "creator_id": USER_ID,
        "version_id": "1.0.0",
        "published": True,
        "mock_enabled": True,
        "mock_settings": mock_settings if mock_settings is not None else {},
        "project_slug": "petstore",
        "metadata": None,
    }


def test_get_returns_the_stored_block(client: TestClient) -> None:
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row(mock_settings=STORED_SETTINGS)),
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.get(ROUTE)

    assert resp.status_code == 200, resp.text
    correlation = resp.json()["correlation"]
    assert correlation["mode"] == "inferred"
    assert correlation["operations"] == {"GET /pets/{petId}": {"/id": "{{request.path.petId}}"}}


def test_get_without_a_block_reports_null(client: TestClient) -> None:
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.get(ROUTE)

    assert resp.status_code == 200
    assert resp.json()["correlation"] is None


def test_get_skips_a_malformed_stored_block(client: TestClient) -> None:
    settings = {"responseCorrelation": {"mode": "sideways"}}
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row(mock_settings=settings)),
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.get(ROUTE)

    assert resp.status_code == 200
    assert resp.json()["correlation"] is None


def test_put_persists_the_canonical_block(client: TestClient) -> None:
    payload = {
        "correlation": {
            "mode": "inferred",
            "operations": {"get /pets/{petId}": {"/id": "{{request.path.petId}}"}},
        }
    }
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch(
            "app.versions_routes.db.set_version_mock_correlation",
            return_value=_version_row(mock_settings=STORED_SETTINGS),
        ) as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(ROUTE, json=payload)

    assert resp.status_code == 200, resp.text
    assert set_mock.call_args.kwargs["correlation"] == {
        "mode": "inferred",
        "operations": {"GET /pets/{petId}": {"/id": "{{request.path.petId}}"}},
    }
    assert resp.json()["correlation"]["mode"] == "inferred"


def test_put_without_a_block_clears_the_stored_one(client: TestClient) -> None:
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row(mock_settings=STORED_SETTINGS)),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch(
            "app.versions_routes.db.set_version_mock_correlation",
            return_value=_version_row(mock_settings={"mode": "private"}),
        ) as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(ROUTE, json={})

    assert resp.status_code == 200
    assert set_mock.call_args.kwargs["correlation"] is None
    assert resp.json()["correlation"] is None


def test_put_mode_off_clears_the_stored_block(client: TestClient) -> None:
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row(mock_settings=STORED_SETTINGS)),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch(
            "app.versions_routes.db.set_version_mock_correlation",
            return_value=_version_row(mock_settings={"mode": "private"}),
        ) as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(ROUTE, json={"correlation": {"mode": "off"}})

    assert resp.status_code == 200
    assert set_mock.call_args.kwargs["correlation"] is None


def test_put_an_unknown_operation_returns_422(client: TestClient) -> None:
    payload = {"correlation": {"mode": "explicit", "operations": {"DELETE /pets": {"/id": "x"}}}}
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch("app.versions_routes.db.set_version_mock_correlation") as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(ROUTE, json=payload)

    assert resp.status_code == 422, resp.text
    assert any("DELETE /pets" in error for error in resp.json()["detail"]["errors"])
    set_mock.assert_not_called()


def test_put_a_malformed_template_returns_422(client: TestClient) -> None:
    payload = {
        "correlation": {"mode": "explicit", "operations": {"GET /pets/{petId}": {"/id": "{{random.nope()}}"}}}
    }
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch("app.versions_routes.db.set_version_mock_correlation") as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(ROUTE, json=payload)

    assert resp.status_code == 422, resp.text
    set_mock.assert_not_called()


def test_put_an_unknown_mode_is_rejected_by_the_model(client: TestClient) -> None:
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(ROUTE, json={"correlation": {"mode": "guess"}})

    assert resp.status_code == 422


def test_put_without_ownership_is_403(client: TestClient) -> None:
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch("app.versions_routes.db.set_version_mock_correlation", return_value=None),
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(ROUTE, json={"correlation": {"mode": "path-params"}})

    assert resp.status_code == 403


def test_a_version_in_another_project_is_404(client: TestClient) -> None:
    row = _version_row()
    row["project_id"] = "other-project"
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=row),
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.get(ROUTE)

    assert resp.status_code == 404

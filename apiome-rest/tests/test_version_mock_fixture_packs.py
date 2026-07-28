"""Version mock fixture pack REST route tests (#4745, PMR-2.2)."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.mock_fixture_packs import PACK_FORMAT, fixture_pack_digest

TENANT = "acme-corp"
PROJECT_ID = "proj-1"
VERSION_ID = "ver-1"
USER_ID = "user-1"
_AUTH = {"tenant_id": "t1", "user_id": USER_ID, "auth_method": "api_key"}

PACKS_PAYLOAD = {
    "packs": {
        "smoke": {
            "description": "Two pets.",
            "data": {"pets": [{"id": 1, "name": "Rex"}]},
            "collections": {"/pets": [{"id": 1, "name": "Rex"}, {"id": 2, "name": "Bella"}]},
        }
    }
}

STORED_PACK = {
    "packFormat": PACK_FORMAT,
    "packFormatVersion": 1,
    "description": "Two pets.",
    "data": {"pets": [{"id": 1, "name": "Rex"}]},
    "collections": {"/pets": [{"id": 1, "name": "Rex"}, {"id": 2, "name": "Bella"}]},
}

STORED_SETTINGS = {"mode": "private", "fixturePacks": {"smoke": STORED_PACK}}

URL = f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/fixture-packs"


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


def test_get_fixture_packs_returns_stored_packs_and_digests(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings=STORED_SETTINGS),
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.get(URL)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["packs"]["smoke"]["description"] == "Two pets."
    assert body["packs"]["smoke"]["collections"]["/pets"][0] == {"id": 1, "name": "Rex"}
    assert body["digests"]["smoke"] == fixture_pack_digest(STORED_PACK)


def test_get_fixture_packs_empty_when_none_stored(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.get(URL)
    assert resp.status_code == 200
    assert resp.json() == {"packs": {}, "digests": {}}


def test_get_fixture_packs_skips_malformed_stored_entries(client: TestClient) -> None:
    settings = {"fixturePacks": {"ok": STORED_PACK, "broken": {"surprise": True}}}
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings=settings),
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.get(URL)
    assert resp.status_code == 200
    assert set(resp.json()["packs"]) == {"ok"}
    assert set(resp.json()["digests"]) == {"ok"}


def test_get_fixture_packs_missing_version_404(client: TestClient) -> None:
    with patch("app.versions_routes.db.get_version_by_id", return_value=None), patch(
        "app.versions_routes.enforce_permission"
    ):
        resp = client.get(URL)
    assert resp.status_code == 404


def test_get_fixture_packs_wrong_project_404(client: TestClient) -> None:
    row = _version_row()
    row["project_id"] = "other-project"
    with patch("app.versions_routes.db.get_version_by_id", return_value=row), patch(
        "app.versions_routes.enforce_permission"
    ):
        resp = client.get(URL)
    assert resp.status_code == 404


def test_put_fixture_packs_validates_and_persists_canonical_form(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(),
    ), patch("app.versions_routes.enforce_permission"), patch(
        "app.versions_routes.db.set_version_mock_fixture_packs",
        return_value=_version_row(mock_settings=STORED_SETTINGS),
    ) as set_packs:
        resp = client.put(URL, json=PACKS_PAYLOAD)
    assert resp.status_code == 200, resp.text

    kwargs = set_packs.call_args.kwargs
    stored = kwargs["packs"]["smoke"]
    assert stored["packFormat"] == PACK_FORMAT
    assert stored["packFormatVersion"] == 1
    assert stored["collections"]["/pets"][1] == {"id": 2, "name": "Bella"}

    body = resp.json()
    assert body["packs"]["smoke"]["packFormat"] == PACK_FORMAT
    assert body["digests"]["smoke"] == fixture_pack_digest(STORED_PACK)


def test_put_fixture_packs_rejects_invalid_packs_422(client: TestClient) -> None:
    payload = {
        "packs": {
            "smoke": {
                "collections": {"no-slash": [{"id": 1}], "/pets": [{"id": 1}, {"id": 1}]},
            }
        }
    }
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.put(URL, json=payload)
    assert resp.status_code == 422
    errors = resp.json()["detail"]["errors"]
    assert any("collection keys must be paths" in error for error in errors)
    assert any("duplicate resource id" in error for error in errors)


def test_put_fixture_packs_rejects_unknown_keys_via_model(client: TestClient) -> None:
    payload = {"packs": {"smoke": {"collecitons": {}}}}
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.put(URL, json=payload)
    assert resp.status_code == 422


def test_put_fixture_packs_requires_user_attribution(client: TestClient) -> None:
    app.dependency_overrides[validate_authentication] = lambda: {
        "tenant_id": "t1",
        "auth_method": "api_key",
    }
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.put(URL, json=PACKS_PAYLOAD)
    assert resp.status_code == 403


def test_put_fixture_packs_ownership_denied_403(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes.enforce_permission"), patch(
        "app.versions_routes.db.set_version_mock_fixture_packs", return_value=None
    ):
        resp = client.put(URL, json=PACKS_PAYLOAD)
    assert resp.status_code == 403


def test_put_empty_packs_clears(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes.enforce_permission"), patch(
        "app.versions_routes.db.set_version_mock_fixture_packs",
        return_value=_version_row(mock_settings={"mode": "private"}),
    ) as set_packs:
        resp = client.put(URL, json={"packs": {}})
    assert resp.status_code == 200
    assert set_packs.call_args.kwargs["packs"] == {}
    assert resp.json() == {"packs": {}, "digests": {}}

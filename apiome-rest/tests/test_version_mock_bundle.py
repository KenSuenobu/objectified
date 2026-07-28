"""Version mock bundle export route tests (#4741, PMR-1.1)."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.mock_bundle import BUNDLE_FORMAT, manifest_digest, verify_bundle

TENANT = "acme-corp"
PROJECT_ID = "proj-1"
VERSION_ID = "11111111-2222-3333-4444-555555555555"
USER_ID = "user-1"
_AUTH = {"tenant_id": "t1", "user_id": USER_ID, "auth_method": "api_key"}
_URL = f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/bundle"

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {"/pets": {"get": {"responses": {"200": {"description": "ok"}}}}},
}

STORED_SETTINGS = {
    "mode": "private",
    "scenarios": {
        "quota-exceeded": {
            "operations": {
                "GET /pets": {
                    "responses": [
                        {"status": 429, "headers": {"Retry-After": "60", "Authorization": "Bearer x"}}
                    ]
                }
            }
        }
    },
    "chaos": {"default": {"errorRate": 10}},
}


@pytest.fixture
def client() -> TestClient:
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield TestClient(app)
    app.dependency_overrides.clear()


def _version_row(*, mock_enabled: bool = True, mock_settings: dict | None = None) -> dict:
    return {
        "id": VERSION_ID,
        "project_id": PROJECT_ID,
        "creator_id": USER_ID,
        "version_id": "1.0.0",
        "published": True,
        "mock_enabled": mock_enabled,
        "mock_settings": mock_settings if mock_settings is not None else STORED_SETTINGS,
        "project_slug": "petstore",
        "metadata": None,
    }


def _get(client: TestClient, *, row: dict | None = None, secret: str | None = None):
    """Call the export route with the database and spec generation stubbed out."""
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=row if row is not None else _version_row()
    ), patch("app.versions_routes.enforce_permission"), patch(
        "app.versions_routes._generated_spec_for_version", return_value=SPEC
    ), patch("app.versions_routes.settings.mock_bundle_signing_secret", secret):
        return client.get(_URL)


def test_export_returns_a_verifiable_bundle(client: TestClient) -> None:
    response = _get(client, secret="s3cret")
    assert response.status_code == 200

    bundle = response.json()
    assert bundle["bundleFormat"] == BUNDLE_FORMAT
    assert bundle["manifest"]["api"] == {
        "tenant": TENANT,
        "project": "petstore",
        "version": "1.0.0",
        "revisionId": VERSION_ID,
        "published": True,
        "protocol": "openapi",
    }
    assert bundle["spec"] == SPEC
    assert bundle["manifestDigest"] == manifest_digest(bundle["manifest"])
    assert verify_bundle(bundle, runtime_version="0.2.0", secret="s3cret").ok


def test_export_is_deterministic_across_calls(client: TestClient) -> None:
    first = _get(client, secret="s3cret").json()
    second = _get(client, secret="s3cret").json()
    assert first == second
    assert first["manifestDigest"] == second["manifestDigest"]


def test_export_drops_hosted_only_and_credential_settings(client: TestClient) -> None:
    bundle = _get(client).json()
    assert set(bundle["settings"]) == {"scenarios", "chaos"}
    assert "mode" not in bundle["settings"]
    headers = bundle["settings"]["scenarios"]["quota-exceeded"]["operations"]["GET /pets"]["responses"][0][
        "headers"
    ]
    assert headers == {"Retry-After": "60"}
    assert bundle["manifest"]["redactions"] == [
        "/scenarios/quota-exceeded/operations/GET ~1pets/responses/0/headers/Authorization"
    ]


def test_export_is_unsigned_when_no_secret_is_configured(client: TestClient) -> None:
    bundle = _get(client, secret=None).json()
    assert bundle["signature"] is None
    assert verify_bundle(bundle, runtime_version="0.2.0").ok


def test_export_advertises_a_download_filename(client: TestClient) -> None:
    response = _get(client, secret=None)
    assert response.headers["content-disposition"] == 'attachment; filename="petstore-1.0.0-mock-bundle.json"'


def test_export_filename_strips_unsafe_characters(client: TestClient) -> None:
    row = _version_row()
    row["version_id"] = '1.0.0"; drop\n'
    response = _get(client, row=row, secret=None)
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="petstore-1.0.0___drop_-mock-bundle.json"'
    )


def test_export_requires_mock_enabled(client: TestClient) -> None:
    response = _get(client, row=_version_row(mock_enabled=False))
    assert response.status_code == 409
    assert "not enabled" in response.json()["detail"]


def test_export_404s_for_an_unknown_version(client: TestClient) -> None:
    with patch("app.versions_routes.db.get_version_by_id", return_value=None), patch(
        "app.versions_routes.enforce_permission"
    ):
        assert client.get(_URL).status_code == 404


def test_export_404s_when_the_version_belongs_to_another_project(client: TestClient) -> None:
    row = _version_row()
    row["project_id"] = "other-project"
    with patch("app.versions_routes.db.get_version_by_id", return_value=row), patch(
        "app.versions_routes.enforce_permission"
    ):
        assert client.get(_URL).status_code == 404


def test_export_enforces_the_versions_view_permission(client: TestClient) -> None:
    from app.permissions import Action, Resource

    with patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()), patch(
        "app.versions_routes._generated_spec_for_version", return_value=SPEC
    ), patch("app.versions_routes.enforce_permission") as enforce:
        client.get(_URL)

    resource, action = enforce.call_args[0][2], enforce.call_args[0][3]
    assert (resource, action) == (Resource.VERSIONS, Action.VIEW)

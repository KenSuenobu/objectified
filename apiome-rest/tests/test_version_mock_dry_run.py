"""``?dryRun=true`` on the version mock-settings write routes (#5530, MSC-1.4).

``apiome mock config push --dry-run`` needs to check a committed configuration document against
the *authoritative* validators without writing, and a plain push needs to validate every section
before any of them is stored. Both are this branch. What it must guarantee is exactly two things:
nothing is written, and the response describes what a real write would have produced.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.mock_fixture_packs import PACK_FORMAT

TENANT = "acme-corp"
PROJECT_ID = "proj-1"
VERSION_ID = "ver-1"
USER_ID = "user-1"
_AUTH = {"tenant_id": "t1", "user_id": USER_ID, "auth_method": "api_key"}

BASE = f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock"
SCENARIOS_URL = f"{BASE}/scenarios"
CORRELATION_URL = f"{BASE}/correlation"
PACKS_URL = f"{BASE}/fixture-packs"

SPEC: dict[str, Any] = {
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


# --------------------------------------------------------------------------- scenarios


def test_scenarios_dry_run_writes_nothing_and_echoes_the_canonical_block(client: TestClient) -> None:
    payload = {
        "scenarios": {"outage": {"description": "Down", "operations": {}}},
        "chaos": {"default": {"delayMs": 100}},
    }
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch("app.versions_routes.db.set_version_mock_scenarios") as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(f"{SCENARIOS_URL}?dryRun=true", json=payload)

    assert resp.status_code == 200, resp.text
    set_mock.assert_not_called()
    body = resp.json()
    assert body["scenarios"]["outage"]["description"] == "Down"
    assert body["chaos"]["default"]["delayMs"] == 100


def test_scenarios_dry_run_normalizes_exactly_as_a_write_would(client: TestClient) -> None:
    """The dry run reports the *stored* form, so what it shows is what a push would produce."""
    payload = {"scenarios": {"outage": {"operations": {"get /pets/{petId}": {"responses": [{"status": 200}]}}}}}
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch("app.versions_routes.db.set_version_mock_scenarios") as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(f"{SCENARIOS_URL}?dryRun=true", json=payload)

    assert resp.status_code == 200, resp.text
    set_mock.assert_not_called()
    assert list(resp.json()["scenarios"]["outage"]["operations"]) == ["GET /pets/{petId}"]


def test_scenarios_dry_run_still_validates(client: TestClient) -> None:
    payload = {"scenarios": {"outage": {"operations": {"GET /nope": {"responses": [{"status": 200}]}}}}}
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch("app.versions_routes.db.set_version_mock_scenarios") as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(f"{SCENARIOS_URL}?dryRun=true", json=payload)

    assert resp.status_code == 422
    set_mock.assert_not_called()
    assert "no operation GET /nope exists" in resp.json()["detail"]["errors"][0]


def test_scenarios_without_the_flag_still_writes(client: TestClient) -> None:
    payload = {"scenarios": {"outage": {"description": "Down", "operations": {}}}}
    stored = {"scenarios": {"outage": {"description": "Down", "operations": {}}}}
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch(
            "app.versions_routes.db.set_version_mock_scenarios",
            return_value=_version_row(mock_settings=stored),
        ) as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(SCENARIOS_URL, json=payload)

    assert resp.status_code == 200, resp.text
    set_mock.assert_called_once()


# --------------------------------------------------------------------------- correlation


def test_correlation_dry_run_writes_nothing_and_echoes_the_canonical_block(client: TestClient) -> None:
    payload = {
        "correlation": {
            "mode": "inferred",
            "operations": {"get /pets/{petId}": {"/id": "{{request.path.petId}}"}},
        }
    }
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch("app.versions_routes.db.set_version_mock_correlation") as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(f"{CORRELATION_URL}?dryRun=true", json=payload)

    assert resp.status_code == 200, resp.text
    set_mock.assert_not_called()
    correlation = resp.json()["correlation"]
    assert correlation["mode"] == "inferred"
    assert list(correlation["operations"]) == ["GET /pets/{petId}"]


def test_correlation_dry_run_reports_a_cleared_block_as_null(client: TestClient) -> None:
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch("app.versions_routes.db.set_version_mock_correlation") as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(f"{CORRELATION_URL}?dryRun=true", json={"correlation": None})

    assert resp.status_code == 200, resp.text
    set_mock.assert_not_called()
    assert resp.json()["correlation"] is None


def test_correlation_dry_run_still_validates(client: TestClient) -> None:
    payload = {"correlation": {"mode": "off", "operations": {"GET /pets/{petId}": {"/id": "x"}}}}
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
        patch("app.versions_routes.db.set_version_mock_correlation") as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(f"{CORRELATION_URL}?dryRun=true", json=payload)

    assert resp.status_code == 422
    set_mock.assert_not_called()
    assert "would never run" in resp.json()["detail"]["errors"][0]


# --------------------------------------------------------------------------- fixture packs


def test_fixture_packs_dry_run_writes_nothing_and_echoes_the_digests(client: TestClient) -> None:
    payload = {"packs": {"smoke": {"description": "Two pets.", "collections": {"/pets": [{"id": 1}]}}}}
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes.db.set_version_mock_fixture_packs") as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(f"{PACKS_URL}?dryRun=true", json=payload)

    assert resp.status_code == 200, resp.text
    set_mock.assert_not_called()
    body = resp.json()
    assert body["packs"]["smoke"]["packFormat"] == PACK_FORMAT
    assert body["digests"]["smoke"].startswith("sha256:")


def test_fixture_packs_dry_run_still_validates(client: TestClient) -> None:
    payload = {"packs": {"smoke": {"collections": {"pets": [{"id": 1}]}}}}
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch("app.versions_routes.db.set_version_mock_fixture_packs") as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(f"{PACKS_URL}?dryRun=true", json=payload)

    assert resp.status_code == 422
    set_mock.assert_not_called()
    assert resp.json()["detail"]["errors"]


def test_dry_run_defaults_to_off_so_existing_callers_are_unaffected(client: TestClient) -> None:
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()),
        patch(
            "app.versions_routes.db.set_version_mock_fixture_packs",
            return_value=_version_row(mock_settings={"fixturePacks": {}}),
        ) as set_mock,
        patch("app.versions_routes.enforce_permission"),
    ):
        resp = client.put(PACKS_URL, json={"packs": {}})

    assert resp.status_code == 200, resp.text
    set_mock.assert_called_once()

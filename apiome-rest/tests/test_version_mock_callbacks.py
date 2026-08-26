"""Version mock callback REST route tests (#4746, PMR-2.3)."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.mock_callbacks import CALLBACK_FORMAT, callback_digest

TENANT = "acme-corp"
PROJECT_ID = "proj-1"
VERSION_ID = "ver-1"
USER_ID = "user-1"
_AUTH = {"tenant_id": "t1", "user_id": USER_ID, "auth_method": "api_key"}

URL = f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/callbacks"

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Orders", "version": "1.0.0"},
    "paths": {"/orders": {"post": {"responses": {"201": {"description": "created"}}}}},
    "components": {
        "schemas": {"OrderEvent": {"type": "object", "properties": {"id": {"type": "string"}}}}
    },
}

CALLBACKS_PAYLOAD = {
    "callbacks": {
        "order-created": {
            "description": "Notifies the consumer's webhook.",
            "trigger": {"operation": "POST /orders", "statuses": [201]},
            "destinations": ["https://hooks.example.com/orders/"],
            "request": {"method": "post", "body": {"id": "{{request.body#/id}}"}},
            "payloadSchema": {"$ref": "#/components/schemas/OrderEvent"},
            "retry": {"maxAttempts": 2, "backoffMs": 25},
        }
    }
}

STORED_CALLBACK = {
    "callbackFormat": CALLBACK_FORMAT,
    "callbackFormatVersion": 1,
    "description": "Notifies the consumer's webhook.",
    "trigger": {"operation": "POST /orders", "statuses": [201]},
    "destinations": ["https://hooks.example.com/orders"],
    "request": {"method": "POST", "body": {"id": "{{request.body#/id}}"}},
    "payloadSchema": {"$ref": "#/components/schemas/OrderEvent"},
    "retry": {"maxAttempts": 2, "backoffMs": 25},
}

STORED_SETTINGS = {"mode": "private", "callbacks": {"order-created": STORED_CALLBACK}}


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
        "project_slug": "orders",
        "metadata": None,
    }


def test_get_callbacks_returns_stored_definitions_and_digests(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings=STORED_SETTINGS),
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.get(URL)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["callbacks"]["order-created"]["destinations"] == ["https://hooks.example.com/orders"]
    assert body["callbacks"]["order-created"]["trigger"]["operation"] == "POST /orders"
    assert body["digests"]["order-created"] == callback_digest(STORED_CALLBACK)


def test_get_callbacks_empty_when_none_stored(client: TestClient) -> None:
    with patch("app.versions_routes.db.get_version_by_id", return_value=_version_row()), patch(
        "app.versions_routes.enforce_permission"
    ):
        resp = client.get(URL)
    assert resp.status_code == 200
    assert resp.json() == {"callbacks": {}, "digests": {}}


def test_get_callbacks_skips_malformed_stored_entries(client: TestClient) -> None:
    settings = {"callbacks": {"ok": STORED_CALLBACK, "broken": {"surprise": True}}}
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings=settings),
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.get(URL)
    assert resp.status_code == 200
    assert set(resp.json()["callbacks"]) == {"ok"}
    assert set(resp.json()["digests"]) == {"ok"}


def test_get_callbacks_missing_version_404(client: TestClient) -> None:
    with patch("app.versions_routes.db.get_version_by_id", return_value=None), patch(
        "app.versions_routes.enforce_permission"
    ):
        resp = client.get(URL)
    assert resp.status_code == 404


def test_put_callbacks_validates_and_persists_canonical_form(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes._generated_spec_for_version", return_value=SPEC), patch(
        "app.versions_routes.enforce_permission"
    ), patch(
        "app.versions_routes.db.set_version_mock_callbacks",
        return_value=_version_row(mock_settings=STORED_SETTINGS),
    ) as set_callbacks:
        resp = client.put(URL, json=CALLBACKS_PAYLOAD)
    assert resp.status_code == 200, resp.text

    stored = set_callbacks.call_args.kwargs["callbacks"]["order-created"]
    assert stored["callbackFormat"] == CALLBACK_FORMAT
    # The trailing slash and the lower-case method are normalized on the way in.
    assert stored["destinations"] == ["https://hooks.example.com/orders"]
    assert stored["request"]["method"] == "POST"

    body = resp.json()
    assert body["digests"]["order-created"] == callback_digest(STORED_CALLBACK)


def test_put_callbacks_rejects_a_trigger_for_an_unknown_operation_422(client: TestClient) -> None:
    payload = {
        "callbacks": {
            "cb": {
                "trigger": {"operation": "POST /nope"},
                "destinations": ["https://hooks.example.com/x"],
            }
        }
    }
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes._generated_spec_for_version", return_value=SPEC), patch(
        "app.versions_routes.enforce_permission"
    ):
        resp = client.put(URL, json=payload)
    assert resp.status_code == 422
    assert any("no operation POST /nope exists" in error for error in resp.json()["detail"]["errors"])


def test_put_callbacks_rejects_an_unsafe_destination_422(client: TestClient) -> None:
    payload = {"callbacks": {"cb": {"destinations": ["file:///etc/passwd"]}}}
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes._generated_spec_for_version", return_value=SPEC), patch(
        "app.versions_routes.enforce_permission"
    ):
        resp = client.put(URL, json=payload)
    assert resp.status_code == 422
    assert resp.json()["detail"]["errors"]


def test_put_callbacks_requires_at_least_one_destination_422(client: TestClient) -> None:
    payload = {"callbacks": {"cb": {"trigger": {"operation": "POST /orders"}}}}
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes._generated_spec_for_version", return_value=SPEC), patch(
        "app.versions_routes.enforce_permission"
    ):
        resp = client.put(URL, json=payload)
    assert resp.status_code == 422


def test_put_callbacks_rejects_unknown_keys_via_model(client: TestClient) -> None:
    payload = {"callbacks": {"cb": {"destinatoins": ["https://hooks.example.com/x"]}}}
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.put(URL, json=payload)
    assert resp.status_code == 422


def test_put_callbacks_requires_user_attribution(client: TestClient) -> None:
    app.dependency_overrides[validate_authentication] = lambda: {
        "tenant_id": "t1",
        "auth_method": "api_key",
    }
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.put(URL, json=CALLBACKS_PAYLOAD)
    assert resp.status_code == 403


def test_put_callbacks_ownership_denied_403(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes._generated_spec_for_version", return_value=SPEC), patch(
        "app.versions_routes.enforce_permission"
    ), patch("app.versions_routes.db.set_version_mock_callbacks", return_value=None):
        resp = client.put(URL, json=CALLBACKS_PAYLOAD)
    assert resp.status_code == 403


def test_put_empty_callbacks_clears(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id", return_value=_version_row()
    ), patch("app.versions_routes._generated_spec_for_version", return_value=SPEC), patch(
        "app.versions_routes.enforce_permission"
    ), patch(
        "app.versions_routes.db.set_version_mock_callbacks",
        return_value=_version_row(mock_settings={"mode": "private"}),
    ) as set_callbacks:
        resp = client.put(URL, json={"callbacks": {}})
    assert resp.status_code == 200
    assert set_callbacks.call_args.kwargs["callbacks"] == {}
    assert resp.json() == {"callbacks": {}, "digests": {}}

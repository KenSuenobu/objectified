"""Dry-run mock preview route tests (#5528, MSC-1.2).

The rendering itself lives in apiome-mock and is covered by its own suite (including a parity test
that renders one request through both the data plane and the preview). What is asserted here is the
control-plane half: who may ask, what gets sent to the runtime, that an unsaved draft is validated
and never persisted, and that every failure mode comes back as something an author can act on.
"""

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.config import settings
from app.main import app
from app.mock_preview import MockPreviewError, MockPreviewRejected, MockPreviewUnavailable
from app.permissions import Action, Resource

TENANT = "acme-corp"
PROJECT_ID = "proj-1"
VERSION_ID = "ver-preview-1"
USER_ID = "user-1"
_AUTH = {"tenant_id": "t1", "user_id": USER_ID, "auth_method": "api_key"}
ROUTE = f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/preview"

SPEC: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets/{petId}": {
            "get": {
                "operationId": "getPet",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"schema": {"type": "object"}}},
                    }
                },
            }
        }
    },
}

STORED_SETTINGS: Dict[str, Any] = {
    "mode": "private",
    "responseCorrelation": {"mode": "path-params"},
}

RUNTIME_RESULT: Dict[str, Any] = {
    "operation": "GET /pets/{petId}",
    "pathParams": {"petId": "42"},
    "status": 200,
    "headers": {"content-type": "application/json", "x-mock-correlation": "path-params"},
    "mediaType": "application/json",
    "body": {"id": 42},
    "bodyEncoding": "json",
    "trace": {
        "layer": "correlation",
        "detail": "Correlation (path-params) rewrote the GET /pets/{petId} response.",
        "scenario": None,
        "ruleIndex": None,
        "seed": 1234,
        "seedSource": "correlation",
        "correlationMode": "path-params",
        "correlationApplied": ["path-params"],
        "correlationPointers": [],
        "schemaValid": True,
        "bodySource": "synthesis",
        "exampleName": None,
    },
    "chaos": {"suppressed": False, "delayMs": 0, "jitterMs": 0, "errorRate": 0.0},
}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(settings, "mock_internal_base_url", "http://mock:8775")
    monkeypatch.setattr(settings, "mock_internal_token", "preview-token")
    monkeypatch.setattr(settings, "mock_preview_rate_limit_per_minute", 10_000)
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield TestClient(app)
    app.dependency_overrides.clear()


def _version_row(*, mock_settings: Any = None, mock_enabled: bool = True) -> Dict[str, Any]:
    return {
        "id": "11111111-1111-4111-8111-111111111111",
        "project_id": PROJECT_ID,
        "creator_id": USER_ID,
        "version_id": "1.0.0",
        "published": True,
        "mock_enabled": mock_enabled,
        "mock_settings": STORED_SETTINGS if mock_settings is None else mock_settings,
        "project_slug": "petstore",
        "metadata": None,
    }


@pytest.fixture
def rendering():
    """Patch the runtime hop, returning the AsyncMock so a test can inspect what was sent."""
    sender = AsyncMock(return_value=dict(RUNTIME_RESULT))
    with patch("app.versions_routes.request_mock_preview", new=sender):
        yield sender


@pytest.fixture
def version(request: pytest.FixtureRequest):
    """Patch the version read, permissions, and spec generation for one preview call."""
    row = getattr(request, "param", None) or _version_row()
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=row),
        patch("app.versions_routes.enforce_permission") as permission,
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
    ):
        yield permission


# ==================================================================================================
# The happy path
# ==================================================================================================


def test_previews_the_stored_settings(client: TestClient, version: Any, rendering: AsyncMock) -> None:
    response = client.post(ROUTE, json={"request": {"method": "GET", "path": "/pets/42"}})

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["operation"] == "GET /pets/{petId}"
    assert payload["body"] == {"id": 42}
    assert payload["trace"]["layer"] == "correlation"
    assert payload["trace"]["correlationMode"] == "path-params"
    assert payload["draft"] is False

    sent = rendering.await_args.kwargs
    assert sent["request"]["path"] == "/pets/42"
    assert sent["bundle"]["settings"]["responseCorrelation"] == {"mode": "path-params"}
    assert sent["bundle"]["spec"]["info"]["title"] == "Pet Store"


def test_the_bundle_carries_only_the_behaviour_keys(
    client: TestClient, version: Any, rendering: AsyncMock
) -> None:
    """The private-mock ``mode`` is hosted access control and has no meaning in a render."""
    client.post(ROUTE, json={"request": {"path": "/pets/42"}})
    assert "mode" not in rendering.await_args.kwargs["bundle"]["settings"]


def test_previews_a_version_whose_mock_is_disabled(client: TestClient, rendering: AsyncMock) -> None:
    """Nothing about serving access is involved, so a disabled mock still previews."""
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row(mock_enabled=False)),
        patch("app.versions_routes.enforce_permission"),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
    ):
        response = client.post(ROUTE, json={"request": {"path": "/pets/42"}})

    assert response.status_code == 200, response.text


def test_an_omitted_request_defaults_to_the_version_root(
    client: TestClient, version: Any, rendering: AsyncMock
) -> None:
    response = client.post(ROUTE, json={})
    assert response.status_code == 200, response.text
    assert rendering.await_args.kwargs["request"]["path"] == "/"


def test_unknown_version_is_a_404(client: TestClient, rendering: AsyncMock) -> None:
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=None),
        patch("app.versions_routes.enforce_permission"),
    ):
        response = client.post(ROUTE, json={"request": {"path": "/pets/42"}})
    assert response.status_code == 404


# ==================================================================================================
# Draft settings
# ==================================================================================================


DRAFT = {
    "settings": {
        "correlation": {
            "mode": "explicit",
            "operations": {"GET /pets/{petId}": {"/id": "{{request.path.petId}}"}},
        }
    },
    "request": {"path": "/pets/42"},
}


def test_a_draft_override_is_rendered_without_being_saved(
    client: TestClient, version: Any, rendering: AsyncMock
) -> None:
    with patch("app.versions_routes.db.set_version_mock_correlation") as writer:
        response = client.post(ROUTE, json=DRAFT)

    assert response.status_code == 200, response.text
    assert response.json()["draft"] is True
    sent_settings = rendering.await_args.kwargs["bundle"]["settings"]
    assert sent_settings["responseCorrelation"]["mode"] == "explicit"
    writer.assert_not_called()


def test_a_draft_override_requires_edit(client: TestClient, version: Any, rendering: AsyncMock) -> None:
    client.post(ROUTE, json=DRAFT)
    demanded = {(call.args[2], call.args[3]) for call in version.call_args_list}
    assert (Resource.VERSIONS, Action.EDIT) in demanded


def test_previewing_stored_settings_only_needs_view(
    client: TestClient, version: Any, rendering: AsyncMock
) -> None:
    client.post(ROUTE, json={"request": {"path": "/pets/42"}})
    demanded = {(call.args[2], call.args[3]) for call in version.call_args_list}
    assert demanded == {(Resource.VERSIONS, Action.VIEW)}


def test_a_draft_keeps_the_settings_keys_it_does_not_declare(
    client: TestClient, rendering: AsyncMock
) -> None:
    """Overlay, not replacement: previewing a new correlation block keeps the stored scenarios."""
    stored = {
        "scenarios": {"quiet": {"operations": {}}},
        "responseCorrelation": {"mode": "path-params"},
    }
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=_version_row(mock_settings=stored)),
        patch("app.versions_routes.enforce_permission"),
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
    ):
        client.post(ROUTE, json=DRAFT)

    sent = rendering.await_args.kwargs["bundle"]["settings"]
    assert sent["responseCorrelation"]["mode"] == "explicit"
    assert "quiet" in sent["scenarios"]


def test_a_draft_that_could_never_be_saved_is_a_422(
    client: TestClient, version: Any, rendering: AsyncMock
) -> None:
    """The same validation the save route applies, so a broken draft is not a silent no-op."""
    response = client.post(
        ROUTE,
        json={
            "settings": {
                "correlation": {
                    "mode": "explicit",
                    "operations": {"GET /nope": {"/id": "{{request.path.petId}}"}},
                }
            }
        },
    )

    assert response.status_code == 422, response.text
    errors = response.json()["detail"]["errors"]
    assert any("no operation" in error.lower() for error in errors)
    rendering.assert_not_awaited()


# ==================================================================================================
# Guardrails
# ==================================================================================================


def test_an_oversized_request_body_is_refused(client: TestClient, version: Any, rendering: AsyncMock) -> None:
    response = client.post(
        ROUTE,
        json={"request": {"method": "POST", "path": "/pets/42", "body": {"blob": "x" * 300_000}}},
    )
    assert response.status_code == 413
    rendering.assert_not_awaited()


def test_the_per_version_rate_limit_applies(
    client: TestClient, version: Any, rendering: AsyncMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "mock_preview_rate_limit_per_minute", 2)
    from app.versions_routes import _mock_preview_limiter

    _mock_preview_limiter._windows.clear()

    statuses = [client.post(ROUTE, json={"request": {"path": "/pets/42"}}).status_code for _ in range(3)]
    assert statuses == [200, 200, 429]


def test_preview_fails_closed_when_the_deployment_has_no_runtime_configured(
    client: TestClient, version: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "mock_internal_base_url", "")
    response = client.post(ROUTE, json={"request": {"path": "/pets/42"}})
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]


def test_a_runtime_refusal_is_forwarded_with_its_own_reason(client: TestClient, version: Any) -> None:
    problems = {"error": "bundle failed verification", "problems": [{"code": "digest-mismatch"}]}
    sender = AsyncMock(side_effect=MockPreviewRejected(422, problems))
    with patch("app.versions_routes.request_mock_preview", new=sender):
        response = client.post(ROUTE, json={"request": {"path": "/pets/42"}})

    assert response.status_code == 422
    assert response.json()["detail"]["problems"][0]["code"] == "digest-mismatch"


def test_a_rejected_service_token_is_not_shown_to_the_caller(client: TestClient, version: Any) -> None:
    """The caller is authenticated; a bad *service* token is a deployment fault, not their business."""
    sender = AsyncMock(side_effect=MockPreviewRejected(403, "Internal service token is not valid."))
    with patch("app.versions_routes.request_mock_preview", new=sender):
        response = client.post(ROUTE, json={"request": {"path": "/pets/42"}})

    assert response.status_code == 502
    assert "token" not in response.json()["detail"].lower()


def test_an_unreachable_runtime_is_a_502(client: TestClient, version: Any) -> None:
    sender = AsyncMock(side_effect=MockPreviewError("connection refused"))
    with patch("app.versions_routes.request_mock_preview", new=sender):
        response = client.post(ROUTE, json={"request": {"path": "/pets/42"}})

    assert response.status_code == 502
    assert "connection refused" in response.json()["detail"]


def test_an_unavailable_runtime_is_a_503(client: TestClient, version: Any) -> None:
    sender = AsyncMock(side_effect=MockPreviewUnavailable("not configured"))
    with patch("app.versions_routes.request_mock_preview", new=sender):
        response = client.post(ROUTE, json={"request": {"path": "/pets/42"}})

    assert response.status_code == 503

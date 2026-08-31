"""Endpoint tests for the Mock Server management + data planes (#3615; folded by #5532).

Since MSC-2.2 the data plane resolves nothing: it enforces the sandbox's lifecycle (existence,
expiry, rate limit), projects the request, forwards it to apiome-mock, and rebuilds what came back.
These tests therefore stub the hop and assert *this* service's half — what it sends, what it does
with the answer, and what it does when the engine is unreachable. What the engine decides is tested
in apiome-mock, against the real serving path.
"""

import base64
import json
from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from unittest.mock import patch

import pytest
from app.auth import validate_authentication
from app.main import app
from app.mock_sandbox import MockSandboxError, MockSandboxRejected
from fastapi.testclient import TestClient

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}

TENANT = "acme"
MOCK_ID = "00000000-0000-0000-0000-0000000000aa"

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "operationId": "listPets",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "array",
                                    "items": {"$ref": "#/components/schemas/Pet"},
                                    "minItems": 1,
                                }
                            }
                        },
                    }
                },
            }
        },
        "/pets/{petId}": {
            "get": {
                "operationId": "getPet",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}
                        },
                    }
                },
            }
        },
    },
    "components": {
        "schemas": {
            "Pet": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
            }
        }
    },
}


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_authentication] = lambda: _MOCK_AUTH
    yield
    app.dependency_overrides.clear()


def _instance_row(**overrides):
    """A representative apiome.mock_instances row as returned by RealDictCursor."""
    row = {
        "id": MOCK_ID,
        "tenant_id": "t1",
        "version_id": "v1",
        "tenant_slug": TENANT,
        "project_slug": "petstore",
        "version_slug": "1.0.0",
        "name": "petstore mock",
        "spec": SPEC,
        "config": {"scenarios": [], "active_scenario": "happy-path", "seed": 0},
        "settings": {},
        "migration_notes": [],
        "rate_limit_per_minute": 60,
        "status": "active",
        "created_by": "u1",
        "request_count": 0,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=24),
        "last_activity_at": None,
    }
    row.update(overrides)
    return row


def _served(
    status: int = 200,
    body: Any = None,
    *,
    encoding: str = "json",
    operation: str | None = "GET /pets/{petId}",
    scenario: str | None = None,
    schema_valid: bool | None = True,
    headers: Dict[str, str] | None = None,
) -> Dict[str, Any]:
    """A payload shaped like apiome-mock's ``/__sandbox__`` answer."""
    return {
        "status": status,
        "headers": headers if headers is not None else {"content-type": "application/json"},
        "mediaType": "application/json",
        "body": body if body is not None else {"id": 1, "name": "Rex"},
        "bodyEncoding": encoding,
        "operation": operation,
        "scenario": scenario,
        "schemaValid": schema_valid,
    }


class _Sandbox:
    """Stand-in for the sandbox hop that records what the data plane sent it."""

    def __init__(self, result: Dict[str, Any] | Exception) -> None:
        self.result = result
        self.calls: List[Dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> Dict[str, Any]:
        self.calls.append(kwargs)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@contextmanager
def _serving(result: Dict[str, Any] | Exception):
    """Run the data plane against a stubbed, configured mock engine.

    Args:
        result: The payload the engine answers with, or the error the hop raises.

    Yields:
        The stub, whose ``calls`` record what the data plane forwarded.
    """
    sandbox = _Sandbox(result)
    with ExitStack() as stack:
        stack.enter_context(patch("app.mock_routes.sandbox_is_configured", return_value=True))
        stack.enter_context(patch("app.mock_routes.request_sandbox_serve", sandbox))
        stack.enter_context(patch("app.mock_routes.db.touch_mock_instance"))
        yield sandbox


# --------------------------------------------------------------------------- #
# Management plane
# --------------------------------------------------------------------------- #


def test_provision_returns_base_url_and_metadata():
    version = {
        "id": "v1",
        "version_id": "1.0.0",
        "published": True,
        "project_description": "pets",
        "metadata": None,
        "project_metadata": None,
    }
    captured = {}

    def _create(**kwargs):
        captured.update(kwargs)
        return _instance_row(
            spec=kwargs["spec"],
            config=kwargs["config"],
            rate_limit_per_minute=kwargs["rate_limit_per_minute"],
            expires_at=kwargs["expires_at"],
        )

    with patch("app.mock_routes.db.get_version_by_slugs", return_value=version), patch(
        "app.mock_routes._build_spec_for_version", return_value=SPEC
    ), patch("app.mock_routes.db.create_mock_instance", side_effect=_create):
        r = client.post(
            f"/v1/mocks/{TENANT}",
            json={"projectSlug": "petstore", "versionSlug": "1.0.0", "ttlHours": 12},
        )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["baseUrl"].endswith(f"/v1/mock/{MOCK_ID}")
    assert body["operationCount"] == 2
    assert body["activeScenario"] == "happy-path"
    assert "server-error" in body["scenarios"]
    # TTL was honoured and frozen spec was passed through.
    assert captured["spec"] == SPEC


def test_provision_rejects_unpublished_version():
    version = {"id": "v1", "version_id": "1.0.0", "published": False}
    with patch("app.mock_routes.db.get_version_by_slugs", return_value=version):
        r = client.post(
            f"/v1/mocks/{TENANT}",
            json={"projectSlug": "petstore", "versionSlug": "1.0.0"},
        )
    assert r.status_code == 400


def test_provision_404_for_missing_version():
    with patch("app.mock_routes.db.get_version_by_slugs", return_value=None):
        r = client.post(
            f"/v1/mocks/{TENANT}",
            json={"projectSlug": "nope", "versionSlug": "9.9.9"},
        )
    assert r.status_code == 404


def test_provision_rejects_unknown_active_scenario():
    version = {"id": "v1", "version_id": "1.0.0", "published": True}
    with patch("app.mock_routes.db.get_version_by_slugs", return_value=version), patch(
        "app.mock_routes._build_spec_for_version", return_value=SPEC
    ):
        r = client.post(
            f"/v1/mocks/{TENANT}",
            json={
                "projectSlug": "petstore",
                "versionSlug": "1.0.0",
                "activeScenario": "ghost",
            },
        )
    assert r.status_code == 400


def test_list_mocks():
    with patch("app.mock_routes.db.list_mock_instances", return_value=[_instance_row()]):
        r = client.get(f"/v1/mocks/{TENANT}")
    assert r.status_code == 200
    assert r.json()[0]["id"] == MOCK_ID


def test_get_mock_detail_and_404():
    with patch("app.mock_routes.db.get_mock_instance_for_tenant", return_value=_instance_row()):
        r = client.get(f"/v1/mocks/{TENANT}/{MOCK_ID}")
    assert r.status_code == 200
    with patch("app.mock_routes.db.get_mock_instance_for_tenant", return_value=None):
        r = client.get(f"/v1/mocks/{TENANT}/{MOCK_ID}")
    assert r.status_code == 404


def test_switch_active_scenario():
    """The switch lands on ``activeScenario`` — the key MSC-2.1 built, now the only spelling."""
    updated = _instance_row(settings={"activeScenario": "server-error"})
    captured = {}

    def _update(mock_id, tenant_id, settings):
        captured["settings"] = settings
        return updated

    with patch(
        "app.mock_routes.db.get_mock_instance_for_tenant", return_value=_instance_row()
    ), patch("app.mock_routes.db.update_mock_instance_settings", side_effect=_update):
        r = client.put(
            f"/v1/mocks/{TENANT}/{MOCK_ID}/active-scenario",
            json={"activeScenario": "server-error"},
        )
    assert r.status_code == 200
    assert r.json()["activeScenario"] == "server-error"
    assert captured["settings"]["activeScenario"] == "server-error"


def test_switch_unknown_scenario_rejected():
    with patch(
        "app.mock_routes.db.get_mock_instance_for_tenant", return_value=_instance_row()
    ):
        r = client.put(
            f"/v1/mocks/{TENANT}/{MOCK_ID}/active-scenario",
            json={"activeScenario": "ghost"},
        )
    assert r.status_code == 400


def test_destroy_mock():
    with patch("app.mock_routes.db.delete_mock_instance", return_value=True):
        r = client.delete(f"/v1/mocks/{TENANT}/{MOCK_ID}")
    assert r.status_code == 204
    with patch("app.mock_routes.db.delete_mock_instance", return_value=False):
        r = client.delete(f"/v1/mocks/{TENANT}/{MOCK_ID}")
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# Data plane
# --------------------------------------------------------------------------- #


def test_data_plane_forwards_the_request_to_the_one_engine():
    """The data plane decides nothing: it projects the request and returns what the engine served."""
    mid = "00000000-0000-0000-0000-0000000000b1"
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(_served()) as sandbox:
            r = client.get(f"/v1/mock/{mid}/pets/7?limit=2&limit=3")

    assert r.status_code == 200
    assert r.json() == {"id": 1, "name": "Rex"}
    assert r.headers["X-Mock-Operation"] == "GET /pets/{petId}"
    assert r.headers["X-Mock-Matched"] == "true"

    forwarded = sandbox.calls[0]
    assert forwarded["sandbox_id"] == mid
    assert forwarded["request"]["method"] == "GET"
    assert forwarded["request"]["path"] == "/pets/7"
    # Repeated query parameters survive the hop as a list, so a predicate reading them agrees
    # with what the caller actually sent.
    assert forwarded["request"]["query"] == {"limit": ["2", "3"]}
    # The bundle carries the frozen spec, so the engine serves the version as provisioned.
    assert forwarded["bundle"]["spec"] == SPEC


def test_data_plane_forwards_the_request_body():
    mid = "00000000-0000-0000-0000-0000000000b9"
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(_served(status=201, operation="POST /pets")) as sandbox:
            r = client.post(f"/v1/mock/{mid}/pets", json={"name": "Nym"})

    assert r.status_code == 201
    assert json.loads(sandbox.calls[0]["request"]["body"]) == {"name": "Nym"}


def test_data_plane_refuses_a_body_larger_than_the_hop_will_carry(monkeypatch):
    """The engine reads a body only for predicates and templates; a huge one would be carried to be ignored."""
    mid = "00000000-0000-0000-0000-0000000000c2"
    monkeypatch.setattr("app.mock_routes.settings.mock_sandbox_max_body_bytes", 16)
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(_served()) as sandbox:
            r = client.post(f"/v1/mock/{mid}/pets", content=b"x" * 32)

    assert r.status_code == 413
    assert sandbox.calls == []


def test_data_plane_does_not_forward_this_connections_framing_headers():
    """`host` names a server the engine is not, and `content-length` describes a re-encoded body."""
    mid = "00000000-0000-0000-0000-0000000000c3"
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(_served(operation="POST /pets")) as sandbox:
            client.post(f"/v1/mock/{mid}/pets", json={"name": "Nym"})

    forwarded = sandbox.calls[0]["request"]["headers"]
    assert "host" not in forwarded
    assert "content-length" not in forwarded
    # Everything the mock might actually read still travels.
    assert forwarded["content-type"] == "application/json"


def test_data_plane_carries_the_instance_seed():
    """apiome-mock takes a seed per request, so a stored one has to ride along on every call."""
    mid = "00000000-0000-0000-0000-0000000000ba"
    row = _instance_row(id=mid, config={"scenarios": [], "active_scenario": "happy-path", "seed": 99})
    with patch("app.mock_routes.db.get_mock_instance", return_value=row):
        with _serving(_served()) as sandbox:
            client.get(f"/v1/mock/{mid}/pets")

    assert sandbox.calls[0]["request"]["seed"] == 99


def test_data_plane_rebuilds_a_text_body_and_drops_framing_headers():
    mid = "00000000-0000-0000-0000-0000000000bb"
    served = _served(
        body="plain",
        encoding="text",
        headers={"content-type": "text/plain", "content-length": "999", "X-Mock-Scenario": "slow"},
    )
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(served):
            r = client.get(f"/v1/mock/{mid}/pets")

    assert r.text == "plain"
    assert r.headers["X-Mock-Scenario"] == "slow"
    # The engine's content-length described its own encoding of the body, not ours.
    assert r.headers["content-length"] == str(len(b"plain"))


def test_data_plane_rebuilds_an_empty_body():
    mid = "00000000-0000-0000-0000-0000000000bc"
    served = _served(status=204, body=None, encoding="empty", operation="DELETE /pets/{petId}")
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(served):
            r = client.delete(f"/v1/mock/{mid}/pets/1")

    assert r.status_code == 204
    assert r.content == b""


def test_data_plane_rebuilds_a_binary_body():
    mid = "00000000-0000-0000-0000-0000000000bd"
    served = _served(body=base64.b64encode(b"\x00\xff").decode(), encoding="base64")
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(served):
            r = client.get(f"/v1/mock/{mid}/pets")

    assert r.content == b"\x00\xff"


def test_data_plane_reports_an_unmatched_operation():
    mid = "00000000-0000-0000-0000-0000000000b3"
    served = _served(status=404, operation=None, schema_valid=None, body={"title": "Not Found"})
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(served):
            r = client.get(f"/v1/mock/{mid}/widgets")

    assert r.status_code == 404
    assert r.headers["X-Mock-Matched"] == "false"
    assert "X-Mock-Operation" not in r.headers


def test_data_plane_missing_instance_404():
    with patch("app.mock_routes.db.get_mock_instance", return_value=None):
        r = client.get("/v1/mock/00000000-0000-0000-0000-0000000000b4/pets")
    assert r.status_code == 404


def test_data_plane_expired_returns_410():
    mid = "00000000-0000-0000-0000-0000000000b5"
    expired = _instance_row(
        id=mid, expires_at=datetime.now(timezone.utc) - timedelta(hours=1)
    )
    with patch("app.mock_routes.db.get_mock_instance", return_value=expired):
        r = client.get(f"/v1/mock/{mid}/pets")
    assert r.status_code == 410


def test_data_plane_forwards_the_scenario_header():
    """Scenario selection is the engine's decision; this plane only has to carry the header."""
    mid = "00000000-0000-0000-0000-0000000000b6"
    served = _served(status=500, scenario="server-error", body={"error": {"code": "internal_error"}})
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(served) as sandbox:
            r = client.get(f"/v1/mock/{mid}/pets/1", headers={"X-Mock-Scenario": "server-error"})

    assert r.status_code == 500
    headers = sandbox.calls[0]["request"]["headers"]
    assert headers["x-mock-scenario"] == "server-error"


def test_data_plane_per_instance_rate_limit():
    """The rate limit is the sandbox's, so it is enforced before the request ever leaves."""
    mid = "00000000-0000-0000-0000-0000000000b7"
    row = _instance_row(id=mid, rate_limit_per_minute=2)
    with patch("app.mock_routes.db.get_mock_instance", return_value=row):
        with _serving(_served(operation="GET /pets")) as sandbox:
            statuses = [client.get(f"/v1/mock/{mid}/pets").status_code for _ in range(3)]

    assert statuses == [200, 200, 429]
    assert len(sandbox.calls) == 2


def test_data_plane_without_a_configured_engine_is_503():
    """There is no local engine to fall back to, and pretending otherwise is the failure MSC-2.2 removes."""
    mid = "00000000-0000-0000-0000-0000000000be"
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)), patch(
        "app.mock_routes.sandbox_is_configured", return_value=False
    ):
        r = client.get(f"/v1/mock/{mid}/pets")

    assert r.status_code == 503
    assert "APIOME_MOCK_INTERNAL_BASE_URL" in r.json()["detail"]


def test_data_plane_unreachable_engine_is_502():
    mid = "00000000-0000-0000-0000-0000000000bf"
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(MockSandboxError("connection refused")):
            r = client.get(f"/v1/mock/{mid}/pets")

    assert r.status_code == 502


def test_data_plane_forwards_a_refusal_about_the_callers_payload():
    mid = "00000000-0000-0000-0000-0000000000c0"
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(MockSandboxRejected(422, "too many headers")):
            r = client.get(f"/v1/mock/{mid}/pets")

    assert r.status_code == 422
    assert r.json()["detail"] == "too many headers"


def test_data_plane_hides_a_deployment_side_refusal():
    """A rejected service token is nothing the caller can act on, so it must not be shown."""
    mid = "00000000-0000-0000-0000-0000000000c1"
    with patch("app.mock_routes.db.get_mock_instance", return_value=_instance_row(id=mid)):
        with _serving(MockSandboxRejected(403, "Internal service token is not valid.")):
            r = client.get(f"/v1/mock/{mid}/pets")

    assert r.status_code == 502
    assert "token" not in r.json()["detail"].lower()


def test_data_plane_respects_feature_flag(monkeypatch):
    monkeypatch.setattr("app.mock_routes.settings.mock_server_enabled", False)
    r = client.get("/v1/mock/00000000-0000-0000-0000-0000000000b8/pets")
    assert r.status_code == 404


def test_mock_usage_endpoint_returns_counters():
    with patch(
        "app.mock_routes.db.get_mock_license_limits_for_tenant",
        return_value={"mock_rps": 5.0, "mock_requests_per_month": 10_000},
    ), patch(
        "app.mock_routes.db.get_mock_monthly_usage",
        return_value=42,
    ), patch(
        "app.mock_routes.db.list_mock_usage_rollups",
        return_value=[
            {
                "usage_date": datetime(2026, 7, 8, tzinfo=timezone.utc).date(),
                "project_slug": "petstore",
                "version_label": "1.0.0",
                "request_count": 42,
            }
        ],
    ):
        r = client.get(f"/v1/mocks/{TENANT}/usage?days=7")
    assert r.status_code == 200
    body = r.json()
    assert body["monthlyRequestCount"] == 42
    assert body["monthlyQuota"] == 10_000
    assert body["mockRps"] == 5.0
    assert body["dailyRollups"][0]["requestCount"] == 42

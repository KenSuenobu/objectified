"""Integration tests for X-Mock-Scenario overrides (#4454, SIM-4.2)."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_routing import extract_operations
from fastapi.testclient import TestClient

from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.scenarios import parse_scenarios
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec

PETSTORE_SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "examples": {"sample": {"value": [{"id": 7, "name": "Rex"}]}},
                                "schema": {
                                    "type": "array",
                                    "items": {"$ref": "#/components/schemas/Pet"},
                                },
                            }
                        },
                    },
                    "429": {"description": "throttled"},
                },
            },
            "post": {
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Pet"},
                        }
                    },
                },
                "responses": {
                    "201": {
                        "description": "created",
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/Pet"},
                            }
                        },
                    }
                },
            },
        },
        "/pets/{petId}": {
            "parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "integer"}}],
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "examples": {"sample": {"value": {"id": 7, "name": "Rex"}}},
                                "schema": {"$ref": "#/components/schemas/Pet"},
                            }
                        },
                    }
                },
            },
        },
    },
    "components": {
        "schemas": {
            "Pet": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {
                    "id": {"type": "integer"},
                    "name": {"type": "string"},
                },
            },
        }
    },
}

MOCK_SETTINGS = {
    "scenarios": {
        "quota-exceeded": {
            "description": "List calls are throttled.",
            "operations": {
                "GET /pets": {
                    "responses": [
                        {
                            "status": 429,
                            "headers": {"Retry-After": "60"},
                            "body": {"error": {"code": "quota_exceeded"}},
                        }
                    ]
                }
            },
        },
        "flaky-then-ok": {
            "description": "First call fails, later calls succeed.",
            "operations": {
                "GET /pets": {
                    "responses": [
                        {"status": 503, "body": {"error": "warming up"}},
                        {"status": 200, "body": [{"id": 1, "name": "Rex"}]},
                    ]
                }
            },
        },
    }
}


def _compiled() -> CompiledSpec:
    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug="demo",
        project_slug="petstore",
        version_label="1.0.0",
        updated_at=datetime.now(timezone.utc),
        spec=PETSTORE_SPEC,
        operations=tuple(extract_operations(PETSTORE_SPEC)),
        scenarios=parse_scenarios(MOCK_SETTINGS),
    )


@pytest.fixture
def session_store() -> InMemorySessionStore:
    return InMemorySessionStore(
        SessionCaps(
            ttl_seconds=3600.0,
            max_resources=5,
            max_bytes=1_048_576,
            max_sessions=100,
        ),
    )


@pytest.fixture
def mock_client(
    monkeypatch: pytest.MonkeyPatch,
    mock_pool: object,
    session_store: InMemorySessionStore,
) -> TestClient:
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    from apiome_mock.server import create_app

    with (
        patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
        patch(
            "apiome_mock.server.resolve_limits_for_tenant",
            new=AsyncMock(return_value=None),
        ),
        patch("apiome_mock.server.record_mock_request"),
        patch(
            "apiome_mock.handler.get_mock_access_status",
            new=AsyncMock(return_value="ok"),
        ),
        patch(
            "apiome_mock.handler.load_compiled_spec",
            new=AsyncMock(return_value=_compiled()),
        ),
    ):
        app = create_app()
        with TestClient(app, raise_server_exceptions=False) as client:
            app.state.db_pool = mock_pool
            app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
            app.state.session_store = session_store
            yield client
    get_settings.cache_clear()


def test_scenario_header_returns_canned_response(mock_client: TestClient) -> None:
    response = mock_client.get(
        "/demo/petstore/1.0.0/pets",
        headers={"X-Mock-Scenario": "quota-exceeded"},
    )
    assert response.status_code == 429
    assert response.json() == {"error": {"code": "quota_exceeded"}}
    assert response.headers["Retry-After"] == "60"
    assert response.headers["X-Mock-Scenario"] == "quota-exceeded"


def test_no_header_keeps_default_behavior(mock_client: TestClient) -> None:
    response = mock_client.get("/demo/petstore/1.0.0/pets")
    assert response.status_code == 200
    assert response.json() == [{"id": 7, "name": "Rex"}]
    assert "X-Mock-Scenario" not in response.headers


def test_blank_header_treated_as_absent(mock_client: TestClient) -> None:
    response = mock_client.get(
        "/demo/petstore/1.0.0/pets",
        headers={"X-Mock-Scenario": "   "},
    )
    assert response.status_code == 200
    assert response.json() == [{"id": 7, "name": "Rex"}]


def test_unknown_scenario_returns_problem(mock_client: TestClient) -> None:
    response = mock_client.get(
        "/demo/petstore/1.0.0/pets",
        headers={"X-Mock-Scenario": "does-not-exist"},
    )
    assert response.status_code == 400
    body = response.json()
    assert body["type"].endswith("/unknown-scenario")
    # Every mock resolves the built-ins as well as whatever the version stores (#5532, MSC-2.2).
    assert body["availableScenarios"] == [
        "flaky-then-ok",
        "happy-path",
        "not-found",
        "quota-exceeded",
        "server-error",
        "slow",
    ]


def test_operation_without_override_falls_through(mock_client: TestClient) -> None:
    response = mock_client.get(
        "/demo/petstore/1.0.0/pets/7",
        headers={"X-Mock-Scenario": "quota-exceeded"},
    )
    assert response.status_code == 200
    assert response.json() == {"id": 7, "name": "Rex"}


def test_scenario_wins_over_forced_status(mock_client: TestClient) -> None:
    response = mock_client.get(
        "/demo/petstore/1.0.0/pets",
        headers={"X-Mock-Scenario": "quota-exceeded", "Prefer": "code=200"},
    )
    assert response.status_code == 429


def test_sequence_advances_per_call_and_sticks_on_last(mock_client: TestClient) -> None:
    headers = {"X-Mock-Scenario": "flaky-then-ok", "X-Mock-Session": "seq-1"}

    first = mock_client.get("/demo/petstore/1.0.0/pets", headers=headers)
    assert first.status_code == 503
    assert first.headers["X-Mock-Scenario-Call"] == "1"

    second = mock_client.get("/demo/petstore/1.0.0/pets", headers=headers)
    assert second.status_code == 200
    assert second.json() == [{"id": 1, "name": "Rex"}]
    assert second.headers["X-Mock-Scenario-Call"] == "2"

    third = mock_client.get("/demo/petstore/1.0.0/pets", headers=headers)
    assert third.status_code == 200
    assert third.headers["X-Mock-Scenario-Call"] == "3"


def test_sequence_resets_per_session(mock_client: TestClient) -> None:
    first = mock_client.get(
        "/demo/petstore/1.0.0/pets",
        headers={"X-Mock-Scenario": "flaky-then-ok", "X-Mock-Session": "seq-a"},
    )
    assert first.status_code == 503

    fresh_session = mock_client.get(
        "/demo/petstore/1.0.0/pets",
        headers={"X-Mock-Scenario": "flaky-then-ok", "X-Mock-Session": "seq-b"},
    )
    assert fresh_session.status_code == 503
    assert fresh_session.headers["X-Mock-Scenario-Call"] == "1"


def test_sequence_falls_back_to_client_ip_without_session(mock_client: TestClient) -> None:
    headers = {"X-Mock-Scenario": "flaky-then-ok"}

    first = mock_client.get("/demo/petstore/1.0.0/pets", headers=headers)
    assert first.status_code == 503

    second = mock_client.get("/demo/petstore/1.0.0/pets", headers=headers)
    assert second.status_code == 200


def test_scenario_takes_precedence_over_stateful_crud(
    mock_client: TestClient,
    session_store: InMemorySessionStore,
) -> None:
    headers = {"X-Mock-Scenario": "quota-exceeded", "X-Mock-Session": "crud-1"}
    response = mock_client.get("/demo/petstore/1.0.0/pets", headers=headers)
    assert response.status_code == 429

    # The same session still serves stateful CRUD for operations the scenario
    # does not override.
    created = mock_client.post(
        "/demo/petstore/1.0.0/pets",
        headers={"X-Mock-Session": "crud-1", "Content-Type": "application/json"},
        json={"id": 1, "name": "Fido"},
    )
    assert created.status_code == 201

"""Integration tests for declarative rules and response templates (#4744, PMR-2.1)."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_engine import extract_operations
from fastapi.testclient import TestClient

from apiome_mock.fixture_data import parse_fixtures
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
                            }
                        },
                    },
                    "429": {"description": "throttled"},
                },
            },
            "post": {
                "requestBody": {
                    "content": {"application/json": {"schema": {"type": "object"}}},
                },
                "responses": {
                    "201": {
                        "description": "created",
                        "content": {"application/json": {"schema": {"type": "object"}}},
                    }
                },
            },
        },
        "/pets/{petId}": {
            "parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "string"}}],
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "examples": {"sample": {"value": {"id": 7, "name": "Rex"}}},
                            }
                        },
                    }
                },
            },
        },
    },
}

MOCK_SETTINGS = {
    "scenarios": {
        "gold-tier": {
            "description": "Gold members get richer data; others fall back.",
            "operations": {
                "GET /pets": {
                    "rules": [
                        {
                            "when": {"header": {"x-tier": {"equals": "gold"}}},
                            "responses": [
                                {
                                    "status": 200,
                                    "body": [{"id": 1, "name": "Golden", "tier": "gold"}],
                                }
                            ],
                        },
                        {
                            "when": {"query": {"limit": {"gt": 100}}},
                            "responses": [{"status": 429, "body": {"error": "too much"}}],
                        },
                    ],
                    "responses": [{"status": 200, "body": []}],
                },
                "POST /pets": {
                    "rules": [
                        {
                            "when": {"body": {"/name": {"matches": "^R"}}},
                            "responses": [
                                {
                                    "status": 201,
                                    "body": {
                                        "id": "{{random.int(1, 1000000)}}",
                                        "name": "{{request.body#/name}}",
                                        "trace": "{{request.header.x-request-id}}",
                                    },
                                }
                            ],
                        }
                    ]
                },
            },
        },
        "templated": {
            "description": "Every pet is personalized from the request.",
            "operations": {
                "GET /pets/{petId}": {
                    "responses": [
                        {
                            "status": 200,
                            "headers": {"X-Pet": "pet-{{request.path.petId}}"},
                            "body": {
                                "id": "{{request.path.petId}}",
                                "name": "{{fixture.pets#/0/name}}",
                                "token": "{{random.hex(8)}}",
                            },
                        }
                    ]
                }
            },
        },
        "header-injection": {
            "operations": {
                "GET /pets/{petId}": {
                    "responses": [
                        {
                            "status": 200,
                            "headers": {"X-Echo": "{{request.query.evil}}"},
                            "body": {},
                        }
                    ]
                }
            },
        },
        "big-output": {
            "operations": {"GET /pets": {"responses": [{"status": 200, "body": "{{fixture.big}}"}]}},
        },
    },
    "fixtures": {
        "pets": [{"name": "Ada"}, {"name": "Rex"}],
        "big": "x" * 400_000,
    },
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
        fixtures=parse_fixtures(MOCK_SETTINGS),
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


BASE = "/demo/petstore/1.0.0"


# ---------------------------------------------------------------------------
# Rule matching
# ---------------------------------------------------------------------------


def test_first_matching_rule_wins(mock_client: TestClient) -> None:
    response = mock_client.get(
        f"{BASE}/pets",
        headers={"X-Mock-Scenario": "gold-tier", "X-Tier": "gold"},
    )
    assert response.status_code == 200
    assert response.json() == [{"id": 1, "name": "Golden", "tier": "gold"}]
    assert response.headers["X-Mock-Scenario-Rule"] == "1"


def test_later_rule_matches_when_earlier_does_not(mock_client: TestClient) -> None:
    response = mock_client.get(
        f"{BASE}/pets?limit=500",
        headers={"X-Mock-Scenario": "gold-tier"},
    )
    assert response.status_code == 429
    assert response.json() == {"error": "too much"}
    assert response.headers["X-Mock-Scenario-Rule"] == "2"


def test_fallback_responses_serve_when_no_rule_matches(mock_client: TestClient) -> None:
    response = mock_client.get(
        f"{BASE}/pets?limit=5",
        headers={"X-Mock-Scenario": "gold-tier"},
    )
    assert response.status_code == 200
    assert response.json() == []
    assert "X-Mock-Scenario-Rule" not in response.headers


def test_no_rule_and_no_fallback_falls_through_to_default_flow(mock_client: TestClient) -> None:
    # POST /pets has one body-predicated rule and no fallback: a non-matching
    # body must fall through to the spec-driven mock (201 with the schema body).
    response = mock_client.post(
        f"{BASE}/pets",
        json={"name": "Ada"},
        headers={"X-Mock-Scenario": "gold-tier"},
    )
    assert response.status_code == 201
    assert "X-Mock-Scenario-Rule" not in response.headers


def test_body_predicate_selects_rule(mock_client: TestClient) -> None:
    response = mock_client.post(
        f"{BASE}/pets",
        json={"name": "Rex"},
        headers={"X-Mock-Scenario": "gold-tier", "X-Request-Id": "req-9"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Rex"
    assert body["trace"] == "req-9"
    assert isinstance(body["id"], int)


# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------


def test_templates_render_request_fields_and_fixtures(mock_client: TestClient) -> None:
    response = mock_client.get(
        f"{BASE}/pets/42",
        headers={"X-Mock-Scenario": "templated"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "42"
    assert body["name"] == "Ada"
    assert len(body["token"]) == 8
    assert response.headers["X-Pet"] == "pet-42"


def test_seeded_templates_are_deterministic(mock_client: TestClient) -> None:
    first = mock_client.get(f"{BASE}/pets/42?__seed=7", headers={"X-Mock-Scenario": "templated"})
    second = mock_client.get(f"{BASE}/pets/42?__seed=7", headers={"X-Mock-Scenario": "templated"})
    other = mock_client.get(f"{BASE}/pets/42?__seed=8", headers={"X-Mock-Scenario": "templated"})
    assert first.json() == second.json()
    assert first.json()["token"] != other.json()["token"]


def test_rendered_headers_cannot_inject_crlf(mock_client: TestClient) -> None:
    response = mock_client.get(
        f"{BASE}/pets/42?evil=a%0d%0aSet-Cookie:%20pwn",
        headers={"X-Mock-Scenario": "header-injection"},
    )
    assert response.status_code == 200
    assert "X-Echo" not in response.headers
    assert "set-cookie" not in response.headers


def test_output_limit_returns_problem_response(mock_client: TestClient) -> None:
    response = mock_client.get(f"{BASE}/pets", headers={"X-Mock-Scenario": "big-output"})
    assert response.status_code == 500
    body = response.json()
    assert body["type"].endswith("/template-limits-exceeded")
    assert "render limits" in body["detail"]


def test_scenarios_without_new_features_behave_as_before(mock_client: TestClient) -> None:
    response = mock_client.get(f"{BASE}/pets")
    assert response.status_code == 200
    assert response.json() == [{"id": 7, "name": "Rex"}]

"""Integration tests for latency/chaos injection (#4455, SIM-4.3)."""

from __future__ import annotations

import random
import time
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_routing import extract_operations
from fastapi.testclient import TestClient

from apiome_mock.chaos import parse_chaos
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.scenarios import parse_scenarios
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec

SPEC = {
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
                    "500": {
                        "description": "boom",
                        "content": {
                            "application/json": {
                                "examples": {"sample": {"value": {"error": "internal"}}},
                            }
                        },
                    },
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
                            }
                        },
                    }
                },
            },
        },
    },
}

# GET /pets defines a 500 with an example; GET /pets/{petId} defines no 5xx at
# all (its injected error must fall back to problem+json).
MOCK_SETTINGS = {
    "chaos": {
        "default": {"delayMs": 0, "jitterMs": 0, "errorRate": 0},
        "operations": {},
    },
    "scenarios": {
        "degraded": {
            "description": "Everything is slow and broken.",
            "operations": {},
            "chaos": {"default": {"errorRate": 100}},
        },
        "calm": {
            "description": "Chaos switched off for triage.",
            "operations": {},
            "chaos": {},
        },
        "throttled": {
            "description": "Canned 429 plus version chaos.",
            "operations": {"GET /pets": {"responses": [{"status": 429, "body": {"error": "slow down"}}]}},
        },
    },
}


def _compiled(mock_settings: dict) -> CompiledSpec:
    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug="demo",
        project_slug="petstore",
        version_label="1.0.0",
        updated_at=datetime.now(timezone.utc),
        spec=SPEC,
        operations=tuple(extract_operations(SPEC)),
        scenarios=parse_scenarios(mock_settings),
        chaos=parse_chaos(mock_settings),
    )


def _settings_with_chaos(chaos: dict) -> dict:
    return {**MOCK_SETTINGS, "chaos": chaos}


@pytest.fixture
def make_client(monkeypatch: pytest.MonkeyPatch, mock_pool: object):
    """Yield a factory building a TestClient over given mock_settings."""
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    from apiome_mock.server import create_app

    stack: list = []

    def _make(mock_settings: dict) -> TestClient:
        patches = [
            patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
            patch("apiome_mock.server.resolve_limits_for_tenant", new=AsyncMock(return_value=None)),
            patch("apiome_mock.server.record_mock_request"),
            patch("apiome_mock.handler.get_mock_access_status", new=AsyncMock(return_value="ok")),
            patch(
                "apiome_mock.handler.load_compiled_spec",
                new=AsyncMock(return_value=_compiled(mock_settings)),
            ),
        ]
        for item in patches:
            item.start()
            stack.append(item)
        app = create_app()
        client = TestClient(app, raise_server_exceptions=False)
        client.__enter__()
        stack.append(client)
        app.state.db_pool = mock_pool
        app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
        app.state.session_store = InMemorySessionStore(
            SessionCaps(ttl_seconds=3600.0, max_resources=5, max_bytes=1_048_576, max_sessions=100),
        )
        return client

    yield _make

    for item in reversed(stack):
        if isinstance(item, TestClient):
            item.__exit__(None, None, None)
        else:
            item.stop()
    get_settings.cache_clear()


def test_zeroed_config_keeps_default_behavior(make_client) -> None:
    client = make_client(MOCK_SETTINGS)
    response = client.get("/demo/petstore/1.0.0/pets")
    assert response.status_code == 200
    assert response.json() == [{"id": 7, "name": "Rex"}]
    assert "X-Mock-Chaos" not in response.headers
    assert "X-Mock-Chaos-Delay-Ms" not in response.headers


def test_configured_delay_is_applied_and_reported(make_client) -> None:
    client = make_client(_settings_with_chaos({"default": {"delayMs": 60}}))
    start = time.monotonic()
    response = client.get("/demo/petstore/1.0.0/pets")
    elapsed = time.monotonic() - start
    assert response.status_code == 200
    assert response.headers["X-Mock-Chaos-Delay-Ms"] == "60"
    assert elapsed >= 0.06


def test_delay_with_jitter_stays_in_band(make_client) -> None:
    client = make_client(_settings_with_chaos({"default": {"delayMs": 40, "jitterMs": 20}}))
    for _ in range(5):
        response = client.get("/demo/petstore/1.0.0/pets")
        applied = int(response.headers["X-Mock-Chaos-Delay-Ms"])
        assert 20 <= applied <= 60


def test_error_rate_100_uses_spec_defined_5xx(make_client) -> None:
    client = make_client(_settings_with_chaos({"default": {"errorRate": 100}}))
    response = client.get("/demo/petstore/1.0.0/pets")
    assert response.status_code == 500
    assert response.json() == {"error": "internal"}
    assert response.headers["X-Mock-Chaos"] == "error"


def test_error_rate_100_falls_back_to_problem_json(make_client) -> None:
    client = make_client(_settings_with_chaos({"default": {"errorRate": 100}}))
    response = client.get("/demo/petstore/1.0.0/pets/7")
    assert response.status_code == 500
    body = response.json()
    assert body["type"].endswith("/chaos-injected-error")
    assert body["chaosInjected"] is True
    assert response.headers["X-Mock-Chaos"] == "error"
    assert response.headers["content-type"].startswith("application/problem+json")


def test_error_rate_statistically_honored(make_client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("apiome_mock.chaos._rng", random.Random(1234))
    client = make_client(_settings_with_chaos({"default": {"errorRate": 40}}))
    statuses = [client.get("/demo/petstore/1.0.0/pets").status_code for _ in range(200)]
    injected = sum(1 for status in statuses if status == 500)
    assert 55 <= injected <= 105  # ~80 expected at 40%
    assert all(status in (200, 500) for status in statuses)


def test_per_route_override_wins_over_default(make_client) -> None:
    client = make_client(
        _settings_with_chaos(
            {
                "default": {"errorRate": 100},
                "operations": {"GET /pets": {"errorRate": 0}},
            }
        )
    )
    listed = client.get("/demo/petstore/1.0.0/pets")
    assert listed.status_code == 200
    fetched = client.get("/demo/petstore/1.0.0/pets/7")
    assert fetched.status_code == 500


def test_scenario_scoped_chaos_only_applies_with_header(make_client) -> None:
    client = make_client(MOCK_SETTINGS)
    without = client.get("/demo/petstore/1.0.0/pets")
    assert without.status_code == 200
    degraded = client.get(
        "/demo/petstore/1.0.0/pets",
        headers={"X-Mock-Scenario": "degraded"},
    )
    assert degraded.status_code == 500
    assert degraded.headers["X-Mock-Chaos"] == "error"


def test_scenario_with_empty_chaos_disables_version_chaos(make_client) -> None:
    settings = _settings_with_chaos({"default": {"errorRate": 100}})
    client = make_client(settings)
    assert client.get("/demo/petstore/1.0.0/pets").status_code == 500
    calm = client.get(
        "/demo/petstore/1.0.0/pets",
        headers={"X-Mock-Scenario": "calm"},
    )
    assert calm.status_code == 200


def test_scenario_canned_response_wins_over_error_injection_and_is_delayed(make_client) -> None:
    settings = _settings_with_chaos({"default": {"delayMs": 30, "errorRate": 100}})
    client = make_client(settings)
    response = client.get(
        "/demo/petstore/1.0.0/pets",
        headers={"X-Mock-Scenario": "throttled"},
    )
    assert response.status_code == 429
    assert response.json() == {"error": "slow down"}
    assert response.headers["X-Mock-Chaos-Delay-Ms"] == "30"
    assert "X-Mock-Chaos" not in response.headers


def test_forced_status_bypasses_error_injection_but_keeps_delay(make_client) -> None:
    client = make_client(_settings_with_chaos({"default": {"delayMs": 20, "errorRate": 100}}))
    response = client.get(
        "/demo/petstore/1.0.0/pets",
        headers={"Prefer": "code=200"},
    )
    assert response.status_code == 200
    assert "X-Mock-Chaos" not in response.headers
    assert response.headers["X-Mock-Chaos-Delay-Ms"] == "20"


def test_unmatched_route_is_not_delayed(make_client) -> None:
    client = make_client(_settings_with_chaos({"default": {"delayMs": 40, "errorRate": 100}}))
    response = client.get("/demo/petstore/1.0.0/nowhere")
    assert response.status_code == 404
    assert "X-Mock-Chaos-Delay-Ms" not in response.headers

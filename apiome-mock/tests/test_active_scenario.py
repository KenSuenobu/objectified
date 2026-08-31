"""The version's stored active scenario in the hosted data plane (#5531, MSC-2.1).

The control plane has been able to store and switch a mock's active scenario for a long time; the
hosted runtime only ever read the ``X-Mock-Scenario`` request header, so the control changed
nothing where it mattered. These tests pin the behaviour that closes that gap:

* precedence — request header, then stored ``activeScenario``, then no scenario at all;
* leniency — a stored name that no longer resolves warns and serves the default flow, because an
  unresolvable default must never be able to take a serving mock down;
* observability — a response names the scenario that was in effect, even for an operation the
  scenario does not override, so a caller who sent no header can tell what answered them.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any, Callable, Iterator
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_routing import extract_operations
from fastapi.testclient import TestClient

from apiome_mock.chaos import parse_chaos
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.scenarios import parse_active_scenario, parse_scenarios
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec

PETSTORE_SPEC: dict[str, Any] = {
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
                                "schema": {"type": "array", "items": {"$ref": "#/components/schemas/Pet"}},
                            }
                        },
                    },
                    "429": {"description": "throttled"},
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
                "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
            },
        }
    },
}

#: Two scenarios that only override ``GET /pets``, so ``GET /pets/{petId}`` exercises the
#: "a scenario is active but does not cover this operation" path.
BASE_SETTINGS: dict[str, Any] = {
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
        "server-error": {
            "description": "Listing always fails.",
            "operations": {"GET /pets": {"responses": [{"status": 429, "body": {"error": {"code": "boom"}}}]}},
        },
        "slow": {
            "description": "A small, bounded injected delay on listing.",
            "chaos": {"operations": {"GET /pets": {"delayMs": 5}}},
            "operations": {},
        },
    }
}


def settings_with(active_scenario: str | None) -> dict[str, Any]:
    """Return the base mock settings, optionally nominating an active scenario.

    Args:
        active_scenario: The value to store under ``activeScenario``; ``None`` stores nothing.

    Returns:
        A fresh settings mapping (never shared between tests).
    """
    settings = copy.deepcopy(BASE_SETTINGS)
    if active_scenario is not None:
        settings["activeScenario"] = active_scenario
    return settings


def compiled_for(settings: dict[str, Any]) -> CompiledSpec:
    """Compile the petstore spec with the given ``mock_settings``, exactly as the loader would."""
    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug="demo",
        project_slug="petstore",
        version_label="1.0.0",
        updated_at=datetime.now(timezone.utc),
        spec=PETSTORE_SPEC,
        operations=tuple(extract_operations(PETSTORE_SPEC)),
        scenarios=parse_scenarios(settings),
        active_scenario=parse_active_scenario(settings),
        chaos=parse_chaos(settings),
    )


@pytest.fixture
def client_for(monkeypatch: pytest.MonkeyPatch, mock_pool: object) -> Iterator[Callable[[dict[str, Any]], TestClient]]:
    """Yield a factory building a hosted mock client over a given ``mock_settings`` blob."""
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    from apiome_mock.server import create_app

    exit_stack: list[Any] = []

    def build(settings: dict[str, Any]) -> TestClient:
        patches = [
            patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
            patch("apiome_mock.server.resolve_limits_for_tenant", new=AsyncMock(return_value=None)),
            patch("apiome_mock.server.record_mock_request"),
            patch("apiome_mock.handler.get_mock_access_status", new=AsyncMock(return_value="ok")),
            patch(
                "apiome_mock.handler.load_compiled_spec",
                new=AsyncMock(return_value=compiled_for(settings)),
            ),
        ]
        for entry in patches:
            entry.start()
            exit_stack.append(entry)
        app = create_app()
        client = TestClient(app, raise_server_exceptions=False)
        client.__enter__()
        exit_stack.append(client)
        app.state.db_pool = mock_pool
        app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
        app.state.session_store = InMemorySessionStore(
            SessionCaps(ttl_seconds=3600.0, max_resources=5, max_bytes=1_048_576, max_sessions=100),
        )
        return client

    yield build

    for entry in reversed(exit_stack):
        if isinstance(entry, TestClient):
            entry.__exit__(None, None, None)
        else:
            entry.stop()
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# The acceptance criteria
# ---------------------------------------------------------------------------


def test_stored_active_scenario_serves_its_overrides(client_for: Callable[..., TestClient]) -> None:
    """With activeScenario set and no request header, the mock serves that scenario."""
    client = client_for(settings_with("quota-exceeded"))
    response = client.get("/demo/petstore/1.0.0/pets")
    assert response.status_code == 429
    assert response.json() == {"error": {"code": "quota_exceeded"}}
    assert response.headers["Retry-After"] == "60"
    assert response.headers["X-Mock-Scenario"] == "quota-exceeded"


def test_request_header_overrides_the_stored_value(client_for: Callable[..., TestClient]) -> None:
    """The X-Mock-Scenario header stays an outright override of the stored default."""
    client = client_for(settings_with("quota-exceeded"))
    response = client.get("/demo/petstore/1.0.0/pets", headers={"X-Mock-Scenario": "server-error"})
    assert response.status_code == 429
    assert response.json() == {"error": {"code": "boom"}}
    assert response.headers["X-Mock-Scenario"] == "server-error"


def test_blank_header_falls_back_to_the_stored_value(client_for: Callable[..., TestClient]) -> None:
    """A blank header reads as absent, so the stored default still applies."""
    client = client_for(settings_with("quota-exceeded"))
    response = client.get("/demo/petstore/1.0.0/pets", headers={"X-Mock-Scenario": "   "})
    assert response.status_code == 429
    assert response.headers["X-Mock-Scenario"] == "quota-exceeded"


def test_no_stored_value_and_no_header_is_unchanged(client_for: Callable[..., TestClient]) -> None:
    """With neither, behaviour is exactly what it was before this feature existed."""
    client = client_for(settings_with(None))
    response = client.get("/demo/petstore/1.0.0/pets")
    assert response.status_code == 200
    assert response.json() == [{"id": 7, "name": "Rex"}]
    assert "X-Mock-Scenario" not in response.headers


def test_unknown_stored_scenario_is_ignored_not_fatal(client_for: Callable[..., TestClient]) -> None:
    """A stored name that no longer resolves serves the default flow and keeps the mock up."""
    client = client_for(settings_with("deleted-last-week"))
    response = client.get("/demo/petstore/1.0.0/pets")
    assert response.status_code == 200
    assert response.json() == [{"id": 7, "name": "Rex"}]
    assert "X-Mock-Scenario" not in response.headers


def test_unknown_stored_scenario_logs_a_warning(client_for: Callable[..., TestClient]) -> None:
    """The ignored default is reported, so an operator can see why nothing changed."""
    client = client_for(settings_with("deleted-last-week"))
    with patch("apiome_mock.handler._log.warning") as warning:
        assert client.get("/demo/petstore/1.0.0/pets").status_code == 200
    assert warning.call_count == 1
    event, kwargs = warning.call_args[0][0], warning.call_args[1]
    assert event == "mock_active_scenario_unknown"
    assert kwargs["active_scenario"] == "deleted-last-week"
    # The built-ins are always defined too (#5532, MSC-2.2); this fixture's own `server-error`
    # and `slow` shadow theirs.
    assert kwargs["available"] == [
        "happy-path",
        "not-found",
        "quota-exceeded",
        "server-error",
        "slow",
    ]


def test_unknown_header_scenario_is_still_refused(client_for: Callable[..., TestClient]) -> None:
    """Leniency belongs to the stored default only: an explicit header still gets a problem."""
    client = client_for(settings_with("quota-exceeded"))
    response = client.get("/demo/petstore/1.0.0/pets", headers={"X-Mock-Scenario": "nope"})
    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/problem+json")


def test_response_names_the_active_scenario_on_a_default_flow_body(
    client_for: Callable[..., TestClient],
) -> None:
    """An operation the active scenario does not override still names the scenario in effect."""
    client = client_for(settings_with("quota-exceeded"))
    response = client.get("/demo/petstore/1.0.0/pets/7")
    assert response.status_code == 200
    assert response.json() == {"id": 7, "name": "Rex"}
    assert response.headers["X-Mock-Scenario"] == "quota-exceeded"


def test_stored_scenario_chaos_applies(client_for: Callable[..., TestClient]) -> None:
    """A scenario-scoped chaos block applies when the scenario came from configuration."""
    client = client_for(settings_with("slow"))
    response = client.get("/demo/petstore/1.0.0/pets")
    assert response.status_code == 200
    assert response.headers["X-Mock-Chaos-Delay-Ms"] == "5"
    assert response.headers["X-Mock-Scenario"] == "slow"


def test_scenario_sequences_still_advance_from_a_stored_default(
    client_for: Callable[..., TestClient],
) -> None:
    """Sequence bookkeeping does not care where the scenario came from."""
    settings = settings_with("flaky")
    settings["scenarios"]["flaky"] = {
        "description": "First call fails, later calls succeed.",
        "operations": {
            "GET /pets": {
                "responses": [
                    {"status": 429, "body": {"error": "warming up"}},
                    {"status": 200, "body": [{"id": 1, "name": "Rex"}]},
                ]
            }
        },
    }
    client = client_for(settings)
    headers = {"X-Mock-Session": "active-scenario-sequence"}
    first = client.get("/demo/petstore/1.0.0/pets", headers=headers)
    second = client.get("/demo/petstore/1.0.0/pets", headers=headers)
    assert (first.status_code, first.headers["X-Mock-Scenario-Call"]) == (429, "1")
    assert (second.status_code, second.headers["X-Mock-Scenario-Call"]) == (200, "2")


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("settings", "expected"),
    [
        pytest.param(None, None, id="no-settings"),
        pytest.param({}, None, id="no-key"),
        pytest.param({"activeScenario": "outage"}, "outage", id="plain"),
        pytest.param({"activeScenario": "  outage  "}, "outage", id="trimmed"),
        pytest.param({"activeScenario": "   "}, None, id="blank"),
        pytest.param({"activeScenario": ""}, None, id="empty"),
        pytest.param({"activeScenario": 7}, None, id="not-a-string"),
        pytest.param({"activeScenario": None}, None, id="explicit-null"),
        pytest.param({"activeScenario": ["outage"]}, None, id="wrong-shape"),
        pytest.param('{"activeScenario": "outage"}', "outage", id="json-text"),
        pytest.param("{not json", None, id="malformed-json-text"),
        pytest.param(["activeScenario"], None, id="not-a-mapping"),
    ],
)
def test_parse_active_scenario(settings: Any, expected: str | None) -> None:
    """Parsing is lenient in every direction: nothing here may raise."""
    assert parse_active_scenario(settings) == expected


def test_active_scenario_does_not_disturb_scenario_parsing() -> None:
    """The sibling key is not mistaken for a scenario definition."""
    settings = settings_with("quota-exceeded")
    assert sorted(parse_scenarios(settings)) == [
        "happy-path",
        "not-found",
        "quota-exceeded",
        "server-error",
        "slow",
    ]

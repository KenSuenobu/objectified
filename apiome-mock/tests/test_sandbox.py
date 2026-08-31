"""Serving hosted sandboxes through the one engine, and its internal endpoint (#5532, MSC-2.2).

The point of the fold is that a sandbox is answered by the *same* function as everything else, so
the central test here sends one request twice — once to the public data plane and once to
``/__sandbox__`` — and asserts the answers agree. The rest covers what a sandbox does that a
preview deliberately does not (apply chaos, keep session state, isolate one sandbox from another)
and the endpoint's token gate.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Callable, Iterator
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_bundle import BundleIdentity, build_bundle
from app.mock_routing import extract_operations
from fastapi.testclient import TestClient

from apiome_mock.chaos import parse_chaos
from apiome_mock.correlation import parse_response_correlation
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.sandbox import SandboxSessionStores, serve_sandbox_request
from apiome_mock.sandbox_routes import INTERNAL_TOKEN_HEADER, SANDBOX_PATH
from apiome_mock.scenarios import parse_active_scenario, parse_scenarios
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec
from apiome_mock.synthetic import SyntheticRequest

TENANT = "demo"
PROJECT = "petstore"
VERSION = "1.0.0"
TOKEN = "sandbox-token-for-tests"

_PET = {
    "type": "object",
    "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
    "required": ["id", "name"],
}

SPEC: dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Sandbox Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "operationId": "listPets",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {"type": "array", "items": _PET},
                                "example": [{"id": 1, "name": "Rex"}],
                            }
                        },
                    }
                },
            },
            "post": {
                "operationId": "createPet",
                "requestBody": {"content": {"application/json": {"schema": _PET}}},
                "responses": {"201": {"description": "created", "content": {"application/json": {"schema": _PET}}}},
            },
        },
        "/pets/{petId}": {
            "get": {
                "operationId": "getPet",
                "parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "integer"}}],
                "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": _PET}}}},
            },
            "delete": {
                "operationId": "deletePet",
                "parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "integer"}}],
                "responses": {"204": {"description": "gone"}},
            },
        },
    },
}

REVISION_ID = str(uuid4())


def _compiled(settings: dict[str, Any]) -> CompiledSpec:
    """Compile a settings blob the way the hosted loader would."""
    return CompiledSpec(
        revision_id=uuid4(),
        spec=SPEC,
        operations=tuple(extract_operations(SPEC)),
        updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        tenant_slug=TENANT,
        project_slug=PROJECT,
        version_label=VERSION,
        scenarios=parse_scenarios(settings),
        active_scenario=parse_active_scenario(settings),
        chaos=parse_chaos(settings),
        correlation=parse_response_correlation(settings),
    )


def _bundle(settings: dict[str, Any]) -> dict[str, Any]:
    """The portable bundle apiome-rest sends across the sandbox hop."""
    return build_bundle(
        identity=BundleIdentity(
            tenant=TENANT,
            project=PROJECT,
            version=VERSION,
            revision_id=REVISION_ID,
            published=True,
            protocol="openapi",
        ),
        spec=SPEC,
        mock_settings=settings,
    )


ClientFactory = Callable[[dict[str, Any]], Any]


@pytest.fixture
def serving(monkeypatch: pytest.MonkeyPatch, mock_pool: Any) -> Iterator[ClientFactory]:
    """A hosted-runtime client for one ``mock_settings`` blob (only spec resolution is stubbed)."""
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.setenv("APIOME_MOCK_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("APIOME_MOCK_INTERNAL_TOKEN", TOKEN)
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()

    @contextmanager
    def build(settings: dict[str, Any]) -> Iterator[TestClient]:
        from apiome_mock.server import create_app

        with (
            patch("apiome_mock.server.create_async_pool", return_value=mock_pool),
            patch("apiome_mock.server.resolve_limits_for_tenant", new=AsyncMock(return_value=None)),
            patch("apiome_mock.server.record_mock_request"),
            patch("apiome_mock.handler.get_mock_access_status", new=AsyncMock(return_value="ok")),
            patch(
                "apiome_mock.handler.load_compiled_spec",
                new=AsyncMock(return_value=_compiled(settings)),
            ),
        ):
            app = create_app()
            with TestClient(app, raise_server_exceptions=False) as client:
                app.state.db_pool = mock_pool
                app.state.spec_cache = SpecCache(max_entries=8, ttl_seconds=300.0)
                app.state.session_store = InMemorySessionStore(
                    SessionCaps(
                        ttl_seconds=3600.0,
                        max_resources=50,
                        max_bytes=1_048_576,
                        max_sessions=100,
                    )
                )
                yield client

    yield build
    get_settings.cache_clear()


def _serve(client: TestClient, settings: dict[str, Any], request: dict[str, Any]) -> Any:
    """POST one request to the internal sandbox endpoint."""
    return client.post(
        SANDBOX_PATH,
        json={"sandbox": "sandbox-1", "bundle": _bundle(settings), "request": request},
        headers={INTERNAL_TOKEN_HEADER: TOKEN},
    )


# ==================================================================================================
# One engine: the sandbox answers exactly as the data plane does
# ==================================================================================================


def test_a_sandbox_answers_a_request_exactly_as_the_data_plane_does(serving: ClientFactory) -> None:
    """The acceptance criterion: one resolution path serves every mock request."""
    with serving({}) as client:
        live = client.get(f"/{TENANT}/{PROJECT}/{VERSION}/pets")
        served = _serve(client, {}, {"method": "GET", "path": "/pets"})

    assert served.status_code == 200, served.text
    result = served.json()
    assert result["status"] == live.status_code
    assert result["body"] == live.json()
    assert result["operation"] == "GET /pets"
    assert result["mediaType"] == "application/json"


def test_a_sandbox_serves_the_built_in_scenarios_the_retired_engine_shipped(
    serving: ClientFactory,
) -> None:
    """`server-error` and friends must keep working by name after the fold (#5532)."""
    with serving({}) as client:
        served = _serve(client, {}, {"method": "GET", "path": "/pets", "scenario": "server-error"})

    result = served.json()
    assert result["status"] == 500
    assert result["body"] == {"error": {"code": "internal_error", "message": "Simulated server error."}}
    assert result["scenario"] == "server-error"


def test_a_sandbox_honours_a_stored_active_scenario(serving: ClientFactory) -> None:
    """The migrated `active_scenario` lands on `activeScenario` and applies with no header."""
    settings = {"activeScenario": "not-found"}
    with serving(settings) as client:
        served = _serve(client, settings, {"method": "GET", "path": "/pets"})

    result = served.json()
    assert result["status"] == 404
    assert result["scenario"] == "not-found"


def test_a_sandbox_gets_the_features_the_retired_engine_never_had(serving: ClientFactory) -> None:
    """Templates and predicates now reach sandboxes, which is the point of folding them in."""
    settings = {
        "scenarios": {
            "echo": {
                "operations": {
                    "GET /pets/{petId}": {
                        "rules": [
                            {
                                "when": {"query": {"mode": {"equals": "echo"}}},
                                "responses": [{"status": 200, "body": {"id": 7, "name": "{{request.path.petId}}"}}],
                            }
                        ]
                    }
                }
            }
        }
    }
    with serving(settings) as client:
        served = _serve(
            client,
            settings,
            {"method": "GET", "path": "/pets/42", "query": {"mode": "echo"}, "scenario": "echo"},
        )

    assert served.json()["body"] == {"id": 7, "name": "42"}


def test_a_status_pin_serves_the_specs_body_for_that_status(serving: ClientFactory) -> None:
    """What a migrated status-only rule folds to: pin the status, let the spec supply the body."""
    settings = {"scenarios": {"pinned": {"operations": {"GET /pets": {"status": 200}}}}}
    with serving(settings) as client:
        served = _serve(client, settings, {"method": "GET", "path": "/pets", "scenario": "pinned"})

    result = served.json()
    assert result["status"] == 200
    assert result["body"] == [{"id": 1, "name": "Rex"}]


def test_a_canned_response_wins_over_a_status_pin_on_the_same_operation(
    serving: ClientFactory,
) -> None:
    """The pin is the weakest layer, so an author's explicit response is never shadowed by it."""
    settings = {
        "scenarios": {
            "pinned": {
                "operations": {"GET /pets": {"status": 503, "responses": [{"status": 429, "body": {"slow": 1}}]}}
            }
        }
    }
    with serving(settings) as client:
        served = _serve(client, settings, {"method": "GET", "path": "/pets", "scenario": "pinned"})

    assert served.json()["status"] == 429


def test_a_sandbox_applies_chaos_rather_than_reporting_it(serving: ClientFactory) -> None:
    """A preview suppresses injected latency; a sandbox is real traffic, so it sleeps."""
    settings = {"chaos": {"default": {"delayMs": 120}}}
    with serving(settings) as client:
        started = time.perf_counter()
        served = _serve(client, settings, {"method": "GET", "path": "/pets"})
        elapsed_ms = (time.perf_counter() - started) * 1000

    assert served.status_code == 200
    assert elapsed_ms >= 100
    assert served.json()["headers"]["x-mock-chaos-delay-ms"] == "120"


def test_a_sandbox_reports_the_matched_operation_and_schema_validity(
    serving: ClientFactory,
) -> None:
    """The calling service rebuilds its own X-Mock-* headers and request log from these."""
    with serving({}) as client:
        matched = _serve(client, {}, {"method": "GET", "path": "/pets/7"}).json()
        missed = _serve(client, {}, {"method": "GET", "path": "/unicorns"}).json()

    assert matched["operation"] == "GET /pets/{petId}"
    assert matched["schemaValid"] is True
    assert missed["operation"] is None
    assert missed["status"] == 404


# ==================================================================================================
# Session state: kept for the sandbox's life, and never shared between sandboxes
# ==================================================================================================


def _served_in(stores: SandboxSessionStores, sandbox_id: str, request: SyntheticRequest) -> Any:
    """Serve one sandbox request synchronously, the way the rest of the suite drives coroutines."""
    return asyncio.run(serve_sandbox_request(_compiled({}), request, session_store=stores.for_sandbox(sandbox_id)))


def test_session_state_survives_between_requests_to_one_sandbox() -> None:
    """Stateful CRUD is one of the features the retired engine never had; it has to persist."""
    stores = SandboxSessionStores()
    headers = {"X-Mock-Session": "s-1"}

    created = _served_in(
        stores,
        "a",
        SyntheticRequest(method="POST", path="/pets", headers=headers, body={"id": 42, "name": "Kit"}),
    )
    listed = _served_in(stores, "a", SyntheticRequest(method="GET", path="/pets", headers=headers))

    assert created.status == 201
    assert created.body["name"] == "Kit"
    assert listed.body == [created.body]


def test_session_state_does_not_leak_between_sandboxes() -> None:
    """Two sandboxes frozen from the same version share API coordinates, and nothing else."""
    stores = SandboxSessionStores()
    headers = {"X-Mock-Session": "s-1"}

    _served_in(
        stores,
        "a",
        SyntheticRequest(method="POST", path="/pets", headers=headers, body={"id": 42, "name": "Kit"}),
    )
    other = _served_in(stores, "b", SyntheticRequest(method="GET", path="/pets", headers=headers))

    # Sandbox "b" never saw the create, so its own session is empty.
    assert other.body == []


def test_the_store_registry_evicts_least_recently_served_sandboxes() -> None:
    stores = SandboxSessionStores(limit=2)
    first = stores.for_sandbox("a")
    stores.for_sandbox("b")
    stores.for_sandbox("a")  # "a" is used again, so "b" becomes the eviction candidate
    stores.for_sandbox("c")

    assert len(stores) == 2
    assert stores.for_sandbox("a") is first


def test_forgetting_a_sandbox_drops_its_state() -> None:
    stores = SandboxSessionStores()
    stores.for_sandbox("a")
    stores.forget("a")
    stores.forget("never-existed")
    assert len(stores) == 0


# ==================================================================================================
# The token gate
# ==================================================================================================


def test_the_endpoint_refuses_an_unauthenticated_caller(serving: ClientFactory) -> None:
    with serving({}) as client:
        response = client.post(SANDBOX_PATH, json={"sandbox": "s", "bundle": _bundle({}), "request": {}})
    assert response.status_code == 401


def test_the_endpoint_refuses_a_wrong_token(serving: ClientFactory) -> None:
    with serving({}) as client:
        response = client.post(
            SANDBOX_PATH,
            json={"sandbox": "s", "bundle": _bundle({}), "request": {}},
            headers={INTERNAL_TOKEN_HEADER: "not-the-token"},
        )
    assert response.status_code == 403


def test_a_malformed_bundle_is_refused_with_its_problems(serving: ClientFactory) -> None:
    with serving({}) as client:
        response = client.post(
            SANDBOX_PATH,
            json={"sandbox": "s", "bundle": {"bundleFormat": "nope"}, "request": {}},
            headers={INTERNAL_TOKEN_HEADER: TOKEN},
        )
    assert response.status_code == 422
    assert response.json()["detail"]["problems"]

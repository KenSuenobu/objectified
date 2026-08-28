"""Dry-run mock preview: the shared render path and its internal endpoint (#5528, MSC-1.2).

The point of a preview is that it cannot disagree with what the mock serves, so the central test
here renders the *same* request twice — once through the hosted data plane and once through
:func:`apiome_mock.preview.render_preview` — and asserts the bodies match. The rest covers the
decision trace (which layer produced the body, and why), the promise that a preview never writes,
chaos being reported rather than applied, and the internal endpoint's token gate.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Callable, Iterator
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from app.mock_bundle import BundleIdentity, build_bundle
from app.mock_engine import extract_operations
from app.mock_template import DEFAULT_MAX_RENDER_OPS
from fastapi.testclient import TestClient

from apiome_mock.chaos import parse_chaos
from apiome_mock.correlation import parse_response_correlation
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.preview import PreviewRequest, render_preview
from apiome_mock.preview_routes import INTERNAL_TOKEN_HEADER, PREVIEW_PATH
from apiome_mock.scenarios import parse_scenarios
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec

TENANT = "demo"
PROJECT = "petstore"
VERSION = "1.0.0"
TOKEN = "preview-token-for-tests"

_PET = {
    "type": "object",
    "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
    "required": ["id", "name"],
}

SPEC: dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Preview Pet Store", "version": "1.0.0"},
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
                "responses": {
                    "201": {
                        "description": "created",
                        "content": {"application/json": {"schema": _PET}},
                    }
                },
            },
        },
        "/pets/{petId}": {
            "get": {
                "operationId": "getPet",
                "parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "integer"}}],
                # No example anywhere: the body is synthesized, which is what makes the
                # correlation pass observable (a static example would look correlated by luck).
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"schema": _PET}},
                    }
                },
            }
        },
    },
}

CORRELATED_SETTINGS: dict[str, Any] = {"responseCorrelation": {"mode": "path-params"}}


def _compiled(settings: dict[str, Any]) -> CompiledSpec:
    """Compile the test spec with one ``mock_settings`` blob, the way the hosted loader does."""
    return CompiledSpec(
        revision_id=uuid4(),
        tenant_slug=TENANT,
        project_slug=PROJECT,
        version_label=VERSION,
        updated_at=datetime.now(timezone.utc),
        spec=SPEC,
        operations=tuple(extract_operations(SPEC)),
        scenarios=parse_scenarios(settings),
        chaos=parse_chaos(settings),
        correlation=parse_response_correlation(settings),
    )


def _bundle(settings: dict[str, Any]) -> dict[str, Any]:
    """Build the portable bundle apiome-rest would post for a preview of these settings."""
    return build_bundle(
        identity=BundleIdentity(
            tenant=TENANT,
            project=PROJECT,
            version=VERSION,
            revision_id=str(uuid4()),
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
            patch("apiome_mock.handler.load_compiled_spec", new=AsyncMock(return_value=_compiled(settings))),
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


# ==================================================================================================
# The parity promise
# ==================================================================================================


def test_preview_matches_what_the_data_plane_serves_for_a_correlated_request(
    serving: ClientFactory,
) -> None:
    """The acceptance criterion: one correlated request, rendered both ways, same body."""
    with serving(CORRELATED_SETTINGS) as client:
        live = client.get(f"/{TENANT}/{PROJECT}/{VERSION}/pets/42")
        previewed = client.post(
            PREVIEW_PATH,
            json={"bundle": _bundle(CORRELATED_SETTINGS), "request": {"method": "GET", "path": "/pets/42"}},
            headers={INTERNAL_TOKEN_HEADER: TOKEN},
        )

    assert live.status_code == 200, live.text
    assert previewed.status_code == 200, previewed.text
    result = previewed.json()

    assert live.json()["id"] == 42, "correlation should have bound the path parameter"
    assert result["body"] == live.json()
    assert result["status"] == live.status_code
    assert result["mediaType"] == "application/json"
    assert result["operation"] == "GET /pets/{petId}"
    assert result["pathParams"] == {"petId": "42"}
    assert result["headers"]["x-mock-correlation"] == live.headers["x-mock-correlation"]


def test_preview_matches_the_data_plane_for_an_uncorrelated_request(serving: ClientFactory) -> None:
    """Parity is not special to correlation: the plain example-first path agrees too."""
    with serving({}) as client:
        live = client.get(f"/{TENANT}/{PROJECT}/{VERSION}/pets")
        previewed = client.post(
            PREVIEW_PATH,
            json={"bundle": _bundle({}), "request": {"path": "/pets"}},
            headers={INTERNAL_TOKEN_HEADER: TOKEN},
        )

    assert previewed.json()["body"] == live.json()
    assert previewed.json()["trace"]["layer"] == "example"


# ==================================================================================================
# The decision trace
# ==================================================================================================


def test_trace_names_correlation_and_the_pointer_it_bound() -> None:
    """An explicit binding reports the mode *and* the pointer, not just "correlation ran"."""
    settings = {
        "responseCorrelation": {
            "mode": "explicit",
            "operations": {"GET /pets/{petId}": {"/name": "pet-{{request.path.petId}}"}},
        }
    }
    result = _render(_compiled(settings), PreviewRequest(path="/pets/7"))

    assert result.trace.layer == "correlation"
    assert result.trace.correlation_mode == "explicit"
    assert list(result.trace.correlation_applied) == ["explicit"]
    assert list(result.trace.correlation_pointers) == ["/name"]
    assert result.body["name"] == "pet-7"
    assert result.trace.seed_source == "correlation"


def test_trace_names_the_matched_scenario_rule_index() -> None:
    """A scenario's matched rule is reported by its stored array index."""
    settings = {
        "scenarios": {
            "throttled": {
                "operations": {
                    "GET /pets": {
                        "rules": [
                            {
                                "when": {"query": {"page": {"equals": "1"}}},
                                "responses": [{"status": 200, "body": {"page": "first"}}],
                            },
                            {
                                "when": {"query": {"page": {"gte": 2}}},
                                "responses": [{"status": 429, "body": {"error": "slow down"}}],
                            },
                        ]
                    }
                }
            }
        }
    }
    result = _render(
        _compiled(settings),
        PreviewRequest(path="/pets?page=9", scenario="throttled"),
    )

    assert result.trace.layer == "scenario"
    assert result.trace.scenario == "throttled"
    assert result.trace.rule_index == 1
    assert result.status == 429
    assert result.body == {"error": "slow down"}


def test_trace_distinguishes_an_authored_example_from_synthesis() -> None:
    """The two default-path layers an author most needs to tell apart."""
    authored = _render(_compiled({}), PreviewRequest(path="/pets"))
    synthesized = _render(_compiled({}), PreviewRequest(path="/pets/3"))

    assert authored.trace.layer == "example"
    assert authored.trace.body_source == "example"
    assert synthesized.trace.layer == "synthesis"
    assert synthesized.trace.body_source == "synthesis"
    assert synthesized.trace.schema_valid is True


def test_trace_reports_an_unmatched_path_as_a_structured_result_not_a_missing_version() -> None:
    """A path that matches nothing is a decision, not a 404 about the version."""
    result = _render(_compiled({}), PreviewRequest(path="/unicorns"))

    assert result.trace.layer == "no-operation"
    assert result.operation is None
    assert result.status == 404
    assert "No operation" in result.trace.detail


def test_trace_reports_a_method_the_path_does_not_declare() -> None:
    result = _render(_compiled({}), PreviewRequest(method="DELETE", path="/pets"))

    assert result.trace.layer == "method-not-allowed"
    assert result.status == 405


def test_trace_reports_a_stateful_answer() -> None:
    """With a session token, session-scoped CRUD is named as the producing layer."""
    compiled = _compiled({})
    result = _render(
        compiled,
        PreviewRequest(
            method="POST",
            path="/pets",
            headers={"X-Mock-Session": "preview-session"},
            body={"id": 5, "name": "Nym"},
        ),
    )

    assert result.trace.layer == "stateful"
    assert result.status == 201
    assert result.body["name"] == "Nym"


def test_a_template_over_budget_is_a_structured_limit_result_not_a_crash() -> None:
    """A body too large to render reports the limit layer; the render itself never raises.

    Every node of a canned body costs one operation from the shared render budget, so a scenario
    response with more nodes than the budget allows is the cheapest way to reach the limit an
    author can actually hit.
    """
    over_budget = list(range(DEFAULT_MAX_RENDER_OPS + 100))
    settings = {
        "scenarios": {"huge": {"operations": {"GET /pets": {"responses": [{"status": 200, "body": over_budget}]}}}}
    }
    result = _render(_compiled(settings), PreviewRequest(path="/pets", scenario="huge"))

    assert result.trace.layer == "template-limit"
    assert "render limits" in result.trace.detail
    assert result.status == 500
    assert result.body["type"].endswith("template-limits-exceeded")


# ==================================================================================================
# Preview never writes
# ==================================================================================================


def test_preview_session_state_does_not_survive_the_call() -> None:
    """Each preview gets its own throwaway store, so nothing it writes is visible anywhere else."""
    compiled = _compiled({})
    created = _render(
        compiled,
        PreviewRequest(
            method="POST",
            path="/pets",
            headers={"X-Mock-Session": "shared-token"},
            body={"id": 11, "name": "Ghost"},
        ),
    )
    assert created.status == 201

    looked_up = _render(
        compiled,
        PreviewRequest(path="/pets/11", headers={"X-Mock-Session": "shared-token"}),
    )
    # The session layer still answers — it just answers "no such resource", because the store the
    # first preview wrote to was discarded with that call.
    assert looked_up.trace.layer == "stateful"
    assert looked_up.status == 404


def test_preview_does_not_write_to_the_deployments_session_store(serving: ClientFactory) -> None:
    """A stateful preview leaves the hosted store the live data plane uses untouched."""
    with serving({}) as client:
        store = client.app.state.session_store
        response = client.post(
            PREVIEW_PATH,
            json={
                "bundle": _bundle({}),
                "request": {
                    "method": "POST",
                    "path": "/pets",
                    "headers": {"X-Mock-Session": "hosted-token"},
                    "body": {"id": 3, "name": "Rex"},
                },
            },
            headers={INTERNAL_TOKEN_HEADER: TOKEN},
        )
        assert response.status_code == 200, response.text
        assert response.json()["trace"]["layer"] == "stateful"

        live = client.get(
            f"/{TENANT}/{PROJECT}/{VERSION}/pets/3",
            headers={"X-Mock-Session": "hosted-token"},
        )

    assert live.status_code == 404, "the preview must not have seeded the hosted session"
    assert store is not None


# ==================================================================================================
# Chaos is reported, not applied
# ==================================================================================================


def test_configured_chaos_is_reported_and_never_applied() -> None:
    """A preview answers "what body?", so it does not sleep and does not roll the error dice."""
    settings = {"chaos": {"default": {"delayMs": 5000, "jitterMs": 250, "errorRate": 100}}}
    result = _render(_compiled(settings), PreviewRequest(path="/pets"))

    assert result.chaos.suppressed is True
    assert result.chaos.delay_ms == 5000
    assert result.chaos.jitter_ms == 250
    assert result.chaos.error_rate == 100
    assert result.status == 200, "the guaranteed chaos error must not have been injected"
    assert result.trace.layer == "example"
    assert "x-mock-chaos" not in {name.lower() for name in result.headers}


def test_chaos_is_not_reported_when_none_is_configured() -> None:
    result = _render(_compiled({}), PreviewRequest(path="/pets"))
    assert result.chaos.suppressed is False


# ==================================================================================================
# Request shaping
# ==================================================================================================


def test_seed_shorthand_pins_synthesis() -> None:
    """The same seed renders the same body; a different one renders a different body."""
    compiled = _compiled({})
    first = _render(compiled, PreviewRequest(path="/pets/1", seed=7))
    again = _render(compiled, PreviewRequest(path="/pets/1", seed=7))
    other = _render(compiled, PreviewRequest(path="/pets/1", seed=8))

    assert first.body == again.body
    assert first.trace.seed == 7
    assert first.trace.seed_source == "request"
    assert first.body != other.body


def test_a_query_string_in_the_path_is_honoured() -> None:
    """A pasted URL works: the ?suffix reaches the match context as query parameters."""
    settings = {
        "scenarios": {
            "s": {
                "operations": {
                    "GET /pets": {
                        "rules": [
                            {
                                "when": {"query": {"page": {"equals": "2"}}},
                                "responses": [{"status": 200, "body": {"page": 2}}],
                            }
                        ]
                    }
                }
            }
        }
    }
    result = _render(_compiled(settings), PreviewRequest(path="/pets?page=2", scenario="s"))

    assert result.trace.layer == "scenario"
    assert result.body == {"page": 2}


def test_an_explicit_scenario_header_beats_the_shorthand() -> None:
    """The shorthand is sugar over the header and never overwrites one the caller set."""
    settings = {
        "scenarios": {
            "wins": {"operations": {"GET /pets": {"responses": [{"status": 202, "body": {"via": "header"}}]}}},
            "loses": {"operations": {"GET /pets": {"responses": [{"status": 203, "body": {"via": "sugar"}}]}}},
        }
    }
    result = _render(
        _compiled(settings),
        PreviewRequest(path="/pets", headers={"X-Mock-Scenario": "wins"}, scenario="loses"),
    )
    assert result.status == 202


# ==================================================================================================
# The internal endpoint
# ==================================================================================================


def test_endpoint_rejects_a_missing_token(serving: ClientFactory) -> None:
    with serving({}) as client:
        response = client.post(PREVIEW_PATH, json={"bundle": _bundle({})})
    assert response.status_code == 401


def test_endpoint_rejects_a_wrong_token(serving: ClientFactory) -> None:
    with serving({}) as client:
        response = client.post(
            PREVIEW_PATH,
            json={"bundle": _bundle({})},
            headers={INTERNAL_TOKEN_HEADER: "not-the-token"},
        )
    assert response.status_code == 403


def test_endpoint_is_disabled_when_no_token_is_configured(monkeypatch: pytest.MonkeyPatch, mock_pool: Any) -> None:
    """Fail closed: with no configured token the endpoint renders for nobody."""
    monkeypatch.setenv("APIOME_MOCK_DATABASE_URL", "postgresql://localhost/db")
    monkeypatch.delenv("APIOME_MOCK_INTERNAL_TOKEN", raising=False)
    from apiome_mock.settings import get_settings

    get_settings.cache_clear()
    try:
        from apiome_mock.server import create_app

        with patch("apiome_mock.server.create_async_pool", return_value=mock_pool):
            app = create_app()
            with TestClient(app, raise_server_exceptions=False) as client:
                response = client.post(
                    PREVIEW_PATH,
                    json={"bundle": _bundle({})},
                    headers={INTERNAL_TOKEN_HEADER: TOKEN},
                )
        assert response.status_code == 503
    finally:
        get_settings.cache_clear()


def test_endpoint_reports_a_tampered_bundle_structurally(serving: ClientFactory) -> None:
    """Bundle verification failures come back as the machine-readable problem list."""
    bundle = _bundle({})
    bundle["spec"]["info"]["title"] = "Tampered"
    with serving({}) as client:
        response = client.post(
            PREVIEW_PATH,
            json={"bundle": bundle, "request": {"path": "/pets"}},
            headers={INTERNAL_TOKEN_HEADER: TOKEN},
        )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert any(problem["code"] == "digest-mismatch" for problem in detail["problems"])


def test_endpoint_defaults_the_request_to_the_version_root(serving: ClientFactory) -> None:
    """Omitting the request entirely still returns a structured answer, not a 422."""
    with serving({}) as client:
        response = client.post(
            PREVIEW_PATH,
            json={"bundle": _bundle({})},
            headers={INTERNAL_TOKEN_HEADER: TOKEN},
        )

    assert response.status_code == 200, response.text
    assert response.json()["trace"]["layer"] == "no-operation"


def test_endpoint_rejects_an_over_wide_request(serving: ClientFactory) -> None:
    with serving({}) as client:
        response = client.post(
            PREVIEW_PATH,
            json={
                "bundle": _bundle({}),
                "request": {"path": "/pets", "headers": {f"X-H-{i}": "v" for i in range(200)}},
            },
            headers={INTERNAL_TOKEN_HEADER: TOKEN},
        )
    assert response.status_code == 422


def test_endpoint_renders_a_draft_configuration_the_version_has_not_saved(
    serving: ClientFactory,
) -> None:
    """The bundle is the whole configuration, so an unsaved draft previews the same way."""
    with serving({}) as client:  # stored settings: no correlation at all
        response = client.post(
            PREVIEW_PATH,
            json={
                "bundle": _bundle(CORRELATED_SETTINGS),
                "request": {"path": "/pets/99"},
            },
            headers={INTERNAL_TOKEN_HEADER: TOKEN},
        )
        stored = client.get(f"/{TENANT}/{PROJECT}/{VERSION}/pets/99")

    assert response.json()["body"]["id"] == 99
    assert response.json()["trace"]["correlationMode"] == "path-params"
    assert stored.json()["id"] != 99, "the stored configuration must be unchanged"


# ==================================================================================================
# The wire contract shared with apiome-rest
# ==================================================================================================


def test_the_request_model_matches_the_one_apiome_rest_sends() -> None:
    """Two packages, one wire shape.

    apiome-rest cannot import this package (the dependency runs the other way), so the synthetic
    request is declared twice. A field added on one side and not the other would be rejected here
    by ``extra="forbid"`` at runtime, which is a bad way to find out.
    """
    from app.models import MockPreviewRequestSpec

    from apiome_mock.preview_routes import PreviewRequestModel

    assert set(MockPreviewRequestSpec.model_fields) == set(PreviewRequestModel.model_fields)


def test_apiome_rest_can_read_the_result_this_endpoint_returns() -> None:
    """The rendered result validates against the response model REST hands its callers."""
    from app.models import VersionMockPreviewResponse

    result = _render(_compiled(CORRELATED_SETTINGS), PreviewRequest(path="/pets/42"))
    parsed = VersionMockPreviewResponse.model_validate({**result.as_dict(), "draft": False})

    assert parsed.operation == "GET /pets/{petId}"
    assert parsed.trace.layer == "correlation"
    assert parsed.trace.correlation_applied == ["path-params"]
    assert parsed.body_encoding == "json"


def _render(compiled: CompiledSpec, request: PreviewRequest) -> Any:
    """Render one preview synchronously (the engine is async; these assertions are not)."""
    import asyncio

    return asyncio.run(render_preview(compiled, request))

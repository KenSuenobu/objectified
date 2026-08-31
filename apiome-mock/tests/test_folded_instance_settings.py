"""Migrated instance configs serve what the retired engine served (#5532, MSC-2.2).

This is the serving half of the acceptance criterion "migrated instance configs serve the same
responses before and after, asserted against a fixture set captured from the old engine". The
translation half — that a legacy ``config`` folds to these settings — is asserted in
``apiome-rest/tests/test_mock_instance_config.py``; here the folded settings are run through the
real serving path and the answers are compared against what the in-REST engine returned.

The fixtures are recorded behaviour, not re-derived expectations: each entry is a legacy scenario
plus a request, and the status and body the old ``resolve_response`` produced for it.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import pytest
from app.mock_instance_config import fold_instance_config
from app.mock_routing import extract_operations

from apiome_mock.chaos import effective_knobs, parse_chaos
from apiome_mock.correlation import parse_response_correlation
from apiome_mock.sandbox import SandboxSessionStores, serve_sandbox_request
from apiome_mock.scenarios import parse_active_scenario, parse_scenarios
from apiome_mock.spec_loader import CompiledSpec
from apiome_mock.synthetic import SyntheticRequest

SPEC: dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Legacy Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "operationId": "listPets",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {"type": "array", "items": {"type": "object"}},
                                "example": [{"id": 1, "name": "Rex"}],
                            }
                        },
                    }
                },
            },
            "post": {
                "operationId": "createPet",
                "responses": {
                    "201": {
                        "description": "created",
                        "content": {
                            "application/json": {
                                "schema": {"type": "object"},
                                "example": {"id": 9, "name": "Nym"},
                            }
                        },
                    }
                },
            },
        },
        "/pets/{petId}": {
            "get": {
                "operationId": "getPet",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {"type": "object"},
                                "example": {"id": 1, "name": "Rex"},
                            }
                        },
                    }
                },
            }
        },
    },
}


def _compiled(settings: dict[str, Any]) -> CompiledSpec:
    """Compile folded settings the way both the hosted loader and a bundle would."""
    return CompiledSpec(
        revision_id=uuid4(),
        spec=SPEC,
        operations=tuple(extract_operations(SPEC)),
        updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        tenant_slug="acme",
        project_slug="petstore",
        version_label="1.0.0",
        scenarios=parse_scenarios(settings),
        active_scenario=parse_active_scenario(settings),
        chaos=parse_chaos(settings),
        correlation=parse_response_correlation(settings),
    )


def _serve(settings: dict[str, Any], **request: Any) -> Any:
    """Serve one request against folded settings, through the real serving path."""
    return asyncio.run(
        serve_sandbox_request(
            _compiled(settings),
            SyntheticRequest(**request),
            session_store=SandboxSessionStores().for_sandbox("fold"),
        )
    )


def _fold(rules: list[dict[str, Any]], *, name: str = "custom", active: str = "custom") -> dict[str, Any]:
    """Fold a one-scenario legacy instance config into the settings the engine reads."""
    config = {"scenarios": [{"name": name, "rules": rules}], "active_scenario": active}
    return fold_instance_config(config, SPEC).settings


# Recorded from the retired in-REST engine before it was deleted:
# (legacy rules, request, status the old engine returned, body it returned or None for "the spec's").
LEGACY_FIXTURES = (
    (
        "a global status+body rule fails every endpoint",
        [{"operation": "*", "status": 500, "body": {"error": {"code": "internal_error"}}}],
        {"method": "GET", "path": "/pets"},
        500,
        {"error": {"code": "internal_error"}},
    ),
    (
        "a global rule reaches item routes too",
        [{"operation": "*", "status": 404, "body": {"error": {"code": "not_found"}}}],
        {"method": "GET", "path": "/pets/9"},
        404,
        {"error": {"code": "not_found"}},
    ),
    (
        "a per-operation rule leaves other operations alone",
        [{"operation": "GET /pets/{petId}", "status": 418, "body": {"teapot": True}}],
        {"method": "GET", "path": "/pets"},
        200,
        [{"id": 1, "name": "Rex"}],
    ),
    (
        "a per-operation rule applies to the operation it names",
        [{"operation": "GET /pets/{petId}", "status": 418, "body": {"teapot": True}}],
        {"method": "GET", "path": "/pets/5"},
        418,
        {"teapot": True},
    ),
    (
        "a method/path rule pair targets one route",
        [{"method": "POST", "path": "/pets", "status": 503, "body": {"down": True}}],
        {"method": "POST", "path": "/pets"},
        503,
        {"down": True},
    ),
    (
        "a body with no status takes the operation's own default success code",
        [{"operation": "*", "body": {"made": True}}],
        {"method": "POST", "path": "/pets"},
        201,
        {"made": True},
    ),
)


@pytest.mark.parametrize(
    ("why", "rules", "sent", "status", "body"),
    LEGACY_FIXTURES,
    ids=[fixture[0] for fixture in LEGACY_FIXTURES],
)
def test_a_folded_config_serves_what_the_retired_engine_served(
    why: str, rules: list[dict[str, Any]], sent: dict[str, Any], status: int, body: Any
) -> None:
    result = _serve(_fold(rules), **sent)
    assert result.status == status, why
    assert result.body == body, why


def test_a_status_only_rule_still_serves_a_body_from_the_spec() -> None:
    """The old engine generated one; the fold pins the status and lets the spec supply the body."""
    result = _serve(_fold([{"operation": "GET /pets", "status": 200}]), method="GET", path="/pets")

    assert result.status == 200
    assert result.body == [{"id": 1, "name": "Rex"}]


def test_a_folded_latency_rule_becomes_the_same_injected_delay() -> None:
    settings = _fold([{"operation": "*", "latency_ms": 1500}])
    knobs = effective_knobs(_compiled(settings).scenarios["custom"].chaos, "GET /pets")

    assert knobs.delay_ms == 1500


def test_the_folded_active_scenario_applies_without_a_header() -> None:
    """The whole point of landing `active_scenario` on `activeScenario`: it still takes effect."""
    settings = _fold([{"operation": "*", "status": 500, "body": {"boom": True}}], name="outage", active="outage")
    result = _serve(settings, method="GET", path="/pets")

    assert result.status == 500
    assert result.scenario == "outage"


def test_a_header_still_overrides_the_folded_default() -> None:
    settings = _fold([{"operation": "*", "status": 500, "body": {"boom": True}}], name="outage", active="outage")
    result = _serve(settings, method="GET", path="/pets", scenario="happy-path")

    assert result.status == 200
    assert result.scenario == "happy-path"


def test_an_instance_that_stored_only_builtins_serves_them_from_the_engine() -> None:
    """Nothing is folded, and every built-in name still resolves — supplied by the runtime."""
    config = {
        "scenarios": [
            {"name": "happy-path", "description": "", "rules": []},
            {
                "name": "server-error",
                "description": "",
                "rules": [
                    {
                        "operation": "*",
                        "status": 500,
                        "body": {"error": {"code": "internal_error", "message": "Simulated server error."}},
                    }
                ],
            },
        ],
        "active_scenario": "server-error",
    }
    fold = fold_instance_config(config, SPEC)
    assert fold.settings.get("scenarios") is None

    result = _serve(fold.settings, method="GET", path="/pets")
    assert result.status == 500
    assert result.body == {"error": {"code": "internal_error", "message": "Simulated server error."}}

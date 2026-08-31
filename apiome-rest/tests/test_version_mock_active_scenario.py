"""The version's stored active scenario on the mock-settings routes (#5531, MSC-2.1).

The runtime is deliberately lenient with a stored ``activeScenario`` it cannot resolve — it warns
and serves the default flow rather than failing requests — so the save is the only place a name
that means nothing can be caught. These tests pin that check, the omitted-vs-null distinction that
keeps an older editor from silently clearing the setting, and the round-trip through the readers
the write path reports with.
"""

from __future__ import annotations

from typing import Any, Dict, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.mock_scenario_settings import active_scenario_from_storage, validate_active_scenario
from app.models import MockScenarioSpec

TENANT = "acme-corp"
PROJECT_ID = "proj-1"
VERSION_ID = "ver-1"
USER_ID = "user-1"
_AUTH = {"tenant_id": "t1", "user_id": USER_ID, "auth_method": "api_key"}
ROUTE = f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios"

SPEC: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {"schema": {"type": "array", "items": {"type": "object"}}}
                        },
                    },
                    "429": {"description": "throttled"},
                }
            }
        }
    },
}

SCENARIOS_PAYLOAD: Dict[str, Any] = {
    "scenarios": {
        "quota-exceeded": {
            "description": "Throttled.",
            "operations": {"GET /pets": {"responses": [{"status": 429}]}},
        }
    }
}

STORED_SETTINGS: Dict[str, Any] = {
    "mode": "private",
    "activeScenario": "quota-exceeded",
    "scenarios": {
        "quota-exceeded": {
            "description": "Throttled.",
            "operations": {"GET /pets": {"responses": [{"status": 429}]}},
        }
    },
}


@pytest.fixture
def client() -> TestClient:
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield TestClient(app)
    app.dependency_overrides.clear()


def _version_row(*, mock_settings: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "id": VERSION_ID,
        "project_id": PROJECT_ID,
        "creator_id": USER_ID,
        "version_id": "1.0.0",
        "published": True,
        "mock_enabled": True,
        "mock_settings": mock_settings if mock_settings is not None else {},
        "project_slug": "petstore",
        "metadata": None,
    }


def _put(client: TestClient, payload: Dict[str, Any], *, stored: Optional[Dict[str, Any]] = None,
         query: str = "") -> tuple[Any, Any]:
    """PUT the scenarios route over a stored settings blob, returning (response, db mock)."""
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings=stored),
    ), patch(
        "app.versions_routes._generated_spec_for_version",
        return_value=SPEC,
    ), patch(
        "app.versions_routes.db.set_version_mock_scenarios",
        return_value=_version_row(mock_settings=STORED_SETTINGS),
    ) as set_mock, patch("app.versions_routes.enforce_permission"):
        response = client.put(f"{ROUTE}{query}", json=payload)
    return response, set_mock


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def test_get_reports_the_stored_active_scenario(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings=STORED_SETTINGS),
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.get(ROUTE)
    assert resp.status_code == 200, resp.text
    assert resp.json()["activeScenario"] == "quota-exceeded"


def test_get_reports_null_when_no_active_scenario_is_stored(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings={"scenarios": {}}),
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.get(ROUTE)
    assert resp.status_code == 200
    assert resp.json()["activeScenario"] is None


def test_get_reports_null_for_a_stored_value_the_runtime_would_ignore(client: TestClient) -> None:
    """The editor reports what the runtime would apply, not what happens to be in the column."""
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings={"activeScenario": "   ", "scenarios": {}}),
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.get(ROUTE)
    assert resp.status_code == 200
    assert resp.json()["activeScenario"] is None


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


def test_put_persists_a_valid_active_scenario(client: TestClient) -> None:
    payload = {**SCENARIOS_PAYLOAD, "activeScenario": "quota-exceeded"}
    resp, set_mock = _put(client, payload)
    assert resp.status_code == 200, resp.text
    assert set_mock.call_args.kwargs["active_scenario"] == "quota-exceeded"
    assert resp.json()["activeScenario"] == "quota-exceeded"


def test_put_rejects_an_active_scenario_that_names_nothing(client: TestClient) -> None:
    payload = {**SCENARIOS_PAYLOAD, "activeScenario": "server-error"}
    resp, set_mock = _put(client, payload)
    assert resp.status_code == 422, resp.text
    errors = resp.json()["detail"]["errors"]
    assert any("activeScenario 'server-error' is not one of this version's scenarios" in e for e in errors)
    assert any("'quota-exceeded'" in e for e in errors)
    set_mock.assert_not_called()


def test_put_rejects_an_active_scenario_when_no_scenarios_are_saved(client: TestClient) -> None:
    resp, set_mock = _put(client, {"scenarios": {}, "activeScenario": "quota-exceeded"})
    assert resp.status_code == 422, resp.text
    assert any("none are defined" in e for e in resp.json()["detail"]["errors"])
    set_mock.assert_not_called()


def test_put_rejects_a_blank_active_scenario(client: TestClient) -> None:
    resp, set_mock = _put(client, {**SCENARIOS_PAYLOAD, "activeScenario": "   "})
    assert resp.status_code == 422, resp.text
    assert any("must name a scenario" in e for e in resp.json()["detail"]["errors"])
    set_mock.assert_not_called()


def test_put_with_explicit_null_clears_the_stored_value(client: TestClient) -> None:
    resp, set_mock = _put(client, {**SCENARIOS_PAYLOAD, "activeScenario": None}, stored=STORED_SETTINGS)
    assert resp.status_code == 200, resp.text
    assert set_mock.call_args.kwargs["active_scenario"] is None


def test_put_omitting_the_field_keeps_the_stored_value(client: TestClient) -> None:
    """An editor that predates the field keeps sending {scenarios, chaos}; it must not clear it."""
    resp, set_mock = _put(client, SCENARIOS_PAYLOAD, stored=STORED_SETTINGS)
    assert resp.status_code == 200, resp.text
    assert set_mock.call_args.kwargs["active_scenario"] == "quota-exceeded"


def test_put_preserving_a_value_still_validates_it(client: TestClient) -> None:
    """A preserved value is re-checked against the scenarios being saved, not waved through."""
    stored = {"activeScenario": "gone", "scenarios": {}}
    resp, set_mock = _put(client, SCENARIOS_PAYLOAD, stored=stored)
    assert resp.status_code == 422, resp.text
    assert any("activeScenario 'gone'" in e for e in resp.json()["detail"]["errors"])
    set_mock.assert_not_called()


def test_put_stores_the_trimmed_name(client: TestClient) -> None:
    """A padded name validates, so it is stored the way the runtime reads it: trimmed."""
    resp, set_mock = _put(client, {**SCENARIOS_PAYLOAD, "activeScenario": "  quota-exceeded  "})
    assert resp.status_code == 200, resp.text
    assert set_mock.call_args.kwargs["active_scenario"] == "quota-exceeded"


def test_put_accepts_the_snake_case_alias(client: TestClient) -> None:
    resp, set_mock = _put(client, {**SCENARIOS_PAYLOAD, "active_scenario": "quota-exceeded"})
    assert resp.status_code == 200, resp.text
    assert set_mock.call_args.kwargs["active_scenario"] == "quota-exceeded"


def test_dry_run_reports_the_active_scenario_without_writing(client: TestClient) -> None:
    payload = {**SCENARIOS_PAYLOAD, "activeScenario": "quota-exceeded"}
    resp, set_mock = _put(client, payload, query="?dryRun=true")
    assert resp.status_code == 200, resp.text
    assert resp.json()["activeScenario"] == "quota-exceeded"
    set_mock.assert_not_called()


def test_dry_run_rejects_an_unresolvable_active_scenario(client: TestClient) -> None:
    resp, set_mock = _put(client, {**SCENARIOS_PAYLOAD, "activeScenario": "nope"}, query="?dryRun=true")
    assert resp.status_code == 422, resp.text
    set_mock.assert_not_called()


# ---------------------------------------------------------------------------
# The validator and the storage reader on their own
# ---------------------------------------------------------------------------


def _scenario() -> MockScenarioSpec:
    return MockScenarioSpec.model_validate(
        {"operations": {"GET /pets": {"responses": [{"status": 429}]}}}
    )


def test_validate_active_scenario_accepts_none() -> None:
    assert validate_active_scenario(None, {}) == []


def test_validate_active_scenario_accepts_a_defined_name() -> None:
    assert validate_active_scenario("outage", {"outage": _scenario()}) == []


def test_validate_active_scenario_trims_before_matching() -> None:
    assert validate_active_scenario("  outage  ", {"outage": _scenario()}) == []


def test_validate_active_scenario_rejects_an_unknown_name() -> None:
    errors = validate_active_scenario("outage", {"quota": _scenario()})
    assert len(errors) == 1
    assert "'quota'" in errors[0]


@pytest.mark.parametrize(
    ("settings", "expected"),
    [
        pytest.param(None, None, id="none"),
        pytest.param({}, None, id="absent"),
        pytest.param({"activeScenario": "outage"}, "outage", id="plain"),
        pytest.param({"activeScenario": "  outage "}, "outage", id="trimmed"),
        pytest.param({"activeScenario": ""}, None, id="empty"),
        pytest.param({"activeScenario": 3}, None, id="not-a-string"),
        pytest.param('{"activeScenario": "outage"}', "outage", id="json-text"),
        pytest.param("{not json", None, id="malformed-json"),
        pytest.param([1, 2], None, id="not-a-mapping"),
    ],
)
def test_active_scenario_from_storage(settings: Any, expected: Optional[str]) -> None:
    assert active_scenario_from_storage(settings) == expected

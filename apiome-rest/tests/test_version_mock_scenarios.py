"""Version mock scenario REST route tests (#4454, SIM-4.2)."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

TENANT = "acme-corp"
PROJECT_ID = "proj-1"
VERSION_ID = "ver-1"
USER_ID = "user-1"
_AUTH = {"tenant_id": "t1", "user_id": USER_ID, "auth_method": "api_key"}

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
                                "schema": {"type": "array", "items": {"type": "object"}},
                            }
                        },
                    },
                    "429": {"description": "throttled"},
                }
            }
        }
    },
}

SCENARIOS_PAYLOAD = {
    "scenarios": {
        "quota-exceeded": {
            "description": "Throttled.",
            "operations": {
                "GET /pets": {
                    "responses": [{"status": 200, "body": [{"id": 1}]}]
                }
            },
        }
    }
}

STORED_SETTINGS = {
    "mode": "private",
    "scenarios": {
        "quota-exceeded": {
            "description": "Throttled.",
            "operations": {"GET /pets": {"responses": [{"status": 200, "body": [{"id": 1}]}]}},
        }
    },
}


@pytest.fixture
def client() -> TestClient:
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield TestClient(app)
    app.dependency_overrides.clear()


def _version_row(*, mock_settings: dict | None = None) -> dict:
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


def test_get_scenarios_returns_stored_definitions(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings=STORED_SETTINGS),
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.get(f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    scenario = body["scenarios"]["quota-exceeded"]
    assert scenario["description"] == "Throttled."
    assert scenario["operations"]["GET /pets"]["responses"][0]["status"] == 200


def test_get_scenarios_skips_malformed_entries(client: TestClient) -> None:
    settings = {
        "scenarios": {
            "ok": {"operations": {"GET /pets": {"responses": [{"status": 200}]}}},
            "broken": {"operations": {"GET /pets": {"responses": []}}},
        }
    }
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings=settings),
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.get(f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios")
    assert resp.status_code == 200
    assert set(resp.json()["scenarios"]) == {"ok"}


def test_get_scenarios_missing_version_404(client: TestClient) -> None:
    with patch("app.versions_routes.db.get_version_by_id", return_value=None), patch(
        "app.versions_routes.enforce_permission"
    ):
        resp = client.get(f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios")
    assert resp.status_code == 404


def test_put_scenarios_persists_canonical_storage(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(),
    ), patch(
        "app.versions_routes._generated_spec_for_version",
        return_value=SPEC,
    ), patch(
        "app.versions_routes.db.set_version_mock_scenarios",
        return_value=_version_row(mock_settings=STORED_SETTINGS),
    ) as set_mock, patch("app.versions_routes.enforce_permission"):
        resp = client.put(
            f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios",
            json=SCENARIOS_PAYLOAD,
        )
    assert resp.status_code == 200, resp.text
    assert set(resp.json()["scenarios"]) == {"quota-exceeded"}
    set_mock.assert_called_once()
    stored = set_mock.call_args.kwargs["scenarios"]
    assert stored["quota-exceeded"]["operations"]["GET /pets"]["responses"][0] == {
        "status": 200,
        "body": [{"id": 1}],
    }


def test_put_scenarios_normalizes_operation_keys(client: TestClient) -> None:
    payload = {
        "scenarios": {
            "s": {"operations": {"get /pets": {"responses": [{"status": 429}]}}}
        }
    }
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(),
    ), patch(
        "app.versions_routes._generated_spec_for_version",
        return_value=SPEC,
    ), patch(
        "app.versions_routes.db.set_version_mock_scenarios",
        return_value=_version_row(mock_settings={}),
    ) as set_mock, patch("app.versions_routes.enforce_permission"):
        resp = client.put(
            f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios",
            json=payload,
        )
    assert resp.status_code == 200, resp.text
    stored = set_mock.call_args.kwargs["scenarios"]
    assert set(stored["s"]["operations"]) == {"GET /pets"}


def test_put_scenarios_validation_failure_returns_422(client: TestClient) -> None:
    payload = {
        "scenarios": {
            "s": {"operations": {"DELETE /pets": {"responses": [{"status": 200}]}}}
        }
    }
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(),
    ), patch(
        "app.versions_routes._generated_spec_for_version",
        return_value=SPEC,
    ), patch(
        "app.versions_routes.db.set_version_mock_scenarios",
    ) as set_mock, patch("app.versions_routes.enforce_permission"):
        resp = client.put(
            f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios",
            json=payload,
        )
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["message"] == "Scenario definitions failed validation."
    assert any("DELETE /pets" in e for e in detail["errors"])
    set_mock.assert_not_called()


def test_put_scenarios_requires_ownership(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(),
    ), patch(
        "app.versions_routes._generated_spec_for_version",
        return_value=SPEC,
    ), patch(
        "app.versions_routes.db.set_version_mock_scenarios",
        return_value=None,
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.put(
            f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios",
            json=SCENARIOS_PAYLOAD,
        )
    assert resp.status_code == 403


def test_put_scenarios_wrong_project_404(client: TestClient) -> None:
    row = _version_row()
    row["project_id"] = "other-project"
    with patch("app.versions_routes.db.get_version_by_id", return_value=row), patch(
        "app.versions_routes.enforce_permission"
    ):
        resp = client.put(
            f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios",
            json=SCENARIOS_PAYLOAD,
        )
    assert resp.status_code == 404


def test_put_scenarios_clears_with_empty_map(client: TestClient) -> None:
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings=STORED_SETTINGS),
    ), patch(
        "app.versions_routes._generated_spec_for_version",
        return_value=SPEC,
    ), patch(
        "app.versions_routes.db.set_version_mock_scenarios",
        return_value=_version_row(mock_settings={"mode": "private"}),
    ) as set_mock, patch("app.versions_routes.enforce_permission"):
        resp = client.put(
            f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios",
            json={"scenarios": {}},
        )
    assert resp.status_code == 200
    assert resp.json()["scenarios"] == {}
    assert set_mock.call_args.kwargs["scenarios"] == {}


# ---------------------------------------------------------------------------
# Declarative rules and templates (#4744, PMR-2.1)
# ---------------------------------------------------------------------------

RULES_PAYLOAD = {
    "scenarios": {
        "personalized": {
            "operations": {
                "GET /pets": {
                    "rules": [
                        {
                            "when": {"query": {"limit": {"gt": 10}}},
                            "responses": [{"status": 429, "offSpec": True}],
                        }
                    ],
                    "responses": [{"status": 200, "body": ["{{random.choice('a', 'b')}}"]}],
                }
            }
        }
    }
}


def test_put_scenarios_with_rules_and_templates_persists(client: TestClient) -> None:
    stored_settings = {"scenarios": {}}
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(),
    ), patch(
        "app.versions_routes._generated_spec_for_version",
        return_value=SPEC,
    ), patch(
        "app.versions_routes.db.set_version_mock_scenarios",
        return_value=_version_row(mock_settings=stored_settings),
    ) as set_mock, patch("app.versions_routes.enforce_permission"):
        resp = client.put(
            f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios",
            json=RULES_PAYLOAD,
        )
    assert resp.status_code == 200, resp.text
    stored = set_mock.call_args.kwargs["scenarios"]
    override = stored["personalized"]["operations"]["GET /pets"]
    assert override["rules"][0]["when"] == {"query": {"limit": {"gt": 10.0}}}
    assert override["rules"][0]["responses"] == [{"status": 429, "offSpec": True}]
    assert override["responses"] == [{"status": 200, "body": ["{{random.choice('a', 'b')}}"]}]


def test_put_scenarios_with_invalid_template_returns_422(client: TestClient) -> None:
    payload = {
        "scenarios": {
            "s": {
                "operations": {
                    "GET /pets": {"responses": [{"status": 429, "body": "{{secrets.env}}"}]}
                }
            }
        }
    }
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(),
    ), patch(
        "app.versions_routes._generated_spec_for_version",
        return_value=SPEC,
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.put(
            f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios",
            json=payload,
        )
    assert resp.status_code == 422
    errors = resp.json()["detail"]["errors"]
    assert any("unknown expression root" in error for error in errors)


def test_put_scenarios_with_invalid_predicate_returns_422(client: TestClient) -> None:
    payload = {
        "scenarios": {
            "s": {
                "operations": {
                    "GET /pets": {
                        "rules": [
                            {
                                "when": {"query": {"tag": {"matches": "("}}},
                                "responses": [{"status": 429}],
                            }
                        ]
                    }
                }
            }
        }
    }
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(),
    ), patch(
        "app.versions_routes._generated_spec_for_version",
        return_value=SPEC,
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.put(
            f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios",
            json=payload,
        )
    assert resp.status_code == 422
    errors = resp.json()["detail"]["errors"]
    assert any("regular expression" in error for error in errors)


def test_get_scenarios_round_trips_rules(client: TestClient) -> None:
    settings = {
        "scenarios": {
            "personalized": {
                "operations": {
                    "GET /pets": {
                        "rules": [
                            {
                                "when": {"query": {"limit": {"gt": 10}}},
                                "responses": [{"status": 429, "offSpec": True}],
                            }
                        ]
                    }
                }
            }
        }
    }
    with patch(
        "app.versions_routes.db.get_version_by_id",
        return_value=_version_row(mock_settings=settings),
    ), patch("app.versions_routes.enforce_permission"):
        resp = client.get(f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/scenarios")
    assert resp.status_code == 200, resp.text
    override = resp.json()["scenarios"]["personalized"]["operations"]["GET /pets"]
    assert override["rules"][0]["when"]["query"]["limit"]["gt"] == 10
    assert override["rules"][0]["responses"][0]["status"] == 429

"""Mock-authoring catalogue route tests (#5529, MSC-1.3).

The projection itself is covered by ``test_mock_correlation_bindings.py``. What is asserted here is
the control-plane half: who may ask, that the answer is the camelCase wire shape the ADE reads, and
that it works on a version whose mock is switched off — which is exactly when correlation is being
configured for the first time.
"""

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.permissions import Action, Resource

TENANT = "acme-corp"
PROJECT_ID = "proj-1"
VERSION_ID = "ver-operations-1"
USER_ID = "user-1"
_AUTH = {"tenant_id": "t1", "user_id": USER_ID, "auth_method": "api_key"}
ROUTE = f"/v1/versions/{TENANT}/{PROJECT_ID}/{VERSION_ID}/mock/operations"

SPEC: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets/{petId}": {
            "get": {
                "operationId": "getPet",
                "parameters": [
                    {"name": "petId", "in": "path", "required": True, "schema": {"type": "string"}},
                    {"name": "expand", "in": "query", "schema": {"type": "string"}},
                ],
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
                                }
                            }
                        },
                    }
                },
            }
        }
    },
}

STORED_SETTINGS: Dict[str, Any] = {
    "fixturePacks": {"seed": {"data": {"pets": [{"id": 1}]}}},
}


@pytest.fixture
def client() -> TestClient:
    app.dependency_overrides[validate_authentication] = lambda: _AUTH
    yield TestClient(app)
    app.dependency_overrides.clear()


def _version_row(*, mock_enabled: bool = True) -> Dict[str, Any]:
    return {
        "id": "11111111-1111-4111-8111-111111111111",
        "project_id": PROJECT_ID,
        "creator_id": USER_ID,
        "version_id": "1.0.0",
        "published": True,
        "mock_enabled": mock_enabled,
        "mock_settings": STORED_SETTINGS,
        "project_slug": "petstore",
        "metadata": None,
    }


@pytest.fixture
def version(request: pytest.FixtureRequest):
    row = getattr(request, "param", None) or _version_row()
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=row),
        patch("app.versions_routes.enforce_permission") as permission,
        patch("app.versions_routes._generated_spec_for_version", return_value=SPEC),
    ):
        yield permission


def test_returns_the_catalogue_in_the_wire_shape_the_editor_reads(client: TestClient, version: Any) -> None:
    response = client.get(ROUTE)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["fixtures"] == ["pets"]

    operation = payload["operations"][0]
    assert operation["key"] == "GET /pets/{petId}"
    assert operation["method"] == "GET"
    assert operation["summary"] == "getPet"
    assert operation["successStatus"] == 200
    assert operation["requestFields"] == []
    assert {p["pointer"] for p in operation["responsePointers"]} == {"/id", "/name"}
    assert operation["parameters"][0] == {
        "name": "petId",
        "location": "path",
        "required": True,
        "type": "string",
        "token": "{{request.path.petId}}",
    }
    # `pass` is a Python keyword, so the model spells it `pass_name` and serializes it back.
    assert operation["bindings"] == [
        {"pointer": "/id", "source": "{{request.path.petId}}", "pass": "path-params", "repeated": False}
    ]


def test_requires_only_view_permission(client: TestClient, version: Any) -> None:
    client.get(ROUTE)

    assert version.call_args.args[2:] == (Resource.VERSIONS, Action.VIEW)


@pytest.mark.parametrize("version", [_version_row(mock_enabled=False)], indirect=True)
def test_answers_for_a_version_whose_mock_is_disabled(client: TestClient, version: Any) -> None:
    # Correlation is configured *before* the mock is switched on; a 409 here would make the editor
    # unreachable in the one state it is most needed in.
    response = client.get(ROUTE)

    assert response.status_code == 200, response.text
    assert response.json()["operations"]


def test_404s_when_the_version_is_not_in_the_project(client: TestClient) -> None:
    with (
        patch("app.versions_routes.db.get_version_by_id", return_value=None),
        patch("app.versions_routes.enforce_permission"),
    ):
        response = client.get(ROUTE)

    assert response.status_code == 404

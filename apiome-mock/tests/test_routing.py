"""OpenAPI path and method matching tests."""

from __future__ import annotations

from app.mock_routing import extract_operations

from apiome_mock.routing import match_request, operations_for_path

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
                                "schema": {
                                    "type": "array",
                                    "items": {"$ref": "#/components/schemas/Pet"},
                                }
                            }
                        },
                    }
                },
            },
            "post": {"responses": {"201": {"description": "created"}}},
        },
        "/pets/{petId}": {
            "get": {"responses": {"200": {"description": "ok"}}},
        },
    },
    "components": {
        "schemas": {
            "Pet": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
            }
        }
    },
}


def test_operations_for_path_matches_template() -> None:
    operations = tuple(extract_operations(PETSTORE_SPEC))
    matched = operations_for_path(operations, "/pets/42")
    assert len(matched) == 1
    assert matched[0].path_template == "/pets/{petId}"


def test_match_request_returns_allowed_methods_on_method_miss() -> None:
    operations = tuple(extract_operations(PETSTORE_SPEC))
    operation, _params, allowed = match_request(operations, "DELETE", "/pets")
    assert operation is None
    assert allowed == ["GET", "POST"]


def test_match_request_finds_get_pets() -> None:
    operations = tuple(extract_operations(PETSTORE_SPEC))
    operation, _params, allowed = match_request(operations, "GET", "/pets")
    assert operation is not None
    assert operation.path_template == "/pets"
    assert allowed == ["GET", "POST"]

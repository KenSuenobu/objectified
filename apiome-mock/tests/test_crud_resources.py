"""Unit tests for CRUD path pairing and id synthesis (#4453)."""

from __future__ import annotations

from app.mock_routing import extract_operations

from apiome_mock.crud_resources import (
    CrudAction,
    build_crud_resources,
    extract_or_synthesize_id,
    match_crud_operation,
)

CRUD_SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {"responses": {"200": {"description": "ok"}}},
            "post": {
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Pet"},
                        }
                    },
                },
                "responses": {"201": {"description": "created"}},
            },
        },
        "/pets/{petId}": {
            "get": {"responses": {"200": {"description": "ok"}}},
            "put": {
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Pet"},
                        }
                    },
                },
                "responses": {"200": {"description": "ok"}},
            },
            "patch": {
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Pet"},
                        }
                    },
                },
                "responses": {"200": {"description": "ok"}},
            },
            "delete": {"responses": {"204": {"description": "gone"}}},
        },
        "/status": {
            "get": {"responses": {"200": {"description": "ok"}}},
        },
    },
    "components": {
        "schemas": {
            "Pet": {
                "type": "object",
                "required": ["name"],
                "properties": {
                    "id": {"type": "integer"},
                    "name": {"type": "string"},
                },
            }
        }
    },
}


def test_build_crud_resources_pairs_collection_and_item() -> None:
    ops = tuple(extract_operations(CRUD_SPEC))
    resources = build_crud_resources(ops)
    assert len(resources) == 1
    assert resources[0].collection_path == "/pets"
    assert resources[0].item_path == "/pets/{petId}"
    assert resources[0].id_param == "petId"


def test_match_crud_actions() -> None:
    ops = tuple(extract_operations(CRUD_SPEC))
    resources = build_crud_resources(ops)
    by_key = {op.key: op for op in ops}

    create = match_crud_operation(by_key["POST /pets"], {}, resources)
    assert create is not None and create.action == CrudAction.CREATE

    listed = match_crud_operation(by_key["GET /pets"], {}, resources)
    assert listed is not None and listed.action == CrudAction.LIST

    read = match_crud_operation(by_key["GET /pets/{petId}"], {"petId": "7"}, resources)
    assert read is not None and read.action == CrudAction.READ and read.resource_id == "7"

    delete = match_crud_operation(by_key["DELETE /pets/{petId}"], {"petId": "7"}, resources)
    assert delete is not None and delete.action == CrudAction.DELETE

    status_op = by_key["GET /status"]
    assert match_crud_operation(status_op, {}, resources) is None


def test_synthesize_integer_id_when_missing() -> None:
    ops = tuple(extract_operations(CRUD_SPEC))
    resources = build_crud_resources(ops)
    post = next(op for op in ops if op.method == "POST")
    resource_id, payload, raw = extract_or_synthesize_id(
        {"name": "Rex"},
        resource=resources[0],
        operation=post,
        spec=CRUD_SPEC,
        next_int=3,
    )
    assert resource_id == "3"
    assert raw == 3
    assert payload == {"name": "Rex", "id": 3}


def test_preserve_client_supplied_id() -> None:
    ops = tuple(extract_operations(CRUD_SPEC))
    resources = build_crud_resources(ops)
    post = next(op for op in ops if op.method == "POST")
    resource_id, payload, raw = extract_or_synthesize_id(
        {"id": 99, "name": "Rex"},
        resource=resources[0],
        operation=post,
        spec=CRUD_SPEC,
        next_int=1,
    )
    assert resource_id == "99"
    assert raw == 99
    assert payload["id"] == 99

"""Author-time correlation projection tests (#5529, MSC-1.3).

The editor's whole promise is that what it shows before a save is what the mock will do after one.
These tests pin that promise from two directions: the projection agrees with the runtime's own
name-matching rules (they are literally the same functions), and it refuses to invent a binding the
schema does not support.
"""

from __future__ import annotations

from typing import Any, Dict

from app.mock_correlation_bindings import build_operation_catalogue, fixture_names
from app.mock_correlation_rules import SERVER_OWNED_FIELDS, normalize_property_name, path_parameter_aliases


def _spec(paths: Dict[str, Any], components: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """Wrap path items in a minimal OpenAPI document."""
    document: Dict[str, Any] = {
        "openapi": "3.1.0",
        "info": {"title": "Pet Store", "version": "1.0.0"},
        "paths": paths,
    }
    if components:
        document["components"] = components
    return document


def _json_response(schema: Dict[str, Any], status: str = "200") -> Dict[str, Any]:
    return {status: {"description": "ok", "content": {"application/json": {"schema": schema}}}}


def _entry(spec: Dict[str, Any], key: str):
    catalogue = {entry.key: entry for entry in build_operation_catalogue(spec)}
    assert key in catalogue, f"{key} missing from {sorted(catalogue)}"
    return catalogue[key]


# ==================================================================================================
# The catalogue itself
# ==================================================================================================


def test_lists_every_operation_with_its_parameters() -> None:
    spec = _spec(
        {
            "/pets/{petId}": {
                "parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "string"}}],
                "get": {
                    "summary": "Fetch one pet",
                    "parameters": [
                        {"name": "expand", "in": "query", "schema": {"type": "string"}},
                        {"name": "X-Tier", "in": "header", "schema": {"type": "string"}},
                        {"name": "ignored", "in": "cookie", "schema": {"type": "string"}},
                    ],
                    "responses": _json_response({"type": "object", "properties": {"id": {"type": "string"}}}),
                },
            }
        }
    )

    entry = _entry(spec, "GET /pets/{petId}")

    assert entry.summary == "Fetch one pet"
    assert entry.success_status == 200
    # Path first, then query, then header — and a cookie parameter is not offerable as a token.
    assert [(p.location, p.name) for p in entry.parameters] == [
        ("path", "petId"),
        ("query", "expand"),
        ("header", "X-Tier"),
    ]
    assert entry.parameters[0].token == "{{request.path.petId}}"
    assert entry.parameters[2].token == "{{request.header.X-Tier}}"


def test_inherits_path_level_parameters_and_lets_the_operation_override_them() -> None:
    spec = _spec(
        {
            "/pets/{petId}": {
                "parameters": [{"name": "petId", "in": "path", "schema": {"type": "string"}}],
                "get": {
                    "parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "integer"}}],
                    "responses": _json_response({"type": "object"}),
                },
            }
        }
    )

    entry = _entry(spec, "GET /pets/{petId}")

    assert len(entry.parameters) == 1
    assert entry.parameters[0].type == "integer"


def test_lists_pointers_an_explicit_binding_can_target() -> None:
    spec = _spec(
        {
            "/pets": {
                "get": {
                    "responses": _json_response(
                        {
                            "type": "object",
                            "properties": {
                                "items": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {"name": {"type": "string"}},
                                    },
                                },
                                "total": {"type": "integer"},
                            },
                        }
                    )
                }
            }
        }
    )

    entry = _entry(spec, "GET /pets")
    pointers = {pointer.pointer: pointer for pointer in entry.response_pointers}

    assert set(pointers) == {"/items", "/items/0/name", "/total"}
    assert pointers["/total"].type == "integer"
    # A pointer inside an array names member 0 and says so, because the runtime binds every member.
    assert pointers["/items/0/name"].repeated is True
    assert pointers["/total"].repeated is False


def test_a_recursive_schema_terminates() -> None:
    spec = _spec(
        {
            "/nodes": {
                "get": {"responses": _json_response({"$ref": "#/components/schemas/Node"})},
            }
        },
        components={
            "schemas": {
                "Node": {
                    "type": "object",
                    "properties": {"id": {"type": "string"}, "child": {"$ref": "#/components/schemas/Node"}},
                }
            }
        },
    )

    entry = _entry(spec, "GET /nodes")

    assert "/id" in {pointer.pointer for pointer in entry.response_pointers}


# ==================================================================================================
# The path-params projection
# ==================================================================================================


def test_projects_path_parameter_bindings_at_every_depth() -> None:
    spec = _spec(
        {
            "/pets/{petId}": {
                "parameters": [{"name": "petId", "in": "path", "schema": {"type": "string"}}],
                "get": {
                    "responses": _json_response(
                        {
                            "type": "object",
                            "properties": {
                                "id": {"type": "integer"},
                                "pet_id": {"type": "string"},
                                "owner": {"type": "object", "properties": {"name": {"type": "string"}}},
                            },
                        }
                    )
                },
            }
        }
    )

    entry = _entry(spec, "GET /pets/{petId}")
    bindings = {binding.pointer: binding for binding in entry.bindings}

    # Both the bare `id` and the snake-cased spelling are the same parameter after normalization.
    assert set(bindings) == {"/id", "/pet_id"}
    assert bindings["/id"].source == "{{request.path.petId}}"
    assert bindings["/id"].pass_name == "path-params"


def test_the_last_id_parameter_claims_the_bare_id_property() -> None:
    spec = _spec(
        {
            "/users/{userId}/pets/{petId}": {
                "parameters": [
                    {"name": "petId", "in": "path", "schema": {"type": "string"}},
                    {"name": "userId", "in": "path", "schema": {"type": "string"}},
                ],
                "get": {"responses": _json_response({"type": "object", "properties": {"id": {"type": "string"}}})},
            }
        }
    )

    entry = _entry(spec, "GET /users/{userId}/pets/{petId}")

    # Template order decides, not the order the spec declares the parameter objects in: the
    # response is about the pet, so `petId` claims the bare `id` (the runtime's rule).
    assert [(b.pointer, b.source) for b in entry.bindings] == [("/id", "{{request.path.petId}}")]


def test_does_not_bind_a_container_property() -> None:
    spec = _spec(
        {
            "/pets/{petId}": {
                "parameters": [{"name": "petId", "in": "path", "schema": {"type": "string"}}],
                "get": {
                    "responses": _json_response(
                        {
                            "type": "object",
                            # An object named `petId` is not a scalar the runtime would overwrite.
                            "properties": {"petId": {"type": "object", "properties": {"id": {"type": "string"}}}},
                        }
                    )
                },
            }
        }
    )

    entry = _entry(spec, "GET /pets/{petId}")

    assert [b.pointer for b in entry.bindings] == ["/petId/id"]


# ==================================================================================================
# The inferred (request-body echo) projection
# ==================================================================================================


def test_projects_the_request_body_echo_on_writes() -> None:
    spec = _spec(
        {
            "/pets": {
                "post": {
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {"name": {"type": "string"}, "tag": {"type": "string"}},
                                }
                            }
                        }
                    },
                    "responses": _json_response(
                        {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "name": {"type": "string"},
                                "tag": {"type": "string"},
                                "createdAt": {"type": "string"},
                            },
                        },
                        status="201",
                    ),
                }
            }
        }
    )

    entry = _entry(spec, "POST /pets")
    bindings = {binding.pointer: binding for binding in entry.bindings}

    assert entry.success_status == 201
    assert entry.request_fields == ("name", "tag")
    assert set(bindings) == {"/name", "/tag"}
    assert bindings["/name"].source == "{{request.body#/name}}"
    assert bindings["/name"].pass_name == "inferred"
    # `id` and `createdAt` are server-owned: a real API would have overruled what the client sent.
    assert set(SERVER_OWNED_FIELDS) >= {"id", "createdat"}


def test_does_not_echo_on_a_read() -> None:
    spec = _spec(
        {
            "/pets/search": {
                "get": {
                    "requestBody": {
                        "content": {"application/json": {"schema": {"type": "object", "properties": {"name": {}}}}}
                    },
                    "responses": _json_response({"type": "object", "properties": {"name": {"type": "string"}}}),
                }
            }
        }
    )

    assert _entry(spec, "GET /pets/search").bindings == ()


def test_treats_an_unmatched_response_object_as_an_envelope() -> None:
    spec = _spec(
        {
            "/pets": {
                "post": {
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {"type": "object", "properties": {"name": {"type": "string"}}}
                            }
                        }
                    },
                    "responses": _json_response(
                        {
                            "type": "object",
                            "properties": {
                                "data": {"type": "object", "properties": {"name": {"type": "string"}}}
                            },
                        }
                    ),
                }
            }
        }
    )

    entry = _entry(spec, "POST /pets")

    assert [b.pointer for b in entry.bindings] == ["/data/name"]


def test_a_path_parameter_binding_wins_over_an_echo_for_the_same_pointer() -> None:
    spec = _spec(
        {
            "/pets/{petId}": {
                "parameters": [{"name": "petId", "in": "path", "schema": {"type": "string"}}],
                "put": {
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {"type": "object", "properties": {"petId": {"type": "string"}}}
                            }
                        }
                    },
                    "responses": _json_response({"type": "object", "properties": {"petId": {"type": "string"}}}),
                },
            }
        }
    )

    entry = _entry(spec, "PUT /pets/{petId}")

    # The passes run path-params -> inferred, and the editor must not list the pointer twice.
    assert [(b.pointer, b.pass_name) for b in entry.bindings] == [("/petId", "path-params")]


def test_reports_nothing_for_an_operation_with_no_json_response() -> None:
    spec = _spec({"/ping": {"get": {"responses": {"204": {"description": "no content"}}}}})

    entry = _entry(spec, "GET /ping")

    assert entry.bindings == ()
    assert entry.response_pointers == ()
    assert entry.success_status == 204


def test_the_projection_uses_the_runtime_name_rules() -> None:
    # Not a restatement: these are the exact functions apiome_mock.correlation imports, so a change
    # to either side is a change to both.
    assert normalize_property_name("Pet-Id") == "petid"
    assert path_parameter_aliases({"petId": "42"}) == {"petid": "42", "id": "42"}


# ==================================================================================================
# Fixture names
# ==================================================================================================


def test_lists_fixture_names_across_packs() -> None:
    settings = {
        "fixturePacks": {
            "b-pack": {"data": {"owners": [{"id": 1}]}},
            "a-pack": {"data": {"pets": [{"id": 1}]}},
        }
    }

    assert fixture_names(settings) == ["owners", "pets"]


def test_fixture_names_tolerates_junk() -> None:
    assert fixture_names(None) == []
    assert fixture_names("not json") == []
    assert fixture_names('{"fixturePacks": {"p": {"data": {"pets": []}}}}') == ["pets"]
    assert fixture_names({"fixturePacks": []}) == []

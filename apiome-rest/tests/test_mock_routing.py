"""Unit tests for the shared mock routing primitives (#5532, MSC-2.2).

Routing is all that survived ``app.mock_engine``: both the author-time validators here and the
runtime in apiome-mock resolve "which operation is this request for?" through these functions, so
they are tested directly against synthetic specs rather than through either caller.
"""

import re

from app.mock_routing import (
    HTTP_METHODS,
    compile_path_template,
    extract_operations,
    match_operation,
)

SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "Pet Store", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "get": {"operationId": "listPets", "responses": {"200": {"description": "ok"}}},
            "post": {"operationId": "createPet", "responses": {"201": {"description": "created"}}},
            "parameters": [{"name": "limit", "in": "query"}],
            "summary": "Pets collection",
        },
        "/pets/{petId}": {
            "get": {"operationId": "getPet", "responses": {"200": {"description": "ok"}}},
            "delete": {"operationId": "deletePet", "responses": {"204": {"description": "gone"}}},
        },
    },
}


def test_extract_operations_counts_all_methods():
    keys = {op.key for op in extract_operations(SPEC)}
    assert keys == {
        "GET /pets",
        "POST /pets",
        "GET /pets/{petId}",
        "DELETE /pets/{petId}",
    }


def test_extract_operations_ignores_path_item_keys_that_are_not_operations():
    """``parameters`` and ``summary`` sit beside methods in a path item and are not operations."""
    keys = {op.key for op in extract_operations(SPEC)}
    assert not any(key.startswith(("PARAMETERS", "SUMMARY")) for key in keys)


def test_extract_operations_survives_a_malformed_spec():
    """A stored spec that is not a document must yield nothing rather than raise."""
    assert extract_operations({}) == []
    assert extract_operations({"paths": "nope"}) == []
    assert extract_operations({"paths": {"/x": "nope"}}) == []
    assert extract_operations({"paths": {"/x": {"get": "nope"}}}) == []


def test_match_operation_with_path_param():
    op, params = match_operation(extract_operations(SPEC), "GET", "/pets/123")
    assert op is not None and op.key == "GET /pets/{petId}"
    assert params == {"petId": "123"}


def test_match_operation_is_case_insensitive_on_method():
    op, _ = match_operation(extract_operations(SPEC), "get", "/pets")
    assert op is not None and op.method == "GET"


def test_match_operation_prefers_literal_over_param():
    spec = {
        "paths": {
            "/pets/mine": {"get": {"responses": {"200": {"description": "ok"}}}},
            "/pets/{petId}": {"get": {"responses": {"200": {"description": "ok"}}}},
        }
    }
    op, _ = match_operation(extract_operations(spec), "GET", "/pets/mine")
    assert op.path_template == "/pets/mine"


def test_no_match_returns_none():
    op, params = match_operation(extract_operations(SPEC), "GET", "/unknown")
    assert op is None and params == {}


def test_a_path_that_matches_another_method_is_still_a_miss():
    op, _ = match_operation(extract_operations(SPEC), "PATCH", "/pets")
    assert op is None


def test_matches_path_ignores_the_method():
    """Callers enumerating what a *path* supports (405 handling) need method-blind matching."""
    item = next(op for op in extract_operations(SPEC) if op.key == "DELETE /pets/{petId}")
    assert item.matches_path("/pets/7") == {"petId": "7"}
    assert item.matches_path("pets/7") == {"petId": "7"}
    assert item.matches_path("/pets") is None


def test_matches_path_distinguishes_no_parameters_from_no_match():
    collection = next(op for op in extract_operations(SPEC) if op.key == "GET /pets")
    assert collection.matches_path("/pets") == {}
    assert collection.matches_path("/pets/1") is None


def test_parameter_count_orders_candidates():
    ops = extract_operations(SPEC)
    assert next(op for op in ops if op.key == "GET /pets").parameter_count == 0
    assert next(op for op in ops if op.key == "GET /pets/{petId}").parameter_count == 1


def test_compile_path_template_tolerates_slashes_and_sanitises_group_names():
    matcher = compile_path_template("pets/{pet-id}/")
    assert matcher.match("/pets/9").groupdict() == {"pet_id": "9"}
    assert matcher.match("/pets/9/") is not None
    assert matcher.match("/pets/9/toys") is None


def test_compile_path_template_escapes_regex_metacharacters():
    """A literal segment containing regex syntax must match literally, not as a pattern."""
    matcher = compile_path_template("/files/a.b")
    assert matcher.match("/files/a.b") is not None
    assert matcher.match("/files/axb") is None


def test_compile_path_template_returns_a_compiled_pattern():
    assert isinstance(compile_path_template("/pets"), re.Pattern)


def test_http_methods_covers_the_openapi_operation_keys():
    assert set(HTTP_METHODS) == {
        "get",
        "put",
        "post",
        "delete",
        "options",
        "head",
        "patch",
        "trace",
    }

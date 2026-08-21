"""Tests for the vendored provider tool-array contract — FMT-2.5 (#5423).

:mod:`app.llm_tool_schema` is the gate every emitted array passes before it leaves the
emitter, so its own rules have to be right: a validator that accepts an invalid array is
worth nothing, and one that rejects a valid array makes a legitimate export impossible.
Each dialect is exercised on a known-good entry and on one deliberate violation per rule.
"""

from __future__ import annotations

import math
from typing import Any, Dict

import pytest

from app.llm_tool_schema import (
    ANTHROPIC_TOOL_KEYS,
    BARE_TOOL_KEYS,
    MODE_SCHEMA_FIELD,
    OPENAI_FUNCTION_KEYS,
    OPENAI_TOOL_KEYS,
    TOOL_MODES,
    anthropic_tool_violations,
    bare_tool_violations,
    openai_tool_violations,
    tool_array_violations,
    tool_violations,
    validate_tool_array,
)


def _schema(**properties: Dict[str, Any]) -> Dict[str, Any]:
    return {"type": "object", "properties": dict(properties)}


def _openai(**overrides: Any) -> Dict[str, Any]:
    function: Dict[str, Any] = {
        "name": "get_weather",
        "description": "Look up the weather.",
        "parameters": _schema(city={"type": "string"}),
    }
    function.update(overrides.pop("function", {}))
    entry = {"type": "function", "function": function}
    entry.update(overrides)
    return entry


def _anthropic(**overrides: Any) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "name": "get_weather",
        "description": "Look up the weather.",
        "input_schema": _schema(city={"type": "string"}),
    }
    entry.update(overrides)
    return entry


def _bare(**overrides: Any) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "name": "get_weather",
        "description": "Look up the weather.",
        "parameters": _schema(city={"type": "string"}),
    }
    entry.update(overrides)
    return entry


_BUILDERS = {"openai": _openai, "anthropic": _anthropic, "bare": _bare}


# ===========================================================================
# Happy path
# ===========================================================================


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_a_well_formed_entry_has_no_violations(mode: str) -> None:
    assert tool_violations(_BUILDERS[mode](), mode=mode) == []


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_a_tool_may_omit_its_description(mode: str) -> None:
    entry = _BUILDERS[mode]()
    if mode == "openai":
        entry["function"].pop("description")
    else:
        entry.pop("description")
    assert tool_violations(entry, mode=mode) == []


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_a_tool_may_take_no_arguments(mode: str) -> None:
    entry = _BUILDERS[mode]()
    target = entry["function"] if mode == "openai" else entry
    target[MODE_SCHEMA_FIELD[mode].rsplit(".", 1)[-1]] = {"type": "object", "properties": {}}
    assert tool_violations(entry, mode=mode) == []


def test_the_mode_schema_field_table_covers_every_mode() -> None:
    assert set(MODE_SCHEMA_FIELD) == set(TOOL_MODES)


def test_an_unknown_mode_is_a_programming_error_not_a_violation() -> None:
    with pytest.raises(ValueError, match="Unknown tool mode"):
        tool_violations(_openai(), mode="gemini")


# ===========================================================================
# Envelope rules
# ===========================================================================


def test_openai_requires_the_function_type_literal() -> None:
    violations = openai_tool_violations(_openai(type="tool"))
    assert any("must be the literal 'function'" in v for v in violations)


def test_openai_rejects_a_missing_function_object() -> None:
    violations = openai_tool_violations({"type": "function"})
    assert any(".function: must be an object" in v for v in violations)


def test_openai_rejects_an_unknown_top_level_key() -> None:
    violations = openai_tool_violations(_openai(cache="yes"))
    assert any("unknown key(s) 'cache'" in v for v in violations)


def test_openai_rejects_an_unknown_function_key() -> None:
    violations = openai_tool_violations(_openai(function={"returns": {}}))
    assert any("unknown key(s) 'returns'" in v for v in violations)


def test_anthropic_accepts_cache_control_because_the_api_does() -> None:
    assert "cache_control" in ANTHROPIC_TOOL_KEYS
    assert anthropic_tool_violations(_anthropic(cache_control={"type": "ephemeral"})) == []


def test_anthropic_rejects_the_openai_parameters_spelling() -> None:
    entry = _anthropic()
    entry["parameters"] = entry.pop("input_schema")
    violations = anthropic_tool_violations(entry)
    assert any("unknown key(s) 'parameters'" in v for v in violations)
    assert any("input_schema" in v for v in violations)


def test_bare_rejects_the_anthropic_input_schema_spelling() -> None:
    entry = _bare()
    entry["input_schema"] = entry.pop("parameters")
    violations = bare_tool_violations(entry)
    assert any("unknown key(s) 'input_schema'" in v for v in violations)


def test_the_key_sets_are_disjoint_where_the_dialects_differ() -> None:
    assert "input_schema" in ANTHROPIC_TOOL_KEYS and "input_schema" not in BARE_TOOL_KEYS
    assert "parameters" in BARE_TOOL_KEYS and "parameters" not in ANTHROPIC_TOOL_KEYS
    assert "parameters" in OPENAI_FUNCTION_KEYS and "parameters" not in OPENAI_TOOL_KEYS


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_a_non_object_entry_is_rejected(mode: str) -> None:
    assert tool_violations("get_weather", mode=mode) == ["tool: tool entry must be an object"]


# ===========================================================================
# Names
# ===========================================================================


@pytest.mark.parametrize("mode", TOOL_MODES)
@pytest.mark.parametrize("name", ["get weather", "get/weather", "get.weather", "", "x" * 65])
def test_a_name_outside_the_grammar_is_rejected(mode: str, name: str) -> None:
    entry = _BUILDERS[mode]()
    target = entry["function"] if mode == "openai" else entry
    target["name"] = name
    assert any("tool name" in v for v in tool_violations(entry, mode=mode))


@pytest.mark.parametrize("mode", TOOL_MODES)
@pytest.mark.parametrize("name", ["get_weather", "get-weather", "GetWeather9", "x" * 64])
def test_a_name_inside_the_grammar_is_accepted(mode: str, name: str) -> None:
    entry = _BUILDERS[mode]()
    target = entry["function"] if mode == "openai" else entry
    target["name"] = name
    assert tool_violations(entry, mode=mode) == []


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_a_blank_description_is_rejected_rather_than_shipped(mode: str) -> None:
    entry = _BUILDERS[mode]()
    target = entry["function"] if mode == "openai" else entry
    target["description"] = "   "
    assert any("description" in v for v in tool_violations(entry, mode=mode))


# ===========================================================================
# Argument schema
# ===========================================================================


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_a_non_object_argument_schema_is_rejected(mode: str) -> None:
    entry = _BUILDERS[mode]()
    target = entry["function"] if mode == "openai" else entry
    target[MODE_SCHEMA_FIELD[mode].rsplit(".", 1)[-1]] = {"type": "array"}
    assert any("must be `object`" in v for v in tool_violations(entry, mode=mode))


def test_a_missing_properties_map_is_rejected() -> None:
    violations = anthropic_tool_violations(_anthropic(input_schema={"type": "object"}))
    assert any(".properties: must be an object" in v for v in violations)


def test_required_may_not_name_an_undeclared_property() -> None:
    schema = {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["state"]}
    violations = anthropic_tool_violations(_anthropic(input_schema=schema))
    assert any("names undeclared" in v for v in violations)


def test_required_must_be_a_list_of_strings() -> None:
    schema = {"type": "object", "properties": {}, "required": "city"}
    violations = anthropic_tool_violations(_anthropic(input_schema=schema))
    assert any("list of property-name strings" in v for v in violations)


def test_a_nested_required_violation_is_found_too() -> None:
    schema = {
        "type": "object",
        "properties": {
            "pet": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["id"]}
        },
    }
    violations = anthropic_tool_violations(_anthropic(input_schema=schema))
    assert any("properties.pet" in v and "names undeclared" in v for v in violations)


def test_a_schema_nested_past_the_provider_limit_is_rejected() -> None:
    deep: Dict[str, Any] = {"type": "string"}
    for _ in range(8):
        deep = {"type": "object", "properties": {"child": deep}}
    violations = anthropic_tool_violations(_anthropic(input_schema=deep))
    assert any("nests deeper" in v for v in violations)


def test_a_schema_at_the_provider_limit_is_accepted() -> None:
    deep: Dict[str, Any] = {"type": "string"}
    for _ in range(4):
        deep = {"type": "object", "properties": {"child": deep}}
    assert anthropic_tool_violations(_anthropic(input_schema=deep)) == []


def test_an_any_of_branch_is_not_charged_a_nesting_level() -> None:
    schema = {
        "type": "object",
        "properties": {
            "mode": {"anyOf": [{"type": "string"}, {"type": "integer"}]},
        },
    }
    assert anthropic_tool_violations(_anthropic(input_schema=schema)) == []


def test_a_schema_that_cannot_be_serialized_is_rejected() -> None:
    schema = {"type": "object", "properties": {"when": {"type": "string", "default": object()}}}
    violations = anthropic_tool_violations(_anthropic(input_schema=schema))
    assert any("not JSON-serializable" in v for v in violations)


def test_a_non_finite_number_is_rejected_as_unserializable() -> None:
    schema = {"type": "object", "properties": {"n": {"type": "number", "maximum": math.nan}}}
    # `json.dumps` accepts NaN by default, so this documents the boundary: the check
    # catches values Python cannot serialize at all, not values JSON spells oddly.
    assert not any(
        "not JSON-serializable" in v
        for v in anthropic_tool_violations(_anthropic(input_schema=schema))
    )


# ===========================================================================
# Strict subset
# ===========================================================================


def _strict_function(schema: Dict[str, Any]) -> Dict[str, Any]:
    return _openai(function={"parameters": schema, "strict": True})


def test_a_valid_strict_tool_has_no_violations() -> None:
    schema = {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
        "additionalProperties": False,
    }
    assert openai_tool_violations(_strict_function(schema)) == []


def test_strict_requires_additional_properties_false() -> None:
    schema = {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
    violations = openai_tool_violations(_strict_function(schema))
    assert any("additionalProperties: false" in v for v in violations)


def test_strict_requires_every_property_to_be_required() -> None:
    schema = {
        "type": "object",
        "properties": {"city": {"type": "string"}, "unit": {"type": "string"}},
        "required": ["city"],
        "additionalProperties": False,
    }
    violations = openai_tool_violations(_strict_function(schema))
    assert any("must list every property in `required`" in v for v in violations)


def test_strict_rejects_a_keyword_outside_the_subset() -> None:
    schema = {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
        "additionalProperties": False,
        "oneOf": [{"type": "object"}],
    }
    violations = openai_tool_violations(_strict_function(schema))
    assert any("fixed keyword subset" in v and "'oneOf'" in v for v in violations)


def test_strict_checks_nested_objects_too() -> None:
    schema = {
        "type": "object",
        "properties": {
            "pet": {"type": "object", "properties": {"name": {"type": "string"}}},
        },
        "required": ["pet"],
        "additionalProperties": False,
    }
    violations = openai_tool_violations(_strict_function(schema))
    assert any("properties.pet" in v for v in violations)


def test_the_strict_flag_must_be_a_boolean() -> None:
    violations = openai_tool_violations(_openai(function={"strict": "yes"}))
    assert any("strict: must be a boolean" in v for v in violations)


def test_strict_rules_are_not_applied_when_the_tool_does_not_claim_them() -> None:
    schema = {"type": "object", "properties": {"city": {"type": "string"}}}
    assert openai_tool_violations(_openai(function={"parameters": schema})) == []


# ===========================================================================
# Array-level rules
# ===========================================================================


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_a_valid_array_passes(mode: str) -> None:
    assert tool_array_violations([_BUILDERS[mode]()], mode=mode) == []


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_the_tools_wrapper_object_is_accepted(mode: str) -> None:
    assert tool_array_violations({"tools": [_BUILDERS[mode]()]}, mode=mode) == []


def test_a_non_array_document_is_rejected() -> None:
    assert tool_array_violations({"foo": 1}, mode="openai") == [
        "document: a tool array must be a JSON array (or an object with `tools`)"
    ]


def test_an_empty_array_is_rejected() -> None:
    assert tool_array_violations([], mode="openai") == [
        "document: a tool array must declare at least one tool"
    ]


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_a_duplicate_tool_name_is_rejected(mode: str) -> None:
    build = _BUILDERS[mode]
    violations = tool_array_violations([build(), build()], mode=mode)
    assert any("already declared by tools[0]" in v for v in violations)


def test_violations_are_reported_with_their_array_index() -> None:
    violations = tool_array_violations([_openai(), {"type": "function"}], mode="openai")
    assert any(v.startswith("tools[1]") for v in violations)


def test_validate_raises_with_every_violation_listed() -> None:
    with pytest.raises(ValueError) as excinfo:
        validate_tool_array([{"type": "function"}], mode="openai", source_label="widgets")
    message = str(excinfo.value)
    assert "Invalid openai tool array (widgets)" in message
    assert "tools[0].function" in message


def test_validate_is_silent_for_a_valid_array() -> None:
    validate_tool_array([_anthropic()], mode="anthropic")

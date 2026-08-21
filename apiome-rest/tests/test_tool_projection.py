"""Tests for the shared canonical → tool-definition projection — FMT-2.5 (#5423).

:mod:`app.tool_projection` is the middle that :mod:`app.llm_tools_emitter` and the MCP
tool-definition emitter (MFX-32.1, #4295) both render, so these tests pin the behaviour
the two renderers are entitled to rely on:

* **names** are charset-legal, length-bounded, collision-free, and identical across two
  runs of the same model;
* **descriptions** compose summary and description without repeating either, and never
  carry a credential literal out of the source;
* **argument schemas** merge path/query/header parameters with the request body, inline
  named types, and report — never silently drop — a cycle, an over-deep subtree, a
  credential parameter or a strict-subset keyword;
* **selection** explains every operation it leaves out.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Constraints,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
    Service,
    StreamingMode,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import LossTracker, Provenance
from app.tool_projection import (
    BODY_ARGUMENT_NAME,
    DEFAULT_MAX_NAME_LENGTH,
    DEFAULT_MAX_NESTING_DEPTH,
    LOSS_BODY_NESTED,
    LOSS_COOKIE_PARAMETER,
    LOSS_CREDENTIAL_PARAMETER,
    LOSS_CREDENTIAL_REDACTED,
    LOSS_DEPRECATED_OPERATION,
    LOSS_EVENT_OPERATION,
    LOSS_FILTERED_OPERATION,
    LOSS_NESTING_DEPTH,
    LOSS_ONEOF_AS_ANYOF,
    LOSS_REQUIRED_WITHOUT_PROPERTY,
    LOSS_SCHEMA_CYCLE,
    LOSS_SCHEMA_ONLY_TOOL,
    LOSS_STREAMING_OPERATION,
    LOSS_STRICT_KEYWORD,
    LOSS_STRICT_OPTIONAL,
    LOSS_TOOL_NAME_COLLISION,
    LOSS_TOOL_NAME_SANITIZED,
    LOSS_TOOL_NAME_TRUNCATED,
    LOSS_UNRESOLVED_TYPE,
    TOOL_NAME_PATTERN,
    ToolNamer,
    ToolSchemaBuilder,
    assemble_tool_description,
    is_credential_parameter,
    project_tools,
    sanitize_tool_name,
    scrub_credentials,
    selectable_operations,
)

# ===========================================================================
# Model builders
# ===========================================================================


def _parameter(
    name: str,
    location: ParameterLocation,
    *,
    required: bool = False,
    type_name: str = "string",
    description: Optional[str] = None,
    constraints: Optional[Constraints] = None,
) -> Parameter:
    return Parameter(
        key=f"op#{location.value}.{name}",
        name=name,
        location=location,
        type=TypeRef(name=type_name, nullable=not required),
        required=required,
        description=description,
        constraints=constraints,
    )


def _operation(
    key: str = "GET /widgets",
    *,
    name: str = "listWidgets",
    kind: OperationKind = OperationKind.REQUEST_RESPONSE,
    streaming: StreamingMode = StreamingMode.NONE,
    parameters: Optional[List[Parameter]] = None,
    messages: Optional[List[Message]] = None,
    description: Optional[str] = None,
    deprecated: bool = False,
    tags: Optional[List[str]] = None,
    http_path: Optional[str] = None,
    extras: Optional[Dict[str, Any]] = None,
) -> Operation:
    return Operation(
        key=key,
        name=name,
        kind=kind,
        streaming=streaming,
        description=description,
        deprecated=deprecated,
        http_method="GET",
        http_path=http_path,
        parameters=parameters or [],
        messages=messages or [],
        tags=tags or [],
        extras=extras or {},
    )


def _api(
    operations: Optional[List[Operation]] = None,
    *,
    types: Optional[List[Type]] = None,
    extras: Optional[Dict[str, Any]] = None,
) -> CanonicalApi:
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Widgets"),
        title="Widgets",
        services=[Service(key="Widgets", name="Widgets", operations=operations or [])],
        types=types or [],
        extras=extras or {},
    )


def _body_message(schema: Dict[str, Any], *, required: bool = True) -> Message:
    return Message(
        key="op#request",
        role=MessageRole.REQUEST,
        payload_schema=schema,
        required=required,
    )


def _subjects(losses: LossTracker) -> List[str]:
    return [loss.subject for loss in losses.records()]


# ===========================================================================
# Name derivation
# ===========================================================================


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("get_weather", "get_weather"),
        ("GET /pets/{id}", "GET_pets_id"),
        ("Query.user", "Query_user"),
        ("acme.PetService.GetPet", "acme_PetService_GetPet"),
        ("list-repos", "list-repos"),
        ("  spaced  name ", "spaced_name"),
        ("émoji✨tool", "moji_tool"),
        ("", ""),
        ("///", ""),
    ],
)
def test_sanitize_tool_name_folds_to_the_provider_charset(raw: str, expected: str) -> None:
    assert sanitize_tool_name(raw) == expected


def test_sanitize_preserves_case_so_two_identities_do_not_merge() -> None:
    assert sanitize_tool_name("getPet") == "getPet"
    assert sanitize_tool_name("GetPet") == "GetPet"


def test_namer_returns_the_identity_untouched_when_it_is_already_legal() -> None:
    namer = ToolNamer()
    outcome = namer.name_for("get_weather", source_key="k")
    assert outcome.name == "get_weather"
    assert outcome.provenance is Provenance.SOURCE
    assert not (outcome.sanitized or outcome.truncated or outcome.deduplicated)


def test_namer_reports_sanitization_as_inferred() -> None:
    outcome = ToolNamer().name_for("GET /pets/{id}", source_key="k")
    assert outcome.name == "GET_pets_id"
    assert outcome.sanitized is True
    assert outcome.provenance is Provenance.INFERRED


def test_namer_falls_back_when_the_identity_has_no_legal_character() -> None:
    outcome = ToolNamer().name_for("///", source_key="k")
    assert outcome.name == "tool"
    assert outcome.sanitized is True


def test_namer_truncates_with_a_stable_hash_suffix() -> None:
    identity = "a" * 200
    first = ToolNamer().name_for(identity, source_key="k").name
    second = ToolNamer().name_for(identity, source_key="k").name
    assert first == second
    assert len(first) == DEFAULT_MAX_NAME_LENGTH
    assert TOOL_NAME_PATTERN.fullmatch(first)


def test_truncation_keeps_two_long_shared_prefix_identities_apart() -> None:
    namer = ToolNamer()
    left = namer.name_for("x" * 80 + "left", source_key="a").name
    right = namer.name_for("x" * 80 + "right", source_key="b").name
    assert left != right


def test_namer_disambiguates_a_collision_with_a_counted_suffix() -> None:
    namer = ToolNamer()
    assert namer.name_for("search", source_key="a").name == "search"
    second = namer.name_for("search", source_key="b")
    assert second.name == "search_2"
    assert second.deduplicated is True
    assert namer.name_for("search", source_key="c").name == "search_3"


def test_a_disambiguated_name_still_fits_the_length_limit() -> None:
    namer = ToolNamer(max_length=16)
    first = namer.name_for("y" * 40, source_key="a").name
    second = namer.name_for("y" * 40, source_key="b").name
    assert len(first) <= 16 and len(second) <= 16
    assert first != second


def test_namer_records_who_claimed_each_name() -> None:
    namer = ToolNamer()
    namer.name_for("alpha", source_key="Service.alpha")
    assert namer.taken == {"alpha": "Service.alpha"}


def test_namer_rejects_a_length_limit_with_no_room_to_disambiguate() -> None:
    with pytest.raises(ValueError, match="max_length"):
        ToolNamer(max_length=4)


# ===========================================================================
# Descriptions
# ===========================================================================


def test_description_leads_with_the_summary_then_the_longer_text() -> None:
    text, redacted = assemble_tool_description(summary="List pets", description="Returns every pet.")
    assert text == "List pets\n\nReturns every pet."
    assert redacted == 0


def test_description_does_not_repeat_a_summary_copied_into_description() -> None:
    text, _ = assemble_tool_description(summary="List pets", description="List pets")
    assert text == "List pets"


def test_description_does_not_repeat_a_summary_that_prefixes_the_description() -> None:
    text, _ = assemble_tool_description(
        summary="List pets", description="List pets, newest first."
    )
    assert text == "List pets, newest first."


def test_description_is_none_when_the_source_documented_nothing() -> None:
    text, _ = assemble_tool_description(summary=None, description="   ")
    assert text is None


def test_a_deprecated_operation_says_so_in_its_description() -> None:
    text, _ = assemble_tool_description(summary="List pets", description=None, deprecated=True)
    assert text is not None and text.startswith("Deprecated. ")


def test_a_deprecated_operation_with_no_text_still_carries_the_marker() -> None:
    text, _ = assemble_tool_description(summary=None, description=None, deprecated=True)
    assert text == "Deprecated."


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("See https://user:s3cret@api.example.com/v1", "See https://[redacted]@api.example.com/v1"),
        ("Send Bearer abcdefghijklmnop1234", "Send Bearer [redacted]"),
    ],
)
def test_scrub_credentials_redacts_a_real_secret(text: str, expected: str) -> None:
    cleaned, count = scrub_credentials(text)
    assert cleaned == expected
    assert count == 1


@pytest.mark.parametrize(
    "text",
    [
        "Pass a Bearer token in the Authorization header.",
        "Set api_key to the value from your dashboard.",
        "Visit https://api.example.com/docs for the token policy.",
        "",
    ],
)
def test_scrub_credentials_leaves_ordinary_prose_alone(text: str) -> None:
    cleaned, count = scrub_credentials(text)
    assert (cleaned, count) == (text, 0)


def test_a_redacted_description_is_reported_as_a_loss() -> None:
    losses = LossTracker()
    operation = _operation(description="Call https://root:hunter2@api.example.com/v1/widgets")
    tools = project_tools(_api([operation]), losses=losses)
    assert "hunter2" not in (tools[0].description or "")
    assert LOSS_CREDENTIAL_REDACTED in _subjects(losses)


# ===========================================================================
# Credential parameters
# ===========================================================================


@pytest.mark.parametrize(
    ("name", "location", "credential"),
    [
        ("Authorization", ParameterLocation.HEADER, True),
        ("x-api-key", ParameterLocation.HEADER, True),
        ("X-Auth-Token", ParameterLocation.HEADER, True),
        ("X-Request-ID", ParameterLocation.HEADER, False),
        ("api_key", ParameterLocation.QUERY, True),
        ("access_token", ParameterLocation.QUERY, True),
        ("page", ParameterLocation.QUERY, False),
        ("session_id", ParameterLocation.COOKIE, False),
        ("token", ParameterLocation.PATH, False),
    ],
)
def test_is_credential_parameter_matches_the_snippet_tables(
    name: str, location: ParameterLocation, credential: bool
) -> None:
    assert is_credential_parameter(_parameter(name, location)) is credential


def test_a_credential_parameter_never_becomes_an_argument() -> None:
    losses = LossTracker()
    operation = _operation(
        parameters=[
            _parameter("x-api-key", ParameterLocation.HEADER, required=True),
            _parameter("q", ParameterLocation.QUERY, required=True),
        ]
    )
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=losses).for_operation(operation)
    assert set(schema["properties"]) == {"q"}
    assert LOSS_CREDENTIAL_PARAMETER in _subjects(losses)


def test_a_cookie_parameter_is_omitted_and_reported() -> None:
    losses = LossTracker()
    operation = _operation(parameters=[_parameter("session_id", ParameterLocation.COOKIE)])
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=losses).for_operation(operation)
    assert schema["properties"] == {}
    assert LOSS_COOKIE_PARAMETER in _subjects(losses)


# ===========================================================================
# Parameter + body flattening
# ===========================================================================


def test_parameters_merge_in_path_query_header_order() -> None:
    operation = _operation(
        parameters=[
            _parameter("X-Trace", ParameterLocation.HEADER),
            _parameter("q", ParameterLocation.QUERY),
            _parameter("id", ParameterLocation.PATH, required=True),
        ]
    )
    schema, provenance = ToolSchemaBuilder(_api([operation]), losses=LossTracker()).for_operation(
        operation
    )
    assert list(schema["properties"]) == ["id", "q", "X-Trace"]
    assert provenance is Provenance.INFERRED


def test_a_path_parameter_is_required_even_when_the_source_forgot_to_say_so() -> None:
    operation = _operation(parameters=[_parameter("id", ParameterLocation.PATH, required=False)])
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=LossTracker()).for_operation(operation)
    assert schema["required"] == ["id"]


def test_parameter_constraints_description_and_default_survive() -> None:
    operation = _operation(
        parameters=[
            Parameter(
                key="op#query.limit",
                name="limit",
                location=ParameterLocation.QUERY,
                type=TypeRef(name="integer"),
                description="How many to return",
                default=10,
                constraints=Constraints(minimum=1, maximum=50),
            )
        ]
    )
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=LossTracker()).for_operation(operation)
    assert schema["properties"]["limit"] == {
        "type": "integer",
        "minimum": 1,
        "maximum": 50,
        "default": 10,
        "description": "How many to return",
    }


def test_an_object_body_merges_flat_so_the_agent_calls_it_with_named_arguments() -> None:
    operation = _operation(
        parameters=[_parameter("id", ParameterLocation.PATH, required=True)],
        messages=[
            _body_message(
                {
                    "type": "object",
                    "properties": {"name": {"type": "string"}, "size": {"type": "integer"}},
                    "required": ["name"],
                }
            )
        ],
    )
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=LossTracker()).for_operation(operation)
    assert list(schema["properties"]) == ["id", "name", "size"]
    assert schema["required"] == ["id", "name"]


def test_a_non_object_body_is_nested_because_it_has_no_properties_to_merge() -> None:
    operation = _operation(
        messages=[_body_message({"type": "array", "items": {"type": "string"}})]
    )
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=LossTracker()).for_operation(operation)
    assert schema["properties"][BODY_ARGUMENT_NAME] == {
        "type": "array",
        "items": {"type": "string"},
    }
    assert schema["required"] == [BODY_ARGUMENT_NAME]


def test_a_colliding_body_property_nests_the_whole_body_and_says_so() -> None:
    losses = LossTracker()
    operation = _operation(
        parameters=[_parameter("name", ParameterLocation.QUERY)],
        messages=[
            _body_message(
                {"type": "object", "properties": {"name": {"type": "string"}}}, required=False
            )
        ],
    )
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=losses).for_operation(operation)
    assert set(schema["properties"]) == {"name", BODY_ARGUMENT_NAME}
    assert schema["properties"]["name"] == {"type": "string"}
    assert BODY_ARGUMENT_NAME not in schema.get("required", [])
    assert LOSS_BODY_NESTED in _subjects(losses)


def test_an_optional_body_is_not_listed_as_required() -> None:
    operation = _operation(
        messages=[_body_message({"type": "string"}, required=False)]
    )
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=LossTracker()).for_operation(operation)
    assert "required" not in schema


# ===========================================================================
# Named-type inlining
# ===========================================================================


def _widget_type() -> Type:
    return Type(
        key="Widget",
        name="Widget",
        kind=TypeKind.RECORD,
        description="A widget.",
        fields=[
            CanonicalField(key="Widget.id", name="id", type=TypeRef(name="string", nullable=False)),
            CanonicalField(key="Widget.label", name="label", type=TypeRef(name="string")),
        ],
    )


def test_a_named_type_is_inlined_not_referenced() -> None:
    operation = _operation(
        messages=[
            Message(
                key="op#request",
                role=MessageRole.REQUEST,
                payload=TypeRef(name="Widget", nullable=False),
                required=True,
            )
        ]
    )
    schema, _ = ToolSchemaBuilder(
        _api([operation], types=[_widget_type()]), losses=LossTracker()
    ).for_operation(operation)
    assert schema["properties"]["id"] == {"type": "string"}
    assert "$ref" not in repr(schema)


def test_a_self_referencing_type_reports_a_cycle_instead_of_a_dangling_ref() -> None:
    losses = LossTracker()
    node = Type(
        key="Node",
        name="Node",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(key="Node.child", name="child", type=TypeRef(name="Node")),
            CanonicalField(key="Node.label", name="label", type=TypeRef(name="string")),
        ],
    )
    operation = _operation(
        messages=[
            Message(key="op#request", role=MessageRole.REQUEST, payload=TypeRef(name="Node"))
        ]
    )
    schema, _ = ToolSchemaBuilder(_api([operation], types=[node]), losses=losses).for_operation(
        operation
    )
    assert "$ref" not in repr(schema)
    assert LOSS_SCHEMA_CYCLE in _subjects(losses)


def test_a_reference_to_an_undefined_type_is_reported() -> None:
    losses = LossTracker()
    operation = _operation(
        messages=[
            Message(key="op#request", role=MessageRole.REQUEST, payload=TypeRef(name="Missing"))
        ]
    )
    ToolSchemaBuilder(_api([operation]), losses=losses).for_operation(operation)
    assert LOSS_UNRESOLVED_TYPE in _subjects(losses)


def test_an_over_deep_subtree_is_pruned_and_reported() -> None:
    losses = LossTracker()
    deep: Dict[str, Any] = {"type": "string"}
    for _ in range(8):
        deep = {"type": "object", "properties": {"child": deep}}
    operation = _operation(messages=[_body_message(deep)])
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=losses).for_operation(operation)
    assert LOSS_NESTING_DEPTH in _subjects(losses)
    assert _max_depth(schema) <= DEFAULT_MAX_NESTING_DEPTH


def _max_depth(node: Any, depth: int = 1) -> int:
    """Deepest schema level in ``node``, counting the same positions the emitter does."""
    if not isinstance(node, dict):
        return depth - 1
    deepest = depth
    for key in ("properties", "patternProperties", "$defs"):
        for child in (node.get(key) or {}).values():
            deepest = max(deepest, _max_depth(child, depth + 1))
    for key in ("items", "additionalProperties", "contains"):
        child = node.get(key)
        if isinstance(child, dict):
            deepest = max(deepest, _max_depth(child, depth + 1))
    for key in ("anyOf", "oneOf", "allOf"):
        for child in node.get(key) or []:
            deepest = max(deepest, _max_depth(child, depth))
    return deepest


def test_pruning_a_properties_map_drops_the_required_names_it_orphaned() -> None:
    losses = LossTracker()
    deep: Dict[str, Any] = {
        "type": "object",
        "properties": {"leaf": {"type": "string"}},
        "required": ["leaf"],
    }
    for _ in range(6):
        deep = {"type": "object", "properties": {"child": deep}, "required": ["child"]}
    operation = _operation(messages=[_body_message(deep)])
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=losses).for_operation(operation)
    assert LOSS_REQUIRED_WITHOUT_PROPERTY in _subjects(losses)
    _assert_required_is_declared(schema)


def _assert_required_is_declared(node: Any) -> None:
    if not isinstance(node, dict):
        return
    declared = set(node.get("properties") or {})
    for name in node.get("required") or []:
        assert name in declared, f"required {name!r} has no property behind it"
    for child in (node.get("properties") or {}).values():
        _assert_required_is_declared(child)
    for key in ("items", "additionalProperties"):
        _assert_required_is_declared(node.get(key))


def _four_level_body() -> Dict[str, Any]:
    """An object body whose leaf sits exactly at the limit when merged flat."""
    return {
        "type": "object",
        "properties": {
            "a": {
                "type": "object",
                "properties": {
                    "b": {
                        "type": "object",
                        "properties": {"c": {"type": "object", "properties": {"d": {"type": "string"}}}},
                    }
                },
            }
        },
    }


def test_a_body_merged_flat_keeps_a_leaf_that_sits_at_the_limit() -> None:
    losses = LossTracker()
    operation = _operation(messages=[_body_message(_four_level_body())])
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=losses).for_operation(operation)
    leaf = schema["properties"]["a"]["properties"]["b"]["properties"]["c"]["properties"]
    assert leaf == {"d": {"type": "string"}}
    assert LOSS_NESTING_DEPTH not in _subjects(losses)


def test_nesting_the_same_body_costs_it_the_level_it_no_longer_has() -> None:
    """Depth is measured on the finished object, not on the body in isolation.

    A collision pushes the whole body one level down, so the leaf that fitted when the
    body merged flat no longer does — and the pruning is reported rather than leaving a
    schema the provider would reject.
    """
    losses = LossTracker()
    operation = _operation(
        parameters=[_parameter("a", ParameterLocation.QUERY)],
        messages=[_body_message(_four_level_body())],
    )
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=losses).for_operation(operation)
    nested = schema["properties"][BODY_ARGUMENT_NAME]["properties"]["a"]["properties"]["b"]
    assert nested["properties"]["c"] == {"type": "object"}
    assert LOSS_BODY_NESTED in _subjects(losses)
    assert LOSS_NESTING_DEPTH in _subjects(losses)
    assert _max_depth(schema) <= DEFAULT_MAX_NESTING_DEPTH


def test_a_property_named_like_a_keyword_is_not_mistaken_for_one() -> None:
    """``properties`` holds data, not keywords — the walkers must not filter it by key."""
    operation = _operation(
        messages=[
            _body_message(
                {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string"},
                        "items": {"type": "string"},
                        "required": {"type": "boolean"},
                    },
                }
            )
        ]
    )
    schema, _ = ToolSchemaBuilder(
        _api([operation]), losses=LossTracker(), strict=True
    ).for_operation(operation)
    assert set(schema["properties"]) == {"type", "items", "required"}


# ===========================================================================
# Verbatim schemas (round-trip symmetry)
# ===========================================================================


def test_an_imported_tool_bundles_own_schema_is_emitted_verbatim() -> None:
    parameters = {
        "type": "object",
        "properties": {"city": {"type": "string", "description": "City name"}},
        "required": ["city"],
    }
    operation = _operation(extras={"input_schema": parameters})
    schema, provenance = ToolSchemaBuilder(_api([operation]), losses=LossTracker()).for_operation(
        operation
    )
    assert schema == parameters
    assert provenance is Provenance.SOURCE


def test_a_message_level_parameters_bag_is_also_honoured() -> None:
    parameters = {"type": "object", "properties": {"text": {"type": "string"}}}
    operation = _operation(
        messages=[
            Message(
                key="op#request",
                role=MessageRole.REQUEST,
                extras={"llm_tools_parameters": parameters},
            )
        ]
    )
    schema, provenance = ToolSchemaBuilder(_api([operation]), losses=LossTracker()).for_operation(
        operation
    )
    assert schema == parameters
    assert provenance is Provenance.SOURCE


def test_a_verbatim_untyped_schema_is_labelled_an_object_not_wrapped() -> None:
    operation = _operation(extras={"input_schema": {"properties": {}}})
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=LossTracker()).for_operation(operation)
    assert schema == {"properties": {}, "type": "object"}


def test_a_source_ref_into_its_own_defs_is_left_alone() -> None:
    """A bundle may carry ``$defs`` of its own; those refs are not ours to resolve."""
    parameters = {
        "type": "object",
        "properties": {"pet": {"$ref": "#/$defs/Pet"}},
        "$defs": {"Pet": {"type": "object", "properties": {"name": {"type": "string"}}}},
    }
    losses = LossTracker()
    operation = _operation(extras={"input_schema": parameters})
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=losses).for_operation(operation)
    assert schema["properties"]["pet"] == {"$ref": "#/$defs/Pet"}
    assert LOSS_UNRESOLVED_TYPE not in _subjects(losses)


# ===========================================================================
# Strict schemas
# ===========================================================================


def _strict_schema(operation: Operation, losses: LossTracker, **kwargs: Any) -> Dict[str, Any]:
    schema, _ = ToolSchemaBuilder(
        _api([operation], **kwargs), losses=losses, strict=True
    ).for_operation(operation)
    return schema


def test_strict_closes_every_object_and_requires_every_property() -> None:
    losses = LossTracker()
    operation = _operation(
        parameters=[
            _parameter("id", ParameterLocation.PATH, required=True),
            _parameter("q", ParameterLocation.QUERY),
        ]
    )
    schema = _strict_schema(operation, losses)
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["id", "q"]
    assert schema["properties"]["q"]["type"] == ["string", "null"]
    assert schema["properties"]["id"]["type"] == "string"
    assert LOSS_STRICT_OPTIONAL in _subjects(losses)


def test_strict_drops_a_keyword_outside_the_subset_and_reports_it() -> None:
    losses = LossTracker()
    operation = _operation(
        messages=[
            _body_message(
                {
                    "type": "object",
                    "properties": {"name": {"type": "string", "default": "x"}},
                    "required": ["name"],
                    "unevaluatedProperties": False,
                }
            )
        ]
    )
    schema = _strict_schema(operation, losses)
    assert "default" not in schema["properties"]["name"]
    assert "unevaluatedProperties" not in schema
    assert LOSS_STRICT_KEYWORD in _subjects(losses)


def test_strict_rewrites_one_of_as_any_of_rather_than_deleting_the_alternatives() -> None:
    losses = LossTracker()
    operation = _operation(
        messages=[
            _body_message(
                {
                    "type": "object",
                    "properties": {
                        "mode": {"oneOf": [{"const": "a"}, {"const": "b"}]},
                    },
                    "required": ["mode"],
                }
            )
        ]
    )
    schema = _strict_schema(operation, losses)
    assert schema["properties"]["mode"]["anyOf"] == [{"const": "a"}, {"const": "b"}]
    assert LOSS_ONEOF_AS_ANYOF in _subjects(losses)


def test_strict_keeps_the_validation_facets_the_subset_allows() -> None:
    operation = _operation(
        parameters=[
            Parameter(
                key="op#query.limit",
                name="limit",
                location=ParameterLocation.QUERY,
                type=TypeRef(name="integer", nullable=False),
                required=True,
                constraints=Constraints(minimum=1, maximum=50, format="int32"),
            )
        ]
    )
    schema = _strict_schema(operation, LossTracker())
    assert schema["properties"]["limit"]["minimum"] == 1
    assert schema["properties"]["limit"]["format"] == "int32"


def test_strict_closes_a_free_form_stand_in_rather_than_leaving_it_open() -> None:
    losses = LossTracker()
    node = Type(
        key="Node",
        name="Node",
        kind=TypeKind.RECORD,
        fields=[CanonicalField(key="Node.child", name="child", type=TypeRef(name="Node"))],
    )
    operation = _operation(
        messages=[
            Message(key="op#request", role=MessageRole.REQUEST, payload=TypeRef(name="Node"))
        ]
    )
    schema = _strict_schema(operation, losses, types=[node])
    assert schema["properties"]["child"] == {
        "type": ["object", "null"],
        "properties": {},
        "additionalProperties": False,
    }


def test_non_strict_leaves_objects_open_and_optionality_alone() -> None:
    operation = _operation(parameters=[_parameter("q", ParameterLocation.QUERY)])
    schema, _ = ToolSchemaBuilder(_api([operation]), losses=LossTracker()).for_operation(operation)
    assert "additionalProperties" not in schema
    assert "required" not in schema
    assert schema["properties"]["q"]["type"] == "string"


# ===========================================================================
# Selection
# ===========================================================================


def test_event_and_streaming_operations_are_excluded_with_a_reason() -> None:
    losses = LossTracker()
    api = _api(
        [
            _operation("pub", name="pub", kind=OperationKind.PUBLISH),
            _operation("sub", name="sub", kind=OperationKind.SUBSCRIBE),
            _operation("stream", name="stream", streaming=StreamingMode.SERVER),
            _operation("call", name="call"),
        ]
    )
    selected = selectable_operations(api, losses=losses)
    assert [op.key for _service, op in selected] == ["call"]
    assert _subjects(losses).count(LOSS_EVENT_OPERATION) == 2
    assert LOSS_STREAMING_OPERATION in _subjects(losses)


def test_deprecated_operations_are_excluded_by_default_and_reported() -> None:
    losses = LossTracker()
    api = _api([_operation("old", name="old", deprecated=True), _operation("new", name="new")])
    selected = selectable_operations(api, losses=losses)
    assert [op.key for _service, op in selected] == ["new"]
    assert LOSS_DEPRECATED_OPERATION in _subjects(losses)


def test_deprecated_operations_are_included_on_request() -> None:
    selected = selectable_operations(
        _api([_operation("old", name="old", deprecated=True)]), include_deprecated=True
    )
    assert [op.key for _service, op in selected] == ["old"]


def test_the_tag_filter_keeps_only_matching_operations() -> None:
    losses = LossTracker()
    api = _api(
        [
            _operation("a", name="a", tags=["pets"]),
            _operation("b", name="b", tags=["orders"]),
        ]
    )
    selected = selectable_operations(api, tag="pets", losses=losses)
    assert [op.key for _service, op in selected] == ["a"]
    assert LOSS_FILTERED_OPERATION in _subjects(losses)


def test_the_path_prefix_filter_keeps_only_matching_operations() -> None:
    api = _api(
        [
            _operation("a", name="a", http_path="/v2/pets"),
            _operation("b", name="b", http_path="/v1/pets"),
            _operation("c", name="c", http_path=None),
        ]
    )
    selected = selectable_operations(api, path_prefix="/v2/")
    assert [op.key for _service, op in selected] == ["a"]


def test_selection_is_sorted_by_service_then_operation_key() -> None:
    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="X"),
        services=[
            Service(key="zeta", name="zeta", operations=[_operation("z1", name="z1")]),
            Service(
                key="alpha",
                name="alpha",
                operations=[_operation("a2", name="a2"), _operation("a1", name="a1")],
            ),
        ],
    )
    assert [op.key for _service, op in selectable_operations(api)] == ["a1", "a2", "z1"]


# ===========================================================================
# The whole projection
# ===========================================================================


def test_project_tools_is_stable_across_runs() -> None:
    api = _api([_operation("GET /a", name="a"), _operation("GET /b", name="b")])
    first = project_tools(api, losses=LossTracker())
    second = project_tools(api, losses=LossTracker())
    assert [t.name for t in first] == [t.name for t in second]
    assert [t.input_schema for t in first] == [t.input_schema for t in second]


def test_project_tools_prefers_the_operation_id_over_the_canonical_key() -> None:
    operation = _operation("GET /pets/{id}", name="GET /pets/{id}", extras={"operationId": "getPet"})
    tools = project_tools(_api([operation]), losses=LossTracker())
    assert tools[0].name == "getPet"
    assert tools[0].source_key == "GET /pets/{id}"


def test_two_operations_with_the_same_identity_get_distinct_names() -> None:
    losses = LossTracker()
    api = _api(
        [
            _operation("GET /a", name="a", extras={"operationId": "search"}),
            _operation("GET /b", name="b", extras={"operationId": "search"}),
        ]
    )
    tools = project_tools(api, losses=losses)
    assert [t.name for t in tools] == ["search", "search_2"]
    assert LOSS_TOOL_NAME_COLLISION in _subjects(losses)


def test_every_projected_name_satisfies_the_provider_grammar() -> None:
    api = _api([_operation("GET /pets/{id}", name="GET /pets/{id}")])
    tools = project_tools(api, losses=LossTracker())
    assert all(TOOL_NAME_PATTERN.fullmatch(tool.name) for tool in tools)


def test_name_losses_name_the_adjustment_that_was_made() -> None:
    losses = LossTracker()
    api = _api([_operation("GET /pets", name="GET /pets"), _operation("k", name="x" * 90)])
    project_tools(api, losses=losses)
    subjects = _subjects(losses)
    assert LOSS_TOOL_NAME_SANITIZED in subjects
    assert LOSS_TOOL_NAME_TRUNCATED in subjects


def test_a_schema_only_model_is_projected_from_its_root_record_types() -> None:
    losses = LossTracker()
    api = CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="avro",
        identity=ApiIdentity(name="Billing"),
        types=[
            _widget_type(),
            Type(
                key="Order",
                name="Order",
                kind=TypeKind.RECORD,
                fields=[
                    CanonicalField(key="Order.item", name="item", type=TypeRef(name="Widget"))
                ],
            ),
        ],
    )
    tools = project_tools(api, losses=losses)
    assert [tool.name for tool in tools] == ["Order"]
    assert tools[0].input_schema["properties"]["item"]["properties"]["id"] == {"type": "string"}
    assert LOSS_SCHEMA_ONLY_TOOL in _subjects(losses)


def test_a_schema_only_model_with_no_root_falls_back_to_every_record() -> None:
    api = CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="avro",
        identity=ApiIdentity(name="Loop"),
        types=[
            Type(
                key="A",
                name="A",
                kind=TypeKind.RECORD,
                fields=[CanonicalField(key="A.b", name="b", type=TypeRef(name="B"))],
            ),
            Type(
                key="B",
                name="B",
                kind=TypeKind.RECORD,
                fields=[CanonicalField(key="B.a", name="a", type=TypeRef(name="A"))],
            ),
        ],
    )
    tools = project_tools(api, losses=LossTracker())
    assert [tool.name for tool in tools] == ["A", "B"]


def test_a_model_with_operations_never_falls_back_to_types() -> None:
    api = _api([_operation("GET /a", name="a")], types=[_widget_type()])
    tools = project_tools(api, losses=LossTracker())
    assert [tool.name for tool in tools] == ["a"]


def test_a_model_with_nothing_callable_projects_nothing() -> None:
    api = _api([_operation("pub", name="pub", kind=OperationKind.PUBLISH)])
    assert project_tools(api, losses=LossTracker()) == []

"""Tests for the LLM tool-array emitter — FMT-2.5 (#5423).

Exercises the ticket's acceptance criteria:

* **All three modes emit and validate against the respective provider tool schema** —
  every mode, over every corpus source format the engine can import, is re-checked with
  :func:`~app.llm_tool_schema.tool_array_violations`, which is the vendored equivalent of
  the provider's own acceptance rules.
* **Round-trip through the ``llm-tools`` importer preserves tool names, descriptions and
  parameter schemas** — every hand-authored ``llm-tools`` corpus fixture is imported,
  emitted in each mode and re-imported, and the resulting tool surfaces are compared with
  :func:`~app.tool_surface_compare.tool_surface_fingerprint`.
* **Tool names are deterministic, unique within a document, and stable across runs** —
  the same model is emitted twice by two emitter instances and compared byte for byte,
  and a document with colliding identities is asserted to produce distinct names.
* **Provider constraint violations are reported as losses, never emitted** — the emitted
  document is asserted valid *and* the matching loss is asserted present, for the name
  charset, the name length, the nesting depth and the strict keyword subset.
* **No security-scheme secret or server credential is ever included in a tool
  description** — a model carrying credentials in its servers, its security extras and
  its parameters is emitted and every secret string is asserted absent from the document.

The two committed corpus fixtures (``llm-tools/07-emitted-openai-tools.json`` and
``…/08-emitted-anthropic-strict.json``) are asserted to be exactly what the emitter
writes today, so output that changes without the corpus being regenerated fails here.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
    Server,
    Service,
    StreamingMode,
    Type,
    TypeKind,
    TypeRef,
)
from app.emitter import (
    EmitOptions,
    EmitOptionsError,
    LossKind,
    Provenance,
    coerce_emit_options,
    describe_emit_targets,
    get_emitter,
    load_builtin_emitters,
)
from app.import_source import get_import_source, load_builtin_import_sources
from app.llm_tool_schema import TOOL_MODES, tool_array_violations
from app.llm_tools_emitter import (
    LLM_TOOLS_FORMAT_KEY,
    OUTPUT_FILENAME,
    LlmToolsEmitOptions,
    LlmToolsEmitter,
    LlmToolsFidelityRulePack,
    detect_tool_mode,
    render_tool_entry,
    validate_llm_tools_document,
)
from app.llm_tools_normalizer import LlmToolsNormalizer
from app.llm_tools_parser import parse_llm_tools
from app.roundtrip_matrix import import_source_text
from app.tool_projection import (
    LOSS_NESTING_DEPTH,
    LOSS_STRICT_KEYWORD,
    LOSS_TOOL_NAME_COLLISION,
    LOSS_TOOL_NAME_SANITIZED,
    LOSS_TOOL_NAME_TRUNCATED,
    TOOL_NAME_PATTERN,
    ToolDefinition,
)
from app.tool_surface_compare import project_llm_tools_operation, tool_surface_fingerprint

EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui" / "examples"
LLM_TOOLS_EXAMPLES = EXAMPLES / "llm-tools"
OPENAPI_SOURCE = EXAMPLES / "openapi" / "31-paths-comprehensive.yaml"


# ===========================================================================
# Helpers
# ===========================================================================


def emit(api: CanonicalApi, **options: Any) -> Any:
    """Emit ``api`` with the given options."""
    return LlmToolsEmitter().emit(api, opts=LlmToolsEmitOptions(**options))


def document(api: CanonicalApi, **options: Any) -> List[Dict[str, Any]]:
    """Emit ``api`` and return the parsed tool array."""
    return json.loads(emit(api, **options).files[0].content)


def subjects(result: Any) -> List[str]:
    return [loss.subject for loss in result.losses]


def import_openapi(path: Path = OPENAPI_SOURCE) -> CanonicalApi:
    load_builtin_import_sources()
    adapter = get_import_source("openapi")
    assert adapter is not None
    return import_source_text(adapter, path.read_text(), source_label=path.name)


def import_llm_tools(path: Path) -> CanonicalApi:
    return LlmToolsNormalizer().normalize(
        parse_llm_tools(path.read_text(), source_label=path.name)
    )


def llm_tools_fixtures() -> List[Path]:
    return sorted(LLM_TOOLS_EXAMPLES.glob("*.json"))


def _operation(
    key: str,
    *,
    name: Optional[str] = None,
    parameters: Optional[List[Parameter]] = None,
    description: Optional[str] = None,
    extras: Optional[Dict[str, Any]] = None,
    deprecated: bool = False,
    tags: Optional[List[str]] = None,
    http_path: Optional[str] = None,
    kind: OperationKind = OperationKind.REQUEST_RESPONSE,
    streaming: StreamingMode = StreamingMode.NONE,
    messages: Optional[List[Message]] = None,
) -> Operation:
    return Operation(
        key=key,
        name=name or key,
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
    operations: List[Operation],
    *,
    servers: Optional[List[Server]] = None,
    channels: Optional[List[Channel]] = None,
    types: Optional[List[Type]] = None,
    extras: Optional[Dict[str, Any]] = None,
) -> CanonicalApi:
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="Widgets"),
        title="Widgets",
        servers=servers or [],
        channels=channels or [],
        services=[Service(key="Widgets", name="Widgets", operations=operations)],
        types=types or [],
        extras=extras or {},
    )


# ===========================================================================
# Registration
# ===========================================================================


def test_the_emitter_is_registered_under_the_import_adapter_key() -> None:
    load_builtin_emitters()
    assert get_emitter(LLM_TOOLS_FORMAT_KEY) is LlmToolsEmitter


def test_the_target_is_listed_for_the_ui_and_cli() -> None:
    target = next(
        t for t in describe_emit_targets() if t.descriptor.key == LLM_TOOLS_FORMAT_KEY
    )
    assert target.descriptor.paradigm is ApiParadigm.AGENT
    assert target.descriptor.multi_file is False
    assert target.descriptor.needs_toolchain is False
    assert target.descriptor.available is True
    assert set(target.options_schema["properties"]) == {
        "mode",
        "tag",
        "path_prefix",
        "include_deprecated",
        "strict_schema",
    }
    assert target.default_options["mode"] == "openai"


def test_the_capability_profile_states_what_a_tool_array_carries() -> None:
    profile = LlmToolsEmitter.capability_profile()
    assert profile.operations is True
    assert profile.events is False
    assert profile.unions is True
    assert profile.constraints is True
    assert profile.field_identity is False


def test_the_fidelity_pack_is_the_tool_array_pack() -> None:
    assert LlmToolsEmitter.fidelity_rule_pack() is LlmToolsFidelityRulePack


def test_the_result_is_one_json_file() -> None:
    result = emit(_api([_operation("GET /a", name="listA")]))
    assert [file.path for file in result.files] == [OUTPUT_FILENAME]
    assert result.media_type == "application/json"
    assert result.files[0].content.endswith("\n")


# ===========================================================================
# Options
# ===========================================================================


def test_the_defaults_are_the_openai_dialect_without_strict_schemas() -> None:
    defaults = LlmToolsEmitter.default_options()
    assert isinstance(defaults, LlmToolsEmitOptions)
    assert (defaults.mode, defaults.strict_schema, defaults.include_deprecated) == (
        "openai",
        False,
        False,
    )
    assert defaults.tag is None and defaults.path_prefix is None


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_every_documented_mode_is_accepted(mode: str) -> None:
    assert LlmToolsEmitOptions(mode=mode).mode == mode


def test_an_unknown_mode_is_rejected_by_the_options_model() -> None:
    with pytest.raises(ValueError, match="mode must be one of"):
        LlmToolsEmitOptions(mode="gemini")


def test_an_unknown_mode_through_the_registry_is_a_422() -> None:
    with pytest.raises(EmitOptionsError):
        coerce_emit_options(LlmToolsEmitter, {"mode": "gemini"})


def test_an_unknown_option_key_is_rejected() -> None:
    with pytest.raises(EmitOptionsError):
        coerce_emit_options(LlmToolsEmitter, {"dialect": "openai"})


def test_a_blank_filter_means_no_filter_rather_than_match_nothing() -> None:
    options = LlmToolsEmitOptions(tag="  ", path_prefix="")
    assert options.tag is None and options.path_prefix is None


def test_the_base_options_envelope_is_accepted_and_defaults_applied() -> None:
    result = LlmToolsEmitter().emit(_api([_operation("GET /a", name="listA")]), opts=EmitOptions())
    assert json.loads(result.files[0].content)[0]["type"] == "function"


def test_emit_without_options_uses_the_defaults() -> None:
    result = LlmToolsEmitter().emit(_api([_operation("GET /a", name="listA")]))
    assert json.loads(result.files[0].content)[0]["type"] == "function"


# ===========================================================================
# The three dialects
# ===========================================================================


def test_openai_mode_wraps_the_tool_in_a_function_object() -> None:
    entries = document(_api([_operation("GET /a", name="listA", description="List A.")]))
    assert entries == [
        {
            "type": "function",
            "function": {
                "name": "listA",
                "description": "List A.",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]


def test_anthropic_mode_uses_input_schema() -> None:
    entries = document(
        _api([_operation("GET /a", name="listA", description="List A.")]), mode="anthropic"
    )
    assert entries == [
        {
            "name": "listA",
            "description": "List A.",
            "input_schema": {"type": "object", "properties": {}},
        }
    ]


def test_bare_mode_uses_parameters_without_a_wrapper() -> None:
    entries = document(
        _api([_operation("GET /a", name="listA", description="List A.")]), mode="bare"
    )
    assert entries == [
        {
            "name": "listA",
            "description": "List A.",
            "parameters": {"type": "object", "properties": {}},
        }
    ]


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_a_tool_with_no_documentation_omits_the_description_key(mode: str) -> None:
    entry = document(_api([_operation("GET /a", name="listA")]), mode=mode)[0]
    target = entry["function"] if mode == "openai" else entry
    assert "description" not in target


def test_only_openai_declares_the_strict_flag_on_the_wire() -> None:
    tool = ToolDefinition(
        name="t",
        description=None,
        input_schema={"type": "object", "properties": {}},
        source_key="k",
        source_name="t",
    )
    assert render_tool_entry(tool, mode="openai", strict=True)["function"]["strict"] is True
    assert "strict" not in render_tool_entry(tool, mode="anthropic", strict=True)
    assert "strict" not in render_tool_entry(tool, mode="bare", strict=True)


def test_rendering_an_unknown_mode_raises() -> None:
    tool = ToolDefinition(
        name="t",
        description=None,
        input_schema={"type": "object", "properties": {}},
        source_key="k",
        source_name="t",
    )
    with pytest.raises(ValueError, match="Unknown tool mode"):
        render_tool_entry(tool, mode="gemini")


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_the_three_modes_describe_the_same_tools(mode: str) -> None:
    api = import_openapi()
    entries = document(api, mode=mode)
    names = [(e["function"] if mode == "openai" else e)["name"] for e in entries]
    baseline = [e["function"]["name"] for e in document(api)]
    assert names == baseline


# ===========================================================================
# Provider-schema validity (AC 1)
# ===========================================================================


@pytest.mark.parametrize("mode", TOOL_MODES)
@pytest.mark.parametrize("strict", [False, True])
@pytest.mark.parametrize("fixture", llm_tools_fixtures(), ids=lambda p: p.name)
def test_every_llm_tools_fixture_emits_a_valid_array(
    fixture: Path, mode: str, strict: bool
) -> None:
    api = import_llm_tools(fixture)
    entries = document(api, mode=mode, strict_schema=strict)
    assert tool_array_violations(entries, mode=mode) == []


@pytest.mark.parametrize("mode", TOOL_MODES)
@pytest.mark.parametrize("strict", [False, True])
def test_an_openapi_source_emits_a_valid_array(mode: str, strict: bool) -> None:
    entries = document(import_openapi(), mode=mode, strict_schema=strict)
    assert tool_array_violations(entries, mode=mode) == []


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_every_emitted_name_satisfies_the_provider_grammar(mode: str) -> None:
    entries = document(import_openapi(), mode=mode)
    names = [(e["function"] if mode == "openai" else e)["name"] for e in entries]
    assert all(TOOL_NAME_PATTERN.fullmatch(name) for name in names)


# ===========================================================================
# Round-trip (AC 2)
# ===========================================================================


@pytest.mark.parametrize("mode", TOOL_MODES)
@pytest.mark.parametrize("fixture", llm_tools_fixtures(), ids=lambda p: p.name)
def test_a_bundle_round_trips_through_the_importer_unchanged(fixture: Path, mode: str) -> None:
    api = import_llm_tools(fixture)
    before = {op.name: project_llm_tools_operation(op) for op in api.operations()}

    emitted = emit(api, mode=mode).files[0].content
    reimported = LlmToolsNormalizer().normalize(
        parse_llm_tools(emitted, source_label=OUTPUT_FILENAME)
    )
    after = {op.name: project_llm_tools_operation(op) for op in reimported.operations()}

    assert set(after) == set(before), "tool names changed across the round trip"
    for name, surface in before.items():
        assert tool_surface_fingerprint(after[name]) == tool_surface_fingerprint(surface), (
            f"tool {name!r} changed across the round trip"
        )


@pytest.mark.parametrize("mode", TOOL_MODES)
def test_the_re_imported_bundle_reports_the_mode_it_was_written_in(mode: str) -> None:
    api = import_llm_tools(LLM_TOOLS_EXAMPLES / "03-mixed-dialects.json")
    reimported = LlmToolsNormalizer().normalize(
        parse_llm_tools(emit(api, mode=mode).files[0].content, source_label=OUTPUT_FILENAME)
    )
    assert reimported.extras["dialects"] == [mode]


def test_collapsing_a_mixed_dialect_bundle_is_reported_as_a_loss() -> None:
    api = import_llm_tools(LLM_TOOLS_EXAMPLES / "03-mixed-dialects.json")
    assert "mixed-dialect-collapsed" in subjects(emit(api))


def test_a_single_dialect_bundle_reports_no_dialect_loss() -> None:
    api = import_llm_tools(LLM_TOOLS_EXAMPLES / "01-minimal-openai.json")
    assert "mixed-dialect-collapsed" not in subjects(emit(api))


def test_an_openapi_source_round_trips_to_the_same_tool_surface() -> None:
    """Re-emitting a re-imported array reproduces every tool, verbatim.

    Only the *order* differs: an imported bundle keys its operations by tool name, so a
    second emit walks them alphabetically rather than in the OpenAPI path order the first
    one used. The tools themselves must be identical, which is what the round trip is
    for.
    """
    api = import_openapi()
    emitted = emit(api).files[0].content
    reimported = LlmToolsNormalizer().normalize(
        parse_llm_tools(emitted, source_label=OUTPUT_FILENAME)
    )
    assert [op.name for op in reimported.operations()] == sorted(
        e["function"]["name"] for e in json.loads(emitted)
    )
    by_name = {e["function"]["name"]: e for e in json.loads(emitted)}
    again = {e["function"]["name"]: e for e in json.loads(emit(reimported).files[0].content)}
    assert again == by_name


# ===========================================================================
# Determinism (AC 3)
# ===========================================================================


def test_two_emitters_produce_byte_identical_output() -> None:
    api = import_openapi()
    first = LlmToolsEmitter().emit(api).files[0].content
    second = LlmToolsEmitter().emit(api).files[0].content
    assert first == second


def test_provenance_and_losses_are_stable_across_runs() -> None:
    api = import_openapi()
    first = LlmToolsEmitter().emit(api)
    second = LlmToolsEmitter().emit(api)
    assert [(r.pointer, r.provenance) for r in first.provenance] == [
        (r.pointer, r.provenance) for r in second.provenance
    ]
    assert [(loss.kind, loss.subject, loss.detail) for loss in first.losses] == [
        (loss.kind, loss.subject, loss.detail) for loss in second.losses
    ]


def test_names_are_unique_within_one_document() -> None:
    api = _api(
        [
            _operation("GET /a", name="a", extras={"operationId": "search"}),
            _operation("GET /b", name="b", extras={"operationId": "search"}),
            _operation("GET /c", name="c", extras={"operationId": "search"}),
        ]
    )
    result = emit(api)
    names = [e["function"]["name"] for e in json.loads(result.files[0].content)]
    assert names == ["search", "search_2", "search_3"]
    assert len(set(names)) == len(names)
    assert LOSS_TOOL_NAME_COLLISION in subjects(result)


def test_tool_order_follows_the_canonical_key_order() -> None:
    api = _api(
        [
            _operation("GET /zebra", name="zebra"),
            _operation("GET /apple", name="apple"),
        ]
    )
    names = [e["function"]["name"] for e in json.loads(emit(api).files[0].content)]
    assert names == ["apple", "zebra"]


# ===========================================================================
# Constraint violations are reported, never emitted (AC 4)
# ===========================================================================


def test_a_name_outside_the_charset_is_rewritten_and_reported() -> None:
    result = emit(_api([_operation("GET /pets/{id}", name="GET /pets/{id}")]))
    entries = json.loads(result.files[0].content)
    assert entries[0]["function"]["name"] == "GET_pets_id"
    assert LOSS_TOOL_NAME_SANITIZED in subjects(result)
    assert tool_array_violations(entries, mode="openai") == []


def test_an_over_long_name_is_shortened_and_reported() -> None:
    result = emit(_api([_operation("k", name="x" * 200)]))
    entries = json.loads(result.files[0].content)
    assert len(entries[0]["function"]["name"]) == 64
    assert LOSS_TOOL_NAME_TRUNCATED in subjects(result)
    assert tool_array_violations(entries, mode="openai") == []


def test_an_over_deep_schema_is_pruned_and_reported() -> None:
    deep: Dict[str, Any] = {"type": "string"}
    for _ in range(9):
        deep = {"type": "object", "properties": {"child": deep}}
    api = _api(
        [
            _operation(
                "POST /deep",
                name="deep",
                messages=[
                    Message(
                        key="POST /deep#request",
                        role=MessageRole.REQUEST,
                        payload_schema=deep,
                        required=True,
                    )
                ],
            )
        ]
    )
    result = emit(api)
    assert LOSS_NESTING_DEPTH in subjects(result)
    assert tool_array_violations(json.loads(result.files[0].content), mode="openai") == []


def test_a_strict_emit_reports_the_keywords_it_dropped() -> None:
    result = emit(import_openapi(), strict_schema=True)
    assert LOSS_STRICT_KEYWORD in subjects(result)
    entries = json.loads(result.files[0].content)
    assert tool_array_violations(entries, mode="openai") == []
    assert all(entry["function"]["strict"] is True for entry in entries)


def test_every_loss_carries_a_kind_and_an_explanation() -> None:
    result = emit(import_openapi(), strict_schema=True)
    assert result.losses
    for loss in result.losses:
        assert loss.kind in (LossKind.NA, LossKind.INFERRED)
        assert loss.detail.strip()


# ===========================================================================
# Credentials never reach the document (AC 5)
# ===========================================================================


def test_no_server_or_security_credential_reaches_the_emitted_document() -> None:
    api = _api(
        [
            _operation(
                "GET /a",
                name="listA",
                description="Reach it at https://svc:hunter2@api.example.com/v1.",
                parameters=[
                    Parameter(
                        key="GET /a#header.Authorization",
                        name="Authorization",
                        location=ParameterLocation.HEADER,
                        type=TypeRef(name="string"),
                        required=True,
                    ),
                    Parameter(
                        key="GET /a#query.api_key",
                        name="api_key",
                        location=ParameterLocation.QUERY,
                        type=TypeRef(name="string"),
                        required=True,
                    ),
                    Parameter(
                        key="GET /a#query.q",
                        name="q",
                        location=ParameterLocation.QUERY,
                        type=TypeRef(name="string"),
                    ),
                ],
                extras={"security": ["bearer"]},
            )
        ],
        servers=[Server(url="https://admin:s3cr3t@api.example.com/v1", name="prod")],
        extras={"inferred_auth_schemes": ["bearer"]},
    )
    result = emit(api)
    content = result.files[0].content
    for secret in ("hunter2", "s3cr3t", "admin:", "svc:"):
        assert secret not in content, f"{secret!r} leaked into the tool array"
    entry = json.loads(content)[0]
    assert set(entry["function"]["parameters"]["properties"]) == {"q"}
    assert "credential-parameter-omitted" in subjects(result)
    assert "security-scheme" in subjects(result)
    assert "server-binding" in subjects(result)


def test_the_security_loss_names_the_schemes_it_dropped() -> None:
    api = _api([_operation("GET /a", name="listA")], extras={"inferred_auth_schemes": ["bearer"]})
    loss = next(loss for loss in emit(api).losses if loss.subject == "security-scheme")
    assert "'bearer'" in loss.detail


# ===========================================================================
# Filters and deprecation
# ===========================================================================


def test_the_tag_filter_selects_the_operations_it_names() -> None:
    api = _api(
        [
            _operation("GET /pets", name="listPets", tags=["pets"]),
            _operation("GET /orders", name="listOrders", tags=["orders"]),
        ]
    )
    result = emit(api, tag="pets")
    assert [e["function"]["name"] for e in json.loads(result.files[0].content)] == ["listPets"]
    assert "filtered-operation" in subjects(result)


def test_the_path_prefix_filter_selects_the_operations_it_names() -> None:
    api = _api(
        [
            _operation("GET /v2/pets", name="listV2", http_path="/v2/pets"),
            _operation("GET /v1/pets", name="listV1", http_path="/v1/pets"),
        ]
    )
    entries = json.loads(emit(api, path_prefix="/v2/").files[0].content)
    assert [e["function"]["name"] for e in entries] == ["listV2"]


def test_a_filter_that_excludes_everything_fails_loudly() -> None:
    api = _api([_operation("GET /pets", name="listPets", tags=["pets"])])
    with pytest.raises(ValueError, match="requires at least one callable"):
        emit(api, tag="orders")


def test_a_deprecated_operation_is_excluded_by_default() -> None:
    api = _api(
        [
            _operation("GET /new", name="listNew"),
            _operation("GET /old", name="listOld", deprecated=True),
        ]
    )
    result = emit(api)
    assert [e["function"]["name"] for e in json.loads(result.files[0].content)] == ["listNew"]
    assert "deprecated-operation-omitted" in subjects(result)


def test_an_included_deprecated_operation_says_so_in_its_description() -> None:
    api = _api([_operation("GET /old", name="listOld", deprecated=True, description="Old list.")])
    result = emit(api, include_deprecated=True)
    entry = json.loads(result.files[0].content)[0]
    assert entry["function"]["description"] == "Deprecated. Old list."
    assert "deprecated-flag-in-description" in subjects(result)


# ===========================================================================
# What a tool array cannot carry
# ===========================================================================


def test_an_event_only_model_refuses_to_emit_rather_than_writing_an_empty_array() -> None:
    api = _api([_operation("pub", name="pub", kind=OperationKind.PUBLISH)])
    with pytest.raises(ValueError, match="requires at least one callable"):
        emit(api)


def test_a_channel_is_reported_as_unrepresentable() -> None:
    api = _api(
        [_operation("GET /a", name="listA")],
        channels=[Channel(key="user/signedup", address="user/signedup")],
    )
    assert "event-channel" in subjects(emit(api))


def test_a_streaming_operation_is_dropped_with_a_reason() -> None:
    api = _api(
        [
            _operation("GET /a", name="listA"),
            _operation("Stream", name="stream", streaming=StreamingMode.SERVER),
        ]
    )
    result = emit(api)
    assert [e["function"]["name"] for e in json.loads(result.files[0].content)] == ["listA"]
    assert "streaming-operation" in subjects(result)


def test_a_declared_response_is_reported_as_not_carried() -> None:
    api = _api(
        [
            _operation(
                "GET /a",
                name="listA",
                messages=[
                    Message(
                        key="GET /a#response.200",
                        role=MessageRole.RESPONSE,
                        payload_schema={"type": "object"},
                        status_code="200",
                    )
                ],
            )
        ]
    )
    assert "response-schema" in subjects(emit(api))


def test_a_schema_only_model_is_projected_from_its_types_and_says_so() -> None:
    widget = Type(
        key="Widget",
        name="Widget",
        kind=TypeKind.RECORD,
        fields=[
            CanonicalField(key="Widget.id", name="id", type=TypeRef(name="string", nullable=False))
        ],
    )
    api = CanonicalApi(
        paradigm=ApiParadigm.DATA_SCHEMA,
        format="avro",
        identity=ApiIdentity(name="Widgets"),
        types=[widget],
    )
    result = emit(api)
    entry = json.loads(result.files[0].content)[0]
    assert entry["function"]["name"] == "Widget"
    assert entry["function"]["parameters"]["properties"]["id"] == {"type": "string"}
    assert "synthesized-schema-tool" in subjects(result)


# ===========================================================================
# Fidelity rules
# ===========================================================================


def _pack() -> LlmToolsFidelityRulePack:
    return LlmToolsFidelityRulePack(
        LlmToolsEmitter.capability_profile(), LlmToolsEmitter.label
    )


def test_the_pack_drops_an_event_operation() -> None:
    verdict = _pack().operation_verdict(_operation("pub", name="pub", kind=OperationKind.PUBLISH))
    assert verdict.kind.value == "drop"


def test_the_pack_drops_a_streaming_operation() -> None:
    verdict = _pack().operation_verdict(
        _operation("s", name="s", streaming=StreamingMode.BIDIRECTIONAL)
    )
    assert verdict.kind.value == "drop"


def test_the_pack_keeps_an_ordinary_operation() -> None:
    assert _pack().operation_verdict(_operation("GET /a", name="a")).kind.value == "ok"


def test_the_pack_drops_a_channel() -> None:
    verdict = _pack().channel_verdict(Channel(key="c", address="c"))
    assert verdict.kind.value == "drop"


def test_the_pack_calls_a_named_type_an_approximation_because_it_is_inlined() -> None:
    verdict = _pack().type_verdict(Type(key="Widget", name="Widget", kind=TypeKind.RECORD))
    assert verdict.kind.value == "approx"
    assert "inlined" in verdict.message


# ===========================================================================
# Provenance
# ===========================================================================


def test_provenance_points_into_the_emitted_array() -> None:
    api = _api([_operation("GET /a", name="listA", description="List A.")])
    pointers = {record.pointer for record in emit(api).provenance}
    assert pointers == {"/0/function/name", "/0/function/description", "/0/function/parameters"}


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        ("anthropic", {"/0/name", "/0/input_schema"}),
        ("bare", {"/0/name", "/0/parameters"}),
    ],
)
def test_provenance_pointers_follow_the_dialect(mode: str, expected: set) -> None:
    api = _api([_operation("GET /a", name="listA")])
    pointers = {record.pointer for record in emit(api, mode=mode).provenance}
    assert pointers == expected


def test_a_verbatim_schema_is_recorded_as_source_provenance() -> None:
    api = import_llm_tools(LLM_TOOLS_EXAMPLES / "01-minimal-openai.json")
    record = next(r for r in emit(api).provenance if r.pointer.endswith("/parameters"))
    assert record.provenance is Provenance.SOURCE


def test_an_assembled_schema_is_recorded_as_inferred_provenance() -> None:
    api = _api([_operation("GET /a", name="listA")])
    record = next(r for r in emit(api).provenance if r.pointer.endswith("/parameters"))
    assert record.provenance is Provenance.INFERRED
    assert record.detail is not None


def test_a_rewritten_name_is_recorded_as_inferred_with_its_source() -> None:
    api = _api([_operation("GET /pets/{id}", name="GET /pets/{id}")])
    record = next(r for r in emit(api).provenance if r.pointer.endswith("/name"))
    assert record.provenance is Provenance.INFERRED
    assert "GET /pets/{id}" in (record.detail or "")


# ===========================================================================
# Committed corpus fixtures
# ===========================================================================


@pytest.mark.parametrize(
    ("fixture", "options"),
    [
        ("07-emitted-openai-tools.json", {"mode": "openai"}),
        ("08-emitted-anthropic-strict.json", {"mode": "anthropic", "strict_schema": True}),
    ],
)
def test_the_committed_corpus_fixture_is_exactly_what_the_emitter_writes(
    fixture: str, options: Dict[str, Any]
) -> None:
    expected = (LLM_TOOLS_EXAMPLES / fixture).read_text()
    assert emit(import_openapi(), **options).files[0].content == expected, (
        f"{fixture} is stale — re-emit it from {OPENAPI_SOURCE.name} with {options}"
    )


@pytest.mark.parametrize(
    "fixture", ["07-emitted-openai-tools.json", "08-emitted-anthropic-strict.json"]
)
def test_the_committed_corpus_fixture_re_imports(fixture: str) -> None:
    api = import_llm_tools(LLM_TOOLS_EXAMPLES / fixture)
    assert api.operations()


# ---------------------------------------------------------------------------
# The post-emit validation gate — FMT-2.7 (#5425)
# ---------------------------------------------------------------------------


def test_the_validator_accepts_an_array_this_emitter_wrote_in_every_dialect() -> None:
    """The gate's checker agrees with the emitter's own pre-flight, mode by mode."""
    api = import_openapi()
    for mode in TOOL_MODES:
        result = LlmToolsEmitter().emit(api, opts=LlmToolsEmitOptions(mode=mode))
        validate_llm_tools_document(str(result.files[0].content))


def test_the_validator_checks_the_dialect_the_document_declares_not_the_one_it_is_told() -> None:
    """An Anthropic tool is held to Anthropic's rules even with no options in sight.

    Detecting the mode from the artifact is what makes the gate independent of how the
    document was produced: a bare array checked as OpenAI would skip the rules the
    provider it is headed to actually applies.
    """
    anthropic = json.dumps(
        [
            {
                "name": "list_widgets",
                "description": "d",
                "input_schema": {"type": "object", "properties": {}},
            }
        ]
    )
    assert detect_tool_mode(json.loads(anthropic)) == "anthropic"
    validate_llm_tools_document(anthropic)


def test_the_validator_rejects_an_argument_schema_that_is_not_an_object() -> None:
    broken = json.dumps([{"name": "list_widgets", "description": "d", "input_schema": []}])
    with pytest.raises(ValueError):
        validate_llm_tools_document(broken)


def test_the_validator_rejects_a_document_that_is_not_a_tool_array() -> None:
    with pytest.raises(ValueError, match="Invalid LLM tool array"):
        validate_llm_tools_document(json.dumps({"openapi": "3.1.0", "paths": {}}))

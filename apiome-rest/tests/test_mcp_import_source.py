"""The ``mcp`` import-source adapter and its normalizer — FMT-1.7 (#5418)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.canonical_model import ApiParadigm, OperationKind, ParameterLocation
from app.fileset import IntakeFileset
from app.import_source import (
    DetectionInput,
    ImportSourceError,
    InputKind,
    describe_import_sources,
    detect_import_source,
    get_import_source,
    load_builtin_import_sources,
    resolve_import_source_key,
)
from app.mcp_import_source import McpImportSource
from app.mcp_manifest_normalizer import PROVENANCE_DECLARED
from app.mcp_manifest_parser import manifest_surface
from app.normalizer import get_normalizer

load_builtin_import_sources()

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/mcp"
_MINIMAL = (_EXAMPLES / "01-minimal-echo-tool.json").read_text(encoding="utf-8")
_TYPICAL = (_EXAMPLES / "02-typical-tickets-server.json").read_text(encoding="utf-8")
_STRESS = (_EXAMPLES / "04-stress-grammar-corners.json").read_text(encoding="utf-8")


@pytest.fixture
def adapter() -> McpImportSource:
    return McpImportSource()


# ---------------------------------------------------------------------------
# Registration (the ticket's first acceptance criterion)
# ---------------------------------------------------------------------------


def test_adapter_is_registered_under_mcp() -> None:
    source = get_import_source("mcp")
    assert source is not None
    assert source.key == "mcp"
    assert resolve_import_source_key("MCP") == "mcp"


def test_descriptor_appears_in_the_import_source_registry() -> None:
    descriptor = next(d for d in describe_import_sources() if d.key == "mcp")
    assert descriptor.paradigm is ApiParadigm.AGENT
    assert descriptor.supports_live_discovery is False
    assert descriptor.formats == ["mcp"]
    assert InputKind.FILE in descriptor.input_kinds
    assert InputKind.PASTE in descriptor.input_kinds
    assert InputKind.URL in descriptor.input_kinds
    assert InputKind.FILESET in descriptor.input_kinds
    assert ".mcp.json" in descriptor.file_extensions
    assert descriptor.available is True


def test_the_mcp_normalizer_is_registered() -> None:
    assert get_normalizer("mcp") is not None


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def test_detect_claims_a_manifest_at_high_confidence(adapter: McpImportSource) -> None:
    result = adapter.detect(DetectionInput(text=_TYPICAL))
    assert result.matched
    assert result.format == "mcp"
    assert result.confidence >= 0.9


def test_detect_reads_a_pre_parsed_document(adapter: McpImportSource) -> None:
    result = adapter.detect(DetectionInput(document=json.loads(_TYPICAL)))
    assert result.matched


def test_detect_falls_back_to_the_conventional_extension(adapter: McpImportSource) -> None:
    result = adapter.detect(DetectionInput(filename="server.mcp.json"))
    assert result.matched
    assert result.confidence < 0.9


def test_detect_declines_an_llm_tool_bundle(adapter: McpImportSource) -> None:
    bundle = json.dumps([{"name": "echo", "parameters": {"type": "object"}}])
    assert not adapter.detect(DetectionInput(text=bundle)).matched


def test_registry_detection_routes_a_manifest_to_this_adapter() -> None:
    """The whole-registry sniff must pick `mcp`, not a neighbouring JSON adapter."""
    match = detect_import_source(DetectionInput(text=_TYPICAL, filename="server.json"))
    assert match is not None
    assert match[0].key == "mcp"


def test_the_llm_tools_adapter_does_not_claim_a_manifest() -> None:
    """The two agent-paradigm adapters must not fight over one document."""
    llm_tools = get_import_source("llm-tools")
    assert not llm_tools.detect(DetectionInput(text=_TYPICAL)).matched


# ---------------------------------------------------------------------------
# Parse / normalize
# ---------------------------------------------------------------------------


def test_parse_rejects_a_broken_manifest_with_its_taxonomy_code(
    adapter: McpImportSource,
) -> None:
    with pytest.raises(ImportSourceError) as exc:
        adapter.parse('{"mcpVersion":"2025-06-18","tools":[{"name":"a"}]}')
    assert exc.value.code == "INPUT_SEMANTIC_INVALID"


def test_normalize_rejects_a_foreign_ast(adapter: McpImportSource) -> None:
    with pytest.raises(ImportSourceError):
        adapter.normalize({"not": "a manifest"})


def test_normalize_produces_an_agent_paradigm_model(adapter: McpImportSource) -> None:
    api = adapter.normalize(adapter.parse(_MINIMAL))
    assert api.paradigm is ApiParadigm.AGENT
    assert api.format == "mcp"
    assert api.protocol == "mcp"
    assert api.identity.name == "echo"


def test_each_capability_kind_becomes_its_own_service(adapter: McpImportSource) -> None:
    api = adapter.normalize(adapter.parse(_TYPICAL))
    names = {service.name for service in api.services}
    assert names == {"tools", "resources", "prompts"}


def test_a_kind_the_manifest_omits_produces_no_service(adapter: McpImportSource) -> None:
    api = adapter.normalize(adapter.parse(_MINIMAL))
    assert [service.name for service in api.services] == ["tools"]


def test_every_operation_is_stamped_declared(adapter: McpImportSource) -> None:
    api = adapter.normalize(adapter.parse(_TYPICAL))
    operations = [op for service in api.services for op in service.operations]
    assert operations
    assert all(op.extras["provenance"] == PROVENANCE_DECLARED for op in operations)
    assert api.extras["provenance"] == PROVENANCE_DECLARED


def test_a_tool_carries_its_input_and_output_schemas(adapter: McpImportSource) -> None:
    composition = (_EXAMPLES / "03-composition-shared-schemas.json").read_text(encoding="utf-8")
    api = adapter.normalize(adapter.parse(composition))
    tools = next(s for s in api.services if s.name == "tools")
    check_stock = next(op for op in tools.operations if op.name == "check_stock")
    roles = {message.role.value for message in check_stock.messages}
    assert roles == {"request", "response"}
    request = next(m for m in check_stock.messages if m.role.value == "request")
    assert request.payload_schema["properties"]["sku"]["pattern"] == "^[A-Z]{3}-[0-9]{4}$"


def test_resource_template_variables_become_parameters(adapter: McpImportSource) -> None:
    """`lab://run/{runId}/report{?format}` states one path and one query variable."""
    api = adapter.normalize(adapter.parse(_STRESS))
    resources = next(s for s in api.services if s.name == "resources")
    report = next(op for op in resources.operations if op.name == "run-report")
    by_name = {p.name: p for p in report.parameters}
    assert by_name["runId"].location is ParameterLocation.PATH
    assert by_name["runId"].required is True
    assert by_name["format"].location is ParameterLocation.QUERY
    assert by_name["format"].required is False


def test_a_concrete_resource_has_no_parameters_and_states_its_media_type(
    adapter: McpImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_TYPICAL))
    resources = next(s for s in api.services if s.name == "resources")
    queue = next(op for op in resources.operations if op.name == "frontline-queue")
    assert queue.parameters == []
    assert queue.extras["uri"] == "tickets://queues/frontline"
    assert queue.messages[0].content_types == ["application/json"]
    assert queue.messages[0].payload is None


def test_prompt_arguments_become_parameters_with_their_required_flag(
    adapter: McpImportSource,
) -> None:
    api = adapter.normalize(adapter.parse(_TYPICAL))
    prompts = next(s for s in api.services if s.name == "prompts")
    summarize = next(op for op in prompts.operations if op.name == "summarize_ticket")
    by_name = {p.name: p.required for p in summarize.parameters}
    assert by_name == {"ticketId": True, "audience": False}


def test_every_operation_is_request_response(adapter: McpImportSource) -> None:
    api = adapter.normalize(adapter.parse(_TYPICAL))
    operations = [op for service in api.services for op in service.operations]
    assert all(op.kind is OperationKind.REQUEST_RESPONSE for op in operations)


def test_the_declared_transport_becomes_the_model_server(adapter: McpImportSource) -> None:
    api = adapter.normalize(adapter.parse(_TYPICAL))
    assert [server.url for server in api.servers] == ["https://mcp.example.com/tickets"]


def test_a_manifest_with_no_transport_invents_no_server(adapter: McpImportSource) -> None:
    api = adapter.normalize(adapter.parse(_MINIMAL))
    assert api.servers == []


def test_the_surface_fingerprint_travels_on_the_model(adapter: McpImportSource) -> None:
    document = adapter.parse(_TYPICAL)
    api = adapter.normalize(document)
    assert api.extras["mcp_surface_fingerprint"] == manifest_surface(document).fingerprint()


def test_capability_counts_are_recorded_on_the_model(adapter: McpImportSource) -> None:
    api = adapter.normalize(adapter.parse(_TYPICAL))
    assert api.extras["tool_count"] == 3
    assert api.extras["resource_count"] == 1
    assert api.extras["resource_template_count"] == 1
    assert api.extras["prompt_count"] == 1


def test_normalization_is_deterministic(adapter: McpImportSource) -> None:
    first = adapter.normalize(adapter.parse(_TYPICAL))
    second = adapter.normalize(adapter.parse(_TYPICAL))
    assert adapter.fingerprint(first) == adapter.fingerprint(second)


def test_include_raw_false_drops_the_fidelity_bag(adapter: McpImportSource) -> None:
    api = adapter.normalize(adapter.parse(_TYPICAL), include_raw=False)
    assert api.raw is None


# ---------------------------------------------------------------------------
# Fileset intake
# ---------------------------------------------------------------------------


def test_parse_fileset_resolves_sibling_schemas(adapter: McpImportSource) -> None:
    members = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted((_EXAMPLES / "06-split-set").iterdir())
    }
    document = adapter.parse_fileset(IntakeFileset.from_members(members, root="manifest.json"))
    api = adapter.normalize(document)
    tools = next(s for s in api.services if s.name == "tools")
    assert {op.name for op in tools.operations} == {"get_invoice", "issue_credit_note"}


def test_parse_fileset_rejects_an_empty_set(adapter: McpImportSource) -> None:
    with pytest.raises(ImportSourceError) as exc:
        adapter.parse_fileset(IntakeFileset(root="manifest.json", members={}))
    assert exc.value.code == "INPUT_MALFORMED"


# ---------------------------------------------------------------------------
# Lint (the paradigm-agnostic default must work over an agent model)
# ---------------------------------------------------------------------------


def test_the_default_lint_scores_a_manifest_model(adapter: McpImportSource) -> None:
    report = adapter.lint(adapter.normalize(adapter.parse(_TYPICAL)))
    assert 0 <= report.score <= 100
    assert report.report_fingerprint

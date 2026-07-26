"""Tests for LLM tool / function-calling import adapter — IXH-7.3 (#5128)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.canonical_model import ApiParadigm
from app.format_lint_capabilities import MODE_NATIVE, capability_for_format
from app.import_source import DetectionInput, ImportSourceError, get_import_source
from app.llm_tools_import_source import LlmToolsImportSource
from app.llm_tools_lint import lint_llm_tools
from app.llm_tools_parser import classify_tool_dialect, is_llm_tools, parse_llm_tools
from app.lint_engine import available_lint_formats

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/llm-tools"
_MINIMAL = (_EXAMPLES / "01-minimal-openai.json").read_text(encoding="utf-8")
_ANTHROPIC = (_EXAMPLES / "02-typical-anthropic.json").read_text(encoding="utf-8")
_MIXED = (_EXAMPLES / "03-mixed-dialects.json").read_text(encoding="utf-8")
_WRAPPER = (_EXAMPLES / "06-tools-wrapper-object.json").read_text(encoding="utf-8")


@pytest.fixture
def adapter() -> LlmToolsImportSource:
    return LlmToolsImportSource()


def test_adapter_registered() -> None:
    assert get_import_source("llm-tools") is not None
    assert get_import_source("llm-tools").key == "llm-tools"


def test_detect_claims_openai_high_confidence(adapter: LlmToolsImportSource) -> None:
    result = adapter.detect(DetectionInput(text=_MINIMAL))
    assert result.matched
    assert result.format == "llm-tools"
    assert result.confidence >= 0.95


def test_detect_declines_openapi_and_json_schema(adapter: LlmToolsImportSource) -> None:
    openapi = '{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{}}'
    assert not adapter.detect(DetectionInput(text=openapi)).matched
    json_schema = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}'
    assert not adapter.detect(DetectionInput(text=json_schema)).matched


def test_is_llm_tools_helpers() -> None:
    assert is_llm_tools(_MINIMAL)
    assert is_llm_tools(_ANTHROPIC)
    assert is_llm_tools(_MIXED)
    assert is_llm_tools(_WRAPPER)
    assert not is_llm_tools('{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{}}')


def test_classify_dialects() -> None:
    assert (
        classify_tool_dialect(
            {"type": "function", "function": {"name": "a", "parameters": {"type": "object"}}}
        )
        == "openai"
    )
    assert (
        classify_tool_dialect(
            {"name": "b", "input_schema": {"type": "object", "properties": {}}}
        )
        == "anthropic"
    )
    assert (
        classify_tool_dialect({"name": "c", "parameters": {"type": "object", "properties": {}}})
        == "bare"
    )
    # MCP camelCase without other cues is declined.
    assert (
        classify_tool_dialect({"name": "d", "inputSchema": {"type": "object", "properties": {}}})
        is None
    )


def test_parse_normalize_minimal(adapter: LlmToolsImportSource) -> None:
    native = adapter.parse(_MINIMAL, source_label="01-minimal-openai.json")
    assert len(native.tools) == 1
    assert native.tools[0].dialect == "openai"
    assert native.tools[0].name == "get_weather"
    model = adapter.normalize(native)
    assert model.format == "llm-tools"
    assert model.paradigm == ApiParadigm.AGENT
    assert len(model.services) == 1
    assert len(model.services[0].operations) == 1
    op = model.services[0].operations[0]
    assert op.name == "get_weather"
    assert op.extras.get("dialect") == "openai"
    assert isinstance(op.extras.get("input_schema"), dict)


def test_mixed_dialects_normalized_with_per_tool_provenance(
    adapter: LlmToolsImportSource,
) -> None:
    model = adapter.normalize(adapter.parse(_MIXED))
    dialects = {op.extras.get("dialect") for svc in model.services for op in svc.operations}
    assert dialects == {"openai", "anthropic", "bare"}
    assert model.extras.get("mixed_dialect_policy") == "normalize_per_tool"
    assert set(model.extras.get("dialects") or []) == {"anthropic", "bare", "openai"}


def test_tools_wrapper_object(adapter: LlmToolsImportSource) -> None:
    native = adapter.parse(_WRAPPER)
    assert len(native.tools) >= 1
    model = adapter.normalize(native)
    assert model.format == "llm-tools"
    assert model.services[0].operations


def test_parse_rejects_missing_name(adapter: LlmToolsImportSource) -> None:
    bad = (_EXAMPLES / "negative/02-semantic-missing-name.json").read_text(encoding="utf-8")
    with pytest.raises(ImportSourceError, match="name|recognized"):
        adapter.parse(bad)


def test_parse_rejects_syntactic_json(adapter: LlmToolsImportSource) -> None:
    bad = (_EXAMPLES / "negative/01-syntactic-unclosed-array.json").read_text(encoding="utf-8")
    with pytest.raises(ImportSourceError):
        adapter.parse(bad)


def test_parse_rejects_wrong_format_openapi(adapter: LlmToolsImportSource) -> None:
    bad = (_EXAMPLES / "negative/04-wrong-format-openapi.json").read_text(encoding="utf-8")
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse(bad)
    assert exc_info.value.code == "FORMAT_MISMATCH"


def test_lint_pack_registered_and_runs() -> None:
    assert "llm-tools" in available_lint_formats()
    assert capability_for_format("llm-tools").mode == MODE_NATIVE
    result = lint_llm_tools(_MINIMAL)
    assert result is not None


def test_lint_flags_duplicate_and_missing_descriptions() -> None:
    raw = """
[
  {
    "name": "dup",
    "parameters": {
      "type": "object",
      "properties": {
        "mode": {
          "type": "string",
          "description": "Must be one of: fast, slow"
        },
        "q": {"type": "string"}
      },
      "required": ["missing", "q", "q"]
    }
  },
  {
    "type": "function",
    "function": {
      "name": "dup",
      "parameters": {"type": "object", "properties": {}}
    }
  }
]
"""
    result = lint_llm_tools(raw)
    rules = {f.rule for f in result.findings}
    assert "llm-tools.duplicate-tool-name" in rules
    assert "llm-tools.tool-missing-description" in rules
    assert "llm-tools.param-missing-description" in rules
    assert "llm-tools.prefer-enum-over-freetext" in rules
    assert "llm-tools.required-field-hygiene" in rules

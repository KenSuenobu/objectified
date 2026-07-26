"""LLM tool / function-calling bundle parser — IXH-7.3 (#5128).

Parses the common agent artifact shapes into a typed :class:`LlmToolsDocument`:

* **OpenAI** — ``{type: "function", function: {name, description, parameters}}``
* **Anthropic** — ``{name, description, input_schema}``
* **Bare** — ``{name, parameters}`` (and optional ``description``)

**Mixed-dialect policy:** a single bundle may mix dialects. Each tool records its
own dialect as provenance; the document lists the distinct dialects present.
Bundles are never rejected solely for mixing dialects.

Accepted document shapes: a top-level JSON array of tools, or an object with a
``tools`` array. OpenAPI / plain JSON Schema / MCP wire listings (camelCase
``inputSchema`` without OpenAI/Anthropic cues) are declined.

Unlike most ImportSource parsers, this one accepts a **top-level JSON array**
(the most common shape in the wild). :func:`app.import_ingestion.parse_document`
rejects arrays, so parsing is local to this module.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import yaml

from .intake_resource_guard import IntakeLimitError, guard_document_text, guard_parsed_document

__all__ = [
    "LlmToolsParseError",
    "LlmToolDialect",
    "LlmTool",
    "LlmToolsDocument",
    "classify_tool_dialect",
    "is_llm_tools",
    "is_llm_tools_document",
    "parse_llm_tools",
]

LlmToolDialect = str  # "openai" | "anthropic" | "bare"

_API_MARKERS = ("openapi", "swagger", "asyncapi", "arazzo", "openrpc")


class LlmToolsParseError(ValueError):
    """Raised when an LLM tool bundle cannot be parsed."""

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class LlmTool:
    """One normalized tool drawn from any supported dialect."""

    name: str
    description: Optional[str]
    parameters: Dict[str, Any]
    dialect: LlmToolDialect
    raw: Dict[str, Any]


@dataclass(frozen=True)
class LlmToolsDocument:
    """A parsed tool bundle ready for normalization."""

    title: str
    tools: Tuple[LlmTool, ...]
    dialects: Tuple[LlmToolDialect, ...]
    raw: str
    source_label: Optional[str] = None


def _optional_str(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _is_schema_object(value: Any) -> bool:
    return isinstance(value, Mapping)


def classify_tool_dialect(entry: Mapping[str, Any]) -> Optional[LlmToolDialect]:
    """Return the dialect for one tool object, or ``None`` if it is not a tool.

    Detection order (first match wins): OpenAI, Anthropic, bare.
    """
    if entry.get("type") == "function":
        function = entry.get("function")
        if isinstance(function, Mapping):
            name = function.get("name")
            if isinstance(name, str) and name.strip():
                return "openai"

    name = entry.get("name")
    if isinstance(name, str) and name.strip():
        if _is_schema_object(entry.get("input_schema")):
            return "anthropic"
        if _is_schema_object(entry.get("inputSchema")) and "parameters" not in entry:
            return None
        if _is_schema_object(entry.get("parameters")):
            return "bare"

    return None


def _extract_tool_list(document: Any) -> Optional[List[Any]]:
    """Return the tool array from a parsed document, or ``None`` if shape is wrong."""
    if isinstance(document, list):
        return document
    if isinstance(document, Mapping):
        if any(marker in document for marker in _API_MARKERS):
            return None
        if "$schema" in document or document.get("kind") == "discovery#restDescription":
            return None
        if "discoveryVersion" in document:
            return None
        tools = document.get("tools")
        if isinstance(tools, list):
            return tools
    return None


def _looks_like_tool_list(items: Sequence[Any]) -> bool:
    """True when every mapping item classifies as a supported tool dialect."""
    if not items:
        return False
    mappings = [item for item in items if isinstance(item, Mapping)]
    if not mappings:
        return False
    return all(classify_tool_dialect(item) is not None for item in mappings)


def is_llm_tools_document(document: Any) -> bool:
    """Return ``True`` when a parsed value looks like an LLM tool bundle."""
    items = _extract_tool_list(document)
    if items is None:
        return False
    return _looks_like_tool_list(items)


def _loads_document(content: str, *, source_label: Optional[str] = None) -> Any:
    """Parse JSON or YAML, allowing a top-level array or mapping."""
    where = f" ({source_label})" if source_label else ""
    try:
        guard_document_text(content, source_label=source_label)
    except IntakeLimitError as exc:
        raise LlmToolsParseError(str(exc), code="INPUT_MALFORMED") from exc

    try:
        parsed: Any = json.loads(content)
    except json.JSONDecodeError:
        try:
            parsed = yaml.safe_load(content)
        except Exception as exc:  # noqa: BLE001 - surface as parse error
            raise LlmToolsParseError(
                f"LLM tool bundle is not valid JSON or YAML{where}: {exc}",
                code="INPUT_MALFORMED",
            ) from exc

    try:
        guard_parsed_document(parsed, source_label=source_label)
    except IntakeLimitError as exc:
        raise LlmToolsParseError(str(exc), code="INPUT_MALFORMED") from exc

    return parsed


def is_llm_tools(content: str) -> bool:
    """Return ``True`` when ``content`` looks like an LLM tool bundle."""
    if not content or not isinstance(content, str) or not content.strip():
        return False
    if "\x00" in content[:256]:
        return False
    try:
        document = _loads_document(content)
    except LlmToolsParseError:
        return False
    return is_llm_tools_document(document)


def _title_from_label(source_label: Optional[str]) -> str:
    if not source_label:
        return "tools"
    base = source_label.rsplit("/", 1)[-1]
    for suffix in (".json", ".yaml", ".yml"):
        if base.lower().endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base.strip() or "tools"


def _tool_from_entry(entry: Mapping[str, Any], dialect: LlmToolDialect) -> LlmTool:
    if dialect == "openai":
        function = entry.get("function")
        assert isinstance(function, Mapping)
        name = str(function["name"]).strip()
        description = _optional_str(function.get("description"))
        parameters = function.get("parameters")
        if not isinstance(parameters, dict):
            parameters = {"type": "object", "properties": {}}
        return LlmTool(
            name=name,
            description=description,
            parameters=dict(parameters),
            dialect=dialect,
            raw=dict(entry),
        )

    name = str(entry["name"]).strip()
    description = _optional_str(entry.get("description"))
    if dialect == "anthropic":
        parameters = entry.get("input_schema")
    else:
        parameters = entry.get("parameters")
    if not isinstance(parameters, dict):
        parameters = {"type": "object", "properties": {}}
    return LlmTool(
        name=name,
        description=description,
        parameters=dict(parameters),
        dialect=dialect,
        raw=dict(entry),
    )


def parse_llm_tools(content: str, *, source_label: Optional[str] = None) -> LlmToolsDocument:
    """Parse an LLM tool bundle into an :class:`LlmToolsDocument`.

    Args:
        content: Raw JSON (or YAML) text of the bundle.
        source_label: Optional filename / URL used for the service title.

    Returns:
        A typed document with per-tool dialect provenance.

    Raises:
        LlmToolsParseError: When the content is empty, malformed, wrong-format,
            or contains no classifiable tools.
    """
    if not content or not content.strip():
        raise LlmToolsParseError(
            "Invalid or empty LLM tool bundle",
            code="INPUT_MALFORMED",
        )

    if content.startswith("\ufeff") and "\x00" in content[:64]:
        raise LlmToolsParseError(
            "LLM tool bundle is not valid UTF-8 (looks like UTF-16)",
            code="INPUT_ENCODING_INVALID",
        )
    if "\x00" in content[:256]:
        raise LlmToolsParseError(
            "LLM tool bundle contains NUL bytes; expected UTF-8 text",
            code="INPUT_ENCODING_INVALID",
        )

    document = _loads_document(content, source_label=source_label)

    if isinstance(document, Mapping) and any(marker in document for marker in _API_MARKERS):
        raise LlmToolsParseError(
            "Content looks like an API description (OpenAPI/Swagger/AsyncAPI/…), "
            "not an LLM tool bundle",
            code="FORMAT_MISMATCH",
        )

    items = _extract_tool_list(document)
    if items is None:
        raise LlmToolsParseError(
            "Content does not appear to be an LLM tool bundle "
            "(expected a tool array or an object with a `tools` array)",
            code="FORMAT_MISMATCH",
        )

    tools: List[LlmTool] = []
    for index, item in enumerate(items):
        if not isinstance(item, Mapping):
            raise LlmToolsParseError(
                f"Tool entry at index {index} is not an object",
                code="INPUT_MALFORMED",
            )
        dialect = classify_tool_dialect(item)
        if dialect is None:
            raise LlmToolsParseError(
                f"Tool entry at index {index} is not a recognized OpenAI, Anthropic, "
                "or bare tool shape (needs name + parameters/input_schema, or "
                "type:function with function.name)",
                code="INPUT_MALFORMED",
            )
        tool = _tool_from_entry(item, dialect)
        if not tool.name:
            raise LlmToolsParseError(
                f"Tool entry at index {index} is missing a non-empty name",
                code="INPUT_MALFORMED",
            )
        tools.append(tool)

    if not tools:
        raise LlmToolsParseError(
            "LLM tool bundle contains no tools",
            code="INPUT_MALFORMED",
        )

    dialects = tuple(sorted({tool.dialect for tool in tools}))
    return LlmToolsDocument(
        title=_title_from_label(source_label),
        tools=tuple(tools),
        dialects=dialects,
        raw=content,
        source_label=source_label,
    )


def dumps_tools_for_raw(document: LlmToolsDocument) -> Any:
    """Best-effort re-parse of the raw text for the fidelity bag."""
    try:
        return json.loads(document.raw)
    except json.JSONDecodeError:
        try:
            return yaml.safe_load(document.raw)
        except Exception:  # noqa: BLE001
            return document.raw

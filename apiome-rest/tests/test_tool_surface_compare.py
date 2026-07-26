"""Tests for MCP ↔ llm-tools tool-surface comparability — IXH-7.3 (#5128)."""

from __future__ import annotations

from app.llm_tools_import_source import LlmToolsImportSource
from app.mcp_client.normalize import CapabilityItem
from app.tool_surface_compare import (
    project_llm_tools_operation,
    project_mcp_tool,
    surfaces_equivalent,
    tool_surface_fingerprint,
)


def test_equivalent_mcp_and_llm_tools_fingerprints() -> None:
    schema = {
        "type": "object",
        "properties": {
            "city": {"type": "string", "description": "City name"},
        },
        "required": ["city"],
    }
    mcp = CapabilityItem.from_tool(
        {
            "name": "get_weather",
            "description": "Look up weather for a city",
            "inputSchema": schema,
        },
        ordinal=0,
    )
    bundle = """
[
  {
    "name": "get_weather",
    "description": "Look up weather for a city",
    "parameters": {
      "type": "object",
      "properties": {
        "city": {"type": "string", "description": "City name"}
      },
      "required": ["city"]
    }
  }
]
"""
    model = LlmToolsImportSource().normalize(LlmToolsImportSource().parse(bundle))
    op = model.services[0].operations[0]

    mcp_surface = project_mcp_tool(mcp)
    llm_surface = project_llm_tools_operation(op)
    assert mcp_surface["name"] == llm_surface["name"]
    assert mcp_surface["description"] == llm_surface["description"]
    assert mcp_surface["inputSchema"] == llm_surface["inputSchema"]
    assert surfaces_equivalent(mcp_surface, llm_surface)
    assert tool_surface_fingerprint(mcp_surface).startswith("sha256:")


def test_fingerprint_sensitive_to_schema_change() -> None:
    left = {
        "name": "t",
        "description": "d",
        "inputSchema": {"type": "object", "properties": {"a": {"type": "string"}}},
    }
    right = {
        "name": "t",
        "description": "d",
        "inputSchema": {"type": "object", "properties": {"a": {"type": "integer"}}},
    }
    assert tool_surface_fingerprint(left) != tool_surface_fingerprint(right)

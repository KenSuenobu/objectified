"""Shared tool-surface projection for MCP ↔ llm-tools comparability — IXH-7.3 (#5128).

An MCP server's tools (``CapabilityItem`` with ``item_type=tool``) and a bare LLM
tool bundle's canonical operations both describe named callables with a JSON Schema
argument object. This module projects both into one comparable surface —

``{name, description, inputSchema}`` —

and fingerprints that surface with sorted-key JSON + SHA-256 so the two catalogs
can be matched without a DB link table.

The field set aligns with the MCP tool fingerprint subset of
:data:`app.mcp_client.normalize.FINGERPRINT_FIELDS` (``name``, ``description``,
``inputSchema``); ``title`` / ``outputSchema`` / ``annotations`` are omitted because
bare LLM tool arrays rarely carry them.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Mapping, Optional, TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from .canonical_model import Operation
    from .mcp_client.normalize import CapabilityItem

__all__ = [
    "ToolSurface",
    "project_mcp_tool",
    "project_llm_tools_operation",
    "tool_surface_fingerprint",
]


#: Comparable projection of one tool (MCP or llm-tools).
ToolSurface = Dict[str, Any]


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def project_mcp_tool(item: "CapabilityItem") -> ToolSurface:
    """Project an MCP tool :class:`~app.mcp_client.normalize.CapabilityItem`."""
    if item.item_type != "tool":
        raise ValueError(f"Expected MCP item_type='tool', got {item.item_type!r}")
    return {
        "name": item.name,
        "description": item.description,
        "inputSchema": item.input_schema,
    }


def project_llm_tools_operation(operation: "Operation") -> ToolSurface:
    """Project an llm-tools canonical :class:`~app.canonical_model.Operation`."""
    extras = operation.extras or {}
    schema = extras.get("input_schema")
    if not isinstance(schema, dict):
        schema = None
        for message in operation.messages:
            bag = message.extras or {}
            params = bag.get("llm_tools_parameters")
            if isinstance(params, dict):
                schema = params
                break
    return {
        "name": operation.name,
        "description": operation.description,
        "inputSchema": schema,
    }


def tool_surface_fingerprint(surface: Mapping[str, Any]) -> str:
    """Return a stable ``sha256:`` fingerprint of a tool surface projection.

    Args:
        surface: A mapping with at least ``name``, ``description``, ``inputSchema``.

    Returns:
        A ``sha256:<hex>`` string over the sorted-key JSON of those three fields.
    """
    projection = {
        "name": surface.get("name"),
        "description": surface.get("description"),
        "inputSchema": surface.get("inputSchema"),
    }
    digest = hashlib.sha256(_canonical_json(projection).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def surfaces_equivalent(
    left: Mapping[str, Any],
    right: Mapping[str, Any],
) -> bool:
    """True when two tool surfaces fingerprint identically."""
    return tool_surface_fingerprint(left) == tool_surface_fingerprint(right)

"""LLM tool bundle → canonical model normalizer — IXH-7.3 (#5128).

Maps a parsed :class:`~app.llm_tools_parser.LlmToolsDocument` into a
:class:`~app.canonical_model.CanonicalApi` of paradigm
:attr:`~app.canonical_model.ApiParadigm.AGENT`.

Each tool becomes one :class:`~app.canonical_model.Operation` under a single
agent-paradigm :class:`~app.canonical_model.Service`. Parameter JSON Schemas are
coerced into canonical types via :class:`~app.normalizer.SchemaCoercer`. Per-tool
``dialect`` is recorded on ``operation.extras``; the bundle lists distinct
dialects on ``CanonicalApi.extras.dialects``.
"""

from __future__ import annotations

from typing import Any, Dict, List

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Service,
    StreamingMode,
)
from .llm_tools_parser import LlmToolsDocument, dumps_tools_for_raw
from .normalizer import Keys, Normalizer, SchemaCoercer, normalize_ordering

__all__ = ["LlmToolsNormalizer"]

_FORMAT_KEY = "llm-tools"
_REF_PREFIX = "#/components/schemas/"


def _component_name(tool_name: str) -> str:
    """Stable components key for a tool's parameters schema."""
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in tool_name)
    return f"{safe}Params"


class LlmToolsNormalizer(Normalizer, register=True):
    """Normalize a parsed LLM tool bundle into a :class:`CanonicalApi`."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.AGENT

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(source, LlmToolsDocument):
            raise ValueError(
                "LLM tools source must be an LlmToolsDocument "
                "(see app.llm_tools_parser.parse_llm_tools)"
            )

        components: Dict[str, Any] = {}
        for tool in source.tools:
            components[_component_name(tool.name)] = tool.parameters

        coercer = SchemaCoercer(components=components, ref_prefix=_REF_PREFIX)
        service_key = Keys.type(source.title, None)
        operations: List[Operation] = []

        for tool in source.tools:
            op_key = Keys.operation_rpc(service_key, tool.name)
            component = _component_name(tool.name)
            payload = coercer.type_ref(
                {"$ref": f"{_REF_PREFIX}{component}"},
                required=True,
            )
            messages = [
                Message(
                    key=Keys.request_message(op_key),
                    role=MessageRole.REQUEST,
                    payload=payload,
                    required=True,
                    extras={
                        "llm_tools_parameters": tool.parameters,
                        "llm_tools_dialect": tool.dialect,
                    },
                )
            ]
            operations.append(
                Operation(
                    key=op_key,
                    name=tool.name,
                    kind=OperationKind.REQUEST_RESPONSE,
                    streaming=StreamingMode.NONE,
                    description=tool.description,
                    messages=messages,
                    extras={
                        "dialect": tool.dialect,
                        "input_schema": tool.parameters,
                    },
                )
            )

        services = [
            Service(
                key=service_key,
                name=source.title,
                operations=operations,
                description="LLM tool / function-calling bundle",
            )
        ]

        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            protocol="llm-tools",
            identity=ApiIdentity(name=source.title),
            title=source.title,
            description="Imported LLM tool / function-calling schema bundle",
            services=services,
            types=coercer.named_types_from_components(),
            raw={"llm-tools": dumps_tools_for_raw(source)} if include_raw else None,
            extras={
                "dialects": list(source.dialects),
                "tool_count": len(source.tools),
                "mixed_dialect_policy": "normalize_per_tool",
            },
        )
        return normalize_ordering(api)

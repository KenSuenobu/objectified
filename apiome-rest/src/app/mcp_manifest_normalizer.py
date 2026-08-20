"""MCP server manifest → canonical model normalizer — FMT-1.7 (#5418).

Maps a parsed :class:`~app.mcp_manifest_parser.McpManifestDocument` onto a
:class:`~app.canonical_model.CanonicalApi` of paradigm
:attr:`~app.canonical_model.ApiParadigm.AGENT`, so a manifest-imported MCP server lands
in the multi-format catalog beside an LLM tool bundle rather than only in the MCP
catalog's own tables.

Shape of the projection
-----------------------
An MCP server offers four *kinds* of capability, and collapsing them into one flat list
would lose the distinction the catalog is for. Each kind that the manifest declares
becomes its own :class:`~app.canonical_model.Service`:

* **tools** — one :class:`~app.canonical_model.Operation` per tool. ``inputSchema``
  becomes the request message's payload type, ``outputSchema`` (2025-06-18+) the response
  message's; both are also kept verbatim on the message's ``extras`` so nothing a coercion
  cannot model is lost.
* **resources** and **resource templates** — one read operation per entry, addressed by
  ``uri`` / ``uriTemplate``. A template's RFC 6570 variables are promoted to
  :class:`~app.canonical_model.Parameter`\\s, so ``lab://run/{runId}/report{?format}``
  yields a path parameter and a query parameter rather than one opaque string.
* **prompts** — one operation per prompt, with its declared ``arguments`` as parameters.

Declared, not observed
----------------------
Every entity this normalizer emits carries ``extras["provenance"] = "declared"``. The
gateway adapters established the convention (:mod:`app.gateway_config_normalizer` stamps
``"inferred"`` on the operations it derives rather than reads); this is the same idea one
step over. A manifest is the *operator's* statement about a server, and a probe is
Apiome's *observation* of one. They are frequently identical and occasionally not, and the
catalog must never present the first as if it were the second — so the stamp rides on the
model itself, not on a report generated beside it.

The surface fingerprint travels with the model
----------------------------------------------
``CanonicalApi.extras["mcp_surface_fingerprint"]`` carries the
:meth:`~app.mcp_client.normalize.DiscoverySurface.fingerprint` of the declared surface.
That is what lets a manifest import recognise the endpoint a probe already catalogued —
identical fingerprints mean identical offerings — without re-deriving the surface
downstream.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
    Server,
    Service,
    StreamingMode,
    TypeRef,
)
from .mcp_manifest_parser import (
    McpManifestDocument,
    dumps_manifest_for_raw,
    manifest_surface,
)
from .normalizer import Keys, Normalizer, SchemaCoercer, normalize_ordering

__all__ = ["FORMAT_KEY", "PROVENANCE_DECLARED", "McpManifestNormalizer"]

#: The normalizer / import-source registry key for static MCP manifests.
FORMAT_KEY = "mcp"

#: The provenance stamp every entity from a manifest carries. Its counterpart,
#: :data:`app.mcp_surface_provenance.PROVENANCE_OBSERVED`, marks facts a probe watched.
PROVENANCE_DECLARED = "declared"

#: JSON-Pointer prefix the emitted component ``$ref``s use.
_REF_PREFIX = "#/components/schemas/"

#: RFC 6570 expression, e.g. ``{runId}`` or ``{?format,page}``.
_URI_TEMPLATE_EXPRESSION = re.compile(r"\{([^{}]+)\}")

#: RFC 6570 operators that introduce *query* parameters; every other operator (and the
#: bare form) addresses part of the path.
_QUERY_OPERATORS = frozenset({"?", "&"})

#: The RFC 6570 operator characters that may lead an expression.
_TEMPLATE_OPERATORS = frozenset({"+", "#", ".", "/", ";", "?", "&", "="})


def _component_name(prefix: str, name: str, suffix: str) -> str:
    """Build a stable components key for one capability's schema.

    Args:
        prefix: The capability kind (``Tool``/``Prompt``), so a tool and a prompt of the
            same name cannot collide.
        name: The capability's programmatic name.
        suffix: ``Input`` or ``Output``.

    Returns:
        A key safe for a JSON Pointer segment (every character outside
        ``[A-Za-z0-9._-]`` becomes ``_``).
    """
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name)
    return f"{prefix}{safe}{suffix}"


def _template_variables(template: str) -> Tuple[Tuple[str, ParameterLocation], ...]:
    """Extract an RFC 6570 URI Template's variables and where each is carried.

    Args:
        template: A URI Template such as ``lab://run/{runId}/report{?format,page}``.

    Returns:
        ``(name, location)`` per variable, in template order and de-duplicated. Variables
        behind ``?``/``&`` are query parameters; everything else addresses the path.
        Explode (``*``) and prefix (``:3``) modifiers are stripped from the name.
    """
    found: List[Tuple[str, ParameterLocation]] = []
    seen: Dict[str, None] = {}
    for expression in _URI_TEMPLATE_EXPRESSION.findall(template or ""):
        if not expression:
            continue
        operator = expression[0] if expression[0] in _TEMPLATE_OPERATORS else ""
        body = expression[1:] if operator else expression
        location = (
            ParameterLocation.QUERY if operator in _QUERY_OPERATORS else ParameterLocation.PATH
        )
        for variable in body.split(","):
            name = variable.strip().split(":", 1)[0].rstrip("*").strip()
            if not name or name in seen:
                continue
            seen[name] = None
            found.append((name, location))
    return tuple(found)


def _text(value: Any) -> Optional[str]:
    """Return ``value`` when it is a non-blank string, else ``None``."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


class McpManifestNormalizer(Normalizer, register=True):
    """Normalize a parsed static MCP server manifest into a :class:`CanonicalApi`."""

    format = FORMAT_KEY
    paradigm = ApiParadigm.AGENT

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Map a manifest onto the canonical agent-paradigm model.

        Args:
            source: The :class:`~app.mcp_manifest_parser.McpManifestDocument` to map.
            include_raw: When ``True`` the manifest is preserved in ``raw``.

        Returns:
            The order-normalized :class:`CanonicalApi`.

        Raises:
            ValueError: When ``source`` is not a parsed manifest.
        """
        if not isinstance(source, McpManifestDocument):
            raise ValueError(
                "MCP manifest source must be an McpManifestDocument "
                "(see app.mcp_manifest_parser.parse_mcp_manifest)"
            )

        components: Dict[str, Any] = {}
        for tool in source.tools:
            name = str(tool.get("name") or "")
            input_schema = tool.get("inputSchema")
            if isinstance(input_schema, Mapping):
                components[_component_name("Tool", name, "Input")] = dict(input_schema)
            output_schema = tool.get("outputSchema")
            if isinstance(output_schema, Mapping):
                components[_component_name("Tool", name, "Output")] = dict(output_schema)

        coercer = SchemaCoercer(components=components, ref_prefix=_REF_PREFIX)
        root_key = Keys.type(source.title, None)

        services: List[Service] = []
        tool_ops = self._tool_operations(source, root_key, coercer)
        if tool_ops:
            services.append(
                Service(
                    key=f"{root_key}.tools",
                    name="tools",
                    description="Tools the MCP server declares it can execute.",
                    operations=tool_ops,
                    extras={"provenance": PROVENANCE_DECLARED, "mcp_kind": "tool"},
                )
            )
        resource_ops = self._resource_operations(source, root_key)
        if resource_ops:
            services.append(
                Service(
                    key=f"{root_key}.resources",
                    name="resources",
                    description="Resources and resource templates the MCP server exposes for reading.",
                    operations=resource_ops,
                    extras={"provenance": PROVENANCE_DECLARED, "mcp_kind": "resource"},
                )
            )
        prompt_ops = self._prompt_operations(source, root_key)
        if prompt_ops:
            services.append(
                Service(
                    key=f"{root_key}.prompts",
                    name="prompts",
                    description="Prompt templates the MCP server offers.",
                    operations=prompt_ops,
                    extras={"provenance": PROVENANCE_DECLARED, "mcp_kind": "prompt"},
                )
            )

        surface = manifest_surface(source)
        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            protocol="mcp",
            identity=ApiIdentity(name=source.server_info.name or source.title),
            version=source.server_info.version,
            title=source.title,
            description=source.instructions
            or "Imported static MCP server manifest (declared capability surface)",
            servers=self._servers(source),
            services=services,
            types=coercer.named_types_from_components(),
            raw={"mcp": dumps_manifest_for_raw(source)} if include_raw else None,
            extras={
                "provenance": PROVENANCE_DECLARED,
                "mcp_protocol_version": source.protocol_version,
                "mcp_capabilities": dict(source.capabilities),
                "mcp_surface_fingerprint": surface.fingerprint(),
                "mcp_transport": source.transport.kind,
                "mcp_endpoint_target": source.transport.endpoint_target(),
                "tool_count": len(source.tools),
                "resource_count": len(source.resources),
                "resource_template_count": len(source.resource_templates),
                "prompt_count": len(source.prompts),
            },
        )
        return normalize_ordering(api)

    # -- per-kind projections ------------------------------------------------

    def _tool_operations(
        self,
        source: McpManifestDocument,
        root_key: str,
        coercer: SchemaCoercer,
    ) -> List[Operation]:
        """Project the manifest's tools onto canonical operations.

        Args:
            source: The parsed manifest.
            root_key: The model's root service-key prefix.
            coercer: The schema coercer holding the emitted components.

        Returns:
            One :class:`Operation` per declared tool.
        """
        service_key = f"{root_key}.tools"
        operations: List[Operation] = []
        for tool in source.tools:
            name = str(tool.get("name") or "")
            op_key = Keys.operation_rpc(service_key, name)
            input_schema = tool.get("inputSchema")
            output_schema = tool.get("outputSchema")

            messages = [
                Message(
                    key=Keys.request_message(op_key),
                    role=MessageRole.REQUEST,
                    payload=coercer.type_ref(
                        {"$ref": f"{_REF_PREFIX}{_component_name('Tool', name, 'Input')}"},
                        required=True,
                    ),
                    payload_schema=dict(input_schema) if isinstance(input_schema, Mapping) else None,
                    required=True,
                    description="Tool call arguments.",
                    extras={"provenance": PROVENANCE_DECLARED},
                )
            ]
            if isinstance(output_schema, Mapping):
                messages.append(
                    Message(
                        key=Keys.response_message(op_key, "result"),
                        role=MessageRole.RESPONSE,
                        payload=coercer.type_ref(
                            {"$ref": f"{_REF_PREFIX}{_component_name('Tool', name, 'Output')}"},
                            required=True,
                        ),
                        payload_schema=dict(output_schema),
                        required=False,
                        status_code="result",
                        description="Structured tool result.",
                        extras={"provenance": PROVENANCE_DECLARED},
                    )
                )

            annotations = tool.get("annotations")
            operations.append(
                Operation(
                    key=op_key,
                    name=name,
                    kind=OperationKind.REQUEST_RESPONSE,
                    streaming=StreamingMode.NONE,
                    description=_text(tool.get("description")),
                    messages=messages,
                    extras={
                        "provenance": PROVENANCE_DECLARED,
                        "mcp_kind": "tool",
                        "title": _text(tool.get("title")),
                        "annotations": dict(annotations)
                        if isinstance(annotations, Mapping)
                        else None,
                    },
                )
            )
        return operations

    def _resource_operations(
        self, source: McpManifestDocument, root_key: str
    ) -> List[Operation]:
        """Project resources and resource templates onto canonical read operations.

        Args:
            source: The parsed manifest.
            root_key: The model's root service-key prefix.

        Returns:
            One read :class:`Operation` per resource and per resource template.
        """
        service_key = f"{root_key}.resources"
        operations: List[Operation] = []

        for entry in source.resources:
            name = str(entry.get("name") or "")
            op_key = Keys.operation_rpc(service_key, name)
            operations.append(
                self._resource_operation(
                    op_key=op_key,
                    name=name,
                    entry=entry,
                    address=_text(entry.get("uri")),
                    parameters=(),
                    mcp_kind="resource",
                )
            )

        for entry in source.resource_templates:
            name = str(entry.get("name") or "")
            op_key = Keys.operation_rpc(service_key, name)
            template = _text(entry.get("uriTemplate")) or ""
            parameters = tuple(
                Parameter(
                    key=Keys.parameter(op_key, location.value, variable),
                    name=variable,
                    location=location,
                    type=TypeRef(name="string"),
                    required=location is ParameterLocation.PATH,
                    description=f"`{variable}` from the resource template.",
                    extras={"provenance": PROVENANCE_DECLARED},
                )
                for variable, location in _template_variables(template)
            )
            operations.append(
                self._resource_operation(
                    op_key=op_key,
                    name=name,
                    entry=entry,
                    address=template or None,
                    parameters=parameters,
                    mcp_kind="resource_template",
                )
            )
        return operations

    @staticmethod
    def _resource_operation(
        *,
        op_key: str,
        name: str,
        entry: Mapping[str, Any],
        address: Optional[str],
        parameters: Tuple[Parameter, ...],
        mcp_kind: str,
    ) -> Operation:
        """Build one resource / resource-template read operation.

        A resource declares a media type but no payload schema, so the response message
        carries the ``mimeType`` as a content type and no payload. That is the honest
        projection: stating a schema the manifest never gave would be an invention, and
        omitting the message entirely would hide that the resource is readable at all.

        Args:
            op_key: The operation's canonical key.
            name: The resource's programmatic name.
            entry: The verbatim wire entry.
            address: The ``uri`` or ``uriTemplate`` the resource is read from.
            parameters: Template variables promoted to parameters (empty for a concrete
                resource).
            mcp_kind: ``resource`` or ``resource_template``.

        Returns:
            The :class:`Operation`.
        """
        mime_type = _text(entry.get("mimeType"))
        annotations = entry.get("annotations")
        return Operation(
            key=op_key,
            name=name,
            kind=OperationKind.REQUEST_RESPONSE,
            streaming=StreamingMode.NONE,
            description=_text(entry.get("description")),
            parameters=list(parameters),
            messages=[
                Message(
                    key=Keys.response_message(op_key, "contents"),
                    role=MessageRole.RESPONSE,
                    content_types=[mime_type] if mime_type else [],
                    required=False,
                    status_code="contents",
                    description="Resource contents returned by `resources/read`.",
                    extras={"provenance": PROVENANCE_DECLARED},
                )
            ],
            extras={
                "provenance": PROVENANCE_DECLARED,
                "mcp_kind": mcp_kind,
                "title": _text(entry.get("title")),
                "uri": address,
                "mime_type": mime_type,
                "annotations": dict(annotations) if isinstance(annotations, Mapping) else None,
            },
        )

    def _prompt_operations(self, source: McpManifestDocument, root_key: str) -> List[Operation]:
        """Project the manifest's prompts onto canonical operations.

        A prompt's ``arguments`` are name/description/required triples with no schema, so
        each becomes a required-or-not string query parameter — the most the manifest
        actually says about them.

        Args:
            source: The parsed manifest.
            root_key: The model's root service-key prefix.

        Returns:
            One :class:`Operation` per declared prompt.
        """
        service_key = f"{root_key}.prompts"
        operations: List[Operation] = []
        for entry in source.prompts:
            name = str(entry.get("name") or "")
            op_key = Keys.operation_rpc(service_key, name)
            arguments = entry.get("arguments")
            parameters: List[Parameter] = []
            if isinstance(arguments, list):
                for argument in arguments:
                    if not isinstance(argument, Mapping):
                        continue
                    argument_name = _text(argument.get("name"))
                    if not argument_name:
                        continue
                    parameters.append(
                        Parameter(
                            key=Keys.parameter(
                                op_key, ParameterLocation.QUERY.value, argument_name
                            ),
                            name=argument_name,
                            location=ParameterLocation.QUERY,
                            type=TypeRef(name="string"),
                            required=bool(argument.get("required")),
                            description=_text(argument.get("description")),
                            extras={"provenance": PROVENANCE_DECLARED},
                        )
                    )
            operations.append(
                Operation(
                    key=op_key,
                    name=name,
                    kind=OperationKind.REQUEST_RESPONSE,
                    streaming=StreamingMode.NONE,
                    description=_text(entry.get("description")),
                    parameters=parameters,
                    messages=[
                        Message(
                            key=Keys.response_message(op_key, "messages"),
                            role=MessageRole.RESPONSE,
                            required=False,
                            status_code="messages",
                            description="Prompt messages returned by `prompts/get`.",
                            extras={"provenance": PROVENANCE_DECLARED},
                        )
                    ],
                    extras={
                        "provenance": PROVENANCE_DECLARED,
                        "mcp_kind": "prompt",
                        "title": _text(entry.get("title")),
                    },
                )
            )
        return operations

    @staticmethod
    def _servers(source: McpManifestDocument) -> List[Server]:
        """Project the manifest's ``transport`` block onto canonical servers.

        Args:
            source: The parsed manifest.

        Returns:
            A one-entry list naming where the server would be reached live, or an empty
            list when the manifest declared no usable transport — never a placeholder URL.
        """
        target = source.transport.endpoint_target()
        if not target:
            return []
        return [
            Server(
                url=target,
                name=source.transport.kind,
                protocol=source.transport.kind,
                description="Where this MCP server is reached live, as the manifest declares it.",
                extras={"provenance": PROVENANCE_DECLARED},
            )
        ]

"""Google API Discovery → canonical model normalizer — IXH-7.1 (#5126).

Maps a parsed :class:`~app.discovery_parser.DiscoveryDocument` into a
:class:`~app.canonical_model.CanonicalApi` of paradigm
:attr:`~app.canonical_model.ApiParadigm.REST`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

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
from .discovery_parser import DiscoveryDocument, DiscoveryMethod, DiscoveryParameter
from .normalizer import Keys, Normalizer, SchemaCoercer, normalize_ordering

__all__ = ["DiscoveryNormalizer"]

_FORMAT_KEY = "discovery"
# Discovery `$ref` values are usually bare schema names (``"Volume"``). The
# ``#/schemas/`` prefix covers the uncommon pointer form; bare names fall through
# to :meth:`SchemaCoercer.ref_name`'s last-segment fallback.
_REF_PREFIX = "#/schemas/"

_PARAM_LOCATIONS = {
    "path": ParameterLocation.PATH,
    "query": ParameterLocation.QUERY,
    "header": ParameterLocation.HEADER,
    "cookie": ParameterLocation.COOKIE,
}

_SCALAR_TO_CANONICAL = {
    "string": "string",
    "boolean": "bool",
    "integer": "i32",
    "number": "double",
    "any": "string",
}


def _http_path(method: DiscoveryMethod, *, service_path: Optional[str]) -> str:
    """Build a stable HTTP path from servicePath + method path."""
    path = (method.path or "").strip()
    if path.startswith("/"):
        return path or "/"
    prefix = (service_path or "").strip().strip("/")
    if prefix and path:
        return f"/{prefix}/{path}"
    if prefix:
        return f"/{prefix}"
    if path:
        return f"/{path}"
    return "/"


def _parameter_schema(param: DiscoveryParameter) -> Dict[str, Any]:
    if param.schema:
        return dict(param.schema)
    schema: Dict[str, Any] = {}
    if param.type_name:
        schema["type"] = param.type_name
    if param.enum_values:
        schema["enum"] = list(param.enum_values)
    if param.description:
        schema["description"] = param.description
    return schema


def _parameter(
    param: DiscoveryParameter,
    *,
    operation_key: str,
    coercer: SchemaCoercer,
) -> Parameter:
    location = _PARAM_LOCATIONS.get(param.location, ParameterLocation.QUERY)
    schema = _parameter_schema(param)
    type_ref = coercer.type_ref(schema, required=param.required)
    if type_ref.name is None and param.type_name:
        mapped = _SCALAR_TO_CANONICAL.get(param.type_name.lower())
        if mapped:
            type_ref = TypeRef(name=mapped, nullable=not param.required)
    extras: Dict[str, Any] = {"discovery_location": param.location}
    if param.enum_values:
        extras["discovery_enum"] = list(param.enum_values)
    return Parameter(
        key=Keys.parameter(operation_key, location.value, param.name),
        name=param.name,
        location=location,
        required=param.required,
        type=type_ref,
        description=param.description,
        extras=extras,
    )


def _merge_parameters(
    method: DiscoveryMethod,
    document_parameters: tuple[DiscoveryParameter, ...],
) -> list[DiscoveryParameter]:
    """Merge document-level common parameters under method-local ones (local wins)."""
    by_name: Dict[str, DiscoveryParameter] = {param.name: param for param in document_parameters}
    for param in method.parameters:
        by_name[param.name] = param
    return list(by_name.values())


def _operation_messages(
    method: DiscoveryMethod,
    *,
    op_key: str,
    coercer: SchemaCoercer,
) -> List[Message]:
    messages: List[Message] = []
    if method.request_schema is not None:
        messages.append(
            Message(
                key=Keys.request_message(op_key),
                role=MessageRole.REQUEST,
                payload=coercer.type_ref(method.request_schema, required=True),
                required=True,
            )
        )
    if method.response_schema is not None:
        messages.append(
            Message(
                key=Keys.response_message(op_key, "200"),
                role=MessageRole.RESPONSE,
                payload=coercer.type_ref(method.response_schema, required=True),
                extras={"http_status": "200"},
            )
        )
    return messages


class DiscoveryNormalizer(Normalizer, register=True):
    """Normalize a parsed Discovery document into a :class:`CanonicalApi`."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.REST

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(source, DiscoveryDocument):
            raise ValueError(
                "Discovery source must be a DiscoveryDocument "
                "(see app.discovery_parser.parse_discovery)"
            )

        coercer = SchemaCoercer(components=source.schemas, ref_prefix=_REF_PREFIX)
        title = source.title or source.name
        service_key = Keys.type(title, None)
        operations: List[Operation] = []

        for method in source.methods:
            path = _http_path(method, service_path=source.service_path or source.base_path)
            op_key = Keys.operation_http(method.http_method, path)
            op_name = method.id or f"{method.resource_path}.{method.name}".strip(".")
            merged = _merge_parameters(method, source.parameters)
            operations.append(
                Operation(
                    key=op_key,
                    name=op_name,
                    kind=OperationKind.REQUEST_RESPONSE,
                    streaming=StreamingMode.NONE,
                    description=method.description,
                    http_method=method.http_method,
                    http_path=path,
                    parameters=[
                        _parameter(param, operation_key=op_key, coercer=coercer)
                        for param in merged
                    ],
                    messages=_operation_messages(method, op_key=op_key, coercer=coercer),
                    extras={
                        "discovery_method": method.name,
                        "discovery_resource_path": method.resource_path,
                        "discovery_id": method.id,
                    },
                )
            )

        services = [Service(key=service_key, name=title, operations=operations)]
        servers: List[Server] = []
        base = source.base_url or source.root_url
        if base:
            servers.append(Server(url=base, description="From Discovery baseUrl/rootUrl"))

        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            protocol="http",
            identity=ApiIdentity(name=title),
            title=title,
            description=source.description,
            version=source.version,
            servers=servers,
            services=services,
            types=coercer.named_types_from_components(),
            raw={"discovery": source.raw} if include_raw else None,
            extras={
                "discovery_version": source.discovery_version,
                "discovery_kind": source.kind,
                "discovery_id": source.id,
                "discovery_name": source.name,
                "discovery_documentation_link": source.documentation_link,
                "discovery_service_path": source.service_path,
            },
        )
        return normalize_ordering(api)

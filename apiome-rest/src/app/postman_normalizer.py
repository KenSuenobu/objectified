"""Postman Collection → canonical model normalizer.

Maps a parsed :class:`~app.postman_parser.PostmanDocument` into a
:class:`~app.canonical_model.CanonicalApi` of paradigm
:attr:`~app.canonical_model.ApiParadigm.REST`.

One normalizer serves Collection v2.0 and v2.1 (FMT-3.6, #5431): the two minors'
spelling differences are resolved by the parser, so everything here reads the same
AST either way. The minor itself is published as ``postman_collection_version`` in
the model's extras — the "with its version recorded" half of FMT-3.6 — and the
collection's and each request's auth **scheme** (never its credentials) as
``postman_auth``.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Set

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
from .normalizer import Keys, Normalizer, SchemaCoercer, normalize_ordering
from .postman_parser import (
    PostmanAuth,
    PostmanDocument,
    PostmanOperation,
    postman_http_path,
)

__all__ = ["PostmanNormalizer"]

_FORMAT_KEY = "postman"
_REF_PREFIX = "#/components/schemas/"


def _infer_schema_from_json(value: Any) -> Dict[str, Any]:
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, int) and not isinstance(value, bool):
        return {"type": "integer"}
    if isinstance(value, float):
        return {"type": "number"}
    if isinstance(value, str):
        return {"type": "string"}
    if isinstance(value, list):
        if not value:
            return {"type": "array", "items": {}}
        return {"type": "array", "items": _infer_schema_from_json(value[0])}
    if isinstance(value, dict):
        properties = {
            str(key): _infer_schema_from_json(item) for key, item in value.items()
        }
        return {
            "type": "object",
            "properties": properties,
            "required": list(value.keys()),
        }
    return {"type": "string"}


def _singularize_resource(path: str) -> Optional[str]:
    segments = [
        segment
        for segment in path.strip("/").split("/")
        if segment and not (segment.startswith("{") and segment.endswith("}"))
    ]
    if not segments:
        return None
    last = segments[-1]
    if last.endswith("ies") and len(last) > 3:
        return last[:-3].capitalize() + "y"
    if last.endswith("s") and len(last) > 1:
        return last[:-1].capitalize()
    return last[:1].upper() + last[1:]


def _type_name_for_body(path: str, operation_name: str) -> str:
    resource = _singularize_resource(path)
    if resource:
        return resource
    cleaned = re.sub(r"[^A-Za-z0-9]+", " ", operation_name).strip()
    parts = [part for part in cleaned.split() if part]
    if parts:
        return parts[-1][:1].upper() + parts[-1][1:]
    return "RequestBody"


def _merge_object_schemas(
    existing: Dict[str, Any],
    incoming: Dict[str, Any],
) -> Dict[str, Any]:
    if existing.get("type") != "object" or incoming.get("type") != "object":
        return incoming
    properties = dict(existing.get("properties") or {})
    properties.update(incoming.get("properties") or {})
    required: Set[str] = set(existing.get("required") or [])
    required.update(incoming.get("required") or [])
    return {
        "type": "object",
        "properties": properties,
        "required": sorted(required),
    }


def _collect_components(document: PostmanDocument) -> Dict[str, Any]:
    components: Dict[str, Any] = {}
    for operation in document.operations:
        body = operation.request.body
        if body is None or body.mode != "raw" or not body.raw:
            continue
        raw = body.raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        schema = _infer_schema_from_json(payload)
        path = postman_http_path(operation.request.url)
        type_name = _type_name_for_body(path, operation.name)
        if type_name in components:
            components[type_name] = _merge_object_schemas(components[type_name], schema)
        else:
            components[type_name] = schema
    return components


def _auth_extras(auth: Optional[PostmanAuth]) -> Optional[Dict[str, Any]]:
    """Render an auth declaration for the extras bag — scheme and parameter names only.

    Args:
        auth: The parsed auth declaration, or ``None``.

    Returns:
        ``{"type": …, "parameters": [...]}``, or ``None`` when nothing was declared.
        Credential *values* are deliberately absent: the parser never reads them,
        so an imported collection cannot leak the token it was exported with.
    """
    if auth is None:
        return None
    return {"type": auth.type, "parameters": list(auth.parameters)}


def _parameters(operation: PostmanOperation, *, op_key: str) -> List[Parameter]:
    params: List[Parameter] = []
    for segment in operation.request.url.path:
        if segment.startswith(":"):
            name = segment[1:]
            location = ParameterLocation.PATH
        elif segment.startswith("{") and segment.endswith("}"):
            name = segment[1:-1]
            location = ParameterLocation.PATH
        else:
            continue
        params.append(
            Parameter(
                key=Keys.parameter(op_key, "path", name),
                name=name,
                location=location,
                required=True,
                type=TypeRef(name="string", nullable=False),
                extras={"postman_style": "path"},
            )
        )
    for variable in operation.request.url.variables:
        if any(param.name == variable.key for param in params):
            continue
        params.append(
            Parameter(
                key=Keys.parameter(op_key, "path", variable.key),
                name=variable.key,
                location=ParameterLocation.PATH,
                required=True,
                type=TypeRef(name="string", nullable=False),
                extras={"postman_style": "path", "postman_sample": variable.value},
            )
        )
    for query in operation.request.url.query:
        if query.disabled:
            continue
        params.append(
            Parameter(
                key=Keys.parameter(op_key, "query", query.name),
                name=query.name,
                location=ParameterLocation.QUERY,
                required=False,
                type=TypeRef(name="string", nullable=False),
                extras={"postman_style": "query", "postman_sample": query.value},
            )
        )
    return params


def _request_message(
    operation: PostmanOperation,
    *,
    op_key: str,
    coercer: SchemaCoercer,
    components: Dict[str, Any],
) -> Optional[Message]:
    body = operation.request.body
    if body is None or body.mode != "raw" or not body.raw:
        return None
    raw = body.raw.strip()
    path = postman_http_path(operation.request.url)
    type_name = _type_name_for_body(path, operation.name)
    schema: Dict[str, Any]
    if raw.startswith("{") or raw.startswith("["):
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            schema = {"type": "string"}
            return Message(
                key=Keys.request_message(op_key),
                role=MessageRole.REQUEST,
                payload=coercer.type_ref(schema, required=True),
                required=True,
                extras={
                    "postman_body_mode": body.mode,
                    "postman_body_raw": body.raw,
                    "postman_body_language": body.language,
                    "postman_body_schema": schema,
                },
            )
        if isinstance(payload, dict) and type_name in components:
            schema = {"$ref": f"{_REF_PREFIX}{type_name}"}
        else:
            schema = _infer_schema_from_json(payload)
        payload_ref = coercer.type_ref(schema, required=True)
    else:
        schema = {"type": "string"}
        payload_ref = coercer.type_ref(schema, required=True)
    return Message(
        key=Keys.request_message(op_key),
        role=MessageRole.REQUEST,
        payload=payload_ref,
        required=True,
        extras={
            "postman_body_mode": body.mode,
            "postman_body_raw": body.raw,
            "postman_body_language": body.language,
            "postman_body_schema": schema,
        },
    )


class PostmanNormalizer(Normalizer, register=True):
    """Normalize a parsed Postman collection into a :class:`CanonicalApi`."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.REST

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(source, PostmanDocument):
            raise ValueError(
                "Postman source must be a PostmanDocument (see app.postman_parser.parse_postman)"
            )

        components = _collect_components(source)
        coercer = SchemaCoercer(components=components, ref_prefix=_REF_PREFIX)
        service_key = Keys.type(source.name, None)
        operations: List[Operation] = []
        for endpoint in source.operations:
            path = postman_http_path(endpoint.request.url)
            method = endpoint.request.method
            op_key = Keys.operation_http(method, path)
            request_message = _request_message(
                endpoint,
                op_key=op_key,
                coercer=coercer,
                components=components,
            )
            messages: List[Message] = []
            if request_message is not None:
                messages.append(request_message)
            for response in endpoint.responses:
                status = str(response.code or response.status or "200")
                response_body = response.body
                extras: Dict[str, Any] = {"http_status": status}
                payload = None
                if response_body is not None and response_body.raw:
                    extras["postman_body_raw"] = response_body.raw
                    if response_body.raw.strip().startswith("{"):
                        try:
                            payload_json = json.loads(response_body.raw)
                            schema = _infer_schema_from_json(payload_json)
                            payload = coercer.type_ref(schema, required=True)
                        except json.JSONDecodeError:
                            payload = None
                messages.append(
                    Message(
                        key=Keys.response_message(op_key, status),
                        role=MessageRole.RESPONSE,
                        name=response.name,
                        payload=payload,
                        extras=extras,
                    )
                )
            operation_extras: Dict[str, Any] = {
                "postman_folder_path": list(endpoint.folder_path),
                "postman_headers": [
                    {"key": header.key, "value": header.value, "disabled": header.disabled}
                    for header in endpoint.request.headers
                ],
            }
            request_auth = _auth_extras(endpoint.request.auth)
            if request_auth is not None:
                operation_extras["postman_auth"] = request_auth
            operations.append(
                Operation(
                    key=op_key,
                    name=endpoint.name,
                    kind=OperationKind.REQUEST_RESPONSE,
                    streaming=StreamingMode.NONE,
                    description=endpoint.request.description,
                    http_method=method,
                    http_path=path,
                    parameters=_parameters(endpoint, op_key=op_key),
                    messages=messages,
                    extras=operation_extras,
                )
            )

        servers: List[Server] = []
        base_url = next((var.value for var in source.variables if var.key == "baseUrl" and var.value), None)
        if base_url:
            servers.append(Server(url=base_url, description="From Postman collection variable"))

        types = coercer.named_types_from_components()
        document_extras: Dict[str, Any] = {
            "postman_schema_url": source.schema_url,
            "postman_variables": [
                {"key": variable.key, "value": variable.value}
                for variable in source.variables
            ],
        }
        if source.collection_version:
            document_extras["postman_collection_version"] = source.collection_version
        collection_auth = _auth_extras(source.auth)
        if collection_auth is not None:
            document_extras["postman_auth"] = collection_auth
        api = CanonicalApi(
            paradigm=self.paradigm,
            format=self.format,
            protocol="http",
            identity=ApiIdentity(name=source.name),
            title=source.name,
            description=source.description,
            servers=servers,
            services=[Service(key=service_key, name=source.name, operations=operations)],
            types=types,
            raw={"postman": source.raw} if include_raw else None,
            extras=document_extras,
        )
        return normalize_ordering(api)

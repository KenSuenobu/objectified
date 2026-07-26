"""Shared inferred-spec engine — observations → canonical REST surface (MFI-32.1 / IXH-7.4).

Collections and captured traffic are lists of concrete HTTP requests, not specs.
This module clusters observations by host + method + tokenized path, generalizes
numeric/UUID/hash path segments into ``{param}`` templates, unions query/header
parameters, and widens JSON schemas across samples. Every emitted construct is
stamped ``extras.provenance = "inferred"`` so the coverage ledger and Catalog
never present traffic as declared.

Consumed by ``http-file`` (IXH-7.4) and intended for HAR / Insomnia / Bruno /
Postman refactor under MFI-EPIC-32 — do not fork this logic into per-format
normalizers.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import parse_qsl, urlparse

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
from .normalizer import Keys, SchemaCoercer, normalize_ordering

__all__ = [
    "HttpObservation",
    "PathInferenceEvidence",
    "InferredSpecResult",
    "infer_canonical_api",
]

_PROVENANCE = "inferred"
_REF_PREFIX = "#/components/schemas/"

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_HEX_HASH_RE = re.compile(r"^[0-9a-fA-F]{16,64}$")
_NUMERIC_RE = re.compile(r"^\d+$")
_ALREADY_PARAM_RE = re.compile(r"^\{[^}]+\}$")
_COLON_PARAM_RE = re.compile(r"^:([A-Za-z_][A-Za-z0-9_]*)$")


@dataclass(frozen=True)
class HttpObservation:
    """One concrete HTTP request (and optional response) sample.

    Attributes:
        method: HTTP verb (GET, POST, …), upper-cased by the engine.
        url: Absolute or path-absolute URL for this sample.
        headers: Observed request headers as ``(name, value)`` pairs.
        query: Explicit query pairs when the URL query string is incomplete;
            otherwise derived from ``url``.
        request_body: Raw request body text, if any.
        response_status: Observed response status code, if any.
        response_body: Raw response body text, if any.
        source_location: ``line:col`` or entry index in the source document.
        source_label: Human label for the source (filename, paste id, …).
        source_file: Path within a fileset when multi-file intake was used.
    """

    method: str
    url: str
    headers: Tuple[Tuple[str, str], ...] = ()
    query: Tuple[Tuple[str, str], ...] = ()
    request_body: Optional[str] = None
    response_status: Optional[int] = None
    response_body: Optional[str] = None
    source_location: Optional[str] = None
    source_label: Optional[str] = None
    source_file: Optional[str] = None


@dataclass(frozen=True)
class PathInferenceEvidence:
    """Evidence that a path template was inferred from concrete sample URLs.

    Attributes:
        template: Inferred route template (e.g. ``/users/{id}``).
        method: HTTP method for this cluster.
        sample_urls: Concrete URLs that were clustered into ``template``.
        generalized_segments: For each path index, ``(index, kind, value)`` where
            ``kind`` is ``literal`` or ``param`` and ``value`` is the literal text
            or parameter name.
    """

    template: str
    method: str
    sample_urls: Tuple[str, ...]
    generalized_segments: Tuple[Tuple[int, str, str], ...]

    def as_dict(self) -> Dict[str, Any]:
        """Serialize for ``CanonicalApi.extras`` and coverage-ledger detail."""
        return {
            "template": self.template,
            "method": self.method,
            "sample_urls": list(self.sample_urls),
            "generalized_segments": [
                {"index": idx, "kind": kind, "value": value}
                for idx, kind, value in self.generalized_segments
            ],
        }


@dataclass(frozen=True)
class InferredSpecResult:
    """Result of running the inferred-spec engine over a set of observations."""

    api: CanonicalApi
    path_inferences: Tuple[PathInferenceEvidence, ...]
    sample_counts: Dict[str, int] = field(default_factory=dict)


def _inferred_extras(**extra: Any) -> Dict[str, Any]:
    bag = {"provenance": _PROVENANCE}
    bag.update(extra)
    return bag


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
            "required": sorted(properties.keys()),
        }
    return {"type": "string"}


def _widen_schemas(existing: Dict[str, Any], incoming: Dict[str, Any]) -> Dict[str, Any]:
    """Widen two JSON-Schema fragments across samples (type promotion + property union).

    For objects, ``required`` is the intersection of both sides' required lists —
    a property is required only when every sample that contributed a schema listed it.
    """
    if not existing:
        return dict(incoming)
    if not incoming:
        return dict(existing)

    et = existing.get("type")
    it = incoming.get("type")
    if et == "object" and it == "object":
        props: Dict[str, Any] = dict(existing.get("properties") or {})
        for key, schema in (incoming.get("properties") or {}).items():
            if key in props:
                props[key] = _widen_schemas(props[key], schema)
            else:
                props[key] = schema
        req_existing = set(existing.get("required") or [])
        req_incoming = set(incoming.get("required") or [])
        return {
            "type": "object",
            "properties": props,
            "required": sorted(req_existing & req_incoming),
        }

    if et == "array" and it == "array":
        return {
            "type": "array",
            "items": _widen_schemas(existing.get("items") or {}, incoming.get("items") or {}),
        }

    if et == it:
        return dict(existing)

    if {et, it} == {"integer", "number"}:
        return {"type": "number"}
    if et == "null":
        return dict(incoming)
    if it == "null":
        return dict(existing)
    return {"type": "string"}


def _is_dynamic_segment(segment: str) -> bool:
    if _ALREADY_PARAM_RE.match(segment) or _COLON_PARAM_RE.match(segment):
        return True
    if _NUMERIC_RE.match(segment):
        return True
    if _UUID_RE.match(segment):
        return True
    if _HEX_HASH_RE.match(segment) and not segment.isalpha():
        return True
    return False


def _param_name_for_segment(segment: str, index: int, prev_literal: Optional[str]) -> str:
    colon = _COLON_PARAM_RE.match(segment)
    if colon:
        return colon.group(1)
    if _ALREADY_PARAM_RE.match(segment):
        return segment[1:-1]
    if prev_literal:
        singular = prev_literal.rstrip("s") or prev_literal
        if singular.lower() in {"user", "users", "id", "item", "order", "pet", "product"}:
            return "id"
        # Prefer resource-derived name when previous segment looks like a plural resource
        if prev_literal.endswith("s") and len(prev_literal) > 1:
            return "id"
    if _UUID_RE.match(segment):
        return "id"
    if _NUMERIC_RE.match(segment):
        return "id" if index > 0 else f"param{index}"
    return f"param{index}"


def _tokenize_path(path: str) -> Tuple[str, ...]:
    stripped = path.strip("/")
    if not stripped:
        return ()
    return tuple(stripped.split("/"))


def _parse_url(url: str) -> Tuple[str, str, Tuple[str, ...], List[Tuple[str, str]]]:
    """Return ``(host, path, segments, query_pairs)`` for an observation URL."""
    raw = url.strip()
    if not raw:
        return "", "/", (), []
    # Path-absolute without scheme
    if raw.startswith("/") and not raw.startswith("//"):
        parsed = urlparse(f"http://placeholder.local{raw}")
        host = ""
    else:
        parsed = urlparse(raw if "://" in raw else f"http://{raw}")
        host = (parsed.netloc or "").lower()
    path = parsed.path or "/"
    if not path.startswith("/"):
        path = "/" + path
    segments = _tokenize_path(path)
    query = list(parse_qsl(parsed.query, keep_blank_values=True))
    return host, path, segments, query


def _cluster_key(method: str, host: str, segments: Tuple[str, ...]) -> Tuple[str, str, Tuple[str, ...]]:
    """Structural key: dynamic segments collapse to a placeholder for clustering."""
    structural: List[str] = []
    for segment in segments:
        if _is_dynamic_segment(segment):
            structural.append("{}")
        else:
            structural.append(segment.lower())
    return method.upper(), host, tuple(structural)


def _build_template(
    segments_list: Sequence[Tuple[str, ...]],
) -> Tuple[str, Tuple[Tuple[int, str, str], ...]]:
    """Build a path template and generalized-segment evidence from clustered paths."""
    if not segments_list:
        return "/", ()
    length = len(segments_list[0])
    generalized: List[Tuple[int, str, str]] = []
    parts: List[str] = []
    used_names: Dict[str, int] = {}
    for index in range(length):
        values = [segs[index] for segs in segments_list]
        unique = set(values)
        if len(unique) == 1 and not _is_dynamic_segment(values[0]):
            literal = values[0]
            parts.append(literal)
            generalized.append((index, "literal", literal))
            continue
        # Already templated identically
        if len(unique) == 1 and (
            _ALREADY_PARAM_RE.match(values[0]) or _COLON_PARAM_RE.match(values[0])
        ):
            name = _param_name_for_segment(values[0], index, parts[-1] if parts else None)
            parts.append("{" + name + "}")
            generalized.append((index, "param", name))
            continue
        prev = parts[-1] if parts else None
        # Prefer a stable name from the first dynamic sample
        name = _param_name_for_segment(values[0], index, prev)
        if name in used_names:
            used_names[name] += 1
            name = f"{name}{used_names[name]}"
        else:
            used_names[name] = 1
        parts.append("{" + name + "}")
        generalized.append((index, "param", name))
    template = "/" + "/".join(parts) if parts else "/"
    return template, tuple(generalized)


def _parse_json_body(raw: Optional[str]) -> Optional[Any]:
    if raw is None:
        return None
    text = raw.strip()
    if not text or (not text.startswith("{") and not text.startswith("[")):
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


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


def _type_name_for(path: str, method: str, role: str) -> str:
    resource = _singularize_resource(path) or "Payload"
    suffix = "Request" if role == "request" else "Response"
    return f"{method.title()}{resource}{suffix}"


def _auth_scheme_from_headers(headers: Iterable[Tuple[str, str]]) -> Optional[str]:
    for name, value in headers:
        lower = name.lower()
        if lower == "authorization":
            scheme = (value.split(None, 1)[0] if value else "").lower()
            if scheme in {"bearer", "basic", "digest"}:
                return scheme
            return "authorization"
        if lower == "x-api-key":
            return "apiKey"
        if lower == "cookie":
            return "cookie"
    return None


@dataclass
class _Cluster:
    method: str
    host: str
    observations: List[HttpObservation] = field(default_factory=list)
    paths: List[Tuple[str, ...]] = field(default_factory=list)
    sample_urls: List[str] = field(default_factory=list)


def infer_canonical_api(
    observations: Sequence[HttpObservation],
    *,
    title: str = "Inferred API",
    format_key: str = "inferred",
    include_raw: bool = True,
) -> InferredSpecResult:
    """Infer a canonical REST surface from concrete HTTP observations.

    Args:
        observations: Concrete request samples to cluster and generalize.
        title: Human title for the resulting artifact.
        format_key: Source format key stamped onto ``CanonicalApi.format``
            (e.g. ``http-file``, ``har``).
        include_raw: When ``True``, preserve observation summaries on ``raw``.

    Returns:
        An :class:`InferredSpecResult` with the canonical model, path-inference
        evidence, and per-operation sample counts. Deterministic for a fixed
        observation list (stable sort by method + url + source_location).
    """
    ordered = sorted(
        observations,
        key=lambda obs: (
            obs.method.upper(),
            obs.url,
            obs.source_location or "",
            obs.source_file or "",
            obs.source_label or "",
        ),
    )

    clusters: Dict[Tuple[str, str, Tuple[str, ...]], _Cluster] = {}
    for obs in ordered:
        host, _path, segments, _query = _parse_url(obs.url)
        key = _cluster_key(obs.method, host, segments)
        cluster = clusters.get(key)
        if cluster is None:
            cluster = _Cluster(method=obs.method.upper(), host=host)
            clusters[key] = cluster
        cluster.observations.append(obs)
        cluster.paths.append(segments)
        cluster.sample_urls.append(obs.url)

    # Stable cluster order
    cluster_items = sorted(
        clusters.values(),
        key=lambda c: (c.method, c.host, "/".join(c.paths[0]) if c.paths else ""),
    )

    path_inferences: List[PathInferenceEvidence] = []
    operations: List[Operation] = []
    sample_counts: Dict[str, int] = {}
    components: Dict[str, Any] = {}
    servers: Dict[str, Server] = {}
    auth_schemes: set[str] = set()

    for cluster in cluster_items:
        template, generalized = _build_template(cluster.paths)
        evidence = PathInferenceEvidence(
            template=template,
            method=cluster.method,
            sample_urls=tuple(cluster.sample_urls),
            generalized_segments=generalized,
        )
        # Only record evidence when something was generalized or multiple samples collapsed
        if any(kind == "param" for _, kind, _ in generalized) or len(cluster.observations) > 1:
            path_inferences.append(evidence)

        for obs in cluster.observations:
            host, _, _, _ = _parse_url(obs.url)
            if host and host not in servers:
                scheme = "https" if obs.url.lower().startswith("https") else "http"
                # Prefer original scheme/host from URL
                parsed = urlparse(obs.url if "://" in obs.url else f"{scheme}://{host}")
                base = f"{parsed.scheme or scheme}://{parsed.netloc or host}"
                servers[host] = Server(
                    url=base,
                    extras=_inferred_extras(source_file=obs.source_file),
                )
            scheme = _auth_scheme_from_headers(obs.headers)
            if scheme:
                auth_schemes.add(scheme)

        op_key = Keys.operation_http(cluster.method, template)
        sample_count = len(cluster.observations)
        sample_counts[op_key] = sample_count

        # Path parameters from template
        parameters: List[Parameter] = []
        for _idx, kind, name in generalized:
            if kind != "param":
                continue
            parameters.append(
                Parameter(
                    key=Keys.parameter(op_key, "path", name),
                    name=name,
                    location=ParameterLocation.PATH,
                    required=True,
                    type=TypeRef(name="string", nullable=False),
                    extras=_inferred_extras(sample_count=sample_count),
                )
            )

        # Query param union
        query_seen: Dict[str, int] = {}
        query_samples: Dict[str, List[str]] = {}
        for obs in cluster.observations:
            _, _, _, url_query = _parse_url(obs.url)
            pairs = list(obs.query) if obs.query else url_query
            names_in_obs = {name for name, _ in pairs}
            for name in names_in_obs:
                query_seen[name] = query_seen.get(name, 0) + 1
            for name, value in pairs:
                query_samples.setdefault(name, []).append(value)
        for name in sorted(query_seen.keys()):
            required = query_seen[name] == sample_count
            parameters.append(
                Parameter(
                    key=Keys.parameter(op_key, "query", name),
                    name=name,
                    location=ParameterLocation.QUERY,
                    required=required,
                    type=TypeRef(name="string", nullable=False),
                    extras=_inferred_extras(
                        sample_count=query_seen[name],
                        samples=query_samples.get(name, [])[:5],
                    ),
                )
            )

        # Header param union (skip hop-by-hop / auth values content)
        header_seen: Dict[str, int] = {}
        skip_headers = {"content-length", "host", "connection", "accept-encoding"}
        for obs in cluster.observations:
            names_in_obs = {
                name.lower() for name, _ in obs.headers if name.lower() not in skip_headers
            }
            for name in names_in_obs:
                header_seen[name] = header_seen.get(name, 0) + 1
        for name in sorted(header_seen.keys()):
            parameters.append(
                Parameter(
                    key=Keys.parameter(op_key, "header", name),
                    name=name,
                    location=ParameterLocation.HEADER,
                    required=header_seen[name] == sample_count,
                    type=TypeRef(name="string", nullable=False),
                    extras=_inferred_extras(sample_count=header_seen[name]),
                )
            )

        # Defer message construction until SchemaCoercer exists; stash schemas here.
        cluster_req_schema: Optional[Dict[str, Any]] = None
        cluster_req_samples = 0
        req_schemas: List[Dict[str, Any]] = []
        for obs in cluster.observations:
            parsed_body = _parse_json_body(obs.request_body)
            if parsed_body is not None:
                req_schemas.append(_infer_schema_from_json(parsed_body))
        if req_schemas:
            schema = req_schemas[0]
            for other in req_schemas[1:]:
                schema = _widen_schemas(schema, other)
            type_name = _type_name_for(template, cluster.method, "request")
            if type_name in components:
                components[type_name] = _widen_schemas(components[type_name], schema)
            else:
                components[type_name] = schema
            cluster_req_schema = {"$ref": f"{_REF_PREFIX}{type_name}"}
            cluster_req_samples = len(req_schemas)

        resp_payloads: List[Tuple[str, Optional[Dict[str, Any]], int]] = []
        resp_by_status: Dict[str, List[Dict[str, Any]]] = {}
        for obs in cluster.observations:
            if obs.response_status is None and not obs.response_body:
                continue
            status = str(obs.response_status or 200)
            parsed = _parse_json_body(obs.response_body)
            if parsed is not None:
                resp_by_status.setdefault(status, []).append(_infer_schema_from_json(parsed))
            else:
                resp_by_status.setdefault(status, [])
        for status in sorted(resp_by_status.keys()):
            schemas = resp_by_status[status]
            if schemas:
                schema = schemas[0]
                for other in schemas[1:]:
                    schema = _widen_schemas(schema, other)
                type_name = _type_name_for(template, cluster.method, "response") + status
                if type_name in components:
                    components[type_name] = _widen_schemas(components[type_name], schema)
                else:
                    components[type_name] = schema
                resp_payloads.append(
                    (status, {"$ref": f"{_REF_PREFIX}{type_name}"}, len(schemas))
                )
            else:
                resp_payloads.append((status, None, sample_count))

        source_files = sorted(
            {obs.source_file for obs in cluster.observations if obs.source_file}
        )
        source_locations = [
            obs.source_location for obs in cluster.observations if obs.source_location
        ]
        operations.append(
            Operation(
                key=op_key,
                name=f"{cluster.method} {template}",
                kind=OperationKind.REQUEST_RESPONSE,
                streaming=StreamingMode.NONE,
                http_method=cluster.method,
                http_path=template,
                parameters=parameters,
                messages=[],  # filled below after SchemaCoercer is built
                extras=_inferred_extras(
                    sample_count=sample_count,
                    inference_evidence=evidence.as_dict(),
                    source_files=source_files,
                    source_location=source_locations[0] if source_locations else None,
                    source_label=cluster.observations[0].source_label,
                    _pending_req_schema=cluster_req_schema,
                    _pending_req_samples=cluster_req_samples,
                    _pending_resp_payloads=resp_payloads,
                ),
            )
        )

    coercer = SchemaCoercer(components=components, ref_prefix=_REF_PREFIX)
    for operation in operations:
        pending_req = operation.extras.pop("_pending_req_schema", None)
        pending_req_samples = int(operation.extras.pop("_pending_req_samples", 0) or 0)
        pending_resp = operation.extras.pop("_pending_resp_payloads", []) or []
        messages: List[Message] = []
        if isinstance(pending_req, dict):
            messages.append(
                Message(
                    key=Keys.request_message(operation.key),
                    role=MessageRole.REQUEST,
                    payload=coercer.type_ref(pending_req, required=True),
                    required=True,
                    content_types=["application/json"],
                    extras=_inferred_extras(sample_count=pending_req_samples),
                )
            )
        for status, schema, count in pending_resp:
            payload = coercer.type_ref(schema, required=True) if isinstance(schema, dict) else None
            messages.append(
                Message(
                    key=Keys.response_message(operation.key, status),
                    role=MessageRole.RESPONSE,
                    payload=payload,
                    status_code=status,
                    content_types=["application/json"] if payload is not None else [],
                    extras=_inferred_extras(http_status=status, sample_count=count),
                )
            )
        operation.messages = messages

    types = coercer.named_types_from_components()
    for typ in types:
        typ.extras = {**typ.extras, **_inferred_extras()}

    service_key = Keys.type(title, None)
    api_extras: Dict[str, Any] = _inferred_extras(
        path_inferences=[ev.as_dict() for ev in path_inferences],
        sample_counts=sample_counts,
    )
    if auth_schemes:
        api_extras["inferred_auth_schemes"] = sorted(auth_schemes)

    raw: Optional[Dict[str, Any]] = None
    if include_raw:
        raw = {
            "observations": [
                {
                    "method": obs.method,
                    "url": obs.url,
                    "source_location": obs.source_location,
                    "source_file": obs.source_file,
                    "source_label": obs.source_label,
                }
                for obs in ordered
            ]
        }

    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format=format_key,
        protocol="http",
        identity=ApiIdentity(name=title),
        title=title,
        servers=sorted(servers.values(), key=lambda s: s.url),
        services=[
            Service(
                key=service_key,
                name=title,
                operations=operations,
                extras=_inferred_extras(),
            )
        ],
        types=types,
        raw=raw,
        extras=api_extras,
    )
    return InferredSpecResult(
        api=normalize_ordering(api),
        path_inferences=tuple(path_inferences),
        sample_counts=sample_counts,
    )

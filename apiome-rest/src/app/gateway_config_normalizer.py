"""Gateway configuration → canonical model normalizer — IXH-7.8 (#5133).

One projection for both flavors: a flavor-neutral
:class:`~app.gateway_config_model.GatewayConfigDocument` (from
:mod:`app.kong_parser` or :mod:`app.gateway_api_parser`) becomes a canonical
REST surface — services grouped by gateway service / HTTPRoute resource, one
operation per flattened match condition, servers from the declared hostnames.

Provenance discipline (this is what makes the import honest):

* Routes, hosts, and methods are **declared** facts — their entities carry no
  ``provenance`` stamp and their unmodeled attributes ride in ``extras``, so the
  coverage ledger reports them ``mapped`` / ``partially-mapped``.
* Path parameters recovered from regex patterns and auth schemes recovered from
  plugins are **inferred** — stamped ``provenance = "inferred"`` so the ledger
  never presents them as declared (same convention as IXH-7.4).
* The formats carry **no request/response schemas**, so operations have no
  messages. That absence is recorded on ``CanonicalApi.extras["gateway"]``
  (``schemaless_operation_count``) and rendered by the preview manifest as a
  capability limit of the source format — never as a drop.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    Operation,
    OperationKind,
    Parameter,
    ParameterLocation,
    Server,
    Service,
    StreamingMode,
    TypeRef,
)
from .gateway_config_model import (
    GatewayAuthHint,
    GatewayConfigDocument,
    GatewayMatch,
    GatewayRoute,
)
from .normalizer import Keys, Normalizer, normalize_ordering

__all__ = [
    "KONG_FORMAT_KEY",
    "GATEWAY_API_FORMAT_KEY",
    "KongNormalizer",
    "GatewayApiNormalizer",
    "normalize_gateway_config",
]

KONG_FORMAT_KEY = "kong"
GATEWAY_API_FORMAT_KEY = "gateway-api"

#: Method placeholder for a route that matches any HTTP method. Kept explicit
#: (rather than a fabricated verb) so diffs and keys stay stable and honest.
_ANY_METHOD = "ANY"


def _auth_dicts(hints: tuple[GatewayAuthHint, ...]) -> List[Dict[str, Any]]:
    """Serialize auth hints for extras bags, mapped hints first, stable order."""
    ordered = sorted(hints, key=lambda h: (h.scheme is None, h.scheme or "", h.plugin))
    return [hint.as_dict() for hint in ordered]


def _operation_for_match(
    route: GatewayRoute,
    match: GatewayMatch,
    *,
    used_keys: Set[str],
) -> Operation:
    """Build one canonical operation from one flattened match condition.

    Args:
        route: The owning route (extras / auth / backends context).
        match: The match condition (path pattern, method, header/query matches).
        used_keys: Keys already assigned — a collision (same method + template on
            two routes, e.g. two hosts) appends ``#<route name>`` so keys stay
            unique while the base coordinate stays diff-stable.

    Returns:
        The operation, message-less by construction (the formats carry no
        schemas; the document-level gateway report states that as a capability
        limit).
    """
    method = match.method or _ANY_METHOD
    template = match.path.template if match.path else "/"
    op_key = Keys.operation_http(method, template)
    if op_key in used_keys:
        op_key = f"{op_key}#{route.name}"
    used_keys.add(op_key)

    parameters: List[Parameter] = []
    if match.path is not None:
        for name in match.path.param_names:
            # Recovered from a regex pattern — inferred, with the pattern as evidence.
            parameters.append(
                Parameter(
                    key=Keys.parameter(op_key, "path", name),
                    name=name,
                    location=ParameterLocation.PATH,
                    required=True,
                    type=TypeRef(name="string", nullable=False),
                    extras={"provenance": "inferred", "pattern": match.path.raw},
                )
            )
    for name, value in match.headers:
        parameters.append(
            Parameter(
                key=Keys.parameter(op_key, "header", name),
                name=name,
                location=ParameterLocation.HEADER,
                required=True,
                type=TypeRef(name="string", nullable=False),
                extras={"match_value": value} if value else {},
            )
        )
    for name, value in match.query:
        parameters.append(
            Parameter(
                key=Keys.parameter(op_key, "query", name),
                name=name,
                location=ParameterLocation.QUERY,
                required=True,
                type=TypeRef(name="string", nullable=False),
                extras={"match_value": value} if value else {},
            )
        )

    extras: Dict[str, Any] = {"gateway_route": route.name}
    if route.hosts:
        extras["hosts"] = sorted(route.hosts)
    if match.path is not None:
        extras["path_match"] = {"kind": match.path.kind, "raw": match.path.raw}
    if match.method is None:
        extras["methods_unrestricted"] = True
    if route.auth:
        extras["security"] = _auth_dicts(route.auth)
    if route.plugins:
        extras["plugins"] = sorted({plugin.name for plugin in route.plugins})
    if route.backends:
        extras["backends"] = [backend.as_dict() for backend in route.backends]
    for key, value in route.extras.items():
        extras.setdefault(key, value)

    return Operation(
        key=op_key,
        name=f"{method} {template}",
        kind=OperationKind.REQUEST_RESPONSE,
        streaming=StreamingMode.NONE,
        http_method=method,
        http_path=template,
        parameters=parameters,
        messages=[],
        extras=extras,
    )


def normalize_gateway_config(
    document: GatewayConfigDocument,
    *,
    format_key: str,
    include_raw: bool = True,
) -> CanonicalApi:
    """Project a parsed gateway configuration onto the canonical model.

    Args:
        document: The flavor-neutral parsed document.
        format_key: Canonical format key to stamp (``kong`` / ``gateway-api``) —
            any non-OpenAPI key routes the import to the non-publishable catalog
            (see :func:`app.import_routing.decide_import_routing`).
        include_raw: When True, retain the parser's credential-free structural
            summary on ``CanonicalApi.raw``.

    Returns:
        The canonical model, deterministically ordered.
    """
    used_keys: Set[str] = set()
    operations_by_service: Dict[str, List[Operation]] = {}
    service_order: List[str] = []
    schemaless_operations = 0

    for route in document.routes:
        group = route.service_name or "(unattached routes)"
        if group not in operations_by_service:
            operations_by_service[group] = []
            service_order.append(group)
        for match in route.matches:
            operation = _operation_for_match(route, match, used_keys=used_keys)
            operations_by_service[group].append(operation)
            schemaless_operations += 1

    service_extras_by_name = {
        service.name: service for service in document.services
    }
    services: List[Service] = []
    for group in service_order:
        extras: Dict[str, Any] = {}
        definition = service_extras_by_name.get(group)
        if definition is not None:
            backend: Dict[str, Any] = {}
            if definition.url:
                backend["url"] = definition.url
            for attr in ("protocol", "host", "port", "path"):
                value = getattr(definition, attr)
                if value is not None:
                    backend[attr] = value
            if backend:
                extras["backend"] = backend
            extras.update(definition.extras)
        services.append(
            Service(
                key=Keys.type(group, None),
                name=group,
                operations=operations_by_service[group],
                extras=extras,
            )
        )

    # Servers: the gateway-facing hostnames. Scheme prefers https when any route
    # declares it (Kong ``protocols``; Gateway API serves both).
    servers: List[Server] = []
    seen_hosts: Set[str] = set()
    for route in document.routes:
        scheme = "https" if ("https" in route.protocols or not route.protocols) else "http"
        for host in route.hosts:
            if host in seen_hosts:
                continue
            seen_hosts.add(host)
            servers.append(Server(url=f"{scheme}://{host}"))
    servers.sort(key=lambda server: server.url)

    mapped_auth = [hint for route in document.routes for hint in route.auth]
    mapped_auth.extend(document.global_auth)
    inferred_schemes = sorted(
        {hint.scheme for hint in mapped_auth if hint.scheme is not None}
    )
    unmapped_plugins = sorted(
        {
            (hint.plugin, hint.scope)
            for hint in mapped_auth
            if hint.scheme is None
        }
    )

    gateway_report: Dict[str, Any] = {
        "flavor": document.flavor,
        "route_count": len(document.routes),
        "operation_count": schemaless_operations,
        "schemaless_operation_count": schemaless_operations,
        "credential_redactions": document.credential_redactions,
        "ignored_constructs": [dict(entry) for entry in document.ignored],
        "auth": [
            hint.as_dict()
            for hint in sorted(
                {
                    (h.scheme, h.plugin, h.scope, h.attached_to): h
                    for h in mapped_auth
                    if h.scheme is not None
                }.values(),
                key=lambda h: (h.scheme or "", h.plugin, h.scope, h.attached_to or ""),
            )
        ],
        "unmapped_plugins": [
            {"name": name, "scope": scope} for name, scope in unmapped_plugins
        ],
        "global_plugins": sorted({plugin.name for plugin in document.global_plugins}),
    }

    api_extras: Dict[str, Any] = {"gateway": gateway_report}
    if inferred_schemes:
        api_extras["inferred_auth_schemes"] = inferred_schemes

    raw: Optional[Dict[str, Any]] = None
    if include_raw and document.raw is not None:
        raw = {"gateway_config": dict(document.raw)}

    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format=format_key,
        protocol="http",
        identity=ApiIdentity(name=document.title),
        title=document.title,
        servers=servers,
        services=services,
        types=[],
        raw=raw,
        extras=api_extras,
    )
    return normalize_ordering(api)


class KongNormalizer(Normalizer, register=True):
    """Normalize a parsed Kong declarative config (format key ``kong``)."""

    format = KONG_FORMAT_KEY
    paradigm = ApiParadigm.REST

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(source, GatewayConfigDocument) or source.flavor != "kong":
            raise ValueError(
                "Kong source must be a GatewayConfigDocument with flavor='kong' "
                "(see app.kong_parser.parse_kong_declarative)"
            )
        return normalize_gateway_config(
            source, format_key=KONG_FORMAT_KEY, include_raw=include_raw
        )


class GatewayApiNormalizer(Normalizer, register=True):
    """Normalize parsed Gateway API HTTPRoutes (format key ``gateway-api``)."""

    format = GATEWAY_API_FORMAT_KEY
    paradigm = ApiParadigm.REST

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        if (
            not isinstance(source, GatewayConfigDocument)
            or source.flavor != "gateway-api"
        ):
            raise ValueError(
                "Gateway API source must be a GatewayConfigDocument with "
                "flavor='gateway-api' (see app.gateway_api_parser.parse_gateway_api)"
            )
        return normalize_gateway_config(
            source, format_key=GATEWAY_API_FORMAT_KEY, include_raw=include_raw
        )

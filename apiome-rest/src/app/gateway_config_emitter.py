"""Canonical model → gateway routing surface, flavor-neutral — FMT-2.2 (#5420).

The emit-side twin of :mod:`app.gateway_config_normalizer`. That module projects a
:class:`~app.gateway_config_model.GatewayConfigDocument` *onto* the canonical model;
this one projects a :class:`~app.canonical_model.CanonicalApi` back *out* to the same
flavor-neutral document, so every gateway emitter — :mod:`app.kong_emitter` today,
the Gateway API ``HTTPRoute`` emitter of FMT-2.3 and the wider gateway family of
FMT-7.6/7.7 next — shares one projection and only supplies its own renderer.

What the projection reads
-------------------------

A model that came *from* a gateway import already carries the routing surface in
its extras, and the projection reads it back verbatim so an import → export round
trip is an identity:

* ``operation.extras["gateway_route"]`` — the owning route's name; operations
  sharing one are re-merged into a single route (Kong's ``paths × methods``
  cross-product is rebuilt from the flattened operations);
* ``operation.extras["hosts"]`` / ``["path_match"]`` / ``["methods_unrestricted"]``
  — the declared hostnames, the original path pattern with its ``exact`` /
  ``prefix`` / ``regex`` kind, and the "matches any method" marker;
* ``operation.extras["security"]`` — auth hints with the plugin, scope and
  attachment that produced them, so each one is re-attached where it came from;
* ``operation.extras["plugins"]`` / ``["backends"]`` and every remaining extras key
  — non-auth plugin names, backend references, and the route attributes the
  canonical model has no field for (``strip_path``, ``tags``, ``headers``, …);
* ``service.extras["backend"]`` — the upstream address, piecewise or as one URL.

What it derives
---------------

A model from anywhere else has none of that, so the projection *derives* a surface
and reports every derivation as a loss rather than presenting it as declared:

* routes come one per operation, named from the operation key;
* a path template with parameters becomes a Kong-style named-capture regex —
  :func:`template_path_pattern` is the exact inverse of
  :func:`~app.gateway_config_model.build_path_pattern`, so ``/users/{userId}``
  round-trips through the gateway and back to ``/users/{userId}``;
* hosts come from the canonical servers, and a service with no recorded backend
  gets a placeholder upstream (a gateway config with no upstream is not a valid
  config, and a silent omission would be worse than a reported placeholder) — for
  the flavors that need one; see :class:`FlavorRules`.

Two rules are worth stating because they are easy to get wrong:

**Request inputs are not match conditions.** A header or query *parameter* on an
OpenAPI operation describes what a caller may send; a header or query *match* on a
gateway route decides whether the request is routed at all. Turning the first into
the second would narrow the surface to requests that happen to carry the header, so
parameters become match conditions only for a model that came from a gateway
import (where they *are* match conditions) and a declared loss everywhere else.

**Nothing is invented into ``security``.** An auth hint is emitted only when the
model names one; the reverse plugin table (:data:`KONG_SCHEME_AUTH_PLUGINS`) is
consulted only to answer "which plugin implements this scheme" for a hint that
names a scheme but no plugin.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

from .canonical_model import CanonicalApi, Operation, ParameterLocation, Service
from .emitter import LossKind, LossTracker
from .gateway_config_model import (
    KONG_SCHEME_AUTH_PLUGINS,
    GatewayAuthHint,
    GatewayBackend,
    GatewayConfigDocument,
    GatewayMatch,
    GatewayPathPattern,
    GatewayPlugin,
    GatewayRoute,
    GatewayServiceDef,
    build_path_pattern,
)

__all__ = [
    "ANY_METHOD",
    "BACKEND_EXTRA",
    "GATEWAY_FLAVOR_RULES",
    "GATEWAY_REPORT_EXTRA",
    "OPERATION_ROUTE_EXTRAS",
    "PLACEHOLDER_UPSTREAM",
    "SERVICE_NAMING_STRATEGIES",
    "UNATTACHED_SERVICE_NAME",
    "FlavorRules",
    "auth_hints_from_extras",
    "escape_path_literal",
    "flavor_rules",
    "gateway_sourced",
    "narrow_service_scoped_auth",
    "plan_gateway_config",
    "preserve_name",
    "safe_name",
    "server_host_schemes",
    "slug_name",
    "template_path_pattern",
]


# ===========================================================================
# The extras vocabulary shared with the normalizer
# ===========================================================================

#: ``CanonicalApi.extras`` key holding the import-side gateway report.
GATEWAY_REPORT_EXTRA = "gateway"

#: ``Service.extras`` key holding the upstream address.
BACKEND_EXTRA = "backend"

#: Method placeholder the normalizer writes for a route that matches any verb.
ANY_METHOD = "ANY"

#: Canonical service name the normalizer groups routes under when they name no
#: service. It is a grouping label, not an upstream — routes under it are emitted
#: unattached rather than against a fabricated service.
UNATTACHED_SERVICE_NAME = "(unattached routes)"

#: ``Operation.extras`` keys the projection consumes itself. Every *other* extras
#: key is a route attribute and is handed to the flavor renderer untouched, so a
#: source attribute the canonical model does not model still reaches the output.
OPERATION_ROUTE_EXTRAS: Tuple[str, ...] = (
    "gateway_route",
    "hosts",
    "path_match",
    "methods_unrestricted",
    "security",
    "plugins",
    "backends",
)

#: Upstream used for a service whose model records none. A gateway service must
#: name an upstream, so the alternative to a visible placeholder is an invalid
#: document; the projection records an ``INFERRED`` loss naming every service that
#: got one.
PLACEHOLDER_UPSTREAM = "http://localhost:8000"

#: Service-naming strategies, as an emit option value → what it does.
#:
#: * ``preserve`` — use the canonical service name unchanged (what a gateway
#:   import → export round trip needs, and the default);
#: * ``slug`` — lower-case, hyphenate and strip every character a gateway entity
#:   name may not carry, for models whose service names are prose (an OpenAPI tag
#:   like ``Pet Store``);
#: * ``host`` — name each service after its upstream host (``inventory.prod.svc``
#:   → ``inventory-prod-svc``), for models whose grouping carries no meaning.
SERVICE_NAMING_STRATEGIES: Tuple[str, ...] = ("preserve", "slug", "host")

#: Characters a gateway entity name may contain (Kong's rule, and a superset-safe
#: choice for the other flavors).
_NAME_SAFE_RE = re.compile(r"[^0-9A-Za-z._~-]+")

#: A path-template parameter, e.g. ``{userId}``.
_TEMPLATE_PARAM_RE = re.compile(r"\{([^{}/]+)\}")

#: Characters that must be escaped when a literal path segment is spliced into a
#: regex pattern.
_REGEX_ESCAPE_RE = re.compile(r"([.^$|?*+()\[\]\\])")

#: Character class an emitted path parameter matches: "anything but a path
#: separator", written as the hex escape rather than the more familiar ``[^/]``.
#: :func:`~app.gateway_config_model.build_path_pattern` reads a regex back
#: *segment-wise*, splitting on ``/``, so a literal slash inside the class would
#: split the parameter in half and recover a template with a phantom segment. The
#: escape is equivalent for PCRE and RE2, which is what Kong's router accepts.
_SEGMENT_CLASS = "[^\\x2f]"


# ===========================================================================
# Naming and path helpers
# ===========================================================================


def safe_name(value: str, *, fallback: str = "route") -> str:
    """Make ``value`` a legal gateway entity name, preserving what is already legal.

    Every run of characters outside ``[0-9A-Za-z._~-]`` collapses to one hyphen and
    leading/trailing separators are trimmed; case is kept, so a name a gateway
    already accepts comes back unchanged and a declared route name survives an
    import → export round trip byte for byte.

    Args:
        value: The source name (a declared route or service name).
        fallback: Name to return when ``value`` reduces to nothing.

    Returns:
        A non-empty name made only of ``[0-9A-Za-z._~-]``.
    """
    reduced = _NAME_SAFE_RE.sub("-", (value or "").strip()).strip("-._~")
    return reduced or fallback


def slug_name(value: str, *, fallback: str = "route") -> str:
    """Reduce ``value`` to a lower-case gateway-safe entity name.

    :func:`safe_name` over the lower-cased input, for names the projection
    *synthesizes* rather than recovers — an operation key (``"GET /pet/{petId}"``
    → ``"get-pet-petid"``) or an upstream host.

    Args:
        value: The source text to derive a name from.
        fallback: Name to return when ``value`` reduces to nothing.

    Returns:
        A non-empty lower-case name made only of ``[0-9a-z._~-]``.
    """
    return safe_name((value or "").lower(), fallback=fallback)


def preserve_name(value: str, *, fallback: str = "route") -> str:
    """Keep a source name exactly as the canonical model spells it.

    The :attr:`FlavorRules.entity_name` policy for a flavor whose *renderer* owns
    name legality — Gateway API, where a canonical service name carries the
    ``namespace/resource`` structure the emitter has to split before it can
    sanitize either half, and where Kong's character set is the wrong rule anyway
    (a Kubernetes object name is an RFC 1123 name, not ``[0-9A-Za-z._~-]``).

    Args:
        value: The source name.
        fallback: Name to return when ``value`` is blank.

    Returns:
        ``value`` trimmed, or ``fallback`` when nothing is left.
    """
    return (value or "").strip() or fallback


@dataclass(frozen=True)
class FlavorRules:
    """What one gateway flavor needs from the shared projection.

    The projection is flavor-neutral in *shape* but not in every rule: a Kong
    entity name and a Kubernetes object name obey different grammars, and a Kong
    service must name an upstream while a Gateway API rule names its backends on
    the rule itself. Rather than grow a parameter per difference on
    :func:`plan_gateway_config`, each flavor declares them once here.

    Attributes:
        entity_name: How a route/service name is made legal for the flavor.
            Applied by the projection so the document it returns already carries
            names the renderer can use; a renderer whose grammar the projection
            cannot express uses :func:`preserve_name` and sanitizes itself.
        require_upstream: Whether a service with no recorded upstream needs a
            placeholder one (Kong: a service without an upstream is not loadable;
            Gateway API: a rule's ``backendRefs`` carry the destination, so an
            invented service upstream would be noise).
    """

    entity_name: Callable[..., str] = field(default=safe_name)
    require_upstream: bool = True


#: Projection rules per document flavor. Every flavor the gateway *parsers*
#: produce (:mod:`app.kong_parser`, :mod:`app.gateway_api_parser`) has an entry, and
#: an unknown flavor gets the conservative default — legal-everywhere names and a
#: placeholder upstream — rather than silently skipping a rule.
GATEWAY_FLAVOR_RULES: Dict[str, FlavorRules] = {
    "kong": FlavorRules(),
    "gateway-api": FlavorRules(entity_name=preserve_name, require_upstream=False),
}


def flavor_rules(flavor: str) -> FlavorRules:
    """Return the projection rules for ``flavor``.

    Args:
        flavor: The document flavor (``kong`` / ``gateway-api``).

    Returns:
        The flavor's :class:`FlavorRules`, or the conservative default for a
        flavor with no entry.
    """
    return GATEWAY_FLAVOR_RULES.get(flavor, FlavorRules())


def template_path_pattern(template: str) -> GatewayPathPattern:
    """Turn a canonical route template into a gateway path pattern.

    The exact inverse of :func:`~app.gateway_config_model.build_path_pattern`: a
    template with no parameters is a literal ``prefix`` path, and a template with
    parameters becomes an anchored named-capture ``regex`` — ``/users/{userId}``
    → ``~/users/(?<userId>[^/]+)$`` — which that function reads straight back to
    ``/users/{userId}``. Literal segments are regex-escaped so a dot in a path
    stays a dot.

    Args:
        template: The canonical route template (``/users/{userId}``).

    Returns:
        The pattern, with ``kind`` ``prefix`` or ``regex`` and ``template`` equal
        to the input.
    """
    path = (template or "/").strip() or "/"
    if not path.startswith("/"):
        path = "/" + path
    names = _TEMPLATE_PARAM_RE.findall(path)
    if not names:
        return GatewayPathPattern(raw=path, kind="prefix", template=path)

    pieces: List[str] = []
    cursor = 0
    for match in _TEMPLATE_PARAM_RE.finditer(path):
        pieces.append(_REGEX_ESCAPE_RE.sub(r"\\\1", path[cursor : match.start()]))
        pieces.append(f"(?<{slug_param(match.group(1))}>{_SEGMENT_CLASS}+)")
        cursor = match.end()
    pieces.append(_REGEX_ESCAPE_RE.sub(r"\\\1", path[cursor:]))
    return GatewayPathPattern(
        raw="~" + "".join(pieces) + "$",
        kind="regex",
        template=path,
        param_names=tuple(names),
    )


def escape_path_literal(value: str) -> str:
    """Escape a literal path so it can be spliced into a regex pattern unchanged.

    Args:
        value: The literal path or path fragment.

    Returns:
        ``value`` with every regex metacharacter backslash-escaped.
    """
    return _REGEX_ESCAPE_RE.sub(r"\\\1", value)


def slug_param(name: str) -> str:
    """Reduce a template parameter name to a legal regex capture-group name.

    A capture group may only be named ``[A-Za-z_][A-Za-z0-9_]*``; a canonical
    parameter name is free text. Unsafe characters become underscores and a
    leading digit is prefixed, so ``"user-id"`` → ``"user_id"``.

    Args:
        name: The template parameter name.

    Returns:
        A legal capture-group name (``param`` when ``name`` reduces to nothing).
    """
    cleaned = re.sub(r"[^A-Za-z0-9_]", "_", name or "").strip("_")
    if not cleaned:
        return "param"
    return cleaned if cleaned[0].isalpha() or cleaned[0] == "_" else f"p_{cleaned}"


def server_host_schemes(api: CanonicalApi) -> Dict[str, str]:
    """Map each canonical server's host to the URL scheme it is served over.

    Used to give a route the ``protocols`` its hosts were imported with, so the
    servers a re-import derives match the ones the source declared. Hosts are
    recorded in first-declared order and a later duplicate does not overwrite an
    earlier one, matching how the normalizer builds servers.

    Args:
        api: The canonical model.

    Returns:
        ``host → scheme`` for every server whose URL names both.
    """
    schemes: Dict[str, str] = {}
    for server in api.servers:
        parts = urlsplit(server.url)
        if not parts.scheme or not parts.netloc:
            continue
        schemes.setdefault(parts.netloc, parts.scheme)
    return schemes


def gateway_sourced(api: CanonicalApi) -> bool:
    """Whether ``api`` came from a gateway-configuration import.

    True when the import stamped its report on ``extras["gateway"]``. The
    projection uses this for exactly one decision — whether header/query
    parameters are *match conditions* (they are, for a gateway model) or request
    *inputs* a gateway config cannot carry (they are, everywhere else).

    Args:
        api: The canonical model.

    Returns:
        True when the model carries a gateway report.
    """
    return isinstance(api.extras.get(GATEWAY_REPORT_EXTRA), Mapping)


# ===========================================================================
# Auth hints
# ===========================================================================


def auth_hints_from_extras(
    entries: Any,
    *,
    default_scope: str,
    default_attached_to: Optional[str],
) -> Tuple[List[GatewayAuthHint], List[Any]]:
    """Read ``extras["security"]`` back into :class:`GatewayAuthHint` values.

    Accepts the two shapes a canonical model can carry: the full mapping a gateway
    import writes (``scheme`` / ``plugin`` / ``scope`` / ``attached_to`` /
    ``detail``), which is reproduced verbatim, and a bare scheme name — the
    documented shape for any other normalizer — which is resolved to its plugin
    through :data:`~app.gateway_config_model.KONG_SCHEME_AUTH_PLUGINS`, the reverse
    of the table the importer maps plugins with.

    Args:
        entries: The ``security`` extras value (a list; anything else yields no
            hints and is returned as unreadable).
        default_scope: Scope for an entry that names none.
        default_attached_to: Attachment for an entry that names none.

    Returns:
        ``(hints, unreadable)`` — the hints in source order, and the entries that
        named neither a plugin nor a mappable scheme, so a caller can report them.
    """
    hints: List[GatewayAuthHint] = []
    unreadable: List[Any] = []
    if not isinstance(entries, (list, tuple)):
        return hints, unreadable

    for entry in entries:
        if isinstance(entry, str):
            plugin = KONG_SCHEME_AUTH_PLUGINS.get(entry)
            if plugin is None:
                unreadable.append(entry)
                continue
            hints.append(
                GatewayAuthHint(
                    scheme=entry,
                    plugin=plugin,
                    scope=default_scope,
                    attached_to=default_attached_to,
                )
            )
            continue
        if not isinstance(entry, Mapping):
            unreadable.append(entry)
            continue
        scheme = entry.get("scheme")
        scheme = scheme if isinstance(scheme, str) and scheme else None
        plugin = entry.get("plugin")
        if not isinstance(plugin, str) or not plugin:
            plugin = KONG_SCHEME_AUTH_PLUGINS.get(scheme or "")
        if not plugin:
            unreadable.append(entry)
            continue
        scope = entry.get("scope")
        attached = entry.get("attached_to")
        detail = entry.get("detail")
        hints.append(
            GatewayAuthHint(
                scheme=scheme,
                plugin=plugin,
                scope=scope if isinstance(scope, str) and scope else default_scope,
                attached_to=attached if isinstance(attached, str) and attached else default_attached_to,
                detail=dict(detail) if isinstance(detail, Mapping) else {},
            )
        )
    return hints, unreadable


def _hint_identity(hint: GatewayAuthHint) -> str:
    """Stable, hashable identity for an auth hint (used for grouping)."""
    return json.dumps(hint.as_dict(), sort_keys=True, default=str)


# ===========================================================================
# Route projection
# ===========================================================================


@dataclass(frozen=True)
class _RouteSignature:
    """Everything about a route other than its match conditions.

    Two operations named by the same ``gateway_route`` belong to one route only
    when they agree on all of it; a model edited after import can disagree, and
    the projection then splits the group rather than picking one side silently.
    """

    hosts: Tuple[str, ...]
    protocols: Tuple[str, ...]
    auth: Tuple[str, ...]
    plugins: Tuple[str, ...]
    backends: str
    extras: str


def _backends_from_extras(value: Any) -> Tuple[GatewayBackend, ...]:
    """Rebuild ``GatewayBackend`` values from an operation's ``backends`` extras."""
    if not isinstance(value, (list, tuple)):
        return ()
    backends: List[GatewayBackend] = []
    for entry in value:
        if not isinstance(entry, Mapping):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        port = entry.get("port")
        weight = entry.get("weight")
        namespace = entry.get("namespace")
        backends.append(
            GatewayBackend(
                name=name,
                namespace=namespace if isinstance(namespace, str) else None,
                port=port if isinstance(port, int) and not isinstance(port, bool) else None,
                weight=weight if isinstance(weight, int) and not isinstance(weight, bool) else None,
            )
        )
    return tuple(backends)


def _match_conditions(
    operation: Operation,
    *,
    as_matches: bool,
) -> Tuple[Tuple[Tuple[str, str], ...], Tuple[Tuple[str, str], ...], List[str]]:
    """Split an operation's header/query parameters into matches and losses.

    Args:
        operation: The operation whose parameters are being read.
        as_matches: True when this model's parameters really are match conditions
            (a gateway import); False when they are request inputs a gateway
            config cannot carry.

    Returns:
        ``(headers, query, unrepresentable)`` — the header and query match pairs
        and the names of parameters reported as losses instead.
    """
    headers: List[Tuple[str, str]] = []
    query: List[Tuple[str, str]] = []
    unrepresentable: List[str] = []
    for parameter in operation.parameters:
        if parameter.location is ParameterLocation.PATH:
            continue
        if not as_matches or parameter.location not in (
            ParameterLocation.HEADER,
            ParameterLocation.QUERY,
        ):
            unrepresentable.append(parameter.key)
            continue
        value = parameter.extras.get("match_value")
        pair = (parameter.name, value if isinstance(value, str) else "")
        if parameter.location is ParameterLocation.HEADER:
            headers.append(pair)
        else:
            query.append(pair)
    return tuple(headers), tuple(query), unrepresentable


def _operation_route_extras(operation: Operation) -> Dict[str, Any]:
    """Return the operation extras that are route attributes, in sorted order."""
    return {
        key: value
        for key, value in sorted(operation.extras.items())
        if key not in OPERATION_ROUTE_EXTRAS
    }


def _path_pattern_for(operation: Operation, losses: LossTracker) -> GatewayPathPattern:
    """Recover (or derive) the path pattern one operation matches on."""
    declared = operation.extras.get("path_match")
    if isinstance(declared, Mapping):
        raw = declared.get("raw")
        kind = declared.get("kind")
        if isinstance(raw, str) and raw and isinstance(kind, str) and kind:
            return build_path_pattern(raw, kind)
    template = operation.http_path or "/"
    pattern = template_path_pattern(template)
    if pattern.kind == "regex":
        # Check the inverse rather than assume it: `build_path_pattern` reads a
        # regex back segment-wise, so a parameter that is only *part* of a segment
        # (``/files/{name}.json``) cannot be recovered, and that has to be said.
        recovered = build_path_pattern(pattern.raw, pattern.kind).template
        if recovered == template:
            losses.record(
                LossKind.INFERRED,
                "synthesized-path-regex",
                f"Path template {template!r} has no literal gateway equivalent; emitted "
                f"as the named-capture regex {pattern.raw!r}, which re-imports to the "
                "same template.",
                operation.key,
            )
        else:
            losses.record(
                LossKind.INFERRED,
                "lossy-path-template",
                f"Path template {template!r} places a parameter inside a path segment "
                f"rather than spanning one; the emitted regex {pattern.raw!r} matches "
                f"the same requests, but re-reading it recovers {recovered!r}.",
                operation.key,
            )
    return pattern


def _method_for(operation: Operation) -> Optional[str]:
    """Return the HTTP method the route restricts to, or ``None`` for any method."""
    if operation.extras.get("methods_unrestricted") is True:
        return None
    method = (operation.http_method or "").strip().upper()
    if not method or method == ANY_METHOD:
        return None
    return method


def _route_signature(
    operation: Operation,
    *,
    host_schemes: Mapping[str, str],
    default_hosts: Sequence[str],
    losses: LossTracker,
) -> Tuple[_RouteSignature, Tuple[GatewayAuthHint, ...], Tuple[GatewayPlugin, ...]]:
    """Build one operation's route signature, plus its auth hints and plugins."""
    declared_hosts = operation.extras.get("hosts")
    if isinstance(declared_hosts, (list, tuple)) and declared_hosts:
        hosts = tuple(str(host) for host in declared_hosts)
    else:
        hosts = tuple(default_hosts)
        if hosts:
            losses.record(
                LossKind.INFERRED,
                "synthesized-route-host",
                "The operation declares no gateway host; the route matches the "
                f"canonical servers' hosts ({', '.join(hosts)}) instead.",
                operation.key,
            )

    schemes = {host_schemes[host] for host in hosts if host in host_schemes}
    protocols: Tuple[str, ...] = tuple(sorted(schemes)) if schemes else ()

    hints, unreadable = auth_hints_from_extras(
        operation.extras.get("security"),
        default_scope="route",
        default_attached_to=None,
    )
    for entry in unreadable:
        losses.record(
            LossKind.NA,
            "unmappable-security-scheme",
            f"Security entry {entry!r} names no Kong auth plugin and no scheme the "
            "plugin table maps, so no plugin was emitted for it.",
            operation.key,
        )

    plugin_names = operation.extras.get("plugins")
    plugins = tuple(
        GatewayPlugin(name=str(name), scope="route")
        for name in (plugin_names if isinstance(plugin_names, (list, tuple)) else ())
        if isinstance(name, str) and name
    )

    backends = _backends_from_extras(operation.extras.get("backends"))
    extras = _operation_route_extras(operation)
    signature = _RouteSignature(
        hosts=hosts,
        protocols=protocols,
        auth=tuple(sorted(_hint_identity(hint) for hint in hints)),
        plugins=tuple(sorted(plugin.name for plugin in plugins)),
        backends=json.dumps([b.as_dict() for b in backends], sort_keys=True),
        extras=json.dumps(extras, sort_keys=True, default=str),
    )
    return signature, tuple(hints), plugins


def _service_definition(
    service: Service,
    *,
    name: str,
    api: CanonicalApi,
    losses: LossTracker,
    require_upstream: bool = True,
) -> GatewayServiceDef:
    """Build the upstream definition for one canonical service.

    Args:
        service: The canonical service.
        name: The gateway entity name assigned to it.
        api: The owning model (its first server is the fallback upstream).
        losses: Tracker the placeholder upstream is reported on.
        require_upstream: Whether the flavor needs an upstream address at all
            (see :attr:`FlavorRules.require_upstream`).

    Returns:
        The service definition, with an upstream only where one is recorded or
        the flavor requires a placeholder.
    """
    backend = service.extras.get(BACKEND_EXTRA)
    fields: Dict[str, Any] = dict(backend) if isinstance(backend, Mapping) else {}
    url = fields.get("url") if isinstance(fields.get("url"), str) else None
    protocol = fields.get("protocol") if isinstance(fields.get("protocol"), str) else None
    host = fields.get("host") if isinstance(fields.get("host"), str) else None
    port = fields.get("port") if isinstance(fields.get("port"), int) else None
    path = fields.get("path") if isinstance(fields.get("path"), str) else None

    if url is None and host is None and require_upstream:
        url = api.servers[0].url if api.servers else PLACEHOLDER_UPSTREAM
        losses.record(
            LossKind.INFERRED,
            "synthesized-upstream",
            f"Service {service.name!r} records no upstream address; emitted "
            f"{url!r} so the configuration is loadable — replace it before applying.",
            service.key,
        )

    extras = {key: value for key, value in service.extras.items() if key != BACKEND_EXTRA}
    return GatewayServiceDef(
        name=name,
        url=url,
        protocol=protocol,
        host=host,
        port=port,
        path=path,
        extras=extras,
    )


def _service_names(
    api: CanonicalApi,
    *,
    strategy: str,
    losses: LossTracker,
    entity_name: Callable[..., str] = safe_name,
) -> Dict[str, str]:
    """Assign a gateway service name to every canonical service key.

    Applies the requested :data:`SERVICE_NAMING_STRATEGIES` strategy and
    de-duplicates the result (a strategy can collapse two canonical names onto
    one), appending ``-2``, ``-3``, … and reporting each collision.

    Args:
        api: The canonical model.
        strategy: One of :data:`SERVICE_NAMING_STRATEGIES`.
        losses: Tracker sanitizations and collisions are reported on.
        entity_name: The flavor's name policy (see :class:`FlavorRules`).

    Returns:
        ``service key → gateway service name`` for every canonical service.
    """
    assigned: Dict[str, str] = {}
    taken: Dict[str, int] = {}
    for service in api.services:
        if service.name == UNATTACHED_SERVICE_NAME:
            assigned[service.key] = UNATTACHED_SERVICE_NAME
            continue
        if strategy == "host":
            backend = service.extras.get(BACKEND_EXTRA)
            source = ""
            if isinstance(backend, Mapping):
                url = backend.get("url")
                if isinstance(url, str) and url:
                    source = urlsplit(url).hostname or ""
                elif isinstance(backend.get("host"), str):
                    source = str(backend["host"])
            candidate = slug_name(source or service.name, fallback="service")
        elif strategy == "slug":
            candidate = slug_name(service.name, fallback="service")
        else:
            candidate = entity_name(service.name, fallback="service")
            if candidate != service.name:
                losses.record(
                    LossKind.INFERRED,
                    "sanitized-service-name",
                    f"Service name {service.name!r} contains characters a gateway "
                    f"entity name may not carry; emitted as {candidate!r}.",
                    service.key,
                )
        if candidate in taken:
            taken[candidate] += 1
            deduped = f"{candidate}-{taken[candidate]}"
            losses.record(
                LossKind.INFERRED,
                "deduplicated-service-name",
                f"Service name {candidate!r} is already taken by another service; "
                f"emitted as {deduped!r}.",
                service.key,
            )
            candidate = deduped
        else:
            taken[candidate] = 1
        assigned[service.key] = candidate
    return assigned


def _global_entities(
    api: CanonicalApi,
) -> Tuple[Tuple[GatewayPlugin, ...], Tuple[GatewayAuthHint, ...]]:
    """Recover the gateway-wide plugins and auth hints from the import report."""
    report = api.extras.get(GATEWAY_REPORT_EXTRA)
    if not isinstance(report, Mapping):
        return (), ()

    plugins = tuple(
        GatewayPlugin(name=str(name), scope="global")
        for name in report.get("global_plugins") or []
        if isinstance(name, str) and name
    )

    hints: List[GatewayAuthHint] = []
    for entry in report.get("auth") or []:
        if not isinstance(entry, Mapping) or entry.get("scope") != "global":
            continue
        found, _ = auth_hints_from_extras(
            [entry], default_scope="global", default_attached_to=None
        )
        hints.extend(found)
    for entry in report.get("unmapped_plugins") or []:
        if not isinstance(entry, Mapping) or entry.get("scope") != "global":
            continue
        name = entry.get("name")
        if isinstance(name, str) and name:
            hints.append(GatewayAuthHint(scheme=None, plugin=name, scope="global"))
    return plugins, tuple(hints)


def _record_schema_losses(api: CanonicalApi, losses: LossTracker) -> None:
    """Report every construct a routing surface has no place for.

    A gateway configuration describes *where a request goes*, never *what it
    carries*, so request/response bodies, named types and event channels are
    unrepresentable by construction. Each one is recorded individually — the
    capability profile states the class, these state the instances.
    """
    for service in api.services:
        for operation in service.operations:
            for message in operation.messages:
                losses.record(
                    LossKind.NA,
                    "message-schema",
                    f"A gateway configuration carries no request/response schemas, so "
                    f"the {message.role.value} body of {operation.key!r} is not emitted.",
                    message.key,
                )
    for type_ in api.types:
        losses.record(
            LossKind.NA,
            "named-type",
            f"A gateway configuration has no type system, so the named type "
            f"{type_.name!r} is not emitted.",
            type_.key,
        )
    for channel in api.channels:
        losses.record(
            LossKind.NA,
            "event-channel",
            f"A gateway configuration routes HTTP requests only, so the event channel "
            f"{(channel.address or channel.key)!r} is not emitted.",
            channel.key,
        )
    if api.description:
        losses.record(
            LossKind.NA,
            "artifact-description",
            "A gateway configuration has no field for the artifact description.",
            "",
        )
    if api.version:
        losses.record(
            LossKind.NA,
            "artifact-version",
            "A gateway configuration has no field for the artifact version.",
            "",
        )


def _record_report_losses(api: CanonicalApi, losses: LossTracker) -> None:
    """Report what the *import* already recorded as unrecoverable.

    Constructs the importer listed as ignored (consumers, upstreams, certificates)
    and credentials it redacted never reached the canonical model, so an export
    cannot put them back — stating that is the difference between a config a user
    can trust and one that quietly forgets their consumers.
    """
    report = api.extras.get(GATEWAY_REPORT_EXTRA)
    if not isinstance(report, Mapping):
        return
    for entry in report.get("ignored_constructs") or []:
        if not isinstance(entry, Mapping):
            continue
        construct = entry.get("construct")
        if not isinstance(construct, str) or not construct:
            continue
        losses.record(
            LossKind.NA,
            "unimported-construct",
            f"The import did not model the source's {construct!r} section "
            f"({entry.get('count', 0)} entries), so it cannot be emitted back.",
            "",
        )
    redactions = report.get("credential_redactions")
    if isinstance(redactions, int) and redactions > 0:
        losses.record(
            LossKind.NA,
            "redacted-credential",
            f"{redactions} credential values were redacted at import and are never "
            "retained, so the emitted configuration declares no credentials.",
            "",
        )


def plan_gateway_config(
    api: CanonicalApi,
    *,
    flavor: str,
    losses: LossTracker,
    service_naming: str = "preserve",
) -> GatewayConfigDocument:
    """Project ``api`` onto a flavor-neutral gateway configuration document.

    Reads a gateway import's routing surface back out of the canonical extras
    verbatim (so import → export is an identity) and derives one for any other
    model, recording every derivation and every unrepresentable construct on
    ``losses``. Pure and deterministic: the same model always yields an equal
    document, with services in canonical order and routes in first-appearance
    order within each service.

    Args:
        api: The canonical model to project.
        flavor: The document flavor to stamp (``kong`` / ``gateway-api``). It also
            selects the :class:`FlavorRules` the projection applies — how names are
            made legal, and whether a service needs a placeholder upstream.
        losses: Tracker the projection reports fidelity losses on.
        service_naming: One of :data:`SERVICE_NAMING_STRATEGIES`.

    Returns:
        The :class:`~app.gateway_config_model.GatewayConfigDocument` a flavor
        renderer turns into its own syntax.

    Raises:
        ValueError: When ``service_naming`` is not a known strategy.
    """
    if service_naming not in SERVICE_NAMING_STRATEGIES:
        raise ValueError(
            f"Unknown service-naming strategy {service_naming!r}; expected one of "
            f"{', '.join(SERVICE_NAMING_STRATEGIES)}"
        )

    rules = flavor_rules(flavor)

    _record_schema_losses(api, losses)
    _record_report_losses(api, losses)

    host_schemes = server_host_schemes(api)
    default_hosts = tuple(host_schemes)
    as_matches = gateway_sourced(api)
    names_by_key = _service_names(
        api, strategy=service_naming, losses=losses, entity_name=rules.entity_name
    )

    services: List[GatewayServiceDef] = []
    routes: List[GatewayRoute] = []

    for service in api.services:
        service_name = names_by_key[service.key]
        unattached = service_name == UNATTACHED_SERVICE_NAME
        if not unattached:
            services.append(
                _service_definition(
                    service,
                    name=service_name,
                    api=api,
                    losses=losses,
                    require_upstream=rules.require_upstream,
                )
            )

        # Group the service's operations back into routes: same declared route
        # name *and* same signature. A second signature under one name means the
        # model was edited after import, so the route is split rather than merged.
        grouped: Dict[Tuple[str, _RouteSignature], List[GatewayMatch]] = {}
        order: List[Tuple[str, _RouteSignature]] = []
        context: Dict[
            Tuple[str, _RouteSignature],
            Tuple[Tuple[GatewayAuthHint, ...], Tuple[GatewayPlugin, ...], Dict[str, Any]],
        ] = {}

        for operation in service.operations:
            if not operation.http_path:
                # An RPC method, a GraphQL field or a pub/sub action has no HTTP
                # coordinate. Routing it would mean inventing one, so it is
                # reported instead — a gateway cannot route what has no address.
                losses.record(
                    LossKind.NA,
                    "unroutable-operation",
                    f"Operation {operation.key!r} declares no HTTP path, so a gateway "
                    "configuration has no route to express it.",
                    operation.key,
                )
                continue
            declared_name = operation.extras.get("gateway_route")
            route_name = (
                declared_name
                if isinstance(declared_name, str) and declared_name
                else slug_name(operation.key, fallback="route")
            )
            signature, hints, plugins = _route_signature(
                operation,
                host_schemes=host_schemes,
                default_hosts=default_hosts,
                losses=losses,
            )
            headers, query, unrepresentable = _match_conditions(
                operation, as_matches=as_matches
            )
            for key in unrepresentable:
                losses.record(
                    LossKind.NA,
                    "request-parameter",
                    "A gateway route matches on headers and query parameters but does "
                    f"not describe request inputs, so parameter {key!r} is not emitted.",
                    key,
                )
            bucket = (route_name, signature)
            if bucket not in grouped:
                grouped[bucket] = []
                order.append(bucket)
                context[bucket] = (hints, plugins, _operation_route_extras(operation))
            grouped[bucket].append(
                GatewayMatch(
                    path=_path_pattern_for(operation, losses),
                    method=_method_for(operation),
                    headers=headers,
                    query=query,
                )
            )

        seen_names: Dict[str, int] = {}
        for bucket in order:
            route_name, signature = bucket
            hints, plugins, extras = context[bucket]
            seen_names[route_name] = seen_names.get(route_name, 0) + 1
            emitted_name = route_name
            if seen_names[route_name] > 1:
                emitted_name = f"{route_name}-{seen_names[route_name]}"
                losses.record(
                    LossKind.INFERRED,
                    "split-route",
                    f"Operations naming route {route_name!r} no longer agree on its "
                    f"hosts, plugins or attributes; emitted the remainder as "
                    f"{emitted_name!r}.",
                    route_name,
                )
            routes.append(
                GatewayRoute(
                    name=rules.entity_name(emitted_name, fallback="route"),
                    service_name=None if unattached else service_name,
                    hosts=signature.hosts,
                    matches=tuple(grouped[bucket]),
                    protocols=signature.protocols,
                    auth=tuple(hints),
                    plugins=plugins,
                    backends=_backends_from_extras(json.loads(signature.backends)),
                    extras=dict(extras),
                )
            )

    # A gateway service with no route is dead configuration — and a canonical
    # service whose every operation was unroutable produces exactly that. Drop it
    # rather than emit an upstream nothing reaches, and say which one went.
    routed = {route.service_name for route in routes}
    kept: List[GatewayServiceDef] = []
    for service in services:
        if service.name in routed:
            kept.append(service)
            continue
        losses.record(
            LossKind.NA,
            "unrouted-service",
            f"Service {service.name!r} has no operation a gateway can route, so no "
            "upstream is emitted for it.",
            service.name,
        )

    global_plugins, global_auth = _global_entities(api)
    return GatewayConfigDocument(
        flavor=flavor,
        title=api.title or api.identity.name,
        services=tuple(kept),
        routes=tuple(routes),
        global_plugins=global_plugins,
        global_auth=global_auth,
    )


def narrow_service_scoped_auth(
    document: GatewayConfigDocument,
) -> Tuple[GatewayConfigDocument, List[Tuple[str, str]]]:
    """Move a service-scoped auth hint to route scope when it is not universal.

    A gateway attaches a service-scoped plugin to *every* route of that service, so
    a hint recorded as service-scoped may only be re-emitted there when every route
    of the service still carries it. When a model was edited so that one route lost
    it, re-emitting at service scope would silently put it back; this narrows the
    hint to the routes that actually carry it instead.

    Args:
        document: The projected document.

    Returns:
        ``(document, narrowed)`` — the document with such hints rewritten to
        ``scope="route"``, and ``(route name, plugin name)`` pairs for each
        rewrite so the caller can report them.
    """
    routes_by_service: Dict[str, List[GatewayRoute]] = {}
    for route in document.routes:
        routes_by_service.setdefault(route.service_name or "", []).append(route)

    universal: Dict[str, set] = {}
    for service_name, routes in routes_by_service.items():
        shared: Optional[set] = None
        for route in routes:
            identities = {
                _hint_identity(hint) for hint in route.auth if hint.scope == "service"
            }
            shared = identities if shared is None else (shared & identities)
        universal[service_name] = shared or set()

    narrowed: List[Tuple[str, str]] = []
    rewritten: List[GatewayRoute] = []
    for route in document.routes:
        shared = universal.get(route.service_name or "", set())
        auth: List[GatewayAuthHint] = []
        for hint in route.auth:
            if (
                hint.scope == "service"
                and hint.attached_to == route.service_name
                and _hint_identity(hint) in shared
            ):
                auth.append(hint)
                continue
            if hint.scope == "service":
                narrowed.append((route.name, hint.plugin))
                auth.append(replace(hint, scope="route", attached_to=route.name))
                continue
            auth.append(hint)
        rewritten.append(replace(route, auth=tuple(auth)))

    return replace(document, routes=tuple(rewritten)), narrowed

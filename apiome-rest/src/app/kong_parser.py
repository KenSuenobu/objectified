"""Parser for Kong declarative configuration (YAML/JSON) — IXH-7.8 (#5133).

Reads a `deck`-style declarative file (``_format_version`` + ``services`` /
``routes`` / ``plugins`` / ``consumers`` / ``upstreams``) into the flavor-neutral
:class:`~app.gateway_config_model.GatewayConfigDocument`. Routes become flattened
match conditions (Kong's ``paths × methods`` cross-product), auth plugins become
canonical-scheme hints where a mapping exists (:data:`KONG_AUTH_PLUGIN_SCHEMES`),
and everything else attached to the surface is preserved as plugins/extras.

Consumer credential sections (``keyauth_credentials``, ``jwt_secrets``, …) and
secret-shaped plugin config values are **redacted at parse time** — only counts
survive. Constructs the adapter recognizes but does not model (``upstreams``,
``certificates``, …) are recorded on ``document.ignored`` so the coverage ledger
can state them instead of dropping them silently.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Dict, List, Optional, Tuple

import yaml

from .gateway_config_model import (
    KONG_AUTH_PLUGIN_SCHEMES,
    GatewayAuthHint,
    GatewayConfigDocument,
    GatewayConfigParseError,
    GatewayMatch,
    GatewayPlugin,
    GatewayRoute,
    GatewayServiceDef,
    build_path_pattern,
    redact_secret_config,
)

__all__ = [
    "is_kong_declarative",
    "is_kong_declarative_document",
    "parse_kong_declarative",
    "parse_kong_fileset",
]

#: Top-level keys that mark a mapping as a Kong declarative config.
_KONG_SECTION_KEYS = ("services", "routes", "plugins", "consumers", "upstreams")

#: Top-level keys the parser reads (everything else is recorded as ignored).
_KNOWN_TOP_LEVEL_KEYS = frozenset(
    {"_format_version", "_transform", "_info", "_comment", *_KONG_SECTION_KEYS}
)

#: Recognized-but-unmodeled top-level constructs, with the honest reason each is
#: not part of the imported API surface.
_IGNORED_CONSTRUCT_REASONS: Dict[str, str] = {
    "upstreams": "load-balancing targets describe deployment topology, not the API surface",
    "certificates": "TLS certificate material is deployment configuration, not the API surface",
    "ca_certificates": "CA certificate material is deployment configuration, not the API surface",
    "snis": "SNI bindings are TLS routing detail, not the API surface",
    "vaults": "vault references are secret-storage configuration, not the API surface",
    "consumers": (
        "consumer identities are callers of the API, not part of its surface; "
        "credential values are redacted and never imported"
    ),
}

#: Consumer sub-keys that hold credential material (counted, then discarded).
_CREDENTIAL_KEYS = (
    "keyauth_credentials",
    "basicauth_credentials",
    "jwt_secrets",
    "hmac_credentials",
    "oauth2_credentials",
    "mtls_auth_credentials",
)

#: Route attributes carried into ``GatewayRoute.extras`` when present (attributes
#: the canonical model has no field for; preserved, never dropped).
_ROUTE_EXTRA_KEYS = (
    "strip_path",
    "preserve_host",
    "path_handling",
    "regex_priority",
    "https_redirect_status_code",
    "request_buffering",
    "response_buffering",
    "tags",
    "headers",
    "snis",
    "expression",
    "priority",
)


def is_kong_declarative_document(document: Any) -> bool:
    """Return True when a pre-parsed document is a Kong declarative config."""
    if not isinstance(document, dict):
        return False
    if "_format_version" not in document:
        return False
    return any(key in document for key in _KONG_SECTION_KEYS)


def is_kong_declarative(text: str) -> bool:
    """Cheap sniff: does ``text`` look like a Kong declarative YAML/JSON config?"""
    if not text or "_format_version" not in text:
        return False
    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError:
        return False
    return is_kong_declarative_document(document)


def _reject_binary(text: str) -> None:
    """Reject text that decoded from a non-UTF-8 source (NUL bytes survive)."""
    if "\x00" in text:
        raise GatewayConfigParseError(
            "Kong declarative config contains NUL bytes — the file is binary or "
            "not UTF-8 encoded",
            code="INPUT_ENCODING_INVALID",
        )


def _load_yaml(text: str) -> Any:
    """Parse YAML/JSON text, mapping truncation and syntax errors to taxonomy codes."""
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as exc:
        message = str(exc)
        if "end of stream" in message or "<stream end>" in message:
            raise GatewayConfigParseError(
                f"Kong declarative config is truncated: {message}",
                code="INPUT_TRUNCATED",
            ) from exc
        raise GatewayConfigParseError(
            f"Kong declarative config is not valid YAML/JSON: {message}",
            code="INPUT_MALFORMED",
        ) from exc


def _as_str_tuple(value: Any) -> Tuple[str, ...]:
    """Coerce a source list-of-strings field to a tuple, dropping non-strings."""
    if not isinstance(value, list):
        return ()
    return tuple(str(item) for item in value if isinstance(item, (str, int)))


def _plugin_and_hint(
    entry: Dict[str, Any], scope: str, attached_to: Optional[str]
) -> Tuple[Optional[GatewayPlugin], Optional[GatewayAuthHint], int]:
    """Build a plugin (and auth hint, when the plugin is an auth mechanism).

    Args:
        entry: The raw plugin mapping.
        scope: Attachment scope (``global`` / ``service`` / ``route`` / ``consumer``).
        attached_to: Name of the owning entity, when scoped.

    Returns:
        ``(plugin, auth_hint, redaction_count)``. ``plugin`` is ``None`` for a
        nameless entry; ``auth_hint`` is ``None`` for a non-auth plugin.
    """
    name = entry.get("name")
    if not isinstance(name, str) or not name:
        return None, None, 0
    config, redacted = redact_secret_config(entry.get("config") or {})
    if not isinstance(config, dict):
        config = {"value": config}
    enabled = bool(entry.get("enabled", True))
    plugin = GatewayPlugin(
        name=name, scope=scope, attached_to=attached_to, enabled=enabled, config=config
    )

    hint: Optional[GatewayAuthHint] = None
    if name in KONG_AUTH_PLUGIN_SCHEMES and enabled:
        scheme = KONG_AUTH_PLUGIN_SCHEMES[name]
        detail: Dict[str, Any] = {}
        if name in ("key-auth", "key-auth-enc"):
            detail["key_names"] = list(config.get("key_names") or ["apikey"])
            detail["in"] = "header"
        if name == "jwt":
            detail["bearer_format"] = "JWT"
        if name == "oauth2":
            detail["scopes"] = list(config.get("scopes") or [])
            detail["flows"] = sorted(
                flag
                for flag in (
                    "enable_authorization_code",
                    "enable_client_credentials",
                    "enable_implicit_grant",
                    "enable_password_grant",
                )
                if config.get(flag)
            )
        hint = GatewayAuthHint(
            scheme=scheme, plugin=name, scope=scope, attached_to=attached_to, detail=detail
        )
    return plugin, hint, redacted


def _route_matches(entry: Dict[str, Any]) -> Tuple[GatewayMatch, ...]:
    """Flatten a Kong route's ``paths × methods`` cross-product into matches."""
    raw_paths = entry.get("paths")
    patterns = []
    if isinstance(raw_paths, list) and raw_paths:
        for raw in raw_paths:
            if not isinstance(raw, str) or not raw:
                continue
            kind = "regex" if raw.startswith("~") else "prefix"
            patterns.append(build_path_pattern(raw, kind))
    if not patterns:
        # A route with hosts but no paths matches any path.
        patterns.append(build_path_pattern("/", "prefix"))

    methods = [m.upper() for m in _as_str_tuple(entry.get("methods"))]
    if not methods:
        return tuple(GatewayMatch(path=pattern) for pattern in patterns)
    return tuple(
        GatewayMatch(path=pattern, method=method)
        for pattern in patterns
        for method in methods
    )


def _parse_route(
    entry: Dict[str, Any],
    *,
    index: int,
    service_name: Optional[str],
    service_auth: Tuple[GatewayAuthHint, ...],
    service_plugins: Tuple[GatewayPlugin, ...],
    source_location: str,
) -> Tuple[GatewayRoute, int]:
    """Parse one route entry (nested under a service or top-level).

    Returns:
        ``(route, redaction_count)``.
    """
    name = entry.get("name")
    route_name = name if isinstance(name, str) and name else f"route-{index}"

    plugins: List[GatewayPlugin] = list(service_plugins)
    auth: List[GatewayAuthHint] = list(service_auth)
    redactions = 0
    raw_plugins = entry.get("plugins")
    if isinstance(raw_plugins, list):
        for plugin_entry in raw_plugins:
            if not isinstance(plugin_entry, dict):
                continue
            plugin, hint, redacted = _plugin_and_hint(plugin_entry, "route", route_name)
            redactions += redacted
            if plugin is not None and hint is None:
                plugins.append(plugin)
            if hint is not None:
                auth.append(hint)

    extras: Dict[str, Any] = {}
    for key in _ROUTE_EXTRA_KEYS:
        if key in entry and entry[key] is not None:
            extras[key] = entry[key]

    route = GatewayRoute(
        name=route_name,
        service_name=service_name,
        hosts=_as_str_tuple(entry.get("hosts")),
        matches=_route_matches(entry),
        protocols=_as_str_tuple(entry.get("protocols")),
        auth=tuple(auth),
        plugins=tuple(plugins),
        source_location=source_location,
        extras=extras,
    )
    return route, redactions


def _service_ref_name(value: Any) -> Optional[str]:
    """Resolve a top-level route's ``service`` reference (string or ``{name}``)."""
    if isinstance(value, str) and value:
        return value
    if isinstance(value, dict):
        name = value.get("name") or value.get("id")
        if isinstance(name, str) and name:
            return name
    return None


def parse_kong_declarative(
    text: str, *, source_label: Optional[str] = None
) -> GatewayConfigDocument:
    """Parse a Kong declarative config into a :class:`GatewayConfigDocument`.

    Args:
        text: The YAML or JSON source text.
        source_label: Filename / paste label for provenance.

    Returns:
        The flavor-neutral document (``flavor="kong"``), credential-free.

    Raises:
        GatewayConfigParseError: With a taxonomy code — ``INPUT_ENCODING_INVALID``
            for binary input, ``INPUT_TRUNCATED``/``INPUT_MALFORMED`` for broken
            YAML, ``FORMAT_MISMATCH`` when the mapping is not a Kong config, and
            ``INPUT_SEMANTIC_INVALID`` when it declares no routable surface.
    """
    _reject_binary(text)
    if not text.strip():
        raise GatewayConfigParseError(
            "Kong declarative config is empty", code="INPUT_MALFORMED"
        )
    document = _load_yaml(text)
    if not isinstance(document, dict):
        raise GatewayConfigParseError(
            "Kong declarative config must be a YAML/JSON mapping",
            code="INPUT_MALFORMED",
        )
    if not any(key in document for key in _KONG_SECTION_KEYS) and "_format_version" not in document:
        raise GatewayConfigParseError(
            "Document is not a Kong declarative config (no _format_version and no "
            "services/routes/plugins/consumers/upstreams sections)",
            code="FORMAT_MISMATCH",
        )

    services: List[GatewayServiceDef] = []
    routes: List[GatewayRoute] = []
    global_plugins: List[GatewayPlugin] = []
    global_auth: List[GatewayAuthHint] = []
    ignored: List[Dict[str, Any]] = []
    redactions = 0
    route_index = 0

    # --- services (with nested routes and plugins) -----------------------------
    raw_services = document.get("services")
    service_auth_by_name: Dict[str, Tuple[GatewayAuthHint, ...]] = {}
    service_plugins_by_name: Dict[str, Tuple[GatewayPlugin, ...]] = {}
    if isinstance(raw_services, list):
        for service_index, raw_service in enumerate(raw_services):
            if not isinstance(raw_service, dict):
                continue
            raw_name = raw_service.get("name")
            service_name = (
                raw_name if isinstance(raw_name, str) and raw_name else f"service-{service_index}"
            )
            svc_plugins: List[GatewayPlugin] = []
            svc_auth: List[GatewayAuthHint] = []
            raw_plugins = raw_service.get("plugins")
            if isinstance(raw_plugins, list):
                for plugin_entry in raw_plugins:
                    if not isinstance(plugin_entry, dict):
                        continue
                    plugin, hint, redacted = _plugin_and_hint(
                        plugin_entry, "service", service_name
                    )
                    redactions += redacted
                    if plugin is not None and hint is None:
                        svc_plugins.append(plugin)
                    if hint is not None:
                        svc_auth.append(hint)
            service_auth_by_name[service_name] = tuple(svc_auth)
            service_plugins_by_name[service_name] = tuple(svc_plugins)

            extras = {
                key: raw_service[key]
                for key in ("tags", "retries", "connect_timeout", "read_timeout", "write_timeout", "enabled")
                if key in raw_service and raw_service[key] is not None
            }
            services.append(
                GatewayServiceDef(
                    name=service_name,
                    url=raw_service.get("url") if isinstance(raw_service.get("url"), str) else None,
                    protocol=raw_service.get("protocol") if isinstance(raw_service.get("protocol"), str) else None,
                    host=raw_service.get("host") if isinstance(raw_service.get("host"), str) else None,
                    port=raw_service.get("port") if isinstance(raw_service.get("port"), int) else None,
                    path=raw_service.get("path") if isinstance(raw_service.get("path"), str) else None,
                    extras=extras,
                )
            )

            raw_routes = raw_service.get("routes")
            if isinstance(raw_routes, list):
                for raw_route in raw_routes:
                    if not isinstance(raw_route, dict):
                        continue
                    route, route_redactions = _parse_route(
                        raw_route,
                        index=route_index,
                        service_name=service_name,
                        service_auth=tuple(svc_auth),
                        service_plugins=tuple(svc_plugins),
                        source_location=f"services[{service_index}].routes",
                    )
                    redactions += route_redactions
                    routes.append(route)
                    route_index += 1

    # --- top-level routes (service referenced by name) --------------------------
    raw_routes = document.get("routes")
    if isinstance(raw_routes, list):
        for raw_route in raw_routes:
            if not isinstance(raw_route, dict):
                continue
            service_name = _service_ref_name(raw_route.get("service"))
            route, route_redactions = _parse_route(
                raw_route,
                index=route_index,
                service_name=service_name,
                service_auth=service_auth_by_name.get(service_name or "", ()),
                service_plugins=service_plugins_by_name.get(service_name or "", ()),
                source_location=f"routes[{route_index}]",
            )
            redactions += route_redactions
            routes.append(route)
            route_index += 1

    # --- top-level plugins (global, or attached by reference) --------------------
    raw_plugins = document.get("plugins")
    if isinstance(raw_plugins, list):
        for plugin_entry in raw_plugins:
            if not isinstance(plugin_entry, dict):
                continue
            service_ref = _service_ref_name(plugin_entry.get("service"))
            route_ref = _service_ref_name(plugin_entry.get("route"))
            consumer_ref = _service_ref_name(plugin_entry.get("consumer"))
            if consumer_ref:
                scope, attached = "consumer", consumer_ref
            elif route_ref:
                scope, attached = "route", route_ref
            elif service_ref:
                scope, attached = "service", service_ref
            else:
                scope, attached = "global", None
            plugin, hint, redacted = _plugin_and_hint(plugin_entry, scope, attached)
            redactions += redacted
            if hint is not None:
                if scope == "route":
                    routes = [
                        r if r.name != attached else replace(r, auth=(*r.auth, hint))
                        for r in routes
                    ]
                elif scope == "service":
                    routes = [
                        r if r.service_name != attached else replace(r, auth=(*r.auth, hint))
                        for r in routes
                    ]
                else:
                    global_auth.append(hint)
            elif plugin is not None:
                if scope == "global":
                    global_plugins.append(plugin)
                else:
                    # Referenced service/route/consumer plugin, kept at document level
                    # so attachment survives even when the referent is in another file.
                    global_plugins.append(plugin)

    # --- consumers: count credentials, never retain them -------------------------
    raw_consumers = document.get("consumers")
    if isinstance(raw_consumers, list) and raw_consumers:
        credential_count = 0
        for consumer in raw_consumers:
            if not isinstance(consumer, dict):
                continue
            for key in _CREDENTIAL_KEYS:
                creds = consumer.get(key)
                if isinstance(creds, list):
                    credential_count += len(creds)
        redactions += credential_count
        ignored.append(
            {
                "construct": "consumers",
                "count": len(raw_consumers),
                "reason": _IGNORED_CONSTRUCT_REASONS["consumers"],
            }
        )

    # --- recognized-but-unmodeled and unknown top-level constructs ---------------
    for key, reason in _IGNORED_CONSTRUCT_REASONS.items():
        if key == "consumers":
            continue
        value = document.get(key)
        if isinstance(value, list) and value:
            ignored.append({"construct": key, "count": len(value), "reason": reason})
    for key in sorted(document.keys()):
        if key not in _KNOWN_TOP_LEVEL_KEYS and key not in _IGNORED_CONSTRUCT_REASONS:
            ignored.append(
                {
                    "construct": key,
                    "count": 1,
                    "reason": "top-level construct the Kong adapter does not model",
                }
            )

    if not routes:
        raise GatewayConfigParseError(
            "Kong declarative config declares no routes — there is no API surface "
            "to import",
            code="INPUT_SEMANTIC_INVALID",
        )

    title = source_label or "Kong gateway configuration"
    raw_summary: Dict[str, Any] = {
        "flavor": "kong",
        "format_version": document.get("_format_version"),
        "services": sorted(service.name for service in services),
        "route_names": sorted(route.name for route in routes),
        "plugin_names": sorted(
            {p.name for p in global_plugins}
            | {p.name for route in routes for p in route.plugins}
        ),
    }
    return GatewayConfigDocument(
        flavor="kong",
        title=title,
        services=tuple(services),
        routes=tuple(routes),
        global_plugins=tuple(global_plugins),
        global_auth=tuple(global_auth),
        ignored=tuple(ignored),
        credential_redactions=redactions,
        source_label=source_label,
        raw=raw_summary,
    )


def parse_kong_fileset(
    members: Dict[str, str], *, root: Optional[str] = None, source_label: Optional[str] = None
) -> GatewayConfigDocument:
    """Parse a multi-file declarative config (`deck` splits files arbitrarily).

    Every member that sniffs as a Kong declarative config is parsed and merged
    (services, routes, plugins, ignored constructs, and redaction counts are
    concatenated), root member first, remaining members in path order.

    Args:
        members: Mapping of member path → text content.
        root: Preferred root member path, when known.
        source_label: Label for the merged document.

    Returns:
        The merged document.

    Raises:
        GatewayConfigParseError: ``FORMAT_MISMATCH`` when no member is a Kong
            declarative config; parse errors from members propagate with their
            member path prefixed.
    """
    ordered = sorted(members.keys())
    if root in members:
        ordered = [root] + [path for path in ordered if path != root]

    documents: List[GatewayConfigDocument] = []
    for path in ordered:
        text = members[path]
        if not is_kong_declarative(text):
            continue
        try:
            documents.append(parse_kong_declarative(text, source_label=path))
        except GatewayConfigParseError as exc:
            raise GatewayConfigParseError(f"{path}: {exc}", code=exc.code) from exc
    if not documents:
        raise GatewayConfigParseError(
            "No member of the fileset is a Kong declarative config",
            code="FORMAT_MISMATCH",
        )
    if len(documents) == 1:
        merged = documents[0]
        return replace(merged, source_label=source_label or merged.source_label)

    services: List[GatewayServiceDef] = []
    routes: List[GatewayRoute] = []
    global_plugins: List[GatewayPlugin] = []
    global_auth: List[GatewayAuthHint] = []
    ignored: List[Dict[str, Any]] = []
    redactions = 0
    for doc in documents:
        services.extend(doc.services)
        routes.extend(doc.routes)
        global_plugins.extend(doc.global_plugins)
        global_auth.extend(doc.global_auth)
        ignored.extend(doc.ignored)
        redactions += doc.credential_redactions
    title = source_label or documents[0].title
    return GatewayConfigDocument(
        flavor="kong",
        title=title,
        services=tuple(services),
        routes=tuple(routes),
        global_plugins=tuple(global_plugins),
        global_auth=tuple(global_auth),
        ignored=tuple(ignored),
        credential_redactions=redactions,
        source_label=source_label,
        raw={
            "flavor": "kong",
            "members": [doc.source_label for doc in documents],
            "services": sorted({service.name for service in services}),
            "route_names": sorted({route.name for route in routes}),
        },
    )

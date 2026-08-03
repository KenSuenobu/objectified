"""Parser for Kubernetes Gateway API ``HTTPRoute`` manifests — IXH-7.8 (#5133).

Reads a (multi-document) YAML stream of Gateway API resources and models the
``HTTPRoute`` kind into the flavor-neutral
:class:`~app.gateway_config_model.GatewayConfigDocument`. Each rule's matches
flatten to :class:`~app.gateway_config_model.GatewayMatch` entries (path pattern
+ method + header/query conditions), ``backendRefs`` become backends, and
filters (``RequestHeaderModifier``, ``URLRewrite``, ``ExtensionRef``, …) are
preserved as plugins — the Gateway API core has no first-class auth, so no
canonical security mapping is fabricated for it.

Non-``HTTPRoute`` Gateway API kinds (``Gateway``, ``GRPCRoute``, ``TCPRoute``,
…) and unrelated Kubernetes documents in the same stream are recorded on
``document.ignored`` with a reason — never silently skipped.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import yaml

from .gateway_config_model import (
    GatewayBackend,
    GatewayConfigDocument,
    GatewayConfigParseError,
    GatewayMatch,
    GatewayPlugin,
    GatewayRoute,
    build_path_pattern,
)

__all__ = [
    "is_gateway_api_httproute",
    "is_gateway_api_httproute_document",
    "parse_gateway_api",
    "parse_gateway_api_fileset",
]

#: apiVersion group prefix that marks a Gateway API resource.
_GATEWAY_API_GROUP = "gateway.networking.k8s.io"

#: Gateway API ``path.type`` → flavor-neutral pattern kind.
_PATH_TYPE_KINDS = {
    "Exact": "exact",
    "PathPrefix": "prefix",
    "RegularExpression": "regex",
}


def is_gateway_api_httproute_document(document: Any) -> bool:
    """Return True when a pre-parsed document is a Gateway API ``HTTPRoute``."""
    if not isinstance(document, dict):
        return False
    api_version = str(document.get("apiVersion") or "")
    return api_version.startswith(_GATEWAY_API_GROUP) and document.get("kind") == "HTTPRoute"


def is_gateway_api_httproute(text: str) -> bool:
    """Cheap sniff: does ``text`` contain at least one ``HTTPRoute`` manifest?"""
    if not text or _GATEWAY_API_GROUP not in text or "HTTPRoute" not in text:
        return False
    try:
        documents = yaml.safe_load_all(text)
        return any(is_gateway_api_httproute_document(doc) for doc in documents)
    except yaml.YAMLError:
        return False


def _reject_binary(text: str) -> None:
    """Reject text that decoded from a non-UTF-8 source (NUL bytes survive)."""
    if "\x00" in text:
        raise GatewayConfigParseError(
            "Gateway API manifest contains NUL bytes — the file is binary or not "
            "UTF-8 encoded",
            code="INPUT_ENCODING_INVALID",
        )


def _load_documents(text: str) -> List[Any]:
    """Parse a YAML stream, mapping truncation and syntax errors to taxonomy codes."""
    try:
        return [doc for doc in yaml.safe_load_all(text) if doc is not None]
    except yaml.YAMLError as exc:
        message = str(exc)
        if "end of stream" in message or "<stream end>" in message:
            raise GatewayConfigParseError(
                f"Gateway API manifest is truncated: {message}",
                code="INPUT_TRUNCATED",
            ) from exc
        raise GatewayConfigParseError(
            f"Gateway API manifest is not valid YAML: {message}",
            code="INPUT_MALFORMED",
        ) from exc


def _match_pairs(entries: Any) -> Tuple[Tuple[str, str], ...]:
    """Flatten header/query match entries to ``(name, value)`` pairs."""
    if not isinstance(entries, list):
        return ()
    pairs: List[Tuple[str, str]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        pairs.append((name, str(entry.get("value") or "")))
    return tuple(pairs)


def _parse_match(entry: Dict[str, Any]) -> GatewayMatch:
    """Parse one ``rules[].matches[]`` entry."""
    path = entry.get("path")
    pattern = None
    if isinstance(path, dict):
        kind = _PATH_TYPE_KINDS.get(str(path.get("type") or "PathPrefix"), "prefix")
        pattern = build_path_pattern(str(path.get("value") or "/"), kind)
    else:
        # The Gateway API default match is PathPrefix "/".
        pattern = build_path_pattern("/", "prefix")
    method = entry.get("method")
    return GatewayMatch(
        path=pattern,
        method=method.upper() if isinstance(method, str) and method else None,
        headers=_match_pairs(entry.get("headers")),
        query=_match_pairs(entry.get("queryParams")),
    )


def _parse_backends(entries: Any) -> Tuple[GatewayBackend, ...]:
    """Parse a rule's ``backendRefs``."""
    if not isinstance(entries, list):
        return ()
    backends: List[GatewayBackend] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        backends.append(
            GatewayBackend(
                name=name,
                namespace=entry.get("namespace") if isinstance(entry.get("namespace"), str) else None,
                port=entry.get("port") if isinstance(entry.get("port"), int) else None,
                weight=entry.get("weight") if isinstance(entry.get("weight"), int) else None,
            )
        )
    return tuple(backends)


def _parse_filters(entries: Any, route_name: str) -> Tuple[GatewayPlugin, ...]:
    """Preserve a rule's ``filters`` as plugins (no canonical mapping exists)."""
    if not isinstance(entries, list):
        return ()
    plugins: List[GatewayPlugin] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        filter_type = entry.get("type")
        if not isinstance(filter_type, str) or not filter_type:
            continue
        config = {key: value for key, value in entry.items() if key != "type"}
        plugins.append(
            GatewayPlugin(
                name=filter_type,
                scope="route",
                attached_to=route_name,
                enabled=True,
                config=config,
            )
        )
    return tuple(plugins)


def _parse_httproute(
    document: Dict[str, Any], *, document_index: int, source_label: Optional[str]
) -> List[GatewayRoute]:
    """Parse one ``HTTPRoute`` resource into per-rule :class:`GatewayRoute` entries."""
    metadata = document.get("metadata") if isinstance(document.get("metadata"), dict) else {}
    name = metadata.get("name")
    resource_name = name if isinstance(name, str) and name else f"httproute-{document_index}"
    namespace = metadata.get("namespace") if isinstance(metadata.get("namespace"), str) else None
    service_name = f"{namespace}/{resource_name}" if namespace else resource_name

    spec = document.get("spec") if isinstance(document.get("spec"), dict) else {}
    hostnames = tuple(
        str(host) for host in (spec.get("hostnames") or []) if isinstance(host, str)
    )
    parent_refs = spec.get("parentRefs")

    rules = spec.get("rules")
    routes: List[GatewayRoute] = []
    if not isinstance(rules, list):
        return routes
    for rule_index, rule in enumerate(rules):
        if not isinstance(rule, dict):
            continue
        raw_matches = rule.get("matches")
        if isinstance(raw_matches, list) and raw_matches:
            matches = tuple(
                _parse_match(entry) for entry in raw_matches if isinstance(entry, dict)
            )
        else:
            # A rule with no matches defaults to PathPrefix "/".
            matches = (GatewayMatch(path=build_path_pattern("/", "prefix")),)
        route_name = (
            resource_name if len(rules) == 1 else f"{resource_name}#rule-{rule_index}"
        )
        extras: Dict[str, Any] = {}
        if isinstance(parent_refs, list) and parent_refs:
            extras["parent_refs"] = parent_refs
        if namespace:
            extras["namespace"] = namespace
        routes.append(
            GatewayRoute(
                name=route_name,
                service_name=service_name,
                hosts=hostnames,
                matches=matches,
                protocols=("http", "https"),
                plugins=_parse_filters(rule.get("filters"), route_name),
                backends=_parse_backends(rule.get("backendRefs")),
                source_location=(
                    f"{source_label or 'document'}[{document_index}].spec.rules[{rule_index}]"
                ),
                extras=extras,
            )
        )
    return routes


def parse_gateway_api(
    text: str, *, source_label: Optional[str] = None
) -> GatewayConfigDocument:
    """Parse a Gateway API manifest stream into a :class:`GatewayConfigDocument`.

    Args:
        text: YAML text — a single ``HTTPRoute`` or a ``---``-separated stream.
        source_label: Filename / paste label for provenance.

    Returns:
        The flavor-neutral document (``flavor="gateway-api"``).

    Raises:
        GatewayConfigParseError: With a taxonomy code — ``INPUT_ENCODING_INVALID``
            for binary input, ``INPUT_TRUNCATED``/``INPUT_MALFORMED`` for broken
            YAML, ``FORMAT_MISMATCH`` when nothing in the stream is a Gateway API
            resource, and ``INPUT_SEMANTIC_INVALID`` when Gateway API resources
            are present but none is an ``HTTPRoute`` with rules.
    """
    _reject_binary(text)
    if not text.strip():
        raise GatewayConfigParseError(
            "Gateway API manifest is empty", code="INPUT_MALFORMED"
        )
    documents = _load_documents(text)
    if not documents:
        raise GatewayConfigParseError(
            "Gateway API manifest contains no YAML documents", code="INPUT_MALFORMED"
        )

    routes: List[GatewayRoute] = []
    ignored: List[Dict[str, Any]] = []
    saw_gateway_api = False
    for index, document in enumerate(documents):
        if not isinstance(document, dict):
            ignored.append(
                {
                    "construct": f"document[{index}]",
                    "count": 1,
                    "reason": "not a Kubernetes resource mapping",
                }
            )
            continue
        api_version = str(document.get("apiVersion") or "")
        kind = str(document.get("kind") or "")
        if api_version.startswith(_GATEWAY_API_GROUP):
            saw_gateway_api = True
            if kind == "HTTPRoute":
                parsed = _parse_httproute(
                    document, document_index=index, source_label=source_label
                )
                if parsed:
                    routes.extend(parsed)
                else:
                    ignored.append(
                        {
                            "construct": f"HTTPRoute[{index}]",
                            "count": 1,
                            "reason": "HTTPRoute declares no rules — nothing to import",
                        }
                    )
            else:
                ignored.append(
                    {
                        "construct": kind or f"document[{index}]",
                        "count": 1,
                        "reason": "only HTTPRoute resources are modeled; other Gateway API "
                        "kinds describe infrastructure, not the HTTP surface",
                    }
                )
        else:
            ignored.append(
                {
                    "construct": kind or f"document[{index}]",
                    "count": 1,
                    "reason": "not a Gateway API resource",
                }
            )

    if not routes:
        if saw_gateway_api:
            raise GatewayConfigParseError(
                "Gateway API stream contains no importable HTTPRoute rules",
                code="INPUT_SEMANTIC_INVALID",
            )
        raise GatewayConfigParseError(
            "No Gateway API resources found in the manifest stream",
            code="FORMAT_MISMATCH",
        )

    title = source_label or routes[0].service_name or "Gateway API HTTPRoutes"
    raw_summary: Dict[str, Any] = {
        "flavor": "gateway-api",
        "resources": sorted({route.service_name for route in routes if route.service_name}),
        "route_names": sorted(route.name for route in routes),
        "hostnames": sorted({host for route in routes for host in route.hosts}),
    }
    return GatewayConfigDocument(
        flavor="gateway-api",
        title=title,
        routes=tuple(routes),
        ignored=tuple(ignored),
        source_label=source_label,
        raw=raw_summary,
    )


def parse_gateway_api_fileset(
    members: Dict[str, str], *, root: Optional[str] = None, source_label: Optional[str] = None
) -> GatewayConfigDocument:
    """Parse a directory of Gateway API manifests, merging every member's routes.

    Args:
        members: Mapping of member path → text content.
        root: Preferred root member path, when known (parsed first).
        source_label: Label for the merged document.

    Returns:
        The merged document (routes and ignored constructs concatenated).

    Raises:
        GatewayConfigParseError: ``FORMAT_MISMATCH`` when no member contains a
            Gateway API resource; per-member errors propagate with the member
            path prefixed.
    """
    ordered = sorted(members.keys())
    if root in members:
        ordered = [root] + [path for path in ordered if path != root]

    routes: List[GatewayRoute] = []
    ignored: List[Dict[str, Any]] = []
    parsed_any = False
    for path in ordered:
        text = members[path]
        if _GATEWAY_API_GROUP not in (text or ""):
            continue
        try:
            document = parse_gateway_api(text, source_label=path)
        except GatewayConfigParseError as exc:
            if exc.code in ("FORMAT_MISMATCH", "INPUT_SEMANTIC_INVALID"):
                continue
            raise GatewayConfigParseError(f"{path}: {exc}", code=exc.code) from exc
        parsed_any = True
        routes.extend(document.routes)
        ignored.extend(document.ignored)
    if not parsed_any or not routes:
        raise GatewayConfigParseError(
            "No member of the fileset contains importable HTTPRoute resources",
            code="FORMAT_MISMATCH",
        )
    return GatewayConfigDocument(
        flavor="gateway-api",
        title=source_label or "Gateway API HTTPRoutes",
        routes=tuple(routes),
        ignored=tuple(ignored),
        source_label=source_label,
        raw={
            "flavor": "gateway-api",
            "members": sorted(members.keys()),
            "route_names": sorted(route.name for route in routes),
            "hostnames": sorted({host for route in routes for host in route.hosts}),
        },
    )

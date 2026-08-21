"""Kong ``deck`` declarative-file vocabulary and validation — FMT-2.2 (#5420).

The rules ``deck validate`` (and, behind it, the Kong Admin API's entity schemas)
enforce on a declarative configuration file, expressed once so both halves of the
Kong round trip can rely on them: :mod:`app.kong_emitter` builds documents that
satisfy them, and :func:`validate_kong_declarative_document` re-checks a finished
document against them independently of how it was produced.

`deck` is a Go binary and is not part of this runtime, so this module is the
*vendored equivalent* the ticket allows: the same structural contract, expressed in
Python and runnable in CI on every emit. It deliberately checks the parts of the
schema an emitter can get wrong —

* the top-level shape: a required ``_format_version`` deck understands, and no
  unknown top-level sections;
* entity **names**, which Kong restricts to ``[0-9A-Za-z._~-]`` — a name with a
  space or a slash is rejected on load, so the emitter sanitizes rather than
  discovers this at ``deck sync`` time;
* the **service upstream**, which must be given either as one ``url`` or
  piecewise, never as neither;
* the **route matching rule**: a route that declares no ``paths``, ``hosts``,
  ``methods``, ``headers`` or ``snis`` matches nothing and Kong refuses it;
* closed vocabularies — protocols, ``path_handling``, redirect status codes — and
  the shapes of ``headers``, ``methods`` and ``paths``;
* plugins, which must name a plugin and whose ``config`` must be a mapping.

It does *not* attempt to validate individual plugin configuration schemas: those
are per-plugin, versioned with Kong itself, and a config this codebase emits is
only ever one an import read back out of a real file.
"""

from __future__ import annotations

import re
from typing import Any, List, Mapping

__all__ = [
    "DECK_FORMAT_VERSIONS",
    "KONG_ENTITY_NAME",
    "KONG_HTTP_METHODS",
    "KONG_PATH_HANDLING",
    "KONG_PROTOCOLS",
    "KONG_REDIRECT_STATUS_CODES",
    "KONG_TOP_LEVEL_SECTIONS",
    "deck_document_violations",
    "validate_kong_declarative_document",
]


# ===========================================================================
# deck / Kong vocabulary
# ===========================================================================

#: ``_format_version`` values `deck` accepts. ``3.0`` is what current deck writes;
#: the ``1.1``/``2.1`` files still in the wild load too.
DECK_FORMAT_VERSIONS: frozenset = frozenset({"1.1", "2.1", "3.0"})

#: Top-level sections a declarative file may declare. Keys outside this set are
#: rejected by deck rather than ignored, which is why the emitter never invents one.
KONG_TOP_LEVEL_SECTIONS: frozenset = frozenset(
    {
        "_format_version",
        "_transform",
        "_workspace",
        "_info",
        "_comment",
        "services",
        "routes",
        "plugins",
        "consumers",
        "consumer_groups",
        "upstreams",
        "certificates",
        "ca_certificates",
        "snis",
        "vaults",
    }
)

#: Kong's entity-name rule. Applied to services, routes, plugins and upstreams.
KONG_ENTITY_NAME = re.compile(r"^[0-9A-Za-z._~-]+$")

#: Protocols a service or route may declare.
KONG_PROTOCOLS: frozenset = frozenset(
    {"http", "https", "grpc", "grpcs", "tcp", "tls", "tls_passthrough", "udp", "ws", "wss"}
)

#: HTTP methods a route may match on. Kong upper-cases and does not restrict to the
#: RFC set, but a lower-cased or misspelled verb is the mistake worth catching.
KONG_HTTP_METHODS: frozenset = frozenset(
    {
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
        "TRACE",
        "CONNECT",
    }
)

#: Legal ``path_handling`` values.
KONG_PATH_HANDLING: frozenset = frozenset({"v0", "v1"})

#: Legal ``https_redirect_status_code`` values.
KONG_REDIRECT_STATUS_CODES: frozenset = frozenset({426, 301, 302, 307, 308})

#: Route fields that count as a matching rule. A route with none of them matches no
#: request and Kong rejects it on load.
_ROUTE_MATCH_FIELDS = ("paths", "hosts", "methods", "headers", "snis", "expression")


# ===========================================================================
# Validation
# ===========================================================================


def _name_violations(value: Any, *, path: str) -> List[str]:
    """Check one entity ``name`` field against Kong's name rule."""
    if value is None:
        return [f"{path}: must declare a `name`"]
    if not isinstance(value, str) or not value:
        return [f"{path}: `name` must be a non-empty string"]
    if not KONG_ENTITY_NAME.match(value):
        return [
            f"{path}: name {value!r} contains characters Kong does not allow "
            "(names match [0-9A-Za-z._~-]+)"
        ]
    return []


def _string_list_violations(value: Any, *, path: str) -> List[str]:
    """Check a field declared as a list of non-empty strings."""
    if not isinstance(value, list):
        return [f"{path}: must be a list of strings"]
    return [
        f"{path}[{index}]: must be a non-empty string"
        for index, item in enumerate(value)
        if not isinstance(item, str) or not item
    ]


def _plugin_violations(entry: Any, *, path: str) -> List[str]:
    """Check one ``plugins[]`` entry."""
    if not isinstance(entry, Mapping):
        return [f"{path}: must be a mapping"]
    problems = _name_violations(entry.get("name"), path=path)
    config = entry.get("config")
    if config is not None and not isinstance(config, Mapping):
        problems.append(f"{path}.config: must be a mapping")
    enabled = entry.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        problems.append(f"{path}.enabled: must be a boolean")
    protocols = entry.get("protocols")
    if protocols is not None:
        problems.extend(_string_list_violations(protocols, path=f"{path}.protocols"))
        if isinstance(protocols, list):
            problems.extend(
                f"{path}.protocols[{index}]: {item!r} is not a Kong protocol"
                for index, item in enumerate(protocols)
                if isinstance(item, str) and item not in KONG_PROTOCOLS
            )
    tags = entry.get("tags")
    if tags is not None:
        problems.extend(_string_list_violations(tags, path=f"{path}.tags"))
    return problems


def _route_violations(entry: Any, *, path: str) -> List[str]:
    """Check one ``routes[]`` entry."""
    if not isinstance(entry, Mapping):
        return [f"{path}: must be a mapping"]
    problems = _name_violations(entry.get("name"), path=path)

    if not any(entry.get(field) for field in _ROUTE_MATCH_FIELDS):
        problems.append(
            f"{path}: declares no matching rule — a route needs at least one of "
            f"{', '.join(_ROUTE_MATCH_FIELDS)}"
        )

    paths = entry.get("paths")
    if paths is not None:
        problems.extend(_string_list_violations(paths, path=f"{path}.paths"))
        if isinstance(paths, list):
            problems.extend(
                f"{path}.paths[{index}]: {item!r} must start with `/` (literal) or "
                "`~/` (regex)"
                for index, item in enumerate(paths)
                if isinstance(item, str)
                and item
                and not item.startswith("/")
                and not item.startswith("~/")
            )

    methods = entry.get("methods")
    if methods is not None:
        problems.extend(_string_list_violations(methods, path=f"{path}.methods"))
        if isinstance(methods, list):
            problems.extend(
                f"{path}.methods[{index}]: {item!r} is not an HTTP method"
                for index, item in enumerate(methods)
                if isinstance(item, str) and item not in KONG_HTTP_METHODS
            )

    hosts = entry.get("hosts")
    if hosts is not None:
        problems.extend(_string_list_violations(hosts, path=f"{path}.hosts"))

    protocols = entry.get("protocols")
    if protocols is not None:
        problems.extend(_string_list_violations(protocols, path=f"{path}.protocols"))
        if isinstance(protocols, list):
            problems.extend(
                f"{path}.protocols[{index}]: {item!r} is not a Kong protocol"
                for index, item in enumerate(protocols)
                if isinstance(item, str) and item not in KONG_PROTOCOLS
            )

    headers = entry.get("headers")
    if headers is not None:
        if not isinstance(headers, Mapping):
            problems.append(f"{path}.headers: must be a mapping of name → values")
        else:
            for name, values in headers.items():
                problems.extend(
                    _string_list_violations(values, path=f"{path}.headers.{name}")
                )

    for flag in ("strip_path", "preserve_host", "request_buffering", "response_buffering"):
        value = entry.get(flag)
        if value is not None and not isinstance(value, bool):
            problems.append(f"{path}.{flag}: must be a boolean")

    handling = entry.get("path_handling")
    if handling is not None and handling not in KONG_PATH_HANDLING:
        problems.append(
            f"{path}.path_handling: must be one of {', '.join(sorted(KONG_PATH_HANDLING))}"
        )

    redirect = entry.get("https_redirect_status_code")
    if redirect is not None and redirect not in KONG_REDIRECT_STATUS_CODES:
        problems.append(
            f"{path}.https_redirect_status_code: must be one of "
            f"{', '.join(str(code) for code in sorted(KONG_REDIRECT_STATUS_CODES))}"
        )

    priority = entry.get("regex_priority")
    if priority is not None and (
        not isinstance(priority, int) or isinstance(priority, bool)
    ):
        problems.append(f"{path}.regex_priority: must be an integer")

    tags = entry.get("tags")
    if tags is not None:
        problems.extend(_string_list_violations(tags, path=f"{path}.tags"))

    plugins = entry.get("plugins")
    if plugins is not None:
        if not isinstance(plugins, list):
            problems.append(f"{path}.plugins: must be a list")
        else:
            for index, plugin in enumerate(plugins):
                problems.extend(_plugin_violations(plugin, path=f"{path}.plugins[{index}]"))

    return problems


def _service_violations(entry: Any, *, path: str) -> List[str]:
    """Check one ``services[]`` entry."""
    if not isinstance(entry, Mapping):
        return [f"{path}: must be a mapping"]
    problems = _name_violations(entry.get("name"), path=path)

    url = entry.get("url")
    host = entry.get("host")
    if url is None and host is None:
        problems.append(f"{path}: must declare an upstream as `url` or as `host` (+ `port`/`path`)")
    if url is not None and not isinstance(url, str):
        problems.append(f"{path}.url: must be a string")
    if host is not None and not isinstance(host, str):
        problems.append(f"{path}.host: must be a string")

    protocol = entry.get("protocol")
    if protocol is not None and protocol not in KONG_PROTOCOLS:
        problems.append(f"{path}.protocol: {protocol!r} is not a Kong protocol")

    port = entry.get("port")
    if port is not None:
        if not isinstance(port, int) or isinstance(port, bool):
            problems.append(f"{path}.port: must be an integer")
        elif not 0 < port <= 65535:
            problems.append(f"{path}.port: must be between 1 and 65535")

    service_path = entry.get("path")
    if service_path is not None and (
        not isinstance(service_path, str) or not service_path.startswith("/")
    ):
        problems.append(f"{path}.path: must be a string starting with `/`")

    for numeric in ("retries", "connect_timeout", "read_timeout", "write_timeout"):
        value = entry.get(numeric)
        if value is not None and (not isinstance(value, int) or isinstance(value, bool)):
            problems.append(f"{path}.{numeric}: must be an integer")

    enabled = entry.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        problems.append(f"{path}.enabled: must be a boolean")

    tags = entry.get("tags")
    if tags is not None:
        problems.extend(_string_list_violations(tags, path=f"{path}.tags"))

    routes = entry.get("routes")
    if routes is not None:
        if not isinstance(routes, list):
            problems.append(f"{path}.routes: must be a list")
        else:
            for index, route in enumerate(routes):
                problems.extend(_route_violations(route, path=f"{path}.routes[{index}]"))

    plugins = entry.get("plugins")
    if plugins is not None:
        if not isinstance(plugins, list):
            problems.append(f"{path}.plugins: must be a list")
        else:
            for index, plugin in enumerate(plugins):
                problems.extend(_plugin_violations(plugin, path=f"{path}.plugins[{index}]"))

    return problems


def deck_document_violations(document: Any) -> List[str]:
    """Return every way ``document`` breaks the deck declarative-file contract.

    Args:
        document: The parsed declarative configuration (a mapping; anything else
            is itself a violation).

    Returns:
        One message per violation, in document order. An empty list means the
        document is a loadable deck file.
    """
    if not isinstance(document, Mapping):
        return [
            f"$: a declarative configuration must be a mapping, got "
            f"{type(document).__name__}"
        ]

    problems: List[str] = []

    version = document.get("_format_version")
    if version is None:
        problems.append("$: `_format_version` is required")
    elif not isinstance(version, str):
        problems.append("$._format_version: must be a string (quote it in YAML)")
    elif version not in DECK_FORMAT_VERSIONS:
        problems.append(
            f"$._format_version: {version!r} is not a version deck understands "
            f"({', '.join(sorted(DECK_FORMAT_VERSIONS))})"
        )

    for key in sorted(document):
        if str(key) not in KONG_TOP_LEVEL_SECTIONS:
            problems.append(f"$: `{key}` is not a declarative-configuration section")

    for section, checker in (
        ("services", _service_violations),
        ("routes", _route_violations),
        ("plugins", _plugin_violations),
    ):
        entries = document.get(section)
        if entries is None:
            continue
        if not isinstance(entries, list):
            problems.append(f"$.{section}: must be a list")
            continue
        for index, entry in enumerate(entries):
            problems.extend(checker(entry, path=f"$.{section}[{index}]"))

    for section in ("consumers", "upstreams", "certificates", "ca_certificates", "snis", "vaults"):
        entries = document.get(section)
        if entries is not None and not isinstance(entries, list):
            problems.append(f"$.{section}: must be a list")

    return problems


def validate_kong_declarative_document(
    content: str,
    *,
    source_label: str = "emitted",
) -> None:
    """Validate emitted deck YAML/JSON as a loadable Kong declarative configuration.

    Re-parses ``content`` through the import adapter — so the text really is a
    declarative config the Kong reader accepts — and then applies
    :func:`deck_document_violations` to the raw document, which is where the
    entity-level rules deck enforces live.

    Args:
        content: The emitted YAML or JSON text.
        source_label: Label used in the parse error, when parsing is what fails.

    Raises:
        ValueError: When the text cannot be parsed as a Kong declarative config, or
            breaks any deck rule. The message names every violation found.
    """
    import yaml

    from .kong_import_source import KongImportSource

    KongImportSource().parse(content, source_label=source_label)
    problems = deck_document_violations(yaml.safe_load(content))
    if problems:
        raise ValueError(
            "Invalid Kong declarative configuration: " + "; ".join(problems)
        )

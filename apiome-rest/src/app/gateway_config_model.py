"""Shared route model for gateway-configuration imports — IXH-7.8 (#5133).

Kong declarative config and Kubernetes Gateway API ``HTTPRoute`` manifests both
describe a *routing surface* — hosts, path patterns, methods, and the auth or
traffic plugins attached to them — with no request/response schemas. This module
is the flavor-neutral middle: both parsers (:mod:`app.kong_parser`,
:mod:`app.gateway_api_parser`) produce a :class:`GatewayConfigDocument`, and one
normalizer (:mod:`app.gateway_config_normalizer`) projects it onto the canonical
model, so the two adapters cannot drift apart.

Fidelity rules encoded here:

* **Schema absence is a capability limit, not a loss.** Gateway configs carry no
  request/response schemas; the normalizer records that fact on the document
  report and the preview-manifest ledger states it as ``inferred`` /
  ``source_incomplete`` — never as a drop.
* **Credential material never survives parsing.** Kong consumer credentials and
  secret-shaped plugin config values are redacted at parse time
  (:func:`redact_secret_config`); only counts are retained.
* **Regex path patterns are inferred into templates.**
  :func:`build_path_pattern` turns ``~/users/\\d+`` into ``/users/{param1}``,
  preserving the original pattern, and the inference is stamped
  ``provenance = "inferred"`` downstream so the ledger never presents an
  inferred template as declared.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple

__all__ = [
    "KONG_AUTH_PLUGIN_SCHEMES",
    "KONG_SCHEME_AUTH_PLUGINS",
    "SECRET_CONFIG_KEYS",
    "GatewayConfigParseError",
    "GatewayPathPattern",
    "GatewayMatch",
    "GatewayAuthHint",
    "GatewayPlugin",
    "GatewayBackend",
    "GatewayServiceDef",
    "GatewayRoute",
    "GatewayConfigDocument",
    "build_path_pattern",
    "redact_secret_config",
]


#: Kong auth-plugin name → canonical security-scheme identifier. ``None`` means the
#: plugin *is* an auth mechanism but has no canonical mapping — it is preserved as an
#: unmapped hint (never silently dropped) and the ledger reports the gap. Scheme
#: identifiers follow the OpenAPI security-scheme vocabulary so downstream surfaces
#: can render them without a private dialect.
KONG_AUTH_PLUGIN_SCHEMES: Dict[str, Optional[str]] = {
    "key-auth": "apiKey",
    "key-auth-enc": "apiKey",
    "basic-auth": "basic",
    "jwt": "bearer",
    "oauth2": "oauth2",
    "openid-connect": "openIdConnect",
    "mtls-auth": "mutualTLS",
    "hmac-auth": None,
    "ldap-auth": None,
}

#: Canonical security-scheme identifier → the Kong auth plugin that implements it —
#: the *reverse* of :data:`KONG_AUTH_PLUGIN_SCHEMES`, used by
#: :mod:`app.gateway_config_emitter` when a canonical model names a scheme but no
#: source plugin (a cross-format export, where nothing recorded which plugin the
#: scheme came from). Derived from the forward table rather than written out a
#: second time, so the two can never disagree: the first plugin declared for a
#: scheme wins (``apiKey`` → ``key-auth``, not ``key-auth-enc``), and plugins with
#: no canonical scheme contribute nothing. ``test_gateway_security_table_symmetry``
#: asserts the round trip in both directions.
KONG_SCHEME_AUTH_PLUGINS: Dict[str, str] = {}
for _plugin, _scheme in KONG_AUTH_PLUGIN_SCHEMES.items():
    if _scheme is not None:
        KONG_SCHEME_AUTH_PLUGINS.setdefault(_scheme, _plugin)
del _plugin, _scheme

#: Plugin-config keys whose values are credential material. Redacted recursively by
#: :func:`redact_secret_config` before a config dict is retained anywhere. ``key`` is
#: included deliberately: a benign ``key`` value loses a little fidelity when masked,
#: while an unmasked credential is unrecoverable damage — the trade is one-sided.
SECRET_CONFIG_KEYS = frozenset(
    {
        "secret",
        "client_secret",
        "provision_key",
        "password",
        "private_key",
        "key",
    }
)

#: Replacement value for redacted credential material.
_REDACTED = "***"

#: Characters that mark a path segment as a regex (not a literal).
_REGEX_META = set("\\^$.|?*+()[]")

#: Named capture group in either Python (``(?P<name>``) or RE2 (``(?<name>``) syntax.
_NAMED_GROUP_RE = re.compile(r"\(\?P?<(?P<name>[A-Za-z_][A-Za-z0-9_]*)>")


class GatewayConfigParseError(ValueError):
    """Raised when a gateway configuration document cannot be parsed.

    Attributes:
        code: Intake-error-taxonomy code (see :mod:`app.intake_error_taxonomy`).
    """

    def __init__(self, message: str, *, code: str = "INPUT_MALFORMED") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class GatewayPathPattern:
    """One path-match pattern of a route, normalized to a canonical route template.

    Attributes:
        raw: The pattern exactly as the source declared it (``/users``,
            ``~/users/\\d+``, …).
        kind: Match semantics — ``exact``, ``prefix``, or ``regex``.
        template: The canonical route template (``/users/{param1}``). For
            ``exact``/``prefix`` patterns this is the raw path; for ``regex`` it is
            inferred (see :func:`build_path_pattern`).
        param_names: Parameter names appearing in ``template``, in path order.
            Non-empty only when the template was inferred from a regex.
    """

    raw: str
    kind: str
    template: str
    param_names: Tuple[str, ...] = ()


@dataclass(frozen=True)
class GatewayMatch:
    """One concrete match condition of a route — the unit an operation is built from.

    Kong's ``paths × methods`` cross-product and Gateway API's per-match coupling
    both flatten to this shape, so the normalizer treats the flavors identically.

    Attributes:
        path: The path pattern, or ``None`` when the route matches any path.
        method: Upper-cased HTTP method, or ``None`` when unrestricted.
        headers: Header-match conditions as ``(name, value)`` pairs.
        query: Query-parameter-match conditions as ``(name, value)`` pairs.
    """

    path: Optional[GatewayPathPattern] = None
    method: Optional[str] = None
    headers: Tuple[Tuple[str, str], ...] = ()
    query: Tuple[Tuple[str, str], ...] = ()


@dataclass(frozen=True)
class GatewayAuthHint:
    """One auth mechanism attached to the surface, mapped where a mapping exists.

    Attributes:
        scheme: Canonical security-scheme identifier (``apiKey``, ``basic``,
            ``bearer``, ``oauth2``, ``openIdConnect``, ``mutualTLS``), or ``None``
            when the plugin has no canonical mapping (preserved, reported as a gap).
        plugin: Source plugin/filter name that implied the scheme.
        scope: Attachment scope — ``global``, ``service``, or ``route``.
        attached_to: Name of the service/route the plugin is attached to, when scoped.
        detail: Non-secret configuration summary (key names, flow flags, …).
    """

    scheme: Optional[str]
    plugin: str
    scope: str
    attached_to: Optional[str] = None
    detail: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        """Serialize for extras bags and the document-level gateway report."""
        return {
            "scheme": self.scheme,
            "plugin": self.plugin,
            "scope": self.scope,
            "attached_to": self.attached_to,
            "detail": dict(self.detail),
        }


@dataclass(frozen=True)
class GatewayPlugin:
    """One plugin (Kong) or filter (Gateway API) attached to the surface.

    Attributes:
        name: Plugin/filter name (``rate-limiting``, ``RequestHeaderModifier``, …).
        scope: Attachment scope — ``global``, ``service``, ``route``, or ``consumer``.
        attached_to: Name of the entity the plugin is attached to, when scoped.
        enabled: Whether the source marks the plugin enabled (Kong ``enabled``).
        config: Plugin configuration with secret-shaped values redacted.
    """

    name: str
    scope: str
    attached_to: Optional[str] = None
    enabled: bool = True
    config: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        """Serialize for extras bags and the document-level gateway report."""
        return {
            "name": self.name,
            "scope": self.scope,
            "attached_to": self.attached_to,
            "enabled": self.enabled,
            "config": dict(self.config),
        }


@dataclass(frozen=True)
class GatewayBackend:
    """One backend a route forwards to (Gateway API ``backendRefs`` / Kong service).

    Attributes:
        name: Backend service name.
        namespace: Kubernetes namespace, when the flavor has one.
        port: Backend port, when declared.
        weight: Traffic weight, when declared.
    """

    name: str
    namespace: Optional[str] = None
    port: Optional[int] = None
    weight: Optional[int] = None

    def as_dict(self) -> Dict[str, Any]:
        """Serialize for extras bags."""
        out: Dict[str, Any] = {"name": self.name}
        if self.namespace is not None:
            out["namespace"] = self.namespace
        if self.port is not None:
            out["port"] = self.port
        if self.weight is not None:
            out["weight"] = self.weight
        return out


@dataclass(frozen=True)
class GatewayServiceDef:
    """One upstream service the gateway fronts (Kong ``services[]`` entry).

    The canonical model groups operations by this name; the upstream address is
    backend detail carried in extras (the imported surface is the gateway-facing
    one, not the upstream).

    Attributes:
        name: Service name (grouping key).
        url: Upstream URL when declared as one field.
        protocol: Upstream protocol when declared piecewise.
        host: Upstream host when declared piecewise.
        port: Upstream port when declared piecewise.
        path: Upstream path prefix when declared.
        extras: Unmodeled source attributes (tags, retries, timeouts, …).
    """

    name: str
    url: Optional[str] = None
    protocol: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    path: Optional[str] = None
    extras: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class GatewayRoute:
    """One route of the gateway surface, in either flavor.

    Attributes:
        name: Route name (source-declared or synthesized ``route-N``).
        service_name: Owning service/grouping name, or ``None`` when unattached.
        hosts: Hostnames the route matches (may contain wildcards).
        matches: Flattened match conditions — one canonical operation per entry.
        protocols: Protocols the route serves (``http``, ``https``, …).
        auth: Auth hints in effect for this route (route- plus service-scoped).
        plugins: Non-auth plugins/filters attached to this route (or its service).
        backends: Backends the route forwards to.
        source_location: Human-readable source coordinate (document index, member
            path), when the parser captured one; never fabricated.
        extras: Unmodeled source attributes (``strip_path``, ``parentRefs``, …).
    """

    name: str
    service_name: Optional[str] = None
    hosts: Tuple[str, ...] = ()
    matches: Tuple[GatewayMatch, ...] = ()
    protocols: Tuple[str, ...] = ()
    auth: Tuple[GatewayAuthHint, ...] = ()
    plugins: Tuple[GatewayPlugin, ...] = ()
    backends: Tuple[GatewayBackend, ...] = ()
    source_location: Optional[str] = None
    extras: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class GatewayConfigDocument:
    """A parsed gateway configuration, flavor-neutral and credential-free.

    Attributes:
        flavor: ``kong`` or ``gateway-api``.
        title: Human title for the resulting artifact.
        services: Declared upstream services (may be empty for Gateway API).
        routes: The routing surface.
        global_plugins: Plugins attached to the whole gateway (non-auth).
        global_auth: Auth hints attached to the whole gateway.
        ignored: Source constructs the parser recognized but does not model —
            each entry a ``{"construct", "count", "reason"}`` mapping, surfaced on
            the coverage ledger so nothing disappears silently.
        credential_redactions: Number of credential values redacted at parse time.
        source_label: Filename / paste label for provenance.
        raw: Credential-free structural summary of the source (names and counts,
            never the full document), retained for round-trip evidence.
    """

    flavor: str
    title: str
    services: Tuple[GatewayServiceDef, ...] = ()
    routes: Tuple[GatewayRoute, ...] = ()
    global_plugins: Tuple[GatewayPlugin, ...] = ()
    global_auth: Tuple[GatewayAuthHint, ...] = ()
    ignored: Tuple[Dict[str, Any], ...] = ()
    credential_redactions: int = 0
    source_label: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None


def _template_from_regex(pattern: str) -> Tuple[str, Tuple[str, ...]]:
    """Infer a route template from a regex path pattern.

    Best-effort, segment-wise: a segment containing a named capture group becomes
    ``{name}``; any other segment containing regex metacharacters becomes
    ``{paramN}``; literal segments pass through with escapes removed. The original
    pattern is always preserved alongside the template, so the inference is
    evidence-backed rather than destructive.

    Args:
        pattern: The regex pattern, with or without Kong's leading ``~`` marker.

    Returns:
        ``(template, param_names)`` — the inferred template and the parameter
        names it introduces, in path order.
    """
    work = pattern.strip()
    if work.startswith("~"):
        work = work[1:]
    work = work.lstrip("^").rstrip("$")
    stripped = work.strip("/")
    segments = stripped.split("/") if stripped else []

    parts: list[str] = []
    names: list[str] = []
    for segment in segments:
        named = _NAMED_GROUP_RE.search(segment)
        if named:
            name = named.group("name")
        elif any(ch in _REGEX_META for ch in segment):
            name = f"param{len(names) + 1}"
        else:
            parts.append(segment.replace("\\", ""))
            continue
        while name in names:
            name = f"{name}_"
        names.append(name)
        parts.append("{" + name + "}")
    template = "/" + "/".join(parts) if parts else "/"
    return template, tuple(names)


def build_path_pattern(raw: str, kind: str) -> GatewayPathPattern:
    """Build a :class:`GatewayPathPattern` from a source path declaration.

    Args:
        raw: The path as declared (``/users``, ``~/users/\\d+``, …).
        kind: ``exact``, ``prefix``, or ``regex``.

    Returns:
        The pattern with its canonical template. ``exact``/``prefix`` paths keep
        their literal value (normalized to a leading slash); ``regex`` paths get
        an inferred template with the original preserved in ``raw``.
    """
    if kind == "regex":
        template, params = _template_from_regex(raw)
        return GatewayPathPattern(raw=raw, kind=kind, template=template, param_names=params)
    path = (raw or "/").strip() or "/"
    if not path.startswith("/"):
        path = "/" + path
    return GatewayPathPattern(raw=raw, kind=kind, template=path)


def redact_secret_config(config: Any) -> Tuple[Any, int]:
    """Recursively redact secret-shaped values from a plugin-config structure.

    Any mapping value under a key in :data:`SECRET_CONFIG_KEYS` is replaced with
    ``***`` (lists of credentials are replaced element-wise), so no credential
    material survives into the document, the canonical model, or golden snapshots.

    Args:
        config: The raw config structure (mapping / list / scalar).

    Returns:
        ``(redacted_copy, redaction_count)``. The input is never mutated.
    """
    if isinstance(config, dict):
        out: Dict[str, Any] = {}
        count = 0
        for key, value in config.items():
            if str(key).lower() in SECRET_CONFIG_KEYS and value is not None:
                if isinstance(value, list):
                    out[key] = [_REDACTED for _ in value]
                    count += len(value)
                else:
                    out[key] = _REDACTED
                    count += 1
                continue
            redacted, nested = redact_secret_config(value)
            out[key] = redacted
            count += nested
        return out, count
    if isinstance(config, list):
        items = []
        count = 0
        for value in config:
            redacted, nested = redact_secret_config(value)
            items.append(redacted)
            count += nested
        return items, count
    return config, 0

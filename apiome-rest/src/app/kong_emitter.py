"""Kong emitter: canonical model → deck declarative config — FMT-2.2 (#5420).

The inverse of :class:`app.kong_import_source.KongImportSource` and an
implementation of the :class:`app.emitter.Emitter` SPI. Until now the Kong adapter
was read-only: a gateway configuration could be imported, governed, diffed and
scored, and there was no way to get the governed result back out to the gateway.
This emitter closes that loop — ``services`` from the canonical services and their
recorded upstreams, ``routes`` rebuilt from the operations each one was flattened
into, and ``plugins`` from the canonical security hints through the same mapping
table the importer reads plugins with, in reverse.

The projection itself is not here. :mod:`app.gateway_config_emitter` turns a
:class:`~app.canonical_model.CanonicalApi` into the flavor-neutral
:class:`~app.gateway_config_model.GatewayConfigDocument` that both gateway
importers already produce, and this module is *only* the deck renderer for it —
so FMT-2.3's ``HTTPRoute`` emitter and the wider gateway family of FMT-7.6/7.7
inherit one projection instead of re-deriving it per product.

What round-trips, and what cannot
---------------------------------

Kong's ``paths × methods`` cross-product is rebuilt: operations that name the same
``gateway_route`` become one route again, with its paths, methods, hosts,
protocols, header matches and every route attribute the import preserved
(``strip_path``, ``regex_priority``, ``tags``, …). A path template with parameters
becomes the named-capture regex the importer reads straight back to the same
template, so ``/users/{userId}`` survives the trip in both directions.

Two things genuinely cannot:

* **Schemas.** A gateway configuration says where a request goes, never what it
  carries. Every request/response body, every named type and every event channel
  in the model is therefore a declared loss on the :class:`~app.emitter.EmitResult`
  — one per construct, not one blanket statement — and the capability profile says
  so up front rather than claiming a fidelity the format cannot deliver.
* **The artifact title.** deck has no field for it, and inventing one (an ``_info``
  key of our own, say) would produce a file ``deck validate`` rejects. It is a
  declared loss; a re-import names the configuration after the file it read.

Credentials are never emitted. The importer redacts consumer credentials and
secret-shaped plugin values at parse time, so they are not in the canonical model
to emit — and the emitted configuration says as much through a loss rather than
leaving the reader to assume their credentials came along.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Union

import yaml
from pydantic import Field, field_validator

from .canonical_model import ApiParadigm, CanonicalApi
from .emitter import (
    CapabilityProfile,
    EmitOptions,
    EmitOptionsError,
    EmitResult,
    EmittedFile,
    Emitter,
    LossKind,
    LossTracker,
    Provenance,
    ProvenanceTracker,
)
from .gateway_config_emitter import (
    SERVICE_NAMING_STRATEGIES,
    escape_path_literal,
    gateway_sourced,
    narrow_service_scoped_auth,
    plan_gateway_config,
)
from .gateway_config_model import (
    KONG_AUTH_PLUGIN_SCHEMES,
    GatewayAuthHint,
    GatewayMatch,
    GatewayPathPattern,
    GatewayPlugin,
    GatewayRoute,
    GatewayServiceDef,
)
from .gateway_config_normalizer import KONG_FORMAT_KEY
from .kong_deck_schema import (
    DECK_FORMAT_VERSIONS,
    deck_document_violations,
    validate_kong_declarative_document,
)
from .kong_parser import ROUTE_EXTRA_KEYS, SERVICE_EXTRA_KEYS

__all__ = [
    "KongEmitOptions",
    "KongEmitter",
    # Re-exported so an export caller needs one import to emit and verify.
    "deck_document_violations",
    "validate_kong_declarative_document",
]


# ===========================================================================
# Emit-side vocabulary
# ===========================================================================

#: OAuth 2 flow flags the importer reads into an ``oauth2`` hint's ``detail``, and
#: therefore the only flags this emitter writes back.
_OAUTH2_FLOW_FLAGS: frozenset = frozenset(
    {
        "enable_authorization_code",
        "enable_client_credentials",
        "enable_implicit_grant",
        "enable_password_grant",
    }
)

#: Output filenames. ``kong.yaml`` is deck's conventional name and is also what the
#: import adapter recognizes by filename alone.
_OUTPUT_FILENAMES: Dict[str, str] = {"yaml": "kong.yaml", "json": "kong.json"}

#: Bundle media type per output format.
_MEDIA_TYPES: Dict[str, str] = {"yaml": "application/yaml", "json": "application/json"}


class KongEmitOptions(EmitOptions):
    """Per-target options for :class:`KongEmitter`.

    The defaults reproduce a Kong import faithfully: the current deck format
    version, plugins emitted, and service names preserved exactly as the canonical
    model carries them.
    """

    format_version: str = Field(
        default="3.0",
        description="deck `_format_version` to declare. One of 1.1, 2.1, 3.0.",
    )
    emit_plugins: bool = Field(
        default=True,
        description="Emit `plugins` blocks (auth plugins from canonical security, plus "
        "the non-auth plugins the model records by name). Disable for a routing-only "
        "configuration.",
    )
    service_naming: str = Field(
        default="preserve",
        description="How to name Kong services: `preserve` (canonical service name, "
        "sanitized only where Kong forbids a character), `slug` (lower-cased and "
        "hyphenated), or `host` (named after the upstream host).",
    )
    output_format: str = Field(
        default="yaml",
        description="Serialize as `yaml` (deck's usual form) or `json`.",
    )
    pretty_print: bool = Field(
        default=True,
        description="Render block-style YAML / indented JSON. Disable for a compact "
        "single-line document.",
    )

    @field_validator("format_version")
    @classmethod
    def _known_format_version(cls, value: str) -> str:
        """Reject a ``_format_version`` deck would not load."""
        if value not in DECK_FORMAT_VERSIONS:
            raise ValueError(
                f"format_version must be one of {', '.join(sorted(DECK_FORMAT_VERSIONS))}"
            )
        return value

    @field_validator("service_naming")
    @classmethod
    def _known_service_naming(cls, value: str) -> str:
        """Reject an unknown service-naming strategy."""
        if value not in SERVICE_NAMING_STRATEGIES:
            raise ValueError(
                f"service_naming must be one of {', '.join(SERVICE_NAMING_STRATEGIES)}"
            )
        return value

    @field_validator("output_format")
    @classmethod
    def _known_output_format(cls, value: str) -> str:
        """Reject an output format this emitter cannot serialize."""
        if value not in _OUTPUT_FILENAMES:
            raise ValueError(
                f"output_format must be one of {', '.join(sorted(_OUTPUT_FILENAMES))}"
            )
        return value


# ===========================================================================
# Plugin rendering
# ===========================================================================


def _auth_plugin_config(hint: GatewayAuthHint) -> Dict[str, Any]:
    """Rebuild the plugin ``config`` an auth hint's ``detail`` was read from.

    The exact inverse of the importer's detail extraction, so a re-import of the
    emitted plugin produces an identical hint:

    * ``key-auth`` / ``key-auth-enc`` — ``key_names`` back from ``detail``;
    * ``oauth2`` — ``scopes`` and one boolean per enabled flow flag;
    * every other plugin — no config, because the importer derives no detail from
      one (its real configuration was never carried by the canonical model).

    Args:
        hint: The auth hint to render.

    Returns:
        The plugin ``config`` mapping, empty when the plugin needs none.
    """
    config: Dict[str, Any] = {}
    if hint.plugin in ("key-auth", "key-auth-enc"):
        key_names = hint.detail.get("key_names")
        if isinstance(key_names, (list, tuple)) and key_names:
            config["key_names"] = [str(name) for name in key_names]
    elif hint.plugin == "oauth2":
        scopes = hint.detail.get("scopes")
        if isinstance(scopes, (list, tuple)) and scopes:
            config["scopes"] = [str(scope) for scope in scopes]
        flows = hint.detail.get("flows")
        if isinstance(flows, (list, tuple)):
            for flag in sorted(str(flow) for flow in flows):
                if flag in _OAUTH2_FLOW_FLAGS:
                    config[flag] = True
    return config


def _auth_plugin_entry(hint: GatewayAuthHint) -> Dict[str, Any]:
    """Render one auth hint as a Kong plugin entry."""
    entry: Dict[str, Any] = {"name": hint.plugin}
    config = _auth_plugin_config(hint)
    if config:
        entry["config"] = config
    return entry


def _plugin_entry(plugin: GatewayPlugin) -> Dict[str, Any]:
    """Render one non-auth plugin as a Kong plugin entry.

    The canonical model keeps plugin *names*, not their configuration, so the entry
    is name-only. One inference is load-bearing: a plugin whose name *is* an auth
    plugin can only have reached the non-auth list by being disabled at the source
    (the importer turns an enabled auth plugin into a security hint instead), so it
    is emitted with ``enabled: false`` — which is what it was.
    """
    entry: Dict[str, Any] = {"name": plugin.name}
    if plugin.config:
        entry["config"] = dict(plugin.config)
    if plugin.name in KONG_AUTH_PLUGIN_SCHEMES or not plugin.enabled:
        entry["enabled"] = False
    return entry


# ===========================================================================
# Route rendering
# ===========================================================================


def _kong_path(pattern: GatewayPathPattern) -> Tuple[str, Optional[Tuple[str, str]]]:
    """Spell one path pattern the way Kong declares it.

    Kong has exactly two path types: a literal *prefix* and a regex, marked by a
    leading ``~``. A flavor-neutral pattern can also be ``exact`` (Gateway API's
    ``Exact`` path match), which Kong has no field for — emitting it as a prefix
    would widen the route to every path *starting* with it, so it becomes an
    anchored regex instead, which matches exactly the same requests.

    Args:
        pattern: The flavor-neutral path pattern.

    Returns:
        ``(path, note)`` — the Kong ``paths[]`` value, and a ``(subject, detail)``
        pair when the spelling changed the pattern's declared kind.
    """
    if pattern.kind == "regex":
        raw = pattern.raw if pattern.raw.startswith("~") else "~" + pattern.raw
        return raw, None
    if pattern.kind == "exact":
        anchored = "~" + escape_path_literal(pattern.raw) + "$"
        return anchored, (
            "exact-path-match",
            f"Kong path {pattern.raw!r} was declared as an exact match, which Kong has "
            f"no path type for; emitted as the anchored regex {anchored!r}, which "
            "matches the same requests but re-reads as a regex rather than an exact path.",
        )
    return pattern.raw, None


def _match_bucket_key(match: GatewayMatch) -> str:
    """Group key for matches that can share one Kong route.

    Kong declares header and query matching once per route, so two matches may be
    merged into a ``paths × methods`` cross-product only when their header/query
    conditions are identical.
    """
    return json.dumps(
        {"headers": [list(pair) for pair in match.headers],
         "query": [list(pair) for pair in match.query]},
        sort_keys=True,
    )


def _cross_product_groups(
    matches: Sequence[GatewayMatch],
) -> List[Tuple[List[str], List[str], GatewayMatch]]:
    """Collapse flattened matches back into Kong ``paths`` × ``methods`` groups.

    Args:
        matches: The route's flattened match conditions.

    Returns:
        One ``(paths, methods, exemplar)`` triple per Kong route to emit. A group
        whose ``(path, method)`` pairs form a complete cross-product collapses to a
        single triple; anything else splits per path, so no combination is invented
        and none is lost.
    """
    buckets: Dict[str, List[GatewayMatch]] = {}
    order: List[str] = []
    for match in matches:
        key = _match_bucket_key(match)
        if key not in buckets:
            buckets[key] = []
            order.append(key)
        buckets[key].append(match)

    groups: List[Tuple[List[str], List[str], GatewayMatch]] = []
    for key in order:
        bucket = buckets[key]
        # Spell each match's path Kong's way *before* grouping: `/users` declared
        # exact and `/users` declared as a prefix are different Kong paths.
        spelled = {
            match: _kong_path(match.path)[0] for match in bucket if match.path is not None
        }
        paths = sorted(set(spelled.values()))
        methods = sorted({m.method for m in bucket if m.method is not None})
        pairs = {(spelled.get(m), m.method) for m in bucket}
        expected = {
            (path, method)
            for path in (paths or [None])
            for method in (methods or [None])
        }
        if pairs == expected:
            groups.append((paths, methods, bucket[0]))
            continue
        for path in paths or [None]:
            per_path = sorted(
                {
                    m.method
                    for m in bucket
                    if spelled.get(m) == path and m.method is not None
                }
            )
            groups.append(([path] if path is not None else [], per_path, bucket[0]))
    return groups


# ===========================================================================
# The emitter
# ===========================================================================


class KongEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as a Kong ``deck`` declarative configuration."""

    key = "kong"
    format = KONG_FORMAT_KEY
    label = "Kong Declarative Config"
    description = (
        "Export as a deck declarative configuration (kong.yaml): services from the "
        "canonical upstreams, routes from the operations, and auth plugins from the "
        "canonical security schemes."
    )
    icon = "waypoints"
    paradigm = ApiParadigm.REST
    multi_file = False
    options_model = KongEmitOptions

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        """Declare what a Kong declarative configuration carries faithfully.

        A gateway configuration is a *routing* surface: it carries operations —
        hosts, path patterns, methods, header matches — faithfully, and carries
        nothing about the payloads those operations exchange. There is no type
        system to hold a union, no member declaration to mark nullable, no facet to
        enforce a constraint and no field identity, so every one of those axes is
        ``False``: the schema loss is stated here, before an emit runs, rather than
        discovered in the artifact.
        """
        return CapabilityProfile(
            operations=True,
            events=False,
            unions=False,
            nullability=False,
            constraints=False,
            field_identity=False,
        )

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[KongEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        """Emit ``api`` as one deck declarative configuration file.

        Args:
            api: The canonical model to export.
            opts: Per-target options; the defaults reproduce a Kong import faithfully.

        Returns:
            A single-file :class:`~app.emitter.EmitResult` whose content is the deck
            YAML (or JSON) text, with the provenance of every emitted value and a
            loss for every construct a routing surface cannot carry.

        Raises:
            EmitOptionsError: When ``opts`` names an unknown option value.
            ValueError: When ``api`` declares no operations, so there is no routing
                surface to emit.
        """
        options = _coerce_options(opts)
        writer = _KongWriter(api, options)
        content = writer.render()
        media_type = _MEDIA_TYPES[options.output_format]
        return EmitResult(
            files=[
                EmittedFile(
                    path=_OUTPUT_FILENAMES[options.output_format],
                    content=content,
                    media_type=media_type,
                )
            ],
            media_type=media_type,
            provenance=writer.tracker.records(),
            losses=writer.losses.records(),
        )


def _coerce_options(opts: Optional[Union[KongEmitOptions, EmitOptions]]) -> KongEmitOptions:
    """Validate caller-supplied options into a :class:`KongEmitOptions`."""
    if isinstance(opts, KongEmitOptions):
        return opts
    try:
        return KongEmitOptions.model_validate(opts.model_dump() if opts else {})
    except ValueError as exc:
        raise EmitOptionsError(f"Invalid Kong emit options: {exc}") from exc


class _KongWriter:
    """Render one planned gateway document as deck YAML/JSON, tracking fidelity."""

    def __init__(self, api: CanonicalApi, options: KongEmitOptions) -> None:
        """Plan the emission for ``api`` under ``options``."""
        self._api = api
        self._options = options
        self._declared_routes = gateway_sourced(api)
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()
        document = plan_gateway_config(
            api,
            flavor=KONG_FORMAT_KEY,
            losses=self.losses,
            service_naming=options.service_naming,
        )
        if not document.routes:
            raise ValueError(
                "Kong declarative export requires at least one HTTP operation: a "
                "declarative configuration is a routing surface, and a model with no "
                "operations has no route to declare (Kong rejects a config with none)."
            )
        document, narrowed = narrow_service_scoped_auth(document)
        for route_name, plugin in narrowed:
            self.losses.record(
                LossKind.INFERRED,
                "narrowed-auth-scope",
                f"Auth plugin {plugin!r} is recorded as service-scoped but does not "
                f"apply to every route of its service; emitted on route "
                f"{route_name!r} instead so no route gains authentication it did not have.",
                route_name,
            )
        self._document = document
        self._record_unrepresentable_constructs()

    # --- top level ----------------------------------------------------------

    def render(self) -> str:
        """Return the emitted declarative-configuration text."""
        document = self._build()
        if self._options.output_format == "json":
            return (
                json.dumps(document, indent=2, ensure_ascii=False) + "\n"
                if self._options.pretty_print
                else json.dumps(document, separators=(",", ":"), ensure_ascii=False)
            )
        if self._options.pretty_print:
            return yaml.safe_dump(
                document, sort_keys=False, default_flow_style=False, allow_unicode=True
            )
        return yaml.safe_dump(document, sort_keys=False, default_flow_style=True, allow_unicode=True)

    def _build(self) -> Dict[str, Any]:
        """Assemble the whole declarative document, in deck's conventional order."""
        out: Dict[str, Any] = {"_format_version": self._options.format_version}
        self.tracker.record(
            "/_format_version",
            Provenance.DEFAULT,
            "deck format version chosen by the emit options, not by the source model.",
        )

        routes_by_service: Dict[str, List[GatewayRoute]] = {}
        for route in self._document.routes:
            routes_by_service.setdefault(route.service_name or "", []).append(route)

        services: List[Dict[str, Any]] = []
        for index, service in enumerate(self._document.services):
            services.append(
                self._service(
                    service,
                    routes_by_service.get(service.name, []),
                    pointer=f"/services/{index}",
                )
            )
        if services:
            out["services"] = services

        # Routes that name no service are declared at the top level, exactly as the
        # importer read them (a Kong route may stand alone).
        unattached = self._flatten_routes(
            routes_by_service.get("", []), pointer_root="/routes"
        )
        if unattached:
            out["routes"] = unattached

        plugins = self._global_plugins()
        if plugins:
            out["plugins"] = plugins
        return out

    # --- services and routes ------------------------------------------------

    def _service(
        self,
        service: GatewayServiceDef,
        routes: Sequence[GatewayRoute],
        *,
        pointer: str,
    ) -> Dict[str, Any]:
        """Render one ``services[]`` entry with its nested routes and plugins."""
        entry: Dict[str, Any] = {"name": service.name}
        self.tracker.record(
            ProvenanceTracker.child(pointer, "name"),
            Provenance.SOURCE,
            "Canonical service name.",
        )
        if service.url:
            entry["url"] = service.url
        for attribute in ("protocol", "host", "port", "path"):
            value = getattr(service, attribute)
            if value is not None:
                entry[attribute] = value
        for key in SERVICE_EXTRA_KEYS:
            if key in service.extras and service.extras[key] is not None:
                entry[key] = service.extras[key]
        for key in sorted(service.extras):
            if key not in SERVICE_EXTRA_KEYS:
                self.losses.record(
                    LossKind.NA,
                    "unmapped-service-attribute",
                    f"Service {service.name!r} carries a {key!r} attribute Kong has no "
                    "service field for; it is not emitted.",
                    service.name,
                )

        if self._options.emit_plugins:
            plugins = [
                _auth_plugin_entry(hint)
                for hint in _service_scoped_auth(routes, service.name)
            ]
            if plugins:
                entry["plugins"] = plugins
                self.tracker.record(
                    ProvenanceTracker.child(pointer, "plugins"),
                    Provenance.SOURCE,
                    "Auth plugins recorded as service-scoped by the canonical security hints.",
                )

        rendered = self._flatten_routes(routes, pointer_root=f"{pointer}/routes")
        if rendered:
            entry["routes"] = rendered
        return entry

    def _flatten_routes(
        self,
        routes: Sequence[GatewayRoute],
        *,
        pointer_root: str,
    ) -> List[Dict[str, Any]]:
        """Render a service's (or the document's) routes, expanding split groups."""
        rendered: List[Dict[str, Any]] = []
        for route in routes:
            for entry in self._route_entries(route):
                pointer = f"{pointer_root}/{len(rendered)}"
                self.tracker.record(
                    ProvenanceTracker.child(pointer, "name"),
                    Provenance.SOURCE if self._declared_routes else Provenance.INFERRED,
                    "Route name recovered from the canonical `gateway_route` extra."
                    if self._declared_routes
                    else "Route name derived from the operation key; the model declares none.",
                )
                if entry.get("paths"):
                    self.tracker.record(
                        ProvenanceTracker.child(pointer, "paths"),
                        Provenance.SOURCE,
                        "Path patterns recovered from the operations' `path_match` extras.",
                    )
                if entry.get("hosts"):
                    self.tracker.record(
                        ProvenanceTracker.child(pointer, "hosts"),
                        Provenance.SOURCE,
                        "Hostnames recovered from the operations' `hosts` extras.",
                    )
                if entry.get("protocols"):
                    self.tracker.record(
                        ProvenanceTracker.child(pointer, "protocols"),
                        Provenance.INFERRED,
                        "Protocols derived from the scheme of the canonical servers.",
                    )
                rendered.append(entry)
        return rendered

    def _route_entries(self, route: GatewayRoute) -> List[Dict[str, Any]]:
        """Render one planned route as one or more Kong route entries.

        Fidelity is reported once per route, before the split: a route that expands
        into several Kong routes has not lost anything several times over.
        """
        self._record_route_losses(route)
        groups = _cross_product_groups(route.matches)
        entries: List[Dict[str, Any]] = []
        for index, (paths, methods, exemplar) in enumerate(groups):
            name = route.name if index == 0 else f"{route.name}-{index + 1}"
            if index:
                self.losses.record(
                    LossKind.INFERRED,
                    "split-route",
                    f"Route {route.name!r} matches a combination of paths and methods "
                    "Kong cannot express as one cross-product; emitted the remainder "
                    f"as {name!r}.",
                    route.name,
                )
            entry: Dict[str, Any] = {"name": name}
            if route.hosts:
                entry["hosts"] = list(route.hosts)
            if paths:
                entry["paths"] = paths
            if methods:
                entry["methods"] = methods
            if route.protocols:
                entry["protocols"] = list(route.protocols)
            entry.update(self._route_match_conditions(exemplar))
            for key in ROUTE_EXTRA_KEYS:
                if key in route.extras and route.extras[key] is not None and key not in entry:
                    entry[key] = route.extras[key]
            plugins = self._route_plugins(route)
            if plugins:
                entry["plugins"] = plugins
            entries.append(entry)
        return entries

    @staticmethod
    def _route_match_conditions(match: GatewayMatch) -> Dict[str, Any]:
        """Render one match's header conditions as Kong's ``headers`` mapping."""
        if not match.headers:
            return {}
        headers: Dict[str, List[str]] = {}
        for name, value in match.headers:
            headers.setdefault(name, []).append(value)
        return {"headers": headers}

    def _record_route_losses(self, route: GatewayRoute) -> None:
        """Report, once per route, everything Kong's route shape cannot carry."""
        for match in route.matches:
            if match.path is not None:
                note = _kong_path(match.path)[1]
                if note is not None:
                    self.losses.record(LossKind.INFERRED, note[0], note[1], route.name)
            if match.query:
                self.losses.record(
                    LossKind.NA,
                    "query-match",
                    f"Route {route.name!r} matches on query parameters "
                    f"({', '.join(name for name, _ in match.query)}); a Kong route has no "
                    "query-matching field, so the condition is not emitted.",
                    route.name,
                )
        for key in sorted(route.extras):
            if key not in ROUTE_EXTRA_KEYS:
                self.losses.record(
                    LossKind.NA,
                    "unmapped-route-attribute",
                    f"Route {route.name!r} carries a {key!r} attribute Kong has no "
                    "route field for; it is not emitted.",
                    route.name,
                )
        if not self._options.emit_plugins:
            return
        for plugin in route.plugins:
            self.losses.record(
                LossKind.INFERRED,
                "plugin-configuration",
                f"Plugin {plugin.name!r} on route {route.name!r} is emitted by name "
                "only — the canonical model records which plugins are attached, not "
                "how they are configured.",
                route.name,
            )

    def _route_plugins(self, route: GatewayRoute) -> List[Dict[str, Any]]:
        """Render the plugins a Kong route carries directly."""
        if not self._options.emit_plugins:
            return []
        entries = [
            _auth_plugin_entry(hint) for hint in route.auth if hint.scope == "route"
        ]
        entries.extend(_plugin_entry(plugin) for plugin in route.plugins)
        return entries

    def _global_plugins(self) -> List[Dict[str, Any]]:
        """Render the gateway-wide plugins section."""
        if not self._options.emit_plugins:
            return []
        entries = [_auth_plugin_entry(hint) for hint in self._document.global_auth]
        for plugin in self._document.global_plugins:
            entries.append(_plugin_entry(plugin))
            self.losses.record(
                LossKind.INFERRED,
                "plugin-configuration",
                f"Gateway-wide plugin {plugin.name!r} is emitted by name only — the "
                "canonical model records neither its configuration nor which service "
                "or route it was attached to.",
                "",
            )
        return entries

    # --- fidelity -----------------------------------------------------------

    def _record_unrepresentable_constructs(self) -> None:
        """Report the constructs deck's file format has nowhere to put."""
        if self._api.title or self._api.identity.name:
            self.losses.record(
                LossKind.NA,
                "artifact-title",
                "A Kong declarative configuration has no field for the artifact title "
                f"({self._document.title!r}); a re-import names the configuration after "
                "the file it was read from.",
                "",
            )


def _service_scoped_auth(
    routes: Iterable[GatewayRoute],
    service_name: str,
) -> List[GatewayAuthHint]:
    """Return the auth hints to emit on a service, de-duplicated and ordered.

    A service-scoped plugin is declared once on the service and applies to all of
    its routes, so the hints every route of ``service_name`` shares are collected
    here; :func:`~app.gateway_config_emitter.narrow_service_scoped_auth` has already
    moved any that are *not* shared down to route scope.
    """
    seen: Dict[str, GatewayAuthHint] = {}
    for route in routes:
        for hint in route.auth:
            if hint.scope != "service" or hint.attached_to != service_name:
                continue
            seen.setdefault(json.dumps(hint.as_dict(), sort_keys=True, default=str), hint)
    return [seen[key] for key in sorted(seen)]

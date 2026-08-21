"""Gateway API emitter: canonical model → ``HTTPRoute`` manifests — FMT-2.3 (#5421).

The inverse of :class:`app.gateway_api_import_source.GatewayApiImportSource` and an
implementation of the :class:`app.emitter.Emitter` SPI. Until now the Gateway API
adapter was read-only: an ``HTTPRoute`` stream could be imported, governed, diffed
and scored, and there was no way to write the governed result back. HTTPRoute is
where platform teams increasingly express routing, and it is exactly the artifact
they would want generated from a governed API definition — this emitter closes that
loop.

The projection is not here. :func:`app.gateway_config_emitter.plan_gateway_config`
turns a :class:`~app.canonical_model.CanonicalApi` into the flavor-neutral
:class:`~app.gateway_config_model.GatewayConfigDocument` that both gateway *parsers*
already produce, and this module is *only* the manifest renderer for it — the same
split :mod:`app.kong_emitter` uses, so the two gateway targets cannot drift apart.

How a document becomes manifests
--------------------------------

The mapping is the exact inverse of :mod:`app.gateway_api_parser`:

* one **canonical service** → one ``HTTPRoute`` resource. A gateway-API import
  names its services ``namespace/resource``, so the two halves are split back into
  ``metadata.namespace`` / ``metadata.name``;
* one **planned route** → one ``spec.rules[]`` entry, in the source's rule order
  (the importer names a multi-rule resource's routes ``<resource>#rule-N``, and
  that suffix is what restores the order a canonical model's sorted-by-key
  operations would otherwise lose);
* one **flattened match** → one ``rules[].matches[]`` entry, with the path type
  spelled through :data:`~app.gateway_api_parser.PATH_KIND_TYPES` — the *derived*
  reverse of the table the parser reads path types with, so the two directions
  cannot disagree;
* ``backendRefs`` come from the backends the model records, and ``parentRefs`` and
  ``hostnames`` from the route's extras, falling back to the emit options and the
  canonical servers.

What cannot round-trip, and is declared rather than dropped
-----------------------------------------------------------

* **Filters.** The importer preserves a filter's *name* on the canonical model but
  not its configuration, and every Gateway API filter type is required by the CRD
  to carry its companion field (a ``RequestHeaderModifier`` without a
  ``requestHeaderModifier`` block is rejected on apply). Emitting a bare filter
  would produce a manifest a cluster refuses, and inventing its configuration would
  be worse, so each one is reported as a loss instead.
* **Auth.** The Gateway API core has no authentication filter — authentication is
  an implementation's ``ExtensionRef`` policy — so canonical security hints have
  nowhere to go and are reported per hint.
* **Schemas.** A routing surface says where a request goes, never what it carries;
  the shared projection reports every request/response body, named type and event
  channel individually, and the capability profile says so before an emit runs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

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
from .gateway_api_parser import PATH_KIND_TYPES, ROUTE_EXTRA_KEYS
from .gateway_api_schema import (
    GATEWAY_API_GROUP,
    HTTP_METHODS,
    HTTPROUTE_KIND,
    HTTPROUTE_VERSIONS,
    hostname_violations,
    httproute_document_violations,
    httproute_stream_violations,
    validate_httproute_manifest,
)
from .gateway_config_emitter import (
    SERVICE_NAMING_STRATEGIES,
    UNATTACHED_SERVICE_NAME,
    gateway_sourced,
    plan_gateway_config,
)
from .gateway_config_model import GatewayMatch, GatewayPathPattern, GatewayRoute
from .gateway_config_normalizer import GATEWAY_API_FORMAT_KEY

__all__ = [
    "DOCUMENT_MODES",
    "GatewayApiEmitOptions",
    "GatewayApiEmitter",
    # Re-exported so an export caller needs one import to emit and verify.
    "httproute_document_violations",
    "httproute_stream_violations",
    "validate_httproute_manifest",
]


# ===========================================================================
# Emit-side vocabulary
# ===========================================================================

#: Output document layouts, as an emit option value → what it does.
#:
#: * ``multi`` — one ``HTTPRoute`` document per canonical service, written as a
#:   ``---``-separated stream (the shape the importer reads back identically);
#: * ``single`` — every rule merged into one ``HTTPRoute`` document, for a cluster
#:   that fronts the whole API with a single route. Merging unions the hostnames,
#:   which widens each rule to hostnames it did not match before, so every merge
#:   that changes something is reported.
DOCUMENT_MODES: Tuple[str, ...] = ("multi", "single")

#: An object reference as an emit option spells it: ``[namespace/]name[:section][@weight]``.
_REFERENCE_RE = re.compile(
    r"^(?:(?P<namespace>[^/:@]+)/)?(?P<name>[^/:@]+)(?::(?P<section>[^/:@]+))?"
    r"(?:@(?P<weight>[0-9]+))?$"
)

#: The route-name suffix the importer gives the rules of a multi-rule resource.
_RULE_SUFFIX_RE = re.compile(r"^(?P<stem>.+)#rule-(?P<index>[0-9]+)$")

#: Media type of an emitted manifest stream.
_MEDIA_TYPE = "application/yaml"

#: Fallback names for values that sanitize to nothing.
_FALLBACK_RESOURCE = "httproute"
_FALLBACK_BACKEND = "backend"


class GatewayApiEmitOptions(EmitOptions):
    """Per-target options for :class:`GatewayApiEmitter`.

    The defaults reproduce a Gateway API import faithfully: the GA API version, one
    document per imported resource, and every reference taken from what the model
    records rather than from an option.
    """

    api_version: str = Field(
        default="v1",
        description="Gateway API version to target: `v1` (GA) or `v1beta1`. Emitted as "
        "`apiVersion: gateway.networking.k8s.io/<version>`.",
    )
    document_mode: str = Field(
        default="multi",
        description="`multi` emits one HTTPRoute document per canonical service, as a "
        "`---`-separated stream; `single` merges every rule into one HTTPRoute.",
    )
    parent_refs: List[str] = Field(
        default_factory=list,
        description="`parentRefs` for routes whose model records none, as "
        "`[namespace/]name[:sectionName]` (e.g. `gateway-system/main-gateway:https`). An "
        "HTTPRoute with no parentRefs is attached to no Gateway.",
    )
    backend_refs: List[str] = Field(
        default_factory=list,
        description="`backendRefs` for rules whose model records none, as "
        "`[namespace/]name[:port][@weight]` (e.g. `commerce/orders:8080@90`). Defaults to "
        "one backend named after the canonical service.",
    )
    namespace: Optional[str] = Field(
        default=None,
        description="`metadata.namespace` for resources whose model records none. "
        "Omitted entirely when neither the model nor this option names one.",
    )
    service_naming: str = Field(
        default="preserve",
        description="How to name HTTPRoute resources: `preserve` (the canonical service "
        "name, sanitized only where Kubernetes forbids a character), `slug` (lower-cased "
        "and hyphenated), or `host` (named after the upstream host).",
    )
    pretty_print: bool = Field(
        default=True,
        description="Render block-style YAML. Disable for a compact flow-style stream.",
    )

    @field_validator("api_version")
    @classmethod
    def _known_api_version(cls, value: str) -> str:
        """Reject an API version that does not serve ``HTTPRoute``."""
        if value not in HTTPROUTE_VERSIONS:
            raise ValueError(f"api_version must be one of {', '.join(HTTPROUTE_VERSIONS)}")
        return value

    @field_validator("document_mode")
    @classmethod
    def _known_document_mode(cls, value: str) -> str:
        """Reject an unknown output layout."""
        if value not in DOCUMENT_MODES:
            raise ValueError(f"document_mode must be one of {', '.join(DOCUMENT_MODES)}")
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

    @field_validator("parent_refs", "backend_refs")
    @classmethod
    def _parsable_references(cls, value: List[str]) -> List[str]:
        """Reject a reference spelling the emitter cannot read."""
        for entry in value:
            if not isinstance(entry, str) or not _REFERENCE_RE.match(entry.strip()):
                raise ValueError(
                    f"{entry!r} is not a reference: expected "
                    "`[namespace/]name[:section][@weight]`"
                )
        return [entry.strip() for entry in value]


# ===========================================================================
# Kubernetes name spelling
# ===========================================================================


def _dns_subdomain(value: str, *, fallback: str) -> str:
    """Spell ``value`` as an RFC 1123 subdomain (a Kubernetes object name).

    Lower-cases, replaces every character outside ``[a-z0-9-]`` within a label
    with a hyphen, drops labels that reduce to nothing, and trims to 253
    characters — the rule ``metadata.name`` is validated against.

    Args:
        value: The source name.
        fallback: Name to return when ``value`` reduces to nothing.

    Returns:
        A legal object name.
    """
    labels = []
    for raw in (value or "").strip().lower().split("."):
        label = re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")
        if label:
            labels.append(label)
    name = ".".join(labels)[:253].strip("-.")
    return name or fallback


def _dns_label(value: str, *, fallback: str) -> str:
    """Spell ``value`` as an RFC 1123 label (a Kubernetes namespace).

    Args:
        value: The source name.
        fallback: Name to return when ``value`` reduces to nothing.

    Returns:
        A legal namespace (at most 63 characters, no dots).
    """
    label = re.sub(r"[^a-z0-9-]+", "-", (value or "").strip().lower()).strip("-")
    return label[:63].strip("-") or fallback


def _object_name(value: str, *, fallback: str) -> str:
    """Spell ``value`` as a Gateway API ``ObjectName`` (a referenced object's name).

    Case is preserved — Kubernetes Service names are lower-case but the Gateway API
    pattern accepts both, and preserving case keeps a declared reference byte-identical.

    Args:
        value: The source name.
        fallback: Name to return when ``value`` reduces to nothing.

    Returns:
        A legal object name (no dots, at most 253 characters).
    """
    cleaned = re.sub(r"[^a-zA-Z0-9-]+", "-", (value or "").strip()).strip("-")
    return cleaned[:253].strip("-") or fallback


def _hostname(value: str) -> Tuple[Optional[str], Optional[str]]:
    """Spell one canonical server host as a Gateway API hostname.

    A canonical server's host carries the port (``localhost:8000``) and may be
    mixed-case; a Gateway API hostname is a lower-case DNS name with no port. The
    port is dropped and the name lower-cased, and anything still illegal (an IPv6
    literal, an empty label) is refused rather than emitted.

    Args:
        value: The canonical host.

    Returns:
        ``(hostname, reason)`` — the hostname and ``None``, or ``None`` and the
        reason it cannot be spelled as one.
    """
    host = (value or "").strip().lower()
    if host.startswith("["):
        return None, "an IPv6 literal is not a Gateway API hostname"
    host = host.split(":", 1)[0]
    reason = hostname_violations(host)
    return (None, reason) if reason else (host, None)


def _parse_reference(spec: str, *, port_from_section: bool) -> Dict[str, Any]:
    """Read one ``[namespace/]name[:section][@weight]`` option value.

    Args:
        spec: The option value.
        port_from_section: True for a backend reference, where a ``:`` suffix is a
            port; False for a parent reference, where a numeric suffix is a port
            and anything else is a ``sectionName``.

    Returns:
        The reference mapping, with only the fields the spelling named.

    Raises:
        EmitOptionsError: When ``spec`` is not a reference spelling.
    """
    match = _REFERENCE_RE.match(spec.strip())
    if not match:
        raise EmitOptionsError(
            f"Invalid Gateway API emit options: {spec!r} is not a reference "
            "(expected `[namespace/]name[:section][@weight]`)"
        )
    reference: Dict[str, Any] = {"name": match.group("name")}
    namespace = match.group("namespace")
    if namespace:
        reference["namespace"] = namespace
    section = match.group("section")
    if section:
        if port_from_section or section.isdigit():
            if not section.isdigit():
                raise EmitOptionsError(
                    f"Invalid Gateway API emit options: {spec!r} names a backend port "
                    f"{section!r} that is not a number"
                )
            reference["port"] = int(section)
        else:
            reference["sectionName"] = section
    weight = match.group("weight")
    if weight is not None:
        reference["weight"] = int(weight)
    return reference


# ===========================================================================
# Emission plan
# ===========================================================================


@dataclass(frozen=True)
class _RulePlan:
    """One planned ``spec.rules[]`` entry and the route it came from."""

    route: GatewayRoute
    matches: Tuple[Dict[str, Any], ...]
    backend_refs: Tuple[Dict[str, Any], ...]


@dataclass(frozen=True)
class _ResourcePlan:
    """One planned ``HTTPRoute`` resource."""

    name: str
    namespace: Optional[str]
    hostnames: Tuple[str, ...]
    parent_refs: Tuple[Dict[str, Any], ...]
    rules: Tuple[_RulePlan, ...]
    service_name: str


def _rule_order(routes: Sequence[GatewayRoute]) -> List[GatewayRoute]:
    """Restore the source rule order of one resource's routes.

    The importer names the routes of a multi-rule resource ``<resource>#rule-N``,
    but a canonical model sorts its operations by key, so the projection can hand
    back the rules of one resource in a different order than the manifest declared
    them. When *every* route carries the suffix the order is recovered from it;
    otherwise (a foreign model, or an edited one) the projection's own order stands.

    Args:
        routes: The resource's routes, in projection order.

    Returns:
        The routes in the order their rules should be emitted.
    """
    indices: List[int] = []
    for route in routes:
        match = _RULE_SUFFIX_RE.match(route.name)
        if match is None:
            return list(routes)
        indices.append(int(match.group("index")))
    return [route for _, route in sorted(zip(indices, routes), key=lambda pair: pair[0])]


def _split_resource_name(
    service_name: str,
    routes: Sequence[GatewayRoute],
    *,
    default_namespace: Optional[str],
) -> Tuple[Optional[str], str]:
    """Split a canonical service name into ``(namespace, resource name)``.

    A Gateway API import names a service after the resource it came from —
    ``identity/users`` for a namespaced one — so the split is the inverse of that
    naming. The namespace the routes recorded is preferred over a bare ``/`` split,
    which keeps a resource name that happens to contain a slash intact.

    Args:
        service_name: The canonical service name.
        routes: The service's routes (their extras carry the source namespace).
        default_namespace: Namespace to use when nothing records one.

    Returns:
        ``(namespace, name)``, both unsanitized.
    """
    declared = next(
        (
            route.extras["namespace"]
            for route in routes
            if isinstance(route.extras.get("namespace"), str) and route.extras["namespace"]
        ),
        None,
    )
    if declared and service_name.startswith(f"{declared}/"):
        return declared, service_name[len(declared) + 1 :]
    if "/" in service_name:
        namespace, name = service_name.split("/", 1)
        return namespace, name
    return declared or default_namespace, service_name


# ===========================================================================
# The emitter
# ===========================================================================


class GatewayApiEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as Kubernetes Gateway API ``HTTPRoute`` manifests."""

    key = "gateway-api"
    format = GATEWAY_API_FORMAT_KEY
    label = "Gateway API HTTPRoute"
    description = (
        "Export as gateway.networking.k8s.io HTTPRoute manifests: one resource per "
        "service, one rule per route group, with matches, backendRefs and parentRefs."
    )
    icon = "route"
    paradigm = ApiParadigm.REST
    multi_file = False
    options_model = GatewayApiEmitOptions

    OUTPUT_MEDIA_TYPE = _MEDIA_TYPE

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        """Declare what an ``HTTPRoute`` manifest carries faithfully.

        A routing surface carries operations — hostnames, path patterns, methods,
        header and query matches — faithfully, and carries nothing about the
        payloads those operations exchange. There is no type system to hold a
        union, no member declaration to mark nullable, no facet to enforce a
        constraint and no field identity, so every one of those axes is ``False``:
        the schema loss is stated here, before an emit runs, rather than discovered
        in the artifact.
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
        opts: Optional[Union[GatewayApiEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        """Emit ``api`` as one file holding a stream of ``HTTPRoute`` manifests.

        Args:
            api: The canonical model to export.
            opts: Per-target options; the defaults reproduce a Gateway API import
                faithfully.

        Returns:
            A single-file :class:`~app.emitter.EmitResult` whose content is the
            manifest text, with the provenance of every emitted value and a loss for
            every construct a routing surface cannot carry.

        Raises:
            EmitOptionsError: When ``opts`` names an unknown option value.
            ValueError: When ``api`` declares no routable HTTP operation, so there
                is no rule to emit.
        """
        options = _coerce_options(opts)
        writer = _GatewayApiWriter(api, options)
        content = writer.render()
        return EmitResult(
            files=[
                EmittedFile(
                    path=writer.output_path,
                    content=content,
                    media_type=self.OUTPUT_MEDIA_TYPE,
                )
            ],
            media_type=self.OUTPUT_MEDIA_TYPE,
            provenance=writer.tracker.records(),
            losses=writer.losses.records(),
        )


def _coerce_options(
    opts: Optional[Union[GatewayApiEmitOptions, EmitOptions]]
) -> GatewayApiEmitOptions:
    """Validate caller-supplied options into a :class:`GatewayApiEmitOptions`."""
    if isinstance(opts, GatewayApiEmitOptions):
        return opts
    try:
        return GatewayApiEmitOptions.model_validate(opts.model_dump() if opts else {})
    except ValueError as exc:
        raise EmitOptionsError(f"Invalid Gateway API emit options: {exc}") from exc


class _GatewayApiWriter:
    """Render one planned gateway document as ``HTTPRoute`` YAML, tracking fidelity."""

    def __init__(self, api: CanonicalApi, options: GatewayApiEmitOptions) -> None:
        """Plan the emission for ``api`` under ``options``."""
        self._api = api
        self._options = options
        self._declared_routes = gateway_sourced(api)
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()
        document = plan_gateway_config(
            api,
            flavor=GATEWAY_API_FORMAT_KEY,
            losses=self.losses,
            service_naming=options.service_naming,
        )
        if not document.routes:
            raise ValueError(
                "Gateway API export requires at least one HTTP operation: an HTTPRoute "
                "is a routing surface, and a model with no operations has no rule to "
                "declare (an HTTPRoute with no rules routes nothing)."
            )
        self._document = document
        self._option_parents = tuple(
            _parse_reference(spec, port_from_section=False)
            for spec in options.parent_refs
        )
        self._option_backends = tuple(
            _parse_reference(spec, port_from_section=True) for spec in options.backend_refs
        )
        self._record_unrepresentable_constructs()
        self._resources = self._plan_resources()
        if not self._resources:
            raise ValueError(
                "Gateway API export produced no HTTPRoute: every route's matches use a "
                "condition the Gateway API cannot express (see the emit losses)."
            )
        self.output_path = self._output_path()

    # --- top level ----------------------------------------------------------

    def render(self) -> str:
        """Return the emitted manifest text (one document per planned resource)."""
        documents = [
            self._document_for(resource, index)
            for index, resource in enumerate(self._resources)
        ]
        if self._options.pretty_print:
            return yaml.safe_dump_all(
                documents,
                sort_keys=False,
                default_flow_style=False,
                allow_unicode=True,
                explicit_start=len(documents) > 1,
            )
        return yaml.safe_dump_all(
            documents,
            sort_keys=False,
            default_flow_style=True,
            allow_unicode=True,
            explicit_start=len(documents) > 1,
        )

    def _output_path(self) -> str:
        """Return the emitted file name: the resource's own name, or the artifact's.

        A model imported from a file is titled after that file, so a manifest
        extension is trimmed before the title becomes part of a filename — the
        alternative reads ``routes.yaml.httproute.yaml``.
        """
        if len(self._resources) == 1:
            base = self._resources[0].name
        else:
            base = self._api.title or self._api.identity.name or _FALLBACK_RESOURCE
            for suffix in (".yaml", ".yml", ".json"):
                if base.lower().endswith(suffix):
                    base = base[: -len(suffix)]
                    break
        return f"{_dns_subdomain(base, fallback=_FALLBACK_RESOURCE)}.httproute.yaml"

    def _document_for(self, resource: _ResourcePlan, index: int) -> Dict[str, Any]:
        """Render one planned resource as an ``HTTPRoute`` mapping."""
        pointer = f"/documents/{index}"
        document: Dict[str, Any] = {
            "apiVersion": f"{GATEWAY_API_GROUP}/{self._options.api_version}",
            "kind": HTTPROUTE_KIND,
        }
        self.tracker.record(
            ProvenanceTracker.child(pointer, "apiVersion"),
            Provenance.DEFAULT,
            "Gateway API version chosen by the emit options, not by the source model.",
        )

        metadata: Dict[str, Any] = {"name": resource.name}
        if resource.namespace:
            metadata["namespace"] = resource.namespace
        document["metadata"] = metadata
        self.tracker.record(
            ProvenanceTracker.child(pointer, "metadata", "name"),
            Provenance.SOURCE if self._declared_routes else Provenance.INFERRED,
            "Resource name recovered from the canonical service name."
            if self._declared_routes
            else "Resource name derived from the canonical service; the model declares none.",
        )

        spec: Dict[str, Any] = {}
        if resource.parent_refs:
            spec["parentRefs"] = [dict(ref) for ref in resource.parent_refs]
            self.tracker.record(
                ProvenanceTracker.child(pointer, "spec", "parentRefs"),
                Provenance.SOURCE if self._declared_routes else Provenance.DEFAULT,
                "Parent references recovered from the routes' `parent_refs` extras."
                if self._declared_routes
                else "Parent references chosen by the emit options; the model declares none.",
            )
        if resource.hostnames:
            spec["hostnames"] = list(resource.hostnames)
            self.tracker.record(
                ProvenanceTracker.child(pointer, "spec", "hostnames"),
                Provenance.SOURCE if self._declared_routes else Provenance.INFERRED,
                "Hostnames recovered from the routes' `hosts` extras."
                if self._declared_routes
                else "Hostnames derived from the hosts of the canonical servers.",
            )
        spec["rules"] = [
            self._rule_entry(rule, f"{pointer}/spec/rules/{position}")
            for position, rule in enumerate(resource.rules)
        ]
        document["spec"] = spec
        return document

    def _rule_entry(self, rule: _RulePlan, pointer: str) -> Dict[str, Any]:
        """Render one planned rule as a ``spec.rules[]`` mapping."""
        entry: Dict[str, Any] = {"matches": [dict(match) for match in rule.matches]}
        self.tracker.record(
            ProvenanceTracker.child(pointer, "matches"),
            Provenance.SOURCE,
            "Match conditions recovered from the operations' path, method and "
            "header/query match extras.",
        )
        if rule.backend_refs:
            entry["backendRefs"] = [dict(ref) for ref in rule.backend_refs]
        return entry

    # --- planning -----------------------------------------------------------

    def _plan_resources(self) -> Tuple[_ResourcePlan, ...]:
        """Group the projected routes into the ``HTTPRoute`` resources to emit."""
        grouped: Dict[str, List[GatewayRoute]] = {}
        order: List[str] = []
        for route in self._document.routes:
            group = route.service_name or UNATTACHED_SERVICE_NAME
            if group not in grouped:
                grouped[group] = []
                order.append(group)
            grouped[group].append(route)

        resources = [self._plan_resource(group, grouped[group]) for group in order]
        resources = self._deduplicate([r for r in resources if r is not None])
        if self._options.document_mode == "single" and len(resources) > 1:
            return (self._merge_resources(resources),)
        return tuple(resources)

    def _deduplicate(self, resources: Sequence[_ResourcePlan]) -> List[_ResourcePlan]:
        """Make every planned resource's ``namespace``/``name`` pair unique.

        Two canonical service names can sanitize onto one Kubernetes object name
        (``Pet Store`` and ``pet-store``), and a cluster rejects the second document
        as a duplicate object rather than merging it. The later one is renamed and
        the rename reported.

        Args:
            resources: The planned resources, in projection order.

        Returns:
            The resources with unique identities, in the same order.
        """
        taken: Dict[Tuple[Optional[str], str], int] = {}
        unique: List[_ResourcePlan] = []
        for resource in resources:
            identity = (resource.namespace, resource.name)
            if identity in taken:
                taken[identity] += 1
                renamed = f"{resource.name}-{taken[identity]}"
                self.losses.record(
                    LossKind.INFERRED,
                    "deduplicated-resource-name",
                    f"Resource name {resource.name!r} is already taken by another "
                    f"service in the same namespace; emitted as {renamed!r}.",
                    resource.service_name,
                )
                resource = replace(resource, name=renamed)
            else:
                taken[identity] = 1
            unique.append(resource)
        return unique

    def _plan_resource(
        self, service_name: str, routes: Sequence[GatewayRoute]
    ) -> Optional[_ResourcePlan]:
        """Plan one ``HTTPRoute`` from the routes of one canonical service."""
        ordered = _rule_order(routes)
        rules = [plan for plan in (self._plan_rule(route) for route in ordered) if plan]
        if not rules:
            self.losses.record(
                LossKind.NA,
                "unroutable-resource",
                f"Service {service_name!r} has no rule the Gateway API can express, so "
                "no HTTPRoute is emitted for it.",
                service_name,
            )
            return None

        unattached = service_name == UNATTACHED_SERVICE_NAME
        if unattached:
            namespace: Optional[str] = self._options.namespace
            base = self._api.title or self._api.identity.name or _FALLBACK_RESOURCE
            self.losses.record(
                LossKind.INFERRED,
                "synthesized-resource-name",
                "Routes that name no service have no HTTPRoute of their own; they were "
                f"emitted as one resource named after the artifact ({base!r}).",
                service_name,
            )
        else:
            namespace, base = _split_resource_name(
                service_name, routes, default_namespace=self._options.namespace
            )

        name = _dns_subdomain(base, fallback=_FALLBACK_RESOURCE)
        if name != base:
            self.losses.record(
                LossKind.INFERRED,
                "sanitized-resource-name",
                f"Resource name {base!r} is not a Kubernetes object name; emitted as "
                f"{name!r}.",
                service_name,
            )
        if namespace:
            spelled = _dns_label(namespace, fallback=_FALLBACK_RESOURCE)
            if spelled != namespace:
                self.losses.record(
                    LossKind.INFERRED,
                    "sanitized-namespace",
                    f"Namespace {namespace!r} is not a Kubernetes namespace; emitted as "
                    f"{spelled!r}.",
                    service_name,
                )
            namespace = spelled

        return _ResourcePlan(
            name=name,
            namespace=namespace,
            hostnames=self._hostnames_for(service_name, ordered),
            parent_refs=self._parent_refs_for(service_name, ordered),
            rules=tuple(rules),
            service_name=service_name,
        )

    def _plan_rule(self, route: GatewayRoute) -> Optional[_RulePlan]:
        """Plan one ``spec.rules[]`` entry from one projected route."""
        self._record_route_losses(route)
        matches = [
            entry
            for entry in (self._match_entry(route, match) for match in route.matches)
            if entry is not None
        ]
        if not matches:
            self.losses.record(
                LossKind.NA,
                "unroutable-rule",
                f"Route {route.name!r} has no match the Gateway API can express; the "
                "rule is not emitted (an empty rule would match every request).",
                route.name,
            )
            return None
        return _RulePlan(
            route=route,
            matches=tuple(matches),
            backend_refs=self._backend_refs_for(route),
        )

    def _merge_resources(self, resources: Sequence[_ResourcePlan]) -> _ResourcePlan:
        """Merge every planned resource into one, reporting what the merge changes."""
        hostnames: List[str] = []
        for resource in resources:
            hostnames.extend(host for host in resource.hostnames if host not in hostnames)
        namespaces = [resource.namespace for resource in resources if resource.namespace]
        namespace = namespaces[0] if namespaces else self._options.namespace

        distinct_hosts = {resource.hostnames for resource in resources}
        if len(distinct_hosts) > 1:
            self.losses.record(
                LossKind.INFERRED,
                "widened-hostnames",
                "Merging every rule into one HTTPRoute unions the hostnames "
                f"({', '.join(hostnames) or 'none'}); each rule now matches hostnames it "
                "did not match as a separate resource.",
                "",
            )
        if len(set(namespaces)) > 1:
            self.losses.record(
                LossKind.INFERRED,
                "merged-namespace",
                f"The merged resources declare {len(set(namespaces))} namespaces; one "
                f"HTTPRoute carries one, so {namespace!r} was emitted.",
                "",
            )

        parents: List[Dict[str, Any]] = []
        for resource in resources:
            for ref in resource.parent_refs:
                if ref not in parents:
                    parents.append(ref)

        rules: List[_RulePlan] = []
        for resource in resources:
            rules.extend(resource.rules)

        base = self._api.title or self._api.identity.name or _FALLBACK_RESOURCE
        return _ResourcePlan(
            name=_dns_subdomain(base, fallback=_FALLBACK_RESOURCE),
            namespace=namespace,
            hostnames=tuple(hostnames),
            parent_refs=tuple(parents),
            rules=tuple(rules),
            service_name=base,
        )

    # --- match, hostname and reference rendering ----------------------------

    def _match_entry(
        self, route: GatewayRoute, match: GatewayMatch
    ) -> Optional[Dict[str, Any]]:
        """Render one flattened match as a ``matches[]`` mapping, or refuse it.

        A match is refused (rather than widened) when its method is outside the
        Gateway API's closed enum: dropping the method would route every verb to a
        rule the source restricted to one.
        """
        entry: Dict[str, Any] = {}
        if match.path is not None:
            entry["path"] = self._path_entry(route, match.path)
        if match.method is not None:
            if match.method not in HTTP_METHODS:
                self.losses.record(
                    LossKind.NA,
                    "unsupported-method",
                    f"Route {route.name!r} matches method {match.method!r}, which is "
                    "outside the Gateway API's method vocabulary; the match is not "
                    "emitted (emitting it without the method would route every verb).",
                    route.name,
                )
                return None
            entry["method"] = match.method

        headers = self._name_value_matches(route, match.headers, kind="header")
        if headers:
            entry["headers"] = headers
        query = self._name_value_matches(route, match.query, kind="query parameter")
        if query:
            entry["queryParams"] = query
        return entry or None

    def _path_entry(
        self, route: GatewayRoute, pattern: GatewayPathPattern
    ) -> Dict[str, Any]:
        """Render one path pattern as a ``matches[].path`` mapping.

        The kind is spelled through :data:`~app.gateway_api_parser.PATH_KIND_TYPES`,
        the derived reverse of the parser's table. A regex carried over from Kong
        keeps its meaning but loses Kong's ``~`` marker, which is a spelling the
        Gateway API has no place for — reported so the change is visible.
        """
        kind = pattern.kind if pattern.kind in PATH_KIND_TYPES else "prefix"
        value = pattern.raw or "/"
        if kind == "regex" and value.startswith("~"):
            value = value[1:]
            self.losses.record(
                LossKind.INFERRED,
                "normalized-path-regex",
                f"Path pattern {pattern.raw!r} on route {route.name!r} carries Kong's "
                f"`~` regex marker, which a Gateway API path value has no place for; "
                f"emitted as {value!r} with type RegularExpression.",
                route.name,
            )
        return {"type": PATH_KIND_TYPES[kind], "value": value}

    def _name_value_matches(
        self,
        route: GatewayRoute,
        pairs: Sequence[Tuple[str, str]],
        *,
        kind: str,
    ) -> List[Dict[str, str]]:
        """Render header / query match pairs, dropping the ones with no value.

        A Gateway API match value has ``minLength: 1``: a condition that names only
        a parameter ("this header must be present") has no spelling, and inventing
        a value would match requests the source did not.
        """
        entries: List[Dict[str, str]] = []
        for name, value in pairs:
            if not value:
                self.losses.record(
                    LossKind.NA,
                    "valueless-match",
                    f"Route {route.name!r} matches on the presence of {kind} {name!r} "
                    "without a value; a Gateway API match must name a value, so the "
                    "condition is not emitted.",
                    route.name,
                )
                continue
            entries.append({"name": name, "value": value})
        return entries

    def _hostnames_for(
        self, service_name: str, routes: Sequence[GatewayRoute]
    ) -> Tuple[str, ...]:
        """Render the hostnames one resource matches, in first-declared order."""
        hostnames: List[str] = []
        for route in routes:
            for host in route.hosts:
                spelled, reason = _hostname(host)
                if spelled is None:
                    self.losses.record(
                        LossKind.NA,
                        "unroutable-host",
                        f"Host {host!r} cannot be spelled as a Gateway API hostname "
                        f"({reason}); it is not emitted.",
                        route.name,
                    )
                    continue
                if spelled != host:
                    self.losses.record(
                        LossKind.INFERRED,
                        "normalized-hostname",
                        f"Host {host!r} carries a port or upper case, which a Gateway API "
                        f"hostname has no place for; emitted as {spelled!r}.",
                        route.name,
                    )
                if spelled not in hostnames:
                    hostnames.append(spelled)

        declared = {route.hosts for route in routes}
        if len(declared) > 1:
            self.losses.record(
                LossKind.INFERRED,
                "widened-hostnames",
                f"The rules of {service_name!r} declare different hostnames; one "
                "HTTPRoute carries one set, so every rule now matches their union "
                f"({', '.join(hostnames)}).",
                service_name,
            )
        return tuple(hostnames)

    def _parent_refs_for(
        self, service_name: str, routes: Sequence[GatewayRoute]
    ) -> Tuple[Dict[str, Any], ...]:
        """Return the ``parentRefs`` one resource declares.

        Recovered from the routes' ``parent_refs`` extras when the model records
        them, and from the emit option otherwise. Routes of one resource that
        disagree are reported: the resource can carry only one set.
        """
        declared: List[Tuple[Dict[str, Any], ...]] = []
        for route in routes:
            refs = route.extras.get("parent_refs")
            if isinstance(refs, (list, tuple)) and refs:
                entry = tuple(dict(ref) for ref in refs if isinstance(ref, Mapping))
                if entry and entry not in declared:
                    declared.append(entry)
        if not declared:
            return self._option_parents
        if len(declared) > 1:
            self.losses.record(
                LossKind.INFERRED,
                "merged-parent-refs",
                f"The rules of {service_name!r} declare different parentRefs; one "
                "HTTPRoute carries one set, so the first was emitted.",
                service_name,
            )
        return declared[0]

    def _backend_refs_for(self, route: GatewayRoute) -> Tuple[Dict[str, Any], ...]:
        """Return the ``backendRefs`` one rule forwards to.

        Recovered from the backends the model records, from the emit option when it
        records none, and synthesized from the canonical service name as a last
        resort — a rule with no backend returns 500, so a reported guess beats a
        silent hole.
        """
        if route.backends:
            return tuple(
                {
                    key: value
                    for key, value in (
                        ("name", _object_name(backend.name, fallback=_FALLBACK_BACKEND)),
                        ("namespace", backend.namespace),
                        ("port", backend.port),
                        ("weight", backend.weight),
                    )
                    if value is not None
                }
                for backend in route.backends
            )
        if self._option_backends:
            return self._option_backends

        source = route.service_name or route.name
        # A synthesized reference names a Kubernetes Service, whose names are
        # lower-case; a *declared* one is copied verbatim, case included.
        name = _object_name(source.lower(), fallback=_FALLBACK_BACKEND)
        self.losses.record(
            LossKind.INFERRED,
            "synthesized-backend-ref",
            f"Route {route.name!r} records no backend; emitted a backendRef named "
            f"{name!r} after its canonical service — verify it names a real Service "
            "before applying.",
            route.name,
        )
        return ({"name": name},)

    # --- fidelity -----------------------------------------------------------

    def _record_route_losses(self, route: GatewayRoute) -> None:
        """Report, once per route, everything an HTTPRoute rule cannot carry."""
        for plugin in route.plugins:
            self.losses.record(
                LossKind.NA,
                "filter-configuration",
                f"Filter {plugin.name!r} on route {route.name!r} is not emitted: the "
                "canonical model records which filters are attached, not how they are "
                "configured, and the Gateway API requires every filter to carry its "
                "configuration block.",
                route.name,
            )
        for hint in route.auth:
            self.losses.record(
                LossKind.NA,
                "unsupported-auth",
                f"Route {route.name!r} is authenticated with {hint.plugin!r}"
                + (f" ({hint.scheme})" if hint.scheme else "")
                + "; the Gateway API core has no authentication filter, so no "
                "equivalent is emitted.",
                route.name,
            )
        for key in sorted(route.extras):
            if key not in ROUTE_EXTRA_KEYS:
                self.losses.record(
                    LossKind.NA,
                    "unmapped-route-attribute",
                    f"Route {route.name!r} carries a {key!r} attribute an HTTPRoute has "
                    "no field for; it is not emitted.",
                    route.name,
                )

    def _record_unrepresentable_constructs(self) -> None:
        """Report the constructs an ``HTTPRoute`` manifest has nowhere to put."""
        if self._api.title or self._api.identity.name:
            self.losses.record(
                LossKind.NA,
                "artifact-title",
                "An HTTPRoute manifest has no field for the artifact title "
                f"({self._document.title!r}); a re-import names the routing surface "
                "after the file it was read from.",
                "",
            )
        for plugin in self._document.global_plugins:
            self.losses.record(
                LossKind.NA,
                "filter-configuration",
                f"Gateway-wide filter {plugin.name!r} is not emitted: an HTTPRoute "
                "carries filters per rule, and the canonical model records neither its "
                "configuration nor the rule it applied to.",
                "",
            )
        for hint in self._document.global_auth:
            self.losses.record(
                LossKind.NA,
                "unsupported-auth",
                f"The gateway authenticates with {hint.plugin!r} for every route; the "
                "Gateway API core has no authentication filter, so no equivalent is "
                "emitted.",
                "",
            )

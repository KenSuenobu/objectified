"""WIT emitter: canonical model → a WebAssembly Component Model package — FMT-2.6 (#5424).

The inverse of the IXH-7.9 WIT import adapter (:mod:`app.wit_parser` /
:mod:`app.wit_normalizer`) and an implementation of the :class:`app.emitter.Emitter`
SPI. It walks any :class:`~app.canonical_model.CanonicalApi` — a WIT package that was
imported earlier, a gRPC service, a GraphQL schema, an Avro record set — and writes a
``.wit`` package a component author can build against.

What is written
---------------

* a ``package ns:name@version;`` declaration, taken from the source's own WIT package
  when it had one and derived from its identity otherwise;
* one ``interface`` per canonical operation group, its functions written as ``func``
  items and its named types written as ``record`` / ``variant`` / ``enum`` /
  ``flags`` / ``type`` declarations, with ``use`` statements wherever an interface
  references a type another interface of the package declares;
* one ``world`` per canonical world (for a model that came from WIT) or one
  synthesized world exporting the generated interfaces (for a model that did not).

A type that belongs to no operation group lands in a shared types interface, so a
schema-only model — an Avro record set, a COBOL copybook — still exports a package
worth building against rather than failing to emit.

Round-tripping
--------------

The importer preserves every WIT construct the canonical model cannot hold in
``extras`` — a resource's constructor and methods, a ``tuple``/``borrow``/nested
``result`` spelling, a multi-parameter function's parameter list, a world's
imports/exports/includes. **This emitter writes those back verbatim**, which is what
makes an imported package re-emit as the package that went in rather than as a
lossy paraphrase of it (the extras ↔ emitter contract every format epic in this repo
follows). A world's inline interface is likewise re-inlined into its world, because
its canonical name (``world.iface``) is not a legal WIT identifier at package level.

The loss ledger
---------------

Everything WIT could not carry is reported through
:class:`app.wit_type_system.WitLossClass` — three classes that mirror, one for one,
the three capability-limit classes the importer records, so the two directions
describe the same ledger. Nothing is dropped silently: an event channel, a server
binding and a security scheme are each reported as having no WIT vocabulary, and a
construct WIT can only approximate says what it approximated.
"""

from __future__ import annotations

import re
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

from pydantic import Field, field_validator

from .canonical_model import (
    ApiParadigm,
    CanonicalApi,
    Channel,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Service,
    StreamingMode,
    Type,
    TypeKind,
)
from .emitter import (
    CapabilityProfile,
    EmitOptions,
    EmitOptionsError,
    EmitResult,
    EmittedFile,
    Emitter,
    LossTracker,
    Provenance,
    ProvenanceTracker,
)
from .fidelity_rulepack import CapabilityRulePack, FidelityVerdict, _has_any_constraint
from .wit_type_system import (
    WitNameAllocator,
    WitTypeRenderer,
    record_wit_loss,
    referenced_identifiers,
    wit_identifier,
)

__all__ = [
    "WIT_FORMAT_KEY",
    "DEFAULT_PACKAGE_NAMESPACE",
    "DEFAULT_TYPES_INTERFACE",
    "OUTPUT_MEDIA_TYPE",
    "WitEmitOptions",
    "WitEmitter",
    "WitFidelityRulePack",
]

#: Registry key of this emitter. It matches the ``wit`` import adapter, so the
#: round-trip matrix joins emit and re-import without an alias.
WIT_FORMAT_KEY = "wit"

#: Namespace used for the package declaration when the model supplies none.
DEFAULT_PACKAGE_NAMESPACE = "apiome"

#: Name of the interface that collects types belonging to no operation group.
DEFAULT_TYPES_INTERFACE = "types"

#: Media type of the emitted ``.wit`` file.
OUTPUT_MEDIA_TYPE = "text/x-wit"

#: Operation kinds a WIT ``func`` cannot describe: they name an event flow rather
#: than a callable, and WIT 0.2 has no channel vocabulary at all.
_EVENT_OPERATION_KINDS = frozenset({OperationKind.PUBLISH, OperationKind.SUBSCRIBE})

#: WIT package declarations are ``ns:name`` where each half is an identifier.
_PACKAGE_RE = re.compile(r"\A[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z][a-z0-9]*(?:-[a-z0-9]+)*\Z")

#: The version grammar the parser accepts after ``@``.
_VERSION_RE = re.compile(r"\A[0-9][0-9a-zA-Z.+-]*\Z")

#: A rendered ``use`` the importer recorded as unresolvable (``path.{a, b}``).
_EXTERNAL_USE_RE = re.compile(r"\A[^\s{}]+\.\{[^{}]*\}\Z")

#: Indent of one nesting level in the emitted document.
_INDENT = "    "


# ===========================================================================
# Options
# ===========================================================================


class WitEmitOptions(EmitOptions):
    """Per-target options for :class:`WitEmitter`.

    The defaults reproduce an imported WIT package as closely as the canonical model
    allows, and give any other source a package with one interface per operation
    group plus a world that exports them.
    """

    package: Optional[str] = Field(
        default=None,
        description="Package declaration to write, as `ns:name` (for example "
        "`wasi:keyvalue`). Defaults to the source's own WIT package when it had one, "
        "and to a name derived from the API's identity otherwise.",
    )
    world: Optional[str] = Field(
        default=None,
        description="Name of the world to synthesize for a source that declares none. "
        "Ignored when the model already carries its own worlds.",
    )
    emit_world: bool = Field(
        default=True,
        description="Synthesize a world exporting the generated interfaces when the "
        "model declares none. Off writes an interface-only package.",
    )
    include_docs: bool = Field(
        default=True,
        description="Write canonical descriptions as `///` doc comments. They are "
        "reported as a loss either way: the WIT parser strips comments, so a "
        "description does not survive a re-import.",
    )
    types_interface: str = Field(
        default=DEFAULT_TYPES_INTERFACE,
        description="Name of the interface that collects named types belonging to no "
        "operation group (a schema-only source puts every type here).",
    )

    @field_validator("package")
    @classmethod
    def _valid_package(cls, value: Optional[str]) -> Optional[str]:
        """Reject a package override the WIT grammar would not accept."""
        if value is None:
            return None
        candidate = value.strip()
        if not candidate:
            return None
        if not _PACKAGE_RE.match(candidate):
            raise ValueError(
                "package must be `ns:name` in lower-kebab-case, for example "
                "`wasi:keyvalue`"
            )
        return candidate

    @field_validator("world")
    @classmethod
    def _valid_world(cls, value: Optional[str]) -> Optional[str]:
        """Normalize a caller-supplied world name; blank means 'derive one'."""
        if value is None or not value.strip():
            return None
        return wit_identifier(value, fallback="world")

    @field_validator("types_interface")
    @classmethod
    def _valid_types_interface(cls, value: str) -> str:
        """Normalize the shared interface's name; blank falls back to the default."""
        return wit_identifier(value, fallback=DEFAULT_TYPES_INTERFACE)


# ===========================================================================
# Plan
# ===========================================================================


@dataclass
class _PlannedInterface:
    """One interface the emitter will write, with everything that belongs in it."""

    #: Canonical grouping key — the service name, or the ``wit_interface`` extras value.
    source_key: str
    #: The WIT identifier allocated for it.
    identifier: str
    #: The service whose operations become this interface's functions, when there is one.
    service: Optional[Service] = None
    #: The named types declared inside it, in canonical order.
    types: List[Type] = field(default_factory=list)
    #: Set when this interface was inlined into a world by the source; the world's
    #: source name and the path/direction it was declared under.
    inline_world: Optional[str] = None
    inline_path: Optional[str] = None
    inline_direction: str = "export"
    #: Rendered ``use`` statements the importer could not resolve, parked here.
    external_uses: List[str] = field(default_factory=list)
    #: Allocator holding every identifier already declared in this interface's scope.
    scope_names: WitNameAllocator = field(default_factory=WitNameAllocator)

    @property
    def is_inline(self) -> bool:
        """Whether this interface is written inside a world rather than at package level."""
        return self.inline_world is not None

    @property
    def use_path(self) -> str:
        """The path another interface refers to this one by in a ``use`` statement."""
        return self.inline_path or self.identifier

    def has_functions(self) -> bool:
        """Whether the interface declares at least one emittable function."""
        if self.service is None:
            return False
        return any(op.kind not in _EVENT_OPERATION_KINDS for op in self.service.operations)


@dataclass
class _PlannedWorld:
    """One world the emitter will write."""

    identifier: str
    service: Optional[Service] = None
    #: Interfaces exported by a *synthesized* world (a world the source did not declare).
    synthesized_exports: List[_PlannedInterface] = field(default_factory=list)
    #: Rendered ``use`` statements the importer could not resolve, parked here when
    #: the package declares no interface to park them on.
    external_uses: List[str] = field(default_factory=list)


class _InterfaceScope:
    """Name bookkeeping for one interface body.

    Types, functions and names imported by ``use`` all share one namespace inside a
    WIT interface, so they share one allocator. An imported name that collides with
    something already declared here is aliased (``use other.{name as other-name}``),
    which is why importing is routed through this object rather than done inline.
    """

    def __init__(self, names: WitNameAllocator) -> None:
        self.names = names
        #: Target interface path → the ``(name, alias)`` pairs imported from it.
        self.imports: "OrderedDict[str, List[Tuple[str, Optional[str]]]]" = OrderedDict()
        self._resolved: Dict[Tuple[str, str], str] = {}

    def import_from(self, path: str, name: str) -> str:
        """Import ``name`` from the interface at ``path`` and return its local spelling."""
        cached = self._resolved.get((path, name))
        if cached is not None:
            return cached
        alias = self.names.allocate(name, fallback="imported-type")
        self._resolved[(path, name)] = alias
        self.imports.setdefault(path, []).append((name, None if alias == name else alias))
        return alias

    def use_lines(self, external: List[str]) -> List[str]:
        """Render this interface's ``use`` statements, resolved ones first."""
        lines = []
        for path, names in self.imports.items():
            rendered = ", ".join(
                name if alias is None else f"{name} as {alias}" for name, alias in names
            )
            lines.append(f"use {path}.{{{rendered}}};")
        lines.extend(f"use {entry};" for entry in external)
        return lines


# ===========================================================================
# Writer
# ===========================================================================


class _WitWriter:
    """Builds one ``.wit`` document from a canonical model, with provenance and losses."""

    def __init__(self, api: CanonicalApi, options: WitEmitOptions) -> None:
        self._api = api
        self._options = options
        self.tracker = ProvenanceTracker()
        self.losses = LossTracker()

        self._report: Dict[str, Any] = self._wit_report()
        self._package_names = WitNameAllocator()
        self._interfaces: "OrderedDict[str, _PlannedInterface]" = OrderedDict()
        self._worlds: List[_PlannedWorld] = []
        self._type_home: Dict[str, _PlannedInterface] = {}
        self._type_name: Dict[str, str] = {}
        self._types_by_name: Dict[str, List[_PlannedInterface]] = {}
        self._renames: "OrderedDict[Tuple[str, str], None]" = OrderedDict()
        self._doc_comment_count = 0

        self.package, self.version = self._plan_package()
        self._plan_groups()
        self.output_path = f"{self.package.split(':')[-1]}.wit"

    # --- report ------------------------------------------------------------

    def _wit_report(self) -> Dict[str, Any]:
        """Return the importer's ``extras['wit']`` report, or an empty stand-in."""
        report = (self._api.extras or {}).get("wit")
        return report if isinstance(report, dict) else {}

    # --- package -----------------------------------------------------------

    def _plan_package(self) -> Tuple[str, Optional[str]]:
        """Decide the ``ns:name`` and version the package declaration will carry.

        Returns:
            The package name and its version (``None`` when no legal version applies).
        """
        if self._options.package:
            return self._options.package, self._plan_version()

        for candidate in (self._report.get("package"), self._api.identity.namespace):
            if isinstance(candidate, str) and _PACKAGE_RE.match(candidate.strip()):
                return candidate.strip(), self._plan_version()

        namespace = self._api.identity.namespace
        name_source = self._api.identity.name or self._api.title or self._api.format
        namespace_id = (
            wit_identifier(namespace, fallback=DEFAULT_PACKAGE_NAMESPACE)
            if namespace
            else DEFAULT_PACKAGE_NAMESPACE
        )
        name_id = wit_identifier(name_source, fallback="api")
        if namespace_id == name_id:
            # A source whose namespace *is* its name (a protobuf package, say) would
            # otherwise emit `example-catalog-v1:example-catalog-v1`. Its own segments
            # make a better split than repeating the whole thing twice.
            head, _, tail = namespace_id.partition("-")
            namespace_id, name_id = (
                (wit_identifier(head), wit_identifier(tail))
                if tail
                else (DEFAULT_PACKAGE_NAMESPACE, name_id)
            )
        package = f"{namespace_id}:{name_id}"
        record_wit_loss(
            self.losses,
            "synthesized-package-name",
            f"The model declares no WIT package; {package!r} was derived from its "
            "identity, so a consumer that expected a published package name will not "
            "find one.",
            "identity",
        )
        self.tracker.record(
            "package",
            Provenance.INFERRED,
            "derived from the API identity because the model declares no WIT package",
        )
        return package, self._plan_version()

    def _plan_version(self) -> Optional[str]:
        """Return the package version to write, normalizing or dropping an illegal one."""
        raw = self._report.get("version") or self._api.version
        if not isinstance(raw, str) or not raw.strip():
            return None
        candidate = raw.strip()
        if _VERSION_RE.match(candidate):
            return candidate
        stripped = candidate[1:] if candidate[:1].lower() == "v" else candidate
        if _VERSION_RE.match(stripped):
            self.tracker.record(
                "package/version",
                Provenance.INFERRED,
                f"normalized {candidate!r} onto the WIT version grammar",
            )
            return stripped
        record_wit_loss(
            self.losses,
            "unsupported-version-literal",
            f"Version {candidate!r} is not a WIT version literal (it must start with a "
            "digit); the package is written without a version.",
            "version",
        )
        return None

    # --- grouping ----------------------------------------------------------

    def _plan_groups(self) -> None:
        """Assign every service and type to an interface or a world."""
        world_names = {
            service.name
            for service in self._api.services
            if service.extras.get("wit_kind") == "world"
        }

        for service in self._api.services:
            if service.extras.get("wit_kind") == "world":
                self._worlds.append(
                    _PlannedWorld(
                        identifier=self._package_names.allocate(service.name, fallback="world"),
                        service=service,
                    )
                )
                continue
            self._interface_for(service.name, service=service, world_names=world_names)

        homeless = False
        for type_ in self._api.types:
            home = type_.extras.get("wit_interface")
            if isinstance(home, str) and home:
                source_key = home
            else:
                source_key = self._options.types_interface
                homeless = True
            planned = self._interface_for(source_key, world_names=world_names)
            planned.types.append(type_)
        self._report_shared_types_interface(homeless)

        for planned in self._interfaces.values():
            names = WitNameAllocator()
            for type_ in planned.types:
                self._type_home[type_.key] = planned
                identifier = names.allocate(type_.name, fallback="type")
                self._type_name[type_.key] = identifier
                self._types_by_name.setdefault(identifier, []).append(planned)
            planned.scope_names = names

        self._park_external_uses()
        self._plan_synthesized_world()

    def _report_shared_types_interface(self, homeless: bool) -> None:
        """Report the shared types interface when the emitter had to invent it.

        WIT has no free-standing type declarations: every type lives inside an
        interface. A source that groups its types some other way (or not at all)
        therefore gets one this emitter chose, which is a grouping the source never
        stated.
        """
        if not homeless:
            return
        shared = self._interfaces.get(self._options.types_interface)
        if shared is None or shared.service is not None:
            return
        record_wit_loss(
            self.losses,
            "synthesized-interface",
            f"WIT declares types only inside an interface; the {len(shared.types)} "
            f"type(s) belonging to no operation group were collected into interface "
            f"{shared.identifier!r}, a grouping the model does not state.",
            "types",
        )

    def _interface_for(
        self,
        source_key: str,
        *,
        service: Optional[Service] = None,
        world_names: Optional[set] = None,
    ) -> _PlannedInterface:
        """Return the planned interface for ``source_key``, creating it on first use.

        Args:
            source_key: The canonical grouping name (a service name, or the
                ``wit_interface`` extras value a type carries).
            service: The service whose operations belong to it, when known.
            world_names: Names of the model's worlds, used to recognize an interface
                the source declared inline inside one.

        Returns:
            The planned interface, with ``service`` attached when one was supplied.
        """
        existing = self._interfaces.get(source_key)
        if existing is not None:
            if service is not None and existing.service is None:
                existing.service = service
            return existing

        inline_world, inline_path, inline_direction = self._inline_origin(
            source_key, world_names or set()
        )
        planned = _PlannedInterface(
            source_key=source_key,
            identifier=(
                wit_identifier(inline_path, fallback="iface")
                if inline_world is not None
                else self._package_names.allocate(source_key, fallback="iface")
            ),
            service=service,
            inline_world=inline_world,
            inline_path=inline_path,
            inline_direction=inline_direction,
        )
        self._interfaces[source_key] = planned
        return planned

    def _inline_origin(
        self, source_key: str, world_names: set
    ) -> Tuple[Optional[str], Optional[str], str]:
        """Recognize ``world.iface`` — an interface the source declared inside a world.

        The importer names such an interface after the world that contains it, and
        that name has a ``.`` in it, which no WIT identifier may. Emitting it at
        package level would therefore not parse; it is re-inlined into its world.

        Args:
            source_key: The canonical grouping name.
            world_names: Names of the model's worlds.

        Returns:
            ``(world name, inline path, direction)``, or ``(None, None, 'export')``
            when the name does not describe a world-inline interface.
        """
        if "." not in source_key:
            return None, None, "export"
        world_name, _, path = source_key.partition(".")
        if world_name not in world_names or not path:
            return None, None, "export"
        for service in self._api.services:
            if service.name != world_name:
                continue
            for direction, key in (("import", "wit_imports"), ("export", "wit_exports")):
                listed = service.extras.get(key)
                if isinstance(listed, list) and path in listed:
                    return world_name, path, direction
        return None, None, "export"

    def _park_external_uses(self) -> None:
        """Attach the importer's unresolvable ``use`` statements to the first block.

        The report records them for the document, not per interface, so there is no
        interface to give them back to. Writing them on the first block keeps the
        declaration in the emitted package (and keeps the re-import's report equal to
        this one) without inventing a home for names that resolve nowhere anyway.
        """
        external = [
            entry
            for entry in (self._report.get("external_uses") or [])
            if isinstance(entry, str) and _EXTERNAL_USE_RE.match(entry.strip())
        ]
        if not external:
            return
        host = next(
            (planned for planned in self._interfaces.values() if not planned.is_inline),
            None,
        ) or (self._worlds[0] if self._worlds else None)
        if host is None:
            return
        host.external_uses.extend(entry.strip() for entry in external)

    def _plan_synthesized_world(self) -> None:
        """Add a world exporting the generated interfaces, when the source had none."""
        if self._worlds or not self._options.emit_world:
            return
        exports = [
            planned
            for planned in self._interfaces.values()
            if not planned.is_inline and planned.has_functions()
        ]
        if not exports:
            return
        # A package whose only interface is named after the package would otherwise
        # give the world a counted suffix (`task-api-2`); `task-api-world` says what
        # the second declaration is instead of merely that it is the second.
        preferred = self._options.world or self.package.split(":")[-1]
        taken = self._package_names.taken()
        candidates = [preferred, f"{wit_identifier(preferred)}-world", "world"]
        chosen = next(
            (name for name in candidates if wit_identifier(name) not in taken), preferred
        )
        identifier = self._package_names.allocate(chosen, fallback="world")
        self._worlds.append(
            _PlannedWorld(identifier=identifier, synthesized_exports=exports)
        )
        record_wit_loss(
            self.losses,
            "synthesized-world",
            f"The model declares no world; world {identifier!r} was synthesized to "
            f"export the {len(exports)} generated interface(s), so the export surface "
            "is this emitter's choice rather than the source's.",
            "world",
        )
        self.tracker.record(
            f"world/{identifier}",
            Provenance.INFERRED,
            "synthesized to give the package an export surface",
        )

    # --- rendering ---------------------------------------------------------

    def render(self) -> str:
        """Render the planned package as WIT text.

        Returns:
            The document text, ending in a newline.

        Raises:
            ValueError: When the model yields neither an interface nor a world, which
                is not a WIT package the importer would accept back.
        """
        if not self._interfaces and not self._worlds:
            raise ValueError(
                "WIT export requires at least one interface or world: a WIT package "
                "describes named types and callables, and this model declares no "
                "service and no named type."
            )

        lines: List[str] = [self._package_line(), ""]
        for planned in self._interfaces.values():
            if planned.is_inline:
                continue
            lines.extend(self._render_interface(planned, indent=""))
            lines.append("")
        for world in self._worlds:
            lines.extend(self._render_world(world))
            lines.append("")

        self._record_document_losses()
        return "\n".join(lines).rstrip() + "\n"

    def _package_line(self) -> str:
        """Render the ``package`` declaration."""
        suffix = f"@{self.version}" if self.version else ""
        self.tracker.record(
            "package",
            Provenance.SOURCE if self._report.get("package") else Provenance.INFERRED,
        )
        return f"package {self.package}{suffix};"

    # --- interfaces --------------------------------------------------------

    def _render_interface(self, planned: _PlannedInterface, *, indent: str) -> List[str]:
        """Render one interface block (at package level or inlined in a world)."""
        names = planned.scope_names
        scope = _InterfaceScope(names)
        operations = self._emittable_operations(planned)
        function_names = {
            operation.key: names.allocate(operation.name, fallback="call")
            for operation in operations
        }
        renderer = WitTypeRenderer(
            resolve=self._resolver_for(planned, scope),
            losses=self.losses,
            link=self._linker(scope, self._declared_names(planned), owner=planned),
        )

        body: List[str] = []
        for type_ in planned.types:
            body.extend(self._render_type(type_, planned, renderer))
        for operation in operations:
            body.extend(
                self._render_function(operation, function_names[operation.key], renderer)
            )

        header = self._doc_lines(planned.service.description if planned.service else None)
        opening = (
            f"{planned.inline_direction} {planned.use_path}: interface {{"
            if planned.is_inline
            else f"interface {planned.identifier} {{"
        )
        uses = scope.use_lines(planned.external_uses)
        inner = uses + ([""] if uses and body else []) + body
        if planned.service is not None:
            self.tracker.record(planned.service.key, Provenance.SOURCE)
        return [
            *(f"{indent}{line}" for line in header),
            f"{indent}{opening}",
            *(f"{indent}{_INDENT}{line}" if line else "" for line in inner),
            f"{indent}}}",
        ]

    def _resolver_for(self, planned: _PlannedInterface, scope: _InterfaceScope):
        """Build the type-key resolver a renderer uses inside ``planned``."""

        def resolve(key: str) -> Optional[str]:
            home = self._type_home.get(key)
            if home is None:
                return None
            local = self._type_name[key]
            if home is planned:
                return local
            return scope.import_from(home.use_path, local)

        return resolve

    def _declared_names(self, planned: _PlannedInterface) -> set:
        """Return the type identifiers ``planned`` declares itself."""
        return {self._type_name[type_.key] for type_ in planned.types}

    def _linker(
        self,
        scope: _InterfaceScope,
        declared: set,
        *,
        owner: Optional[_PlannedInterface] = None,
    ):
        """Build the callback that resolves the names inside verbatim WIT text.

        A construct written back verbatim from ``extras`` — a resource's methods, a
        multi-parameter function's parameter list, a ``tuple``/``result`` spelling —
        is already WIT text, so its named types were never resolved through the type
        renderer and no ``use`` statement was registered for them. This walks the
        text instead: a name another interface of the package declares becomes a
        ``use``, and a name nothing declares is reported rather than emitted as if it
        resolved.

        Args:
            scope: The scope collecting this block's ``use`` statements.
            declared: Type identifiers the block declares itself.
            owner: The interface being written, when the block is an interface.

        Returns:
            A ``(expression, pointer) -> None`` callback.
        """
        reported: set = set()

        def link(expression: str, pointer: Optional[str] = None) -> None:
            for identifier in referenced_identifiers(expression):
                if identifier in declared:
                    continue
                homes = [
                    home
                    for home in self._types_by_name.get(identifier, [])
                    if home is not owner
                ]
                if not homes:
                    if identifier not in reported:
                        reported.add(identifier)
                        record_wit_loss(
                            self.losses,
                            "unresolved-type-reference",
                            f"The preserved WIT expression {expression!r} names "
                            f"{identifier!r}, which this package declares nowhere — "
                            "the canonical model kept the spelling but not what it "
                            "resolved to, so the reference is written unresolved.",
                            pointer,
                        )
                    continue
                alias = scope.import_from(homes[0].use_path, identifier)
                if alias != identifier and identifier not in reported:
                    reported.add(identifier)
                    record_wit_loss(
                        self.losses,
                        "unresolved-type-reference",
                        f"The preserved WIT expression {expression!r} names "
                        f"{identifier!r}, which is already taken in this scope; the "
                        "import had to be aliased and the expression no longer "
                        "resolves.",
                        pointer,
                    )

        return link

    def _emittable_operations(self, planned: _PlannedInterface) -> List[Operation]:
        """Return the operations of ``planned`` that become ``func`` items."""
        if planned.service is None:
            return []
        emittable: List[Operation] = []
        for operation in planned.service.operations:
            if operation.kind in _EVENT_OPERATION_KINDS:
                record_wit_loss(
                    self.losses,
                    "event-operation",
                    f"WIT describes callables, not event flows; the "
                    f"{operation.kind.value} operation {operation.key!r} has no "
                    "representation and is not written.",
                    operation.key,
                )
                continue
            emittable.append(operation)
        return emittable

    # --- types -------------------------------------------------------------

    def _render_type(
        self, type_: Type, planned: _PlannedInterface, renderer: WitTypeRenderer
    ) -> List[str]:
        """Render one named type as its WIT declaration."""
        name = self._type_name[type_.key]
        self._note_rename(type_.name, name, type_.key)
        self._note_type_metadata(type_)
        kind = type_.extras.get("wit_kind")
        lines = self._doc_lines(type_.description, deprecated=type_.deprecated)
        self.tracker.record(type_.key, Provenance.SOURCE)

        if kind == "resource" or (kind is None and self._looks_like_resource(type_)):
            return lines + self._render_resource(type_, name, renderer)
        if kind == "flags":
            return lines + self._render_flags(type_, name)
        if type_.kind is TypeKind.ENUM:
            return lines + self._render_enum(type_, name)
        if type_.kind is TypeKind.UNION:
            return lines + self._render_variant(type_, name, renderer)
        if type_.kind is TypeKind.MAP:
            return lines + self._render_map(type_, name, renderer)
        if type_.kind is TypeKind.ALIAS:
            target = renderer.render(type_.aliased, pointer=type_.key)
            return lines + [f"type {name} = {target};"]
        if type_.kind is TypeKind.SCALAR:
            target = renderer.render_name(type_.name, type_.key)
            if target == name:
                # A scalar whose only definition is its own name has nothing behind
                # it; WIT needs a concrete right-hand side.
                target = renderer.render(None, pointer=type_.key)
            return lines + [f"type {name} = {target};"]
        return lines + self._render_record(type_, name, renderer)

    @staticmethod
    def _looks_like_resource(type_: Type) -> bool:
        """Whether a record carries a resource's constructor/methods in its extras."""
        return bool(type_.extras.get("wit_constructor") or type_.extras.get("wit_methods"))

    def _render_record(
        self, type_: Type, name: str, renderer: WitTypeRenderer
    ) -> List[str]:
        """Render a canonical RECORD as a WIT ``record``."""
        if not type_.fields:
            return [f"record {name} {{}}"]
        names = WitNameAllocator()
        rendered: List[str] = []
        for member in type_.fields:
            member_name = names.allocate(member.name, fallback="field")
            self._note_rename(member.name, member_name, member.key)
            expression = renderer.render(member.type, pointer=member.key)
            rendered.append(f"{_INDENT}{member_name}: {expression},")
            self.tracker.record(member.key, Provenance.SOURCE)
        return [f"record {name} {{", *rendered, "}"]

    def _render_enum(self, type_: Type, name: str) -> List[str]:
        """Render a canonical ENUM as a WIT ``enum``."""
        if not type_.enum_values:
            return [f"enum {name} {{}}"]
        names = WitNameAllocator()
        cases = []
        for value in type_.enum_values:
            case = names.allocate(value.name, fallback="case")
            self._note_rename(value.name, case, value.key)
            cases.append(f"{_INDENT}{case},")
            if value.value is not None and str(value.value) != value.name:
                record_wit_loss(
                    self.losses,
                    "default-value",
                    f"Enum member {value.key!r} declares the wire value "
                    f"{value.value!r}; a WIT enum case has no wire value, so only the "
                    "name is written.",
                    value.key,
                )
        return [f"enum {name} {{", *cases, "}"]

    def _render_flags(self, type_: Type, name: str) -> List[str]:
        """Render a type the source declared as WIT ``flags`` (a bitset)."""
        if not type_.enum_values:
            return [f"flags {name} {{}}"]
        names = WitNameAllocator()
        members = []
        for value in type_.enum_values:
            member = names.allocate(value.name, fallback="flag")
            self._note_rename(value.name, member, value.key)
            members.append(f"{_INDENT}{member},")
        return [f"flags {name} {{", *members, "}"]

    def _render_variant(
        self, type_: Type, name: str, renderer: WitTypeRenderer
    ) -> List[str]:
        """Render a canonical UNION as a WIT ``variant``.

        A source that came from WIT carries its cases (name plus optional payload
        spelling) in ``extras['wit_cases']`` and is written back exactly. Any other
        union carries only its member type keys, so the case names are derived from
        those members — reported, because WIT requires named cases and the canonical
        model has none to give.
        """
        cases = type_.extras.get("wit_cases")
        names = WitNameAllocator()
        rendered: List[str] = []
        if isinstance(cases, list) and cases:
            for case in cases:
                if not isinstance(case, dict) or not case.get("name"):
                    continue
                case_name = names.allocate(str(case["name"]), fallback="case")
                payload = case.get("payload")
                if isinstance(payload, str) and payload.strip():
                    rendered.append(f"{_INDENT}{case_name}({renderer.link(payload, type_.key)}),")
                else:
                    rendered.append(f"{_INDENT}{case_name},")
        else:
            for member in type_.union_members:
                member_type = self._api.type_by_key(member)
                label = member_type.name if member_type is not None else member
                case_name = names.allocate(label, fallback="case")
                payload = renderer.render_name(member, type_.key)
                rendered.append(f"{_INDENT}{case_name}({payload}),")
            if type_.union_members:
                record_wit_loss(
                    self.losses,
                    "undiscriminated-union",
                    f"Union {type_.key!r} lists member types but no case names; WIT "
                    "requires a named case per alternative, so the names were derived "
                    "from the member types and are not the source's.",
                    type_.key,
                )
        if not rendered:
            return [f"variant {name} {{}}"]
        return [f"variant {name} {{", *rendered, "}"]

    def _render_map(self, type_: Type, name: str, renderer: WitTypeRenderer) -> List[str]:
        """Render a canonical MAP as WIT's idiomatic association list."""
        key_expr = renderer.render(type_.key_type, pointer=type_.key)
        value_expr = renderer.render(type_.value_type, pointer=type_.key)
        record_wit_loss(
            self.losses,
            "open-ended-map",
            f"WIT has no map type; {type_.key!r} is written as "
            f"`list<tuple<{key_expr}, {value_expr}>>`, which carries the entries but "
            "not the uniqueness of their keys.",
            type_.key,
        )
        return [f"type {name} = list<tuple<{key_expr}, {value_expr}>>;"]

    def _render_resource(
        self, type_: Type, name: str, renderer: WitTypeRenderer
    ) -> List[str]:
        """Re-emit a WIT ``resource`` from the constructor/methods the importer parked.

        The canonical model cannot express resource-scoped methods, which is why the
        importer preserved them verbatim in ``extras``; writing them back from there
        is exact, and is what makes a resource-bearing package round-trip.
        """
        constructor = type_.extras.get("wit_constructor")
        methods = type_.extras.get("wit_methods")
        link = lambda expression: renderer.link(expression, type_.key)  # noqa: E731
        statements: List[str] = []
        if isinstance(constructor, dict):
            params = _render_extras_params(constructor.get("params"), link)
            statements.append(f"{_INDENT}constructor({params});")
        if isinstance(methods, list):
            for method in methods:
                if not isinstance(method, dict) or not method.get("name"):
                    continue
                statements.append(f"{_INDENT}{_render_extras_function(method, link)};")
        if not statements:
            return [f"resource {name};"]
        record_wit_loss(
            self.losses,
            "resource-methods",
            f"Resource {type_.key!r} carries {len(statements)} constructor/method(s) "
            "that the canonical model cannot hold as operations; they are written back "
            "from the import's preserved extras rather than rebuilt from the model.",
            type_.key,
        )
        return [f"resource {name} {{", *statements, "}"]

    def _note_type_metadata(self, type_: Type) -> None:
        """Report the per-type metadata WIT declarations cannot carry."""
        constrained = [
            member.key
            for member in type_.fields
            if member.constraints is not None and _has_any_constraint(member.constraints)
        ]
        if type_.constraints is not None and _has_any_constraint(type_.constraints):
            constrained.append(type_.key)
        if constrained:
            record_wit_loss(
                self.losses,
                "validation-constraints",
                f"WIT declarations carry no validation facets; {len(constrained)} "
                f"constrained member(s) of {type_.key!r} are written as their type "
                "alone.",
                type_.key,
            )
        numbered = [member.key for member in type_.fields if member.field_number is not None]
        if numbered:
            record_wit_loss(
                self.losses,
                "field-identity",
                f"A WIT record field has no wire number; the {len(numbered)} numbered "
                f"field(s) of {type_.key!r} keep their names but lose their identity.",
                type_.key,
            )
        defaulted = [member.key for member in type_.fields if member.default is not None]
        if defaulted:
            record_wit_loss(
                self.losses,
                "default-value",
                f"A WIT record field has no default; the {len(defaulted)} defaulted "
                f"field(s) of {type_.key!r} are written without one.",
                type_.key,
            )

    # --- functions ---------------------------------------------------------

    def _render_function(
        self, operation: Operation, name: str, renderer: WitTypeRenderer
    ) -> List[str]:
        """Render one operation as a WIT ``func`` item."""
        self._note_rename(operation.name, name, operation.key)
        self._note_operation_metadata(operation)
        params = self._render_params(operation, renderer)
        result = self._render_result(operation, renderer)
        keyword = "async func" if operation.extras.get("wit_async") is True else "func"
        signature = f"{name}: {keyword}({params})"
        if result:
            signature = f"{signature} -> {result}"
        self.tracker.record(operation.key, Provenance.SOURCE)
        return self._doc_lines(operation.description, deprecated=operation.deprecated) + [
            f"{signature};"
        ]

    def _render_params(self, operation: Operation, renderer: WitTypeRenderer) -> str:
        """Render an operation's parameter list.

        A WIT function takes named parameters, so a multi-parameter source keeps its
        list exactly (the importer preserved it in ``extras['wit_params']``), a REST
        operation's path/query/header parameters become parameters in declaration
        order, and a single request payload becomes one parameter.
        """
        names = WitNameAllocator()
        parts: List[str] = []
        request = _message(operation, MessageRole.REQUEST)

        preserved = request.extras.get("wit_params") if request is not None else None
        if isinstance(preserved, list) and preserved:
            for entry in preserved:
                if not isinstance(entry, dict) or not entry.get("name"):
                    continue
                param_name = names.allocate(str(entry["name"]), fallback="arg")
                expression = str(entry.get("type") or "").strip()
                if not expression:
                    expression = renderer.render(None, pointer=operation.key)
                parts.append(f"{param_name}: {renderer.link(expression, operation.key)}")
            return ", ".join(parts)

        for parameter in operation.parameters:
            param_name = names.allocate(parameter.name, fallback="arg")
            expression = renderer.render(parameter.type, pointer=parameter.key)
            parts.append(f"{param_name}: {expression}")

        if request is not None:
            expression = self._message_type(request, renderer, operation)
            if expression is not None:
                default_name = request.extras.get("wit_param_name") or request.name or "arg"
                param_name = names.allocate(str(default_name), fallback="arg")
                if operation.streaming in (
                    StreamingMode.CLIENT,
                    StreamingMode.BIDIRECTIONAL,
                ):
                    expression = f"stream<{expression}>"
                parts.append(f"{param_name}: {expression}")
        return ", ".join(parts)

    def _render_result(self, operation: Operation, renderer: WitTypeRenderer) -> str:
        """Render an operation's result clause (empty when it returns nothing).

        A response plus a declared error is exactly WIT's ``result<ok, err>`` — the
        one place the two models line up — and an error alone is ``result<_, err>``.
        """
        responses = [m for m in operation.messages if m.role is MessageRole.RESPONSE]
        errors = [m for m in operation.messages if m.role is MessageRole.ERROR]
        if operation.kind is OperationKind.ONE_WAY:
            responses, errors = [], []

        primary = _primary_response(responses)
        extra = [m for m in responses if m is not primary] + errors[1:]
        if extra:
            record_wit_loss(
                self.losses,
                "additional-response",
                f"A WIT function returns one value; {len(extra)} additional "
                f"response/error message(s) of {operation.key!r} are not written.",
                operation.key,
            )

        ok: Optional[str] = None
        if primary is not None:
            preserved = primary.extras.get("wit_results")
            if isinstance(preserved, list) and preserved:
                rendered = ", ".join(
                    f"{entry['name']}: "
                    f"{renderer.link(str(entry.get('type') or 'string'), operation.key)}"
                    for entry in preserved
                    if isinstance(entry, dict) and entry.get("name")
                )
                return f"({rendered})" if rendered else ""
            ok = self._message_type(primary, renderer, operation)
            if ok is not None and operation.streaming in (
                StreamingMode.SERVER,
                StreamingMode.BIDIRECTIONAL,
            ):
                ok = f"stream<{ok}>"

        err = self._message_type(errors[0], renderer, operation) if errors else None
        if err is not None:
            return f"result<{ok or '_'}, {err}>"
        return ok or ""

    def _message_type(
        self, message: Message, renderer: WitTypeRenderer, operation: Operation
    ) -> Optional[str]:
        """Return the WIT type expression for one message's payload, or ``None``."""
        if message.payload is not None:
            return renderer.render(message.payload, pointer=message.key)
        if message.payload_schema:
            record_wit_loss(
                self.losses,
                "inline-payload-schema",
                f"Message {message.key!r} defines its payload inline; WIT has no "
                "anonymous structural type, so the payload is written as its "
                "serialized text.",
                operation.key,
            )
            return "string"
        return None

    def _note_operation_metadata(self, operation: Operation) -> None:
        """Report the per-operation metadata a WIT ``func`` cannot carry."""
        if operation.http_method or operation.http_path:
            binding = " ".join(
                part for part in (operation.http_method, operation.http_path) if part
            )
            record_wit_loss(
                self.losses,
                "http-binding",
                f"WIT has no transport binding; the {binding} binding of "
                f"{operation.key!r} is not written.",
                operation.key,
            )
        if operation.streaming is not StreamingMode.NONE:
            record_wit_loss(
                self.losses,
                "streaming-operation",
                f"Operation {operation.key!r} is {operation.streaming.value}-streaming; "
                "WIT states that as a `stream<…>` payload, which carries the element "
                "type but not the streaming cardinality.",
                operation.key,
            )
        constrained = [
            parameter.key
            for parameter in operation.parameters
            if parameter.constraints is not None and _has_any_constraint(parameter.constraints)
        ]
        if constrained:
            record_wit_loss(
                self.losses,
                "validation-constraints",
                f"WIT parameters carry no validation facets; {len(constrained)} "
                f"constrained parameter(s) of {operation.key!r} are written as their "
                "type alone.",
                operation.key,
            )

    # --- worlds ------------------------------------------------------------

    def _render_world(self, world: _PlannedWorld) -> List[str]:
        """Render one world block.

        A world has its own scope: it can ``use`` names from the package's interfaces
        for the functions it imports/exports directly, so it gets the same
        scope/allocator machinery an interface body gets.
        """
        service = world.service
        names = WitNameAllocator()
        scope = _InterfaceScope(names)
        body: List[str] = []
        if service is None:
            body.extend(
                f"export {planned.identifier};" for planned in world.synthesized_exports
            )
        else:
            body.extend(self._render_declared_world_body(service, scope, names))
            self.tracker.record(service.key, Provenance.SOURCE)
        uses = scope.use_lines(world.external_uses)
        inner = uses + ([""] if uses and body else []) + body
        description = service.description if service is not None else None
        return [
            *self._doc_lines(description),
            f"world {world.identifier} {{",
            *(f"{_INDENT}{line}" if line else "" for line in inner),
            "}",
        ]

    def _render_declared_world_body(
        self, service: Service, scope: _InterfaceScope, names: WitNameAllocator
    ) -> List[str]:
        """Render the body of a world the source declared.

        Args:
            service: The canonical service carrying the world's extras.
            scope: The world's scope, collecting the ``use`` statements it needs.
            names: The world's identifier allocator.

        Returns:
            The world's body lines, without its ``use`` statements (the caller
            prepends those once rendering has registered them all).
        """
        body: List[str] = []
        for include in service.extras.get("wit_includes") or []:
            body.append(f"include {include};")
        for direction, key in (("import", "wit_imports"), ("export", "wit_exports")):
            for path in service.extras.get(key) or []:
                inline = self._interfaces.get(f"{service.name}.{path}")
                if inline is not None and inline.is_inline:
                    body.extend(self._render_interface(inline, indent=""))
                    continue
                body.append(f"{direction} {path};")

        renderer = WitTypeRenderer(
            resolve=self._world_resolver(scope),
            losses=self.losses,
            link=self._linker(scope, set()),
        )
        for operation in service.operations:
            if operation.kind in _EVENT_OPERATION_KINDS:
                record_wit_loss(
                    self.losses,
                    "event-operation",
                    f"WIT describes callables, not event flows; the "
                    f"{operation.kind.value} operation {operation.key!r} has no "
                    "representation and is not written.",
                    operation.key,
                )
                continue
            direction = operation.extras.get("wit_direction") or "export"
            name = names.allocate(operation.name, fallback="call")
            rendered = self._render_function(operation, name, renderer)
            body.extend(rendered[:-1])
            body.append(f"{direction} {rendered[-1]}")
        return body

    def _world_resolver(self, scope: _InterfaceScope):
        """Build the type resolver used inside a world body.

        A world declares no types of its own, so every named type it mentions is
        imported from the interface that declares it.
        """

        def resolve(key: str) -> Optional[str]:
            home = self._type_home.get(key)
            if home is None:
                return None
            return scope.import_from(home.use_path, self._type_name[key])

        return resolve

    # --- shared ------------------------------------------------------------

    def _doc_lines(
        self, description: Optional[str], *, deprecated: bool = False
    ) -> List[str]:
        """Render a description (and a deprecation marker) as ``///`` doc comments."""
        lines: List[str] = []
        if deprecated:
            record_wit_loss(
                self.losses,
                "deprecated-marker",
                "WIT's deprecation gate is a feature annotation the importer strips; "
                "the construct is marked in a doc comment instead, which a re-import "
                "does not recover.",
                None,
            )
            lines.append("/// Deprecated.")
        if description and self._options.include_docs:
            self._doc_comment_count += 1
            lines.extend(f"/// {line}".rstrip() for line in description.strip().splitlines())
        return lines

    def _note_rename(self, source: str, emitted: str, pointer: Optional[str]) -> None:
        """Note a name WIT's identifier grammar could not carry unchanged.

        Renames are collected rather than reported one by one: WIT identifiers are
        lower-kebab-case, so a source with camel-cased names renames *everything*, and
        a row per name would bury the rest of the ledger under noise. They surface as
        one counted entry in :meth:`_record_document_losses`.
        """
        if source != emitted:
            self._renames.setdefault((source, emitted), None)

    def _record_document_losses(self) -> None:
        """Report what the package as a whole cannot carry."""
        for channel in self._api.channels:
            record_wit_loss(
                self.losses,
                "event-channel",
                f"WIT has no channel vocabulary; channel {channel.key!r} and its "
                "bindings are not written.",
                channel.key,
            )
        if self._api.servers:
            record_wit_loss(
                self.losses,
                "server-binding",
                "A WIT package describes an interface, never where it is served; the "
                f"{len(self._api.servers)} declared server(s) are not written.",
                "servers",
            )
        schemes = _declared_security_schemes(self._api)
        if schemes:
            record_wit_loss(
                self.losses,
                "security-scheme",
                "WIT has no security vocabulary; the declared scheme(s) "
                f"{', '.join(repr(name) for name in schemes)} are not written.",
                "security",
            )
        if self._renames:
            samples = ", ".join(
                f"{source!r} → {emitted!r}" for source, emitted in list(self._renames)[:5]
            )
            more = "" if len(self._renames) <= 5 else f" (and {len(self._renames) - 5} more)"
            record_wit_loss(
                self.losses,
                "renamed-identifier",
                f"{len(self._renames)} name(s) are not WIT identifiers — WIT names are "
                f"lower-kebab-case — and were rewritten: {samples}{more}. A consumer "
                "matching on the source spelling will not find them.",
                "identifiers",
            )
        if self._doc_comment_count:
            record_wit_loss(
                self.losses,
                "documentation-comment",
                f"{self._doc_comment_count} description(s) are written as `///` doc "
                "comments; the WIT parser strips comments, so they do not survive a "
                "re-import.",
                "descriptions",
            )


# ===========================================================================
# Module helpers
# ===========================================================================


def _message(operation: Operation, role: MessageRole) -> Optional[Message]:
    """Return the first message of ``operation`` playing ``role``, or ``None``."""
    return next((m for m in operation.messages if m.role is role), None)


def _primary_response(responses: List[Message]) -> Optional[Message]:
    """Pick the response a WIT function's single return value stands for.

    A REST operation declares several; the successful one is what a caller receives,
    so a ``2xx`` wins over anything else and the declaration order breaks a tie.
    """
    if not responses:
        return None
    for message in responses:
        status = (message.status_code or "").strip()
        if status.startswith("2"):
            return message
    return responses[0]


def _render_extras_params(params: Any, link: Callable[[str], str]) -> str:
    """Render a preserved parameter list (``[{'name': …, 'type': …}]``) as WIT text.

    Args:
        params: The preserved list, as the importer stored it.
        link: Normalizes one verbatim type expression and registers what it needs.

    Returns:
        The rendered ``name: type`` list, comma-separated.
    """
    if not isinstance(params, list):
        return ""
    parts = [
        f"{entry['name']}: {link(str(entry.get('type') or 'string'))}"
        for entry in params
        if isinstance(entry, dict) and entry.get("name")
    ]
    return ", ".join(parts)


def _render_extras_function(function: Dict[str, Any], link: Callable[[str], str]) -> str:
    """Render a preserved resource method/static method as its WIT statement.

    Args:
        function: The preserved signature, as the importer stored it.
        link: Normalizes one verbatim type expression and registers what it needs.

    Returns:
        The method statement, without its trailing semicolon.
    """
    keyword = "async func" if function.get("async") else "func"
    if function.get("kind") == "static":
        keyword = f"static {keyword}"
    signature = (
        f"{function['name']}: {keyword}"
        f"({_render_extras_params(function.get('params'), link)})"
    )
    result = function.get("result")
    if isinstance(result, str) and result.strip():
        return f"{signature} -> {link(result)}"
    named = function.get("results")
    if isinstance(named, list) and named:
        rendered = ", ".join(
            f"{entry['name']}: {link(str(entry.get('type') or 'string'))}"
            for entry in named
            if isinstance(entry, dict) and entry.get("name")
        )
        if rendered:
            return f"{signature} -> ({rendered})"
    return signature


def _declared_security_schemes(api: CanonicalApi) -> List[str]:
    """Return the security-scheme names the model declares, from wherever they live.

    The canonical model has no first-class security field: an import records schemes
    on ``api.extras['inferred_auth_schemes']`` or per operation on
    ``extras['security']``. Both are read so the loss names what is dropped.

    Args:
        api: The model being emitted.

    Returns:
        The distinct scheme names, sorted for determinism.
    """
    names: set = set()
    inferred = (api.extras or {}).get("inferred_auth_schemes")
    if isinstance(inferred, list):
        names.update(str(item) for item in inferred if item)
    elif isinstance(inferred, dict):
        names.update(str(key) for key in inferred)
    for service in api.services:
        for operation in service.operations:
            declared = (operation.extras or {}).get("security")
            if isinstance(declared, list):
                names.update(str(item) for item in declared if isinstance(item, str))
            elif isinstance(declared, str):
                names.add(declared)
    return sorted(names)


# ===========================================================================
# Fidelity
# ===========================================================================


class WitFidelityRulePack(CapabilityRulePack):
    """Fidelity rules for WIT export.

    A WIT package is an *interface* description: named types and the functions that
    take and return them. It has no event vocabulary, no transport binding and no
    validation facets, and its ``variant`` carries discriminated alternatives
    faithfully while its ``option<…>`` carries optionality exactly.
    """

    target_label = "WIT"

    def channel_verdict(self, channel: Channel) -> FidelityVerdict:
        """An event channel has no WIT representation; it is dropped."""
        return FidelityVerdict.drop(
            message=(
                f"{self.target_label} has no event/channel vocabulary; "
                f"channel {channel.key!r} is dropped"
            ),
            target_mapping="channel → dropped",
        )

    def operation_verdict(self, operation: Operation) -> FidelityVerdict:
        """Only a callable becomes a ``func``; an event flow is dropped."""
        if operation.kind in _EVENT_OPERATION_KINDS:
            return FidelityVerdict.drop(
                message=(
                    f"{self.target_label} describes callables, not event flows; "
                    f"{operation.kind.value} operation {operation.key!r} is dropped"
                ),
                target_mapping="event operation → dropped",
            )
        if operation.streaming is not StreamingMode.NONE:
            return FidelityVerdict.approx(
                message=(
                    f"{self.target_label} states streaming as a `stream<…>` payload; "
                    f"the {operation.streaming.value}-streaming cardinality of "
                    f"{operation.key!r} is not carried"
                ),
                target_mapping="streaming operation → stream<…> payload",
            )
        if operation.http_method or operation.http_path:
            return FidelityVerdict.approx(
                message=(
                    f"{self.target_label} has no transport binding; the HTTP binding "
                    f"of {operation.key!r} is not carried"
                ),
                target_mapping="HTTP operation → func",
            )
        return FidelityVerdict.ok(message=f"operation carried to {self.target_label}")

    def type_verdict(self, type_: Type) -> FidelityVerdict:
        """A map is approximated; every other named type has a WIT declaration."""
        if type_.kind is TypeKind.MAP:
            return FidelityVerdict.approx(
                message=(
                    f"{self.target_label} has no map type; {type_.key!r} is carried as "
                    "an association list, which does not state key uniqueness"
                ),
                target_mapping="map → list<tuple<k, v>>",
            )
        return super().type_verdict(type_)


# ===========================================================================
# Emitter
# ===========================================================================


class WitEmitter(Emitter, register=True):
    """Emit a :class:`CanonicalApi` as a WebAssembly Component Model ``.wit`` package."""

    key = WIT_FORMAT_KEY
    format = WIT_FORMAT_KEY
    label = "WIT (WebAssembly)"
    description = (
        "Export as a WebAssembly Component Model WIT package: one interface per "
        "operation group with `func` items, `record`/`variant`/`enum`/`flags` "
        "declarations for named types, and a world that exports them."
    )
    icon = "component"
    paradigm = ApiParadigm.RPC
    multi_file = False
    options_model = WitEmitOptions

    @classmethod
    def capability_profile(cls) -> CapabilityProfile:
        """Declare what a WIT package carries faithfully.

        WIT's ``variant`` is a discriminated union and its ``option<…>`` is exact
        optionality, so both survive. What it has no vocabulary for is events, wire
        field numbers, and validation facets — a WIT type states a shape, never a
        range or a pattern.
        """
        return CapabilityProfile(
            operations=True,
            events=False,
            unions=True,
            nullability=True,
            constraints=False,
            field_identity=False,
        )

    @classmethod
    def fidelity_rule_pack(cls) -> type[CapabilityRulePack]:
        """Return the WIT degradation rules."""
        return WitFidelityRulePack

    def emit(
        self,
        api: CanonicalApi,
        *,
        opts: Optional[Union[WitEmitOptions, EmitOptions]] = None,
    ) -> EmitResult:
        """Emit ``api`` as one ``.wit`` package file.

        Args:
            api: The canonical model to export.
            opts: Per-target options; the defaults reproduce an imported WIT package
                and give any other source interfaces plus a synthesized world.

        Returns:
            A single-file :class:`~app.emitter.EmitResult` whose content is the WIT
            document text, with the provenance of every emitted construct and a loss
            for everything WIT could not carry.

        Raises:
            EmitOptionsError: When ``opts`` fails validation.
            ValueError: When the model declares neither a service nor a named type,
                which is not a package the WIT parser would accept back.
        """
        options = _coerce_options(opts)
        writer = _WitWriter(api, options)
        content = writer.render()
        return EmitResult(
            files=[
                EmittedFile(
                    path=writer.output_path,
                    content=content,
                    media_type=OUTPUT_MEDIA_TYPE,
                )
            ],
            media_type=OUTPUT_MEDIA_TYPE,
            provenance=writer.tracker.records(),
            losses=writer.losses.records(),
        )


def _coerce_options(
    opts: Optional[Union[WitEmitOptions, EmitOptions]],
) -> WitEmitOptions:
    """Validate caller-supplied options into a :class:`WitEmitOptions`."""
    if isinstance(opts, WitEmitOptions):
        return opts
    try:
        return WitEmitOptions.model_validate(opts.model_dump() if opts else {})
    except ValueError as exc:
        raise EmitOptionsError(f"Invalid WIT emit options: {exc}") from exc

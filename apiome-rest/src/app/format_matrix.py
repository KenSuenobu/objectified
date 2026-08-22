"""The format matrix — one authoritative, machine-readable answer to "what do you support?"
(FMT-1.5, #5416).

Answering *"what formats do you support, in which directions, at which versions?"* used to mean
reading three registries in Python. Sales decks, the docs page, the portal and every partner
integration each re-derived it, and each derivation was free to be wrong in its own way.

This module builds that answer **once**, from the registries that already know it:

* :func:`app.import_source.describe_import_sources` — every registered import adapter: label,
  paradigm, input kinds, live-discovery capability, declared format keys (the version coverage),
  file extensions (FMT-1.1), remote-``$ref`` support, and runtime availability.
* :func:`app.emitter.available_emit_formats` / :func:`app.emitter.get_emitter` — every registered
  emitter, its descriptor and its :class:`~app.emitter.CapabilityProfile`, so a row can state what
  an export of this format can actually carry.
* :func:`app.format_capability_registry.capability_for` — the reviewed capability entry behind each
  format, so a row carries the registry's own boundary statement rather than a fresh assertion.
* :data:`app.import_routing.PUBLISHABLE_FORMATS` — the server-side routing rule, so "Project or
  catalog item?" is the code's answer and not a restatement of it.
* ``ImportSource.required_tools`` / ``Emitter.required_tools`` — the toolchain gate, so a format
  that this deployment cannot run says so *and names the tool*.

Three consumers read this one builder:

* ``GET /v1/formats/matrix`` (:mod:`app.format_matrix_routes`) serves it verbatim.
* ``apiome formats`` renders that response.
* :mod:`app.supported_formats_doc` (the FMT-1.2 generated page) renders its rows, so the docs page
  and the endpoint **cannot disagree** — there is no second traversal of the registries to drift.

Everything here is **pure and deterministic**: the same registries in, the same payload out. That
is what lets the generated docs page be drift-checked in CI, and what makes the endpoint safe to
cache by :attr:`FormatMatrixResponse.version`.

The row order is ``(label.casefold(), key)`` — the order the docs page has always used — so the
endpoint, the CLI table and the page all list formats identically.
"""

from __future__ import annotations

from enum import Enum
from typing import Dict, List, Optional, Sequence, Tuple

from pydantic import BaseModel, ConfigDict, Field

from .canonical_model import ApiParadigm
from .emitter import (
    CapabilityProfile,
    Emitter,
    EmitterDescriptor,
    available_emit_formats,
    get_emitter,
)
from .format_capability_registry import (
    REGISTRY_VERSION,
    CapabilityProvenance,
    ConversionSupport,
    FormatAvailability,
    NativeHierarchy,
    ProjectionCoverage,
    capability_for,
)
from .format_version_coverage import VersionCoverage
from .import_routing import PUBLISHABLE_FORMATS
from .import_source import (
    ImportSourceDescriptor,
    describe_import_sources,
    get_import_source,
    resolve_import_source_key,
)
from .toolchain_runner import is_tool_available

__all__ = [
    "FORMAT_MATRIX_VERSION",
    "INTERNAL_FORMAT_KEYS",
    "DirectionFilter",
    "FormatCapabilitySummary",
    "FormatDirection",
    "FormatExportSupport",
    "FormatImportSupport",
    "FormatMatrixCounts",
    "FormatMatrixFilters",
    "FormatMatrixResponse",
    "FormatMatrixRow",
    "FormatToolchainGate",
    "build_format_matrix",
    "filter_format_matrix",
    "is_shipped_import_source",
    "shipped_emitter_classes",
    "shipped_emitters",
]

#: Contract version of the matrix payload. Bumped when a field is removed or its meaning changes —
#: never for a new format, which is exactly the kind of change the matrix exists to absorb without
#: a contract break. Callers may cache a response by this value.
FORMAT_MATRIX_VERSION = "1"

#: Registry keys that are internal machinery rather than a format a reader can use. ``sample`` is
#: the no-op acceptance adapter that exercises the job pipeline; publishing it as a supported format
#: would be exactly the kind of over-claim this matrix exists to end. Public because the FMT-1.4
#: corpus parity gate excludes exactly the same keys — a format that is not published is not
#: required to carry fixtures either, and the two must not drift apart.
INTERNAL_FORMAT_KEYS: frozenset[str] = frozenset({"sample"})

#: Module prefix of an adapter/emitter this repository ships.
#:
#: The matrix answers **what Apiome ships**, so it is built from adapters defined under ``app.``
#: rather than from whatever happens to be in the process-wide registry. Two things depend on this:
#: the payload stays a function of the source tree (a registry a caller has added to at runtime
#: cannot silently rewrite the published answer or the committed docs page), and the drift gate
#: stays meaningful under pytest, where sibling test modules register throwaway adapters and do not
#: always remove them.
_SHIPPED_MODULE_PREFIX = "app."


def is_shipped_import_source(key: str) -> bool:
    """Whether ``key`` names an adapter defined in this repository.

    Args:
        key: An import-source registry key.

    Returns:
        ``True`` when an adapter is registered under ``key`` and its class comes from this
        repository rather than from a test module or a caller-supplied plugin.
    """
    adapter = get_import_source(key)
    return adapter is not None and type(adapter).__module__.startswith(_SHIPPED_MODULE_PREFIX)


def shipped_emitter_classes() -> Dict[str, type[Emitter]]:
    """Map each import-source key onto the shipped emitter class that writes that format.

    Iterates the emitter **registry keys** rather than descriptor keys: the two are not always the
    same string (the AsyncAPI emitter registers under ``asyncapi-3`` but describes itself as
    ``asyncapi``), so a lookup by descriptor key silently misses those emitters and a format that
    round-trips would be reported as import-only.

    The descriptor key is then resolved through :func:`~app.import_source.resolve_import_source_key`,
    which already owns the alias table reconciling the two registries (``protobuf`` → ``grpc``),
    rather than a second mapping being invented here that could drift from it.

    Returns:
        ``{import_source_key: emitter_class}``, first match by sorted registry key so the result is
        deterministic.
    """
    mapping: Dict[str, type[Emitter]] = {}
    for format_key in available_emit_formats():
        emitter = get_emitter(format_key)
        if emitter is None or not emitter.__module__.startswith(_SHIPPED_MODULE_PREFIX):
            continue
        descriptor = emitter.descriptor()
        if descriptor.key in INTERNAL_FORMAT_KEYS:
            continue
        mapping.setdefault(resolve_import_source_key(descriptor.key), emitter)
    return mapping


def shipped_emitters() -> Dict[str, EmitterDescriptor]:
    """Map each import-source key onto the shipped emitter descriptor that writes that format.

    The descriptor-only view of :func:`shipped_emitter_classes`, kept because the FMT-1.4 corpus
    parity gate and the FMT-1.2 page generator both consume it.

    Returns:
        ``{import_source_key: emitter_descriptor}``, deterministically ordered.
    """
    return {key: emitter.descriptor() for key, emitter in shipped_emitter_classes().items()}


# ===========================================================================
# Payload models
# ===========================================================================


class FormatDirection(str, Enum):
    """Which way documents of a format can flow through Apiome."""

    #: Apiome can read this format but writes no artifact for it.
    IMPORT_ONLY = "import_only"
    #: Apiome can write this format but has no adapter that reads it.
    EXPORT_ONLY = "export_only"
    #: Apiome both reads and writes this format — it round-trips.
    BOTH = "both"


class DirectionFilter(str, Enum):
    """The ``direction`` query filter: *which capability must a row have?*

    Deliberately a different vocabulary from :class:`FormatDirection`, which states what a format
    **is**. ``import`` here selects every row Apiome can read — including the ones it can also
    write — so the filter reads as a capability question rather than an exact-match on the row's
    own direction.
    """

    #: Every format that can be imported (import-only *and* round-tripping).
    IMPORT = "import"
    #: Every format that can be exported (export-only *and* round-tripping).
    EXPORT = "export"
    #: Only formats that round-trip.
    BOTH = "both"


class FormatImportSupport(BaseModel):
    """What Apiome can do when *reading* documents of one format."""

    model_config = ConfigDict(extra="forbid")

    supported: bool = Field(
        description="Whether any registered adapter reads this format at all.",
    )
    input_kinds: List[str] = Field(
        default_factory=list,
        description="How a document can reach the adapter: uploaded ``file``, ``url``, pasted "
        "``paste``, live ``discovery``, or a multi-file ``fileset`` (an archive or repository).",
    )
    supports_live_discovery: bool = Field(
        default=False,
        description="Whether the adapter can introspect a running endpoint instead of reading a "
        "document.",
    )
    supports_remote_refs: bool = Field(
        default=False,
        description="Whether documents of this format may reference other documents by URL, so an "
        "import can opt into SSRF-guarded remote ``$ref`` resolution.",
    )
    publishable: bool = Field(
        default=False,
        description="Whether importing this format mints a publishable Project (``true``) or a "
        "catalog item (``false``). This is the server's own routing rule, not a restatement of it.",
    )
    available: bool = Field(
        default=False,
        description="Whether the adapter can actually run in **this** deployment. ``false`` with a "
        "reason means a missing toolchain, never an unsupported format.",
    )
    unavailable_reason: Optional[str] = Field(
        default=None,
        description="Why the import adapter cannot run here, or ``null`` when it can.",
    )


class FormatExportSupport(BaseModel):
    """What Apiome can do when *writing* documents of one format."""

    model_config = ConfigDict(extra="forbid")

    supported: bool = Field(
        description="Whether any registered emitter writes this format at all.",
    )
    target_key: Optional[str] = Field(
        default=None,
        description="The emitter's own registry key, which is not always the import-source key "
        "(the AsyncAPI emitter registers under ``asyncapi-3``).",
    )
    label: Optional[str] = Field(
        default=None,
        description="Human label for the export target, or ``null`` when the format is import-only.",
    )
    format: Optional[str] = Field(
        default=None,
        description="The output format key the emitter produces, e.g. ``openapi-3.1``.",
    )
    multi_file: bool = Field(
        default=False,
        description="Whether an export produces a multi-file bundle rather than one artifact.",
    )
    capability_profile: Optional[CapabilityProfile] = Field(
        default=None,
        description="Which canonical constructs this target can carry faithfully — the input to "
        "the fidelity engine's loss prediction. ``null`` when the format is import-only.",
    )
    available: bool = Field(
        default=False,
        description="Whether the emitter can actually run in **this** deployment.",
    )
    unavailable_reason: Optional[str] = Field(
        default=None,
        description="Why the emitter cannot run here, or ``null`` when it can.",
    )


class FormatToolchainGate(BaseModel):
    """The external binaries a format hard-requires, and whether this runtime has them.

    Separates the two facts a single "unsupported" would collapse: *Apiome does not support this*
    and *this deployment is missing a binary*. Only the first is about the product.
    """

    model_config = ConfigDict(extra="forbid")

    required_tools: List[str] = Field(
        default_factory=list,
        description="Every bundled tool key this format needs in either direction, sorted. Empty "
        "for a pure-Python format.",
    )
    import_tools: List[str] = Field(
        default_factory=list,
        description="The tool keys the import adapter hard-requires, sorted.",
    )
    export_tools: List[str] = Field(
        default_factory=list,
        description="The tool keys the emitter hard-requires, sorted.",
    )
    missing_tools: List[str] = Field(
        default_factory=list,
        description="The required tool keys that cannot be resolved in this runtime, sorted.",
    )
    satisfied: bool = Field(
        default=True,
        description="``true`` when every required tool resolves here (always ``true`` for a format "
        "that requires none).",
    )


class FormatCapabilitySummary(BaseModel):
    """The capability registry's boundary statement for one format, in summary form.

    A compact view of :class:`~app.format_capability_registry.FormatCapability` — enough to answer
    "how faithfully is this format understood, and what does it knowingly not model?" without
    fetching the full entry from ``GET /v1/import/format-capabilities/{format_key}``.
    """

    model_config = ConfigDict(extra="forbid")

    provenance: CapabilityProvenance = Field(
        description="Whether this format's entry was hand-reviewed, derived from the adapter's own "
        "declarations, or is a declaration that the format is unknown.",
    )
    availability: FormatAvailability = Field(
        description="Whether the format can be imported and analysed in the current runtime.",
    )
    native_hierarchy: NativeHierarchy = Field(
        description="How much of the format's own structure the analysis tree preserves: a "
        "format-native vocabulary, the format-blind walk, or no tree at all.",
    )
    native_hierarchy_note: str = Field(
        description="One line on what the analysis tree's node vocabulary actually is.",
    )
    projection_coverage: ProjectionCoverage = Field(
        description="How much of what the analyzer observes survives onto the canonical model.",
    )
    conversion: ConversionSupport = Field(
        description="Whether this format participates in the conversion graph.",
    )
    version_coverage: VersionCoverage = Field(
        description="Which versions of this format are read and written, which one an export "
        "produces by default, and where a version is reached through a projection or downgrade "
        "(FMT-3.8). Distinct from the row's own ``version_coverage``, which is the flat list of "
        "*format keys* the adapter declares — that list mixes version keys with detection aliases "
        "and cannot answer \"which versions?\" on its own.",
    )
    unsupported_constructs: List[str] = Field(
        default_factory=list,
        description="Construct keys the analyzer knowingly does not model, sorted — the format's "
        "unsupported grammar. Their absence from an analysis means nothing about the source.",
    )
    notes: List[str] = Field(
        default_factory=list,
        description="Reviewed prose about this format's boundaries, in reading order. Empty on a "
        "derived entry, which states only what the adapter declared and reviews no boundaries.",
    )
    registry_version: str = Field(
        description="The capability-registry contract version this summary was read from.",
    )
    review_date: str = Field(description="When this format's capability claims were last reviewed.")


class FormatMatrixRow(BaseModel):
    """One format's row: everything Apiome knows about supporting it."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(
        description="The stable registry key. This is the ``source_kind`` the REST API and the CLI "
        "take, and the anchor every other surface refers to this format by.",
    )
    label: str = Field(description="Human label for the format.")
    description: str = Field(description="One-line description of what the format is.")
    icon: str = Field(description="Lucide icon name a UI renders for this format's card.")
    paradigm: ApiParadigm = Field(
        description="The canonical paradigm this format belongs to.",
    )
    direction: FormatDirection = Field(
        description="Whether Apiome reads this format, writes it, or both.",
    )
    version_coverage: List[str] = Field(
        default_factory=list,
        description="Every format key the adapter declares — the declared version coverage, e.g. "
        "``openapi-3.0``/``openapi-3.1``/``openapi-3.2``. A specific version can be requested by "
        "any key listed here. Empty for an export-only destination.",
    )
    file_extensions: List[str] = Field(
        default_factory=list,
        description="Lower-case filename extensions documents of this format normally carry, each "
        "with its leading dot and ordered most-canonical first. An **advisory hint, never an "
        "allow-list**: content sniffing (``POST /v1/import/detect``) is the authority on what a "
        "file is, so an unlisted extension is still offered to detection.",
    )
    import_support: FormatImportSupport = Field(
        description="What Apiome can do when reading this format.",
    )
    export_support: FormatExportSupport = Field(
        description="What Apiome can do when writing this format.",
    )
    toolchain: FormatToolchainGate = Field(
        description="The external binaries this format hard-requires, and whether this runtime "
        "has them.",
    )
    capability: FormatCapabilitySummary = Field(
        description="The capability registry's boundary statement for this format.",
    )


class FormatMatrixCounts(BaseModel):
    """Headline counts over the rows in a response.

    Computed from the rows actually returned, so a filtered response counts the filtered set and
    never restates a whole-registry total beside a partial table.
    """

    model_config = ConfigDict(extra="forbid")

    total: int = Field(description="Rows in this response.")
    importable: int = Field(description="Rows Apiome can read.")
    exportable: int = Field(description="Rows Apiome can write.")
    round_trip: int = Field(description="Rows Apiome can both read and write.")
    import_only: int = Field(description="Rows Apiome can read but not write.")
    export_only: int = Field(description="Rows Apiome can write but not read.")
    live_discovery: int = Field(
        description="Rows whose adapter can introspect a live endpoint rather than read a file.",
    )
    publishable: int = Field(
        description="Rows whose import mints a publishable Project rather than a catalog item.",
    )
    toolchain_gated: int = Field(
        description="Rows that hard-require at least one external tool.",
    )
    unavailable_here: int = Field(
        description="Rows whose required toolchain is missing from **this** deployment. Supported "
        "everywhere, runnable only where the tools are installed.",
    )


class FormatMatrixFilters(BaseModel):
    """The filters that produced a response, echoed back so a partial table is never mistaken for
    the whole matrix."""

    model_config = ConfigDict(extra="forbid")

    paradigm: Optional[ApiParadigm] = Field(
        default=None,
        description="The paradigm filter applied, or ``null`` when every paradigm was returned.",
    )
    direction: Optional[DirectionFilter] = Field(
        default=None,
        description="The direction filter applied, or ``null`` when every direction was returned.",
    )


class FormatMatrixResponse(BaseModel):
    """The format matrix: one row per format Apiome reads or writes."""

    model_config = ConfigDict(extra="forbid")

    version: str = Field(
        description="Contract version of this payload (:data:`FORMAT_MATRIX_VERSION`). Bumped only "
        "when a field is removed or changes meaning — never for a new format — so a response is "
        "safe to cache by it.",
    )
    capability_registry_version: str = Field(
        description="The source-format capability registry version the ``capability`` summaries "
        "were read from.",
    )
    filters: FormatMatrixFilters = Field(
        description="The filters applied to this response.",
    )
    counts: FormatMatrixCounts = Field(
        description="Headline counts over the rows in this response.",
    )
    formats: List[FormatMatrixRow] = Field(
        default_factory=list,
        description="One row per format, ordered by label then key — the same order the generated "
        "supported-formats page and the CLI table use.",
    )


# ===========================================================================
# Builder
# ===========================================================================


def _required_tools(owner: object) -> Tuple[str, ...]:
    """Return an adapter's or emitter's declared ``required_tools``, defensively.

    Args:
        owner: An :class:`~app.import_source.ImportSource` instance or
            :class:`~app.emitter.Emitter` class. Both declare ``required_tools`` as a class
            attribute, but a third-party registration may not, so the lookup tolerates its absence
            rather than raising while building a read-only enumeration.

    Returns:
        The declared tool keys, or an empty tuple.
    """
    tools = getattr(owner, "required_tools", ())
    return tuple(str(tool) for tool in tools)


def _toolchain_gate(
    import_tools: Sequence[str],
    export_tools: Sequence[str],
) -> FormatToolchainGate:
    """Build the toolchain gate for one format from its two directions' requirements.

    Args:
        import_tools: Tool keys the import adapter hard-requires.
        export_tools: Tool keys the emitter hard-requires.

    Returns:
        The gate, with ``missing_tools`` probed once per distinct tool key.
    """
    required = sorted(set(import_tools) | set(export_tools))
    missing = [tool for tool in required if not is_tool_available(tool)]
    return FormatToolchainGate(
        required_tools=required,
        import_tools=sorted(set(import_tools)),
        export_tools=sorted(set(export_tools)),
        missing_tools=missing,
        satisfied=not missing,
    )


def _capability_summary(format_key: str) -> FormatCapabilitySummary:
    """Summarize the capability-registry entry for ``format_key``.

    :func:`~app.format_capability_registry.capability_for` always resolves — a reviewed seed, an
    entry derived from the adapter, or an ``unknown_format`` entry that claims nothing — so this
    never has to invent a placeholder.

    Args:
        format_key: The import-source registry key.

    Returns:
        The compact boundary statement for that format.
    """
    capability = capability_for(format_key)
    return FormatCapabilitySummary(
        provenance=capability.provenance,
        availability=capability.availability,
        native_hierarchy=capability.native_hierarchy,
        native_hierarchy_note=capability.native_hierarchy_note,
        projection_coverage=capability.canonical_projection.coverage,
        conversion=capability.conversion.support,
        version_coverage=capability.version_coverage,
        unsupported_constructs=list(capability.unsupported_constructs),
        notes=list(capability.notes),
        registry_version=capability.registry_version,
        review_date=capability.review_date,
    )


def _is_publishable(descriptor: ImportSourceDescriptor) -> bool:
    """Whether importing this format mints a publishable Project rather than a catalog item.

    Reads :data:`app.import_routing.PUBLISHABLE_FORMATS` — the exact set
    :func:`~app.import_routing.decide_import_routing` branches on — so the matrix cannot claim a
    routing the server would not perform.

    Args:
        descriptor: The adapter's registry descriptor.

    Returns:
        ``True`` when any format key the adapter emits is a publishable one.
    """
    return any(fmt.strip().lower() in PUBLISHABLE_FORMATS for fmt in descriptor.formats)


def _export_support(emitter: Optional[type[Emitter]]) -> FormatExportSupport:
    """Build the export half of a row.

    Args:
        emitter: The shipped emitter class that writes this format, or ``None`` when the format is
            import-only.

    Returns:
        The export support block. An import-only format returns ``supported=False`` with every
        other field left null/false rather than an absent object, so a consumer never has to
        branch on the key's presence.
    """
    if emitter is None:
        return FormatExportSupport(supported=False)
    descriptor = emitter.descriptor()
    return FormatExportSupport(
        supported=True,
        target_key=descriptor.key,
        label=descriptor.label,
        format=descriptor.format,
        multi_file=descriptor.multi_file,
        capability_profile=emitter.capability_profile(),
        available=descriptor.available,
        unavailable_reason=descriptor.unavailable_reason,
    )


def _direction(can_import: bool, can_export: bool) -> FormatDirection:
    """Classify a row from its two capabilities.

    Args:
        can_import: Whether an adapter reads the format.
        can_export: Whether an emitter writes it.

    Returns:
        The row's :class:`FormatDirection`. A row exists because at least one is true, so the
        "neither" case cannot arise.
    """
    if can_import and can_export:
        return FormatDirection.BOTH
    return FormatDirection.IMPORT_ONLY if can_import else FormatDirection.EXPORT_ONLY


def _import_row(
    descriptor: ImportSourceDescriptor,
    emitter: Optional[type[Emitter]],
) -> FormatMatrixRow:
    """Build the row for a format that has an import adapter.

    Args:
        descriptor: The adapter's registry descriptor.
        emitter: The shipped emitter that writes the same format, or ``None``.

    Returns:
        The complete row.
    """
    adapter = get_import_source(descriptor.key)
    import_tools = _required_tools(adapter) if adapter is not None else ()
    export_tools = _required_tools(emitter) if emitter is not None else ()
    return FormatMatrixRow(
        key=descriptor.key,
        label=descriptor.label,
        description=descriptor.description,
        icon=descriptor.icon,
        paradigm=descriptor.paradigm,
        direction=_direction(True, emitter is not None),
        version_coverage=list(descriptor.formats),
        file_extensions=list(descriptor.file_extensions),
        import_support=FormatImportSupport(
            supported=True,
            input_kinds=[kind.value for kind in descriptor.input_kinds],
            supports_live_discovery=descriptor.supports_live_discovery,
            supports_remote_refs=descriptor.supports_remote_refs,
            publishable=_is_publishable(descriptor),
            available=descriptor.available,
            unavailable_reason=descriptor.unavailable_reason,
        ),
        export_support=_export_support(emitter),
        toolchain=_toolchain_gate(import_tools, export_tools),
        capability=_capability_summary(descriptor.key),
    )


def _export_only_row(import_key: str, emitter: type[Emitter]) -> FormatMatrixRow:
    """Build the row for an export destination no adapter reads.

    An emitter with no import adapter behind it is still a format Apiome supports, and a matrix
    whose whole point is stating the surface in full must list it.

    Args:
        import_key: The import-source key the emitter's descriptor key resolves to.
        emitter: The emitter class.

    Returns:
        The complete row, with the import half reported as unsupported.
    """
    descriptor = emitter.descriptor()
    capability = _capability_summary(import_key)
    full_capability = capability_for(import_key)
    paradigm = (
        ApiParadigm(full_capability.paradigm) if full_capability.paradigm else descriptor.paradigm
    )
    return FormatMatrixRow(
        key=import_key,
        label=descriptor.label,
        description=descriptor.description,
        icon=descriptor.icon,
        paradigm=paradigm,
        direction=FormatDirection.EXPORT_ONLY,
        version_coverage=[],
        file_extensions=[],
        import_support=FormatImportSupport(supported=False),
        export_support=_export_support(emitter),
        toolchain=_toolchain_gate((), _required_tools(emitter)),
        capability=capability,
    )


def collect_matrix_rows() -> List[FormatMatrixRow]:
    """Build one row per shipped format, ordered by label then key.

    Every registered import adapter contributes a row, plus any emitter with no import adapter
    behind it, so a format cannot be supported and unpublished. Internal machinery
    (:data:`INTERNAL_FORMAT_KEYS`) and adapters registered from outside this repository are
    excluded.

    Returns:
        The rows, deterministically ordered.
    """
    emitters = shipped_emitter_classes()
    rows: List[FormatMatrixRow] = []
    covered: set[str] = set()

    for descriptor in describe_import_sources():
        if descriptor.key in INTERNAL_FORMAT_KEYS or not is_shipped_import_source(descriptor.key):
            continue
        covered.add(descriptor.key)
        rows.append(_import_row(descriptor, emitters.get(descriptor.key)))

    for import_key, emitter in sorted(emitters.items()):
        if import_key in covered:
            continue
        rows.append(_export_only_row(import_key, emitter))

    rows.sort(key=lambda row: (row.label.lower(), row.key))
    return rows


def _counts(rows: Sequence[FormatMatrixRow]) -> FormatMatrixCounts:
    """Compute the headline counts over ``rows``.

    Args:
        rows: The rows a response will carry — already filtered, so the counts describe exactly
            what the caller receives.

    Returns:
        The counts.
    """
    importable = [row for row in rows if row.import_support.supported]
    exportable = [row for row in rows if row.export_support.supported]
    return FormatMatrixCounts(
        total=len(rows),
        importable=len(importable),
        exportable=len(exportable),
        round_trip=sum(1 for row in rows if row.direction is FormatDirection.BOTH),
        import_only=sum(1 for row in rows if row.direction is FormatDirection.IMPORT_ONLY),
        export_only=sum(1 for row in rows if row.direction is FormatDirection.EXPORT_ONLY),
        live_discovery=sum(1 for row in rows if row.import_support.supports_live_discovery),
        publishable=sum(1 for row in rows if row.import_support.publishable),
        toolchain_gated=sum(1 for row in rows if row.toolchain.required_tools),
        unavailable_here=sum(1 for row in rows if not row.toolchain.satisfied),
    )


def _matches(
    row: FormatMatrixRow,
    *,
    paradigm: Optional[ApiParadigm],
    direction: Optional[DirectionFilter],
) -> bool:
    """Whether ``row`` survives the requested filters.

    Args:
        row: The candidate row.
        paradigm: Keep only this paradigm, or ``None`` for every paradigm.
        direction: Keep only rows with this capability, or ``None`` for every direction.

    Returns:
        ``True`` when the row should be returned.
    """
    if paradigm is not None and row.paradigm is not paradigm:
        return False
    if direction is DirectionFilter.IMPORT:
        return row.import_support.supported
    if direction is DirectionFilter.EXPORT:
        return row.export_support.supported
    if direction is DirectionFilter.BOTH:
        return row.direction is FormatDirection.BOTH
    return True


def build_format_matrix(
    *,
    paradigm: Optional[ApiParadigm] = None,
    direction: Optional[DirectionFilter] = None,
) -> FormatMatrixResponse:
    """Build the format matrix, optionally filtered.

    The single traversal of the registries. ``GET /v1/formats/matrix`` serves the result verbatim,
    ``apiome formats`` renders it, and the FMT-1.2 docs-page generator renders the same rows — so
    none of the three can drift from the others.

    Args:
        paradigm: Return only formats in this paradigm. ``None`` returns every paradigm.
        direction: Return only formats with this capability — ``import`` for everything Apiome can
            read, ``export`` for everything it can write, ``both`` for the formats that round-trip.
            ``None`` returns every direction.

    Returns:
        The matrix, with counts computed over the rows actually returned and the filters echoed
        back so a partial table cannot be mistaken for the whole surface.
    """
    rows = [
        row
        for row in collect_matrix_rows()
        if _matches(row, paradigm=paradigm, direction=direction)
    ]
    return FormatMatrixResponse(
        version=FORMAT_MATRIX_VERSION,
        capability_registry_version=REGISTRY_VERSION,
        filters=FormatMatrixFilters(paradigm=paradigm, direction=direction),
        counts=_counts(rows),
        formats=rows,
    )


def filter_format_matrix(
    matrix: FormatMatrixResponse,
    *,
    paradigm: Optional[ApiParadigm] = None,
    direction: Optional[DirectionFilter] = None,
) -> FormatMatrixResponse:
    """Re-filter an already-built matrix, recomputing its counts and filter echo.

    Lets a caller that already holds the full payload narrow it without a second registry
    traversal — and, more importantly, without a second *copy* of the filter rules.

    Args:
        matrix: A previously built matrix.
        paradigm: Keep only this paradigm, or ``None`` for every paradigm.
        direction: Keep only rows with this capability, or ``None`` for every direction.

    Returns:
        A new response carrying the surviving rows, their counts, and the applied filters.
    """
    rows = [
        row
        for row in matrix.formats
        if _matches(row, paradigm=paradigm, direction=direction)
    ]
    return FormatMatrixResponse(
        version=matrix.version,
        capability_registry_version=matrix.capability_registry_version,
        filters=FormatMatrixFilters(paradigm=paradigm, direction=direction),
        counts=_counts(rows),
        formats=rows,
    )

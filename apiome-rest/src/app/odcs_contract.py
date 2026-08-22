"""Open Data Contract Standard (ODCS) document algebra — FMT-5.1 (#5439).

The typed shape a parsed ODCS v3.x data contract takes on its way to the canonical
model, plus the two things every reader in this fleet must state up front: which
document versions it will read, and which of the format's constructs it carries but
does not model.

**Why a hand-built algebra rather than the raw mapping.** ODCS is YAML (or JSON) with
no schema library in this service's dependency set, and its interesting half is
*governance* — quality rules, ownership, SLAs, serving infrastructure, price — which
the canonical model has no home for. Reading it into typed records makes two things
explicit that a bare ``dict`` walk leaves implicit: the structural half
(``schema[]`` objects and their properties) that becomes canonical types, and the
governance half that is carried **verbatim** so FMT-5.2's emitter can write it back
unchanged. Everything in the governance half keeps its source mapping intact — this
module never re-spells a key, so a round trip cannot lose one.

**Version gating is namespace-first, not marker-first.** ODCS v2.2.x and v3.x share
``apiVersion``/``kind`` but spell a dataset completely differently (``quantumName`` +
``dataset[].columns[]`` versus ``name`` + ``schema[].properties[]``). A v2 document is
therefore recognised, and *rejected by version* with remediation text, rather than
being parsed into an empty contract — see :func:`resolve_api_version`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Set, Tuple

__all__ = [
    "LIMIT_DETAILS",
    "MAX_PROPERTY_DEPTH",
    "MAX_SCHEMA_PROPERTIES",
    "ODCS_KIND",
    "READ_MAJOR_VERSION",
    "LimitRecorder",
    "OdcsApiVersion",
    "OdcsContract",
    "OdcsLimit",
    "OdcsParseError",
    "OdcsProperty",
    "OdcsQualityRule",
    "OdcsSchemaObject",
    "resolve_api_version",
]


# ---------------------------------------------------------------------------
# Version vocabulary
# ---------------------------------------------------------------------------

#: The ``kind`` every ODCS document declares. Matched case-insensitively because the
#: standard's own examples are inconsistent about it, and a reader that refused
#: ``datacontract`` would reject documents the reference tooling accepts.
ODCS_KIND = "datacontract"

#: The single major version this reader models. v3.0 and v3.1 share one document
#: shape — 3.1 added ``customProperties`` on more nodes and widened the quality
#: vocabulary, both of which are carried verbatim — so one reader covers the line.
READ_MAJOR_VERSION = 3

#: ``apiVersion`` spelling: an optional ``v``, then 2 or 3 dot-separated numbers,
#: optionally followed by a pre-release/build suffix (``v3.1.0-rc.1``).
_API_VERSION_RE = re.compile(
    r"^v?(?P<major>\d+)\.(?P<minor>\d+)(?:\.(?P<patch>\d+))?(?P<suffix>[-+][0-9A-Za-z.\-+]+)?$"
)

#: How deeply a property may nest inside another property (``object`` inside
#: ``object``, ``array`` of ``object``, …). The property walk recurses per level, so
#: this is what keeps a pathological document from raising an uncaught
#: ``RecursionError`` — which the import pipeline does not catch, and which would
#: surface as a 5xx rather than a rejection.
MAX_PROPERTY_DEPTH = 64

#: How many properties one contract may declare in total, across every schema object
#: and every nesting level. A runaway backstop: the largest honest contracts model a
#: few hundred columns.
MAX_SCHEMA_PROPERTIES = 20_000


class OdcsParseError(ValueError):
    """Raised when an ODCS document cannot be read into an :class:`OdcsContract`.

    Attributes:
        code: The intake-taxonomy code the pipeline should report, when this reader
            can classify the failure itself. ``None`` leaves the classification to
            :func:`app.import_source_pipeline._classify_parse_failure` — which is
            what makes a UTF-16 upload read as ``INPUT_ENCODING_INVALID`` rather
            than as a generic malformed document.

    Note:
        The taxonomy supplies the *generic* remediation for a code; anything
        contract-specific ("rename ``quantumName`` to ``name``") belongs in the
        message, because that is the half the pipeline surfaces verbatim.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class OdcsApiVersion:
    """A parsed ``apiVersion`` declaration.

    Attributes:
        raw: The declared string, exactly as the document spelled it (``v3.1.0``).
        major: Major version number.
        minor: Minor version number.
        patch: Patch version number; ``0`` when the document declared only two parts.
    """

    raw: str
    major: int
    minor: int
    patch: int = 0

    @property
    def line(self) -> str:
        """The ``major.minor`` line this version belongs to, e.g. ``3.1``."""
        return f"{self.major}.{self.minor}"


def resolve_api_version(declared: Any) -> OdcsApiVersion:
    """Parse and range-check an ODCS ``apiVersion``.

    The v2.2.x line is the one this matters for: it declares the same
    ``apiVersion``/``kind`` pair as v3 but spells a dataset as
    ``dataset[].columns[]`` under a ``quantumName``. Parsing it as v3 would produce a
    contract with no schema objects and a misleading "no structure" error, so the
    version is resolved **before** the body is read and an out-of-range document is
    rejected by version.

    Args:
        declared: The document's ``apiVersion`` value, of whatever type it had.

    Returns:
        The parsed version.

    Raises:
        OdcsParseError: ``INPUT_SEMANTIC_INVALID`` when ``apiVersion`` is missing or
            unparseable; ``FORMAT_VERSION_UNSUPPORTED``, with the v2 → v3 renames
            named in the message, when it parses but is outside the readable major
            version.
    """
    if not isinstance(declared, str) or not declared.strip():
        raise OdcsParseError(
            "ODCS document declares no `apiVersion`; every data contract states the "
            "standard version it is written against (for example `apiVersion: v3.1.0`)",
            code="INPUT_SEMANTIC_INVALID",
        )
    match = _API_VERSION_RE.match(declared.strip())
    if match is None:
        raise OdcsParseError(
            f"ODCS `apiVersion` {declared.strip()!r} is not a version number; expected "
            "a `v<major>.<minor>[.<patch>]` string such as `v3.1.0`",
            code="INPUT_SEMANTIC_INVALID",
        )
    version = OdcsApiVersion(
        raw=declared.strip(),
        major=int(match.group("major")),
        minor=int(match.group("minor")),
        patch=int(match.group("patch") or 0),
    )
    if version.major == READ_MAJOR_VERSION:
        return version
    if version.major < READ_MAJOR_VERSION:
        raise OdcsParseError(
            f"ODCS {version.raw} is a v{version.line} data contract; this importer reads "
            f"the v{READ_MAJOR_VERSION}.x line. The v2 line spells a dataset as "
            "`quantumName` with `dataset[].columns[]`, which v3 renamed to `name` with "
            "`schema[].properties[]`, so the two are not interchangeable documents. To "
            f"import it, migrate the contract to ODCS v{READ_MAJOR_VERSION}.x — rename "
            "`quantumName` to `name`, `dataset` to `schema`, each dataset's `columns` to "
            "`properties`, and each column's `column` to `name`.",
            code="FORMAT_VERSION_UNSUPPORTED",
        )
    raise OdcsParseError(
        f"ODCS {version.raw} declares major version {version.major}; this importer reads "
        f"the v{READ_MAJOR_VERSION}.x line and will not guess at a later major version's "
        f"document shape. Export the contract as ODCS v{READ_MAJOR_VERSION}.x, or upgrade "
        f"Apiome to a release that reads v{version.major}.x.",
        code="FORMAT_VERSION_UNSUPPORTED",
    )


# ---------------------------------------------------------------------------
# Declared limits — what the reader carries but does not model
# ---------------------------------------------------------------------------

#: Stable limit key → the sentence published for it.
#:
#: These keys are one vocabulary in three places: here, in
#: :data:`app.odcs_import_source.ODCS_CAPABILITIES`'s ``unsupported`` list, and in the
#: ``odcs`` seed's ``dropped_constructs`` in :mod:`app.format_capability_registry`. A
#: test asserts all three agree, so a construct cannot be silently carried.
#:
#: Every one of them is *carried*: the source block survives verbatim in canonical
#: ``extras`` under the documented ``odcs_*`` namespace (see
#: :mod:`app.odcs_normalizer`), so FMT-5.2 can write it back. What is declared here is
#: that the canonical model has no *native* home for it — a reader must go to
#: ``extras`` to find it, and no Apiome feature that consumes the canonical model
#: (diff, lint, compatibility) sees it.
LIMIT_DETAILS: Dict[str, str] = {
    "odcs.quality_rule": (
        "A quality rule — a library rule (`rowCount`, `nullCount`, `duplicateCount`, "
        "`freshness`, …), a `sql` query, a free-text expectation or a `custom` engine "
        "block — states an expectation about the *data*, not about the schema. The "
        "canonical model constrains shape, so the rule is carried verbatim in "
        "`extras['odcs_quality']` on the contract, the type or the field that declared "
        "it, and is never executed, translated into a constraint, or checked."
    ),
    "odcs.sla_property": (
        "`slaProperties` states latency, freshness, retention, frequency and "
        "availability windows against a named element. The canonical model has no "
        "service-level vocabulary, so the entries are carried verbatim in "
        "`extras['odcs_sla_properties']` with `slaDefaultElement` beside them."
    ),
    "odcs.server": (
        "A `servers[]` entry describes *serving infrastructure* — a BigQuery dataset, "
        "an S3 prefix, a Snowflake warehouse, a Kafka broker — with a different field "
        "set per `type`. The canonical `Server` is a URL with variables and cannot hold "
        "them without inventing one, so each entry is carried verbatim in "
        "`extras['odcs_servers']` and no canonical server is synthesized."
    ),
    "odcs.team_role": (
        "`team[]` (who owns the contract, since when, and who replaced whom) and "
        "`roles[]` (which access role is granted through which approvers) are "
        "ownership and access-governance facts. The canonical model carries neither, "
        "so both are carried verbatim in `extras['odcs_team']` and "
        "`extras['odcs_roles']`."
    ),
    "odcs.support_channel": (
        "`support[]` names the channels a consumer reaches the producer through. The "
        "canonical model has no contact vocabulary, so the entries are carried "
        "verbatim in `extras['odcs_support']`."
    ),
    "odcs.price": (
        "`price` states an amount, a currency and a billing unit for consuming the "
        "dataset. Nothing in the canonical model prices an API, so the block is "
        "carried verbatim in `extras['odcs_price']`."
    ),
    "odcs.tag": (
        "`tags[]` labels a contract, a schema object or a property with free-form "
        "keywords. The canonical model tags *operations*, not data-schema entities, so "
        "the list is carried verbatim in `extras['odcs_tags']` on whichever node "
        "declared it."
    ),
    "odcs.custom_property": (
        "`customProperties[]` is the standard's own extension point: a list of "
        "`property`/`value` pairs whose meaning is defined by the publisher. It is "
        "carried verbatim in `extras['odcs_custom_properties']` on whichever node "
        "declared it, and no meaning is assigned to any key."
    ),
    "odcs.authoritative_definition": (
        "`authoritativeDefinitions[]` points at an external business definition, "
        "lineage record, or schema document by URL. The URLs are recorded in "
        "`extras['odcs_authoritative_definitions']` and **never fetched** during "
        "import; a relative URL that names a member of the same imported file set is "
        "additionally recorded as resolved, but its content is not expanded into the "
        "canonical model."
    ),
    "odcs.physical_type": (
        "`physicalType` (`varchar(20)`, `numeric(13,2)`, `jsonb`, `array<struct>`) is the "
        "storage type in the serving system, and `physicalName` is what the object or "
        "column is actually called there. Both describe the *physical* dataset, which the "
        "canonical model does not: it names the logical shape. They are carried verbatim "
        "in `extras['odcs_physical_type']` and `extras['odcs_physical_name']`, and the "
        "type is deliberately not interpreted — `varchar(20)` does **not** become "
        "`maxLength: 20`, because the unit differs by dialect and by encoding. Declared "
        "lengths and ranges come from `logicalTypeOptions`, which is the portable half."
    ),
    "odcs.key_uniqueness": (
        "`primaryKey`/`primaryKeyPosition` and `unique` declare identity and "
        "uniqueness over the *rows* of a dataset. The canonical constraint vocabulary "
        "has no identity facet (`unique_items` is about the members of one array), so "
        "the declarations are carried on the field in `extras` and are not enforced."
    ),
    "odcs.partitioning": (
        "`partitioned`/`partitionKeyPosition` describe the physical layout of the "
        "dataset in the serving system. The canonical model describes shape, not "
        "layout, so the declarations are carried on the field in `extras`."
    ),
    "odcs.classification": (
        "`classification` (`confidential`, `restricted`, …) and "
        "`criticalDataElement` are governance labels on a field. The canonical model "
        "has no classification vocabulary, so both are carried on the field in "
        "`extras` — which is what keeps a PII marker visible on the catalog detail "
        "view without pretending it is a validation constraint."
    ),
    "odcs.transform_metadata": (
        "`transformSourceObjects`, `transformLogic`, `transformDescription` and "
        "`encryptedName` describe how a field is derived and where its encrypted twin "
        "lives. That is lineage, not shape, so all four are carried on the field in "
        "`extras['odcs_transform']` and `extras['odcs_encrypted_name']`."
    ),
    "odcs.declaration_order": (
        "A dataset's column order is physical: it is the order the table, file or topic "
        "actually presents. Canonical entities are keyed and sorted by key, so declaration "
        "order is not a canonical property; the source index is recorded on every schema "
        "object and every property as `extras['odcs_position']` and the canonical ordering "
        "does not follow it."
    ),
    "odcs.free_form_object": (
        "A property typed `object` that declares no `properties` of its own (an event "
        "body stored as `jsonb`, a payload whose shape is delegated to an external "
        "schema) has no members to name. It becomes an open-content record with no "
        "fields, and the fact that arbitrary content is admitted is not expressible as "
        "a canonical constraint."
    ),
}


@dataclass(frozen=True)
class OdcsLimit:
    """One declared limit the read document exercised.

    Attributes:
        construct: The stable key; always a key of :data:`LIMIT_DETAILS`.
        detail: The published sentence for ``construct``.
        count: How many occurrences were recorded.
        locations: The canonical entity keys the occurrences sit under, sorted. Empty
            for a contract-level block, which has no owning entity.
    """

    construct: str
    detail: str
    count: int
    locations: Tuple[str, ...] = ()


class LimitRecorder:
    """Accumulates :class:`OdcsLimit` records while a contract is read.

    Recording lives here rather than inline in the normalizer so the wording, the
    de-duplication and the vocabulary check are one implementation — a construct is
    counted the same way wherever it is met.
    """

    def __init__(self) -> None:
        self._counts: Dict[str, int] = {}
        self._locations: Dict[str, Set[str]] = {}

    def record(self, construct: str, *, location: Optional[str] = None) -> None:
        """Record one occurrence of ``construct``.

        Args:
            construct: The stable limit key; must be a key of :data:`LIMIT_DETAILS`.
            location: The canonical entity key the occurrence sits under, when the
                construct belongs to one. Property-level constructs deliberately
                record their owning **schema object**, not the property, so a
                200-column table contributes one location rather than two hundred.

        Raises:
            KeyError: If ``construct`` is not part of the declared vocabulary.
        """
        if construct not in LIMIT_DETAILS:
            raise KeyError(f"unknown ODCS limit key: {construct}")
        self._counts[construct] = self._counts.get(construct, 0) + 1
        if location:
            self._locations.setdefault(construct, set()).add(location)

    def limits(self) -> Tuple[OdcsLimit, ...]:
        """Return the accumulated limits, sorted by construct key."""
        return tuple(
            OdcsLimit(
                construct=construct,
                detail=LIMIT_DETAILS[construct],
                count=count,
                locations=tuple(sorted(self._locations.get(construct, ()))),
            )
            for construct, count in sorted(self._counts.items())
        )


# ---------------------------------------------------------------------------
# The document algebra
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OdcsQualityRule:
    """One entry of a ``quality[]`` list, at contract, object or property level.

    ODCS admits four rule shapes and they overlap: a *library* rule names a built-in
    check with ``rule:``; ``type: sql`` carries a ``query``; ``type: text`` carries a
    prose expectation; ``type: custom`` carries an ``engine`` and an
    ``implementation``. Rather than model each shape's operand vocabulary — which the
    standard keeps widening — the discriminating fields are lifted for the coverage
    ledger and the whole source mapping is kept verbatim.

    Attributes:
        kind: ``library``, ``sql``, ``text`` or ``custom``.
        name: The library rule name (``rowCount``), when ``kind`` is ``library``.
        property: The property the rule applies to, when it names one.
        dimension: The declared data-quality dimension (``completeness``, …).
        severity: The declared severity (``error``, ``warning``, …).
        definition: The source mapping, verbatim and unmodified.
    """

    kind: str
    name: Optional[str]
    property: Optional[str]
    dimension: Optional[str]
    severity: Optional[str]
    definition: Mapping[str, Any]


@dataclass(frozen=True)
class OdcsProperty:
    """One entry of a schema object's (or a parent property's) ``properties[]``.

    Attributes:
        name: The property name.
        logical_type: The declared ``logicalType`` (``string``/``date``/``number``/
            ``integer``/``boolean``/``object``/``array``), lower-cased; ``None`` when
            the document omitted it.
        physical_type: The declared ``physicalType``, verbatim.
        physical_name: The declared ``physicalName``, when it differs from ``name``.
        description: The property description.
        required: Whether the property is declared required.
        properties: Nested properties, when ``logical_type`` is ``object``.
        items: The element property, when ``logical_type`` is ``array``. Synthesized
            with the name ``items`` because ODCS's ``items`` block is unnamed.
        quality: Property-level quality rules.
        logical_type_options: The ``logicalTypeOptions`` mapping, verbatim.
        examples: The declared ``examples`` list, verbatim.
        governance: Every remaining ODCS-declared attribute of this property that the
            canonical model has no home for (``primaryKey``, ``partitioned``,
            ``classification``, ``transformLogic``, …), keyed exactly as the source
            spelled it.
    """

    name: str
    logical_type: Optional[str] = None
    physical_type: Optional[str] = None
    physical_name: Optional[str] = None
    description: Optional[str] = None
    required: bool = False
    properties: Tuple["OdcsProperty", ...] = ()
    items: Optional["OdcsProperty"] = None
    quality: Tuple[OdcsQualityRule, ...] = ()
    logical_type_options: Mapping[str, Any] = field(default_factory=dict)
    examples: Tuple[Any, ...] = ()
    governance: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class OdcsSchemaObject:
    """One entry of the contract's ``schema[]`` — a table, view, topic or file set.

    Attributes:
        name: The object's logical name; the canonical type key.
        physical_name: The declared ``physicalName`` (``orders_v2``).
        logical_type: The declared ``logicalType`` (always ``object`` in practice).
        physical_type: The declared ``physicalType`` (``table``, ``view``, ``topic``).
        description: The object description.
        properties: The object's properties, in declaration order.
        quality: Object-level quality rules, including any merged from a sibling
            quality pack in the same file set.
        governance: Every remaining ODCS-declared attribute of this object
            (``dataGranularityDescription``, ``authoritativeDefinitions``, ``tags``,
            ``customProperties``, …), keyed exactly as the source spelled it.
    """

    name: str
    physical_name: Optional[str] = None
    logical_type: Optional[str] = None
    physical_type: Optional[str] = None
    description: Optional[str] = None
    properties: Tuple[OdcsProperty, ...] = ()
    quality: Tuple[OdcsQualityRule, ...] = ()
    governance: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class OdcsContract:
    """A parsed ODCS v3.x data contract.

    Attributes:
        api_version: The resolved ``apiVersion``.
        name: The contract's ``name`` — the dataset's logical name.
        contract_id: The contract's ``id`` (a UUID in the standard's examples).
        version: The contract's own semantic ``version``.
        status: The declared lifecycle ``status`` (``draft``, ``active``, …).
        domain: The declared business ``domain``.
        tenant: The declared ``tenant``.
        data_product: The declared ``dataProduct``.
        description: The ``description`` block, verbatim; ``purpose`` becomes the
            canonical description and the rest is carried.
        schema_objects: The ``schema[]`` entries, in declaration order.
        governance: The contract-level blocks the canonical model has no home for
            (``servers``, ``team``, ``roles``, ``support``, ``slaProperties``,
            ``slaDefaultElement``, ``price``, ``tags``, ``customProperties``,
            ``quality``), keyed exactly as the source spelled them.
        fileset: What a multi-file import composed — the member names, the quality
            packs merged in and the definitions that resolved to a sibling. Empty for
            a single-document import.
        raw: The source text, retained for the fidelity bag.
    """

    api_version: OdcsApiVersion
    name: str
    contract_id: Optional[str] = None
    version: Optional[str] = None
    status: Optional[str] = None
    domain: Optional[str] = None
    tenant: Optional[str] = None
    data_product: Optional[str] = None
    description: Mapping[str, Any] = field(default_factory=dict)
    schema_objects: Tuple[OdcsSchemaObject, ...] = ()
    governance: Mapping[str, Any] = field(default_factory=dict)
    fileset: Mapping[str, Any] = field(default_factory=dict)
    raw: str = ""

"""Kafka Connect schema algebra — FMT-5.3 (#5441).

The typed AST every Kafka Connect surface parses into, plus the two vocabularies the
reader and the writer must agree on: the logical-type table and the declared-limit
table.

**What a Connect schema is.** Kafka Connect carries data between systems as a
``(schema, value)`` pair, and the schema half is a small closed algebra —
``{type, optional, name, version, doc, default, parameters}`` with ``fields[]`` for a
``struct``, ``items`` for an ``array`` and ``keys``/``values`` for a ``map``. It is
neither Avro nor JSON Schema: a struct's members are keyed ``field`` (not ``name``),
``name`` on a container is the *schema name* while ``name`` on a primitive is a
**logical type**, and optionality is a flag on the schema rather than a union with
null.

**Why the logical-type table is here rather than in the normalizer.** A logical type is
the whole reason this format is worth reading: ``org.apache.kafka.connect.data.Decimal``
is not "some bytes", it is a decimal whose scale rides in ``parameters``. Both the
reader (which must turn it into a canonical constraint) and the writer (which must turn
the constraint back into the name and its parameters) consult
:data:`LOGICAL_TYPES`, so the two can never disagree about what a name means.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Set, Tuple

__all__ = [
    "CONNECT_CONTAINER_TYPES",
    "CONNECT_PRIMITIVE_TYPES",
    "CONNECT_TO_CANONICAL_SCALAR",
    "CONNECT_TYPES",
    "DECIMAL_LOGICAL_TYPE",
    "DECIMAL_PRECISION_PARAMETER",
    "DECIMAL_SCALE_PARAMETER",
    "ENUM_ALLOWED_PARAMETER",
    "ENUM_LOGICAL_TYPE",
    "LIMIT_DETAILS",
    "LOGICAL_TYPES",
    "ConnectConnectorConfig",
    "ConnectDocument",
    "ConnectField",
    "ConnectLimit",
    "ConnectLogicalType",
    "ConnectParseError",
    "ConnectSchema",
    "LimitRecorder",
    "logical_type_for_format",
]


class ConnectParseError(ValueError):
    """Raised when a document cannot be read as a Kafka Connect schema.

    Attributes:
        code: The intake-taxonomy code when this reader can classify the failure, and
            ``None`` when it cannot — a code-less error hands classification to
            :func:`app.import_source_pipeline._classify_parse_failure`, which is what
            makes a UTF-16 upload read as ``INPUT_ENCODING_INVALID`` and an Avro
            ``.avsc`` routed here read as ``FORMAT_MISMATCH``.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# The type vocabulary
# ---------------------------------------------------------------------------

#: Connect's primitive schema types. The widths are declared, not inferred: Connect
#: distinguishes ``int8`` from ``int32`` where Avro promotes both to ``int``.
CONNECT_PRIMITIVE_TYPES = frozenset(
    {"int8", "int16", "int32", "int64", "float32", "float64", "boolean", "string", "bytes"}
)

#: Connect's three container schema types.
CONNECT_CONTAINER_TYPES = frozenset({"struct", "array", "map"})

#: Every schema ``type`` Connect admits.
CONNECT_TYPES = CONNECT_PRIMITIVE_TYPES | CONNECT_CONTAINER_TYPES

#: Connect primitive → canonical scalar name. The canonical vocabulary already carries
#: every width Connect declares, so nothing is widened on the way in: ``int8`` stays
#: ``int8``. ``float32``/``float64`` deliberately land on ``float``/``double`` — the
#: names the Avro reader produces for the same two IEEE widths — so a Connect schema
#: and its Avro equivalent describe the same canonical fields.
CONNECT_TO_CANONICAL_SCALAR: Dict[str, str] = {
    "int8": "int8",
    "int16": "int16",
    "int32": "int32",
    "int64": "int64",
    "float32": "float",
    "float64": "double",
    "boolean": "bool",
    "string": "string",
    "bytes": "bytes",
}


@dataclass(frozen=True)
class ConnectLogicalType:
    """One recognized Connect logical type and how it projects onto the canonical model.

    Attributes:
        name: The fully-qualified Connect logical name, as it appears in ``name``.
        base_type: The Connect primitive the logical type decorates. A document that
            declares a different base is still read — the *name* is the semantic
            authority — but the mismatch is worth recording.
        canonical_scalar: The canonical scalar the value is modelled as, overriding the
            base type's own mapping. ``None`` keeps the base type's canonical scalar.
        canonical_format: The canonical :attr:`~app.canonical_model.Constraints.format`
            token, or ``None`` when the type constrains something other than format.
        summary: One sentence describing the type, for error messages and docs.
    """

    name: str
    base_type: str
    canonical_scalar: Optional[str]
    canonical_format: Optional[str]
    summary: str


#: ``org.apache.kafka.connect.data.Decimal``: the one logical type whose parameters are
#: load-bearing rather than decorative.
DECIMAL_LOGICAL_TYPE = "org.apache.kafka.connect.data.Decimal"

#: The Connect parameter carrying a ``Decimal``'s scale.
DECIMAL_SCALE_PARAMETER = "scale"

#: The Connect parameter carrying a ``Decimal``'s precision.
DECIMAL_PRECISION_PARAMETER = "connect.decimal.precision"

#: ``io.debezium.data.Enum``: a string whose permitted values ride in ``parameters``.
ENUM_LOGICAL_TYPE = "io.debezium.data.Enum"

#: The Connect parameter carrying an ``io.debezium.data.Enum``'s permitted values, as
#: one comma-separated string.
ENUM_ALLOWED_PARAMETER = "allowed"

#: The logical types this reader models, keyed by their Connect ``name``.
#:
#: The four ``org.apache.kafka.connect.data.*`` entries are the ones Connect itself
#: bundles. The ``io.debezium.*`` entries are connector-supplied names a change-data
#: pipeline actually carries; they are here because the corpus carries them and because
#: reading ``MicroTimestamp`` as "an int64" would throw away the only thing that makes
#: the field a timestamp. Every *other* ``name`` on a non-struct schema is carried
#: verbatim and recorded as :data:`LIMIT_DETAILS`'
#: ``kafka-connect.unknown_logical_type`` — recognized as a logical type, not decoded.
LOGICAL_TYPES: Dict[str, ConnectLogicalType] = {
    DECIMAL_LOGICAL_TYPE: ConnectLogicalType(
        name=DECIMAL_LOGICAL_TYPE,
        base_type="bytes",
        canonical_scalar=None,
        canonical_format="decimal",
        summary="An arbitrary-precision decimal, serialized as two's-complement bytes "
        "with `scale` and `connect.decimal.precision` in `parameters`.",
    ),
    "org.apache.kafka.connect.data.Date": ConnectLogicalType(
        name="org.apache.kafka.connect.data.Date",
        base_type="int32",
        canonical_scalar="string",
        canonical_format="date",
        summary="A calendar date with no time-of-day, as days since the Unix epoch.",
    ),
    "org.apache.kafka.connect.data.Time": ConnectLogicalType(
        name="org.apache.kafka.connect.data.Time",
        base_type="int32",
        canonical_scalar="string",
        canonical_format="time",
        summary="A time-of-day with no date, as milliseconds since midnight.",
    ),
    "org.apache.kafka.connect.data.Timestamp": ConnectLogicalType(
        name="org.apache.kafka.connect.data.Timestamp",
        base_type="int64",
        canonical_scalar="string",
        canonical_format="date-time",
        summary="An instant, as milliseconds since the Unix epoch.",
    ),
    "io.debezium.time.MicroTimestamp": ConnectLogicalType(
        name="io.debezium.time.MicroTimestamp",
        base_type="int64",
        canonical_scalar="string",
        canonical_format="date-time",
        summary="An instant, as microseconds since the Unix epoch.",
    ),
    "io.debezium.time.ZonedTimestamp": ConnectLogicalType(
        name="io.debezium.time.ZonedTimestamp",
        base_type="string",
        canonical_scalar="string",
        canonical_format="date-time",
        summary="An instant with a time-zone offset, as an ISO-8601 string.",
    ),
    ENUM_LOGICAL_TYPE: ConnectLogicalType(
        name=ENUM_LOGICAL_TYPE,
        base_type="string",
        canonical_scalar="string",
        canonical_format=None,
        summary="A string restricted to the comma-separated values in the `allowed` "
        "parameter.",
    ),
}


def logical_type_for_format(canonical_format: str, canonical_scalar: str) -> Optional[ConnectLogicalType]:
    """Return the logical type a canonical ``format`` projects onto, if any.

    The inverse of the reader's format mapping, used by the emitter when a model that
    did **not** come from Connect carries a format Connect has a name for. Ambiguity is
    resolved towards the type Connect itself bundles: ``date-time`` maps to
    ``org.apache.kafka.connect.data.Timestamp`` rather than to either Debezium spelling.

    Args:
        canonical_format: The canonical format token (``date``, ``date-time``, …).
        canonical_scalar: The canonical scalar the value is modelled as, used to keep a
            ``decimal``-formatted *string* from being written as Connect's byte-backed
            ``Decimal``.

    Returns:
        The logical type, or ``None`` when Connect has no name for that format.
    """
    token = (canonical_format or "").strip().lower()
    if token == "decimal":
        # Connect's Decimal is byte-backed; a decimal carried as text is a string with a
        # format hint and must not be re-typed as bytes.
        if canonical_scalar in {"bytes", "binary", "blob"}:
            return LOGICAL_TYPES[DECIMAL_LOGICAL_TYPE]
        return None
    for name in (
        "org.apache.kafka.connect.data.Date",
        "org.apache.kafka.connect.data.Time",
        "org.apache.kafka.connect.data.Timestamp",
    ):
        if LOGICAL_TYPES[name].canonical_format == token:
            return LOGICAL_TYPES[name]
    return None


# ---------------------------------------------------------------------------
# Declared limits
# ---------------------------------------------------------------------------

#: What this reader carries but does not model, as one published vocabulary.
#:
#: The same keys appear in three places — here, in the adapter's
#: ``unsupported_constructs``, and in the reviewed capability-registry seed — and are
#: counted and located per document in ``extras['kafka_connect']['capability_limits']``.
#: Every entry is *partially* mapped: the construct is read and carried, and only the
#: ability of a canonical feature to act on it is lost.
LIMIT_DETAILS: Dict[str, str] = {
    "kafka-connect.schema_parameters": (
        "A schema's `parameters` map is free-form connector metadata — a source "
        "database's column type, a converter hint, an ownership label. The parameters a "
        "recognized logical type defines are consumed (a `Decimal`'s scale and "
        "precision, an enum's `allowed` values); every remaining entry is carried "
        "verbatim in `extras['connect_parameters']` on the type or field that declared "
        "it, and no canonical feature reads it."
    ),
    "kafka-connect.unknown_logical_type": (
        "A `name` on a non-struct schema is a *logical type* — the semantic layer over "
        "Connect's nine primitives. A name this reader does not decode is still "
        "recognized as a logical type and carried verbatim in "
        "`extras['connect_logical_type']`, and the field keeps its base type's canonical "
        "scalar; what is lost is the canonical constraint the name would have implied."
    ),
    "kafka-connect.schema_version": (
        "Connect's per-schema integer `version` is the revision a schema registry "
        "assigned to that subject. The canonical model versions an *artifact*, not each "
        "of its types, so the number is carried verbatim in "
        "`extras['connect_version']` on the type or field that declared it."
    ),
    "kafka-connect.decimal_precision": (
        "A `Decimal`'s `scale` and `connect.decimal.precision` state how many digits the "
        "value carries. The canonical constraint vocabulary has no precision facet — "
        "`multipleOf` would describe a different thing — so `format: decimal` is set and "
        "both numbers are carried in `extras['scale']` and `extras['precision']`, which "
        "is the spelling the Avro writer already reads."
    ),
    "kafka-connect.anonymous_struct": (
        "A `struct` schema is not required to declare a `name`. The canonical model "
        "identifies every type by a stable key, so an anonymous struct is given one "
        "derived from where it sits (`Order.customer`) and the fact that the source "
        "named nothing is recorded rather than presented as a source name."
    ),
    "kafka-connect.envelope_payload": (
        "The `{schema, payload}` envelope a JSON converter writes with "
        "`schemas.enable=true` carries one sample record beside the schema. A record is "
        "*data*, not structure: it is carried verbatim in "
        "`extras['kafka_connect_payload']` and nothing is inferred from it."
    ),
    "kafka-connect.connector_config": (
        "A connector configuration — `connector.class`, converters, transforms, sink or "
        "source settings — describes how a pipeline runs, not what it carries. It is "
        "carried verbatim in `extras['kafka_connect_connector']`; the schemas beside it "
        "in the file set are what becomes structure."
    ),
}


@dataclass(frozen=True)
class ConnectLimit:
    """One declared limit, counted and located within a single document.

    Attributes:
        construct: The stable key; always a key of :data:`LIMIT_DETAILS`.
        detail: The published sentence for ``construct``.
        count: How many occurrences were recorded.
        locations: Canonical entity keys the occurrences sit under, sorted. Empty for a
            document-level construct, which has no owning entity.
    """

    construct: str
    detail: str
    count: int
    locations: Tuple[str, ...] = ()


class LimitRecorder:
    """Accumulates :class:`ConnectLimit` records while a document is normalized.

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
                construct belongs to one. A field-level construct records its owning
                **type**, so a 200-column struct contributes one location rather than
                two hundred.

        Raises:
            KeyError: If ``construct`` is not part of the declared vocabulary.
        """
        if construct not in LIMIT_DETAILS:
            raise KeyError(f"unknown Kafka Connect limit key: {construct}")
        self._counts[construct] = self._counts.get(construct, 0) + 1
        if location:
            self._locations.setdefault(construct, set()).add(location)

    def limits(self) -> Tuple[ConnectLimit, ...]:
        """Return the accumulated limits, sorted by construct key."""
        return tuple(
            ConnectLimit(
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
class ConnectSchema:
    """One Connect schema node — a primitive, a struct, an array or a map.

    Attributes:
        type: The Connect ``type`` keyword; always a member of :data:`CONNECT_TYPES`.
        optional: Connect's own nullability flag. Unlike Avro, optionality is a property
            of the schema rather than a union with ``null``.
        name: The schema name for a ``struct``, or the **logical type** for anything
            else. Connect overloads the one key for both, which is why the reader
            branches on ``type`` before reading it.
        version: The integer revision a schema registry assigned to this schema.
        doc: The schema's documentation string.
        default: The declared default value; meaningful only when ``has_default``.
        has_default: Whether ``default`` was declared. Kept apart from ``default``
            because ``"default": null`` is a real declaration on an optional schema.
        parameters: The schema's free-form ``parameters`` map, verbatim.
        fields: A ``struct``'s members, in declaration order.
        items: An ``array``'s element schema.
        keys: A ``map``'s key schema.
        values: A ``map``'s value schema.
    """

    type: str
    optional: bool = False
    name: Optional[str] = None
    version: Optional[int] = None
    doc: Optional[str] = None
    default: Any = None
    has_default: bool = False
    parameters: Mapping[str, Any] = field(default_factory=dict)
    fields: Tuple["ConnectField", ...] = ()
    items: Optional["ConnectSchema"] = None
    keys: Optional["ConnectSchema"] = None
    values: Optional["ConnectSchema"] = None

    @property
    def logical_type(self) -> Optional[str]:
        """The declared logical type, or ``None``.

        Returns:
            ``name`` when this schema is not a ``struct`` (where ``name`` is the record
            name instead), otherwise ``None``.
        """
        return self.name if self.type != "struct" and self.name else None


@dataclass(frozen=True)
class ConnectField:
    """One member of a ``struct`` schema.

    Attributes:
        name: The member name — Connect's ``field`` key, not ``name``. Telling the two
            apart is what separates a Connect struct from an Avro record.
        schema: The member's own schema node.
        index: Zero-based declaration order.
    """

    name: str
    schema: ConnectSchema
    index: int


@dataclass(frozen=True)
class ConnectConnectorConfig:
    """A connector configuration document — ``{name, config}``.

    Attributes:
        name: The connector's name, when declared.
        config: The configuration map, verbatim.
        source_file: The set member the configuration was read from.
    """

    name: Optional[str]
    config: Mapping[str, Any]
    source_file: Optional[str] = None


@dataclass(frozen=True)
class ConnectDocument:
    """One parsed Kafka Connect intake — a schema, an envelope, or a pipeline set.

    Attributes:
        roots: Every root schema the intake carried, in file order. A single document
            contributes one; a pipeline file set contributes its key and value schemas.
        raw: The source text (the root member's text for a file set).
        envelope: Whether the schema arrived inside a ``{schema, payload}`` envelope.
        payloads: The sample records carried beside enveloped schemas, verbatim.
        connector: The connector configuration, when the intake carried one.
        source_files: The set members the roots were read from, aligned with ``roots``.
    """

    roots: Tuple[ConnectSchema, ...]
    raw: str
    envelope: bool = False
    payloads: Tuple[Any, ...] = ()
    connector: Optional[ConnectConnectorConfig] = None
    source_files: Tuple[str, ...] = ()

    @property
    def root(self) -> ConnectSchema:
        """The primary root schema."""
        return self.roots[0]
